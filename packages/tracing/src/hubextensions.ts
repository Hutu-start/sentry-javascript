import { getMainCarrier, Hub } from '@sentry/hub';
import { CustomSamplingContext, SamplingContext, TransactionContext, TransactionSamplingMethod } from '@sentry/types';
import { logger } from '@sentry/utils';

import { registerErrorInstrumentation } from './errors';
import { IdleTransaction } from './idletransaction';
import { Transaction } from './transaction';
import { hasTracingEnabled } from './utils';

/** Returns all trace headers that are currently on the top scope. */
function traceHeaders(this: Hub): { [key: string]: string } {
  const scope = this.getScope();
  if (scope) {
    const span = scope.getSpan();
    if (span) {
      return {
        'sentry-trace': span.toTraceparent(),
      };
    }
  }
  return {};
}

/**
 * Makes a sampling decision for the given transaction and stores it on the transaction.
 *
 * Called every time a transaction is created. Only transactions which emerge with a `sampled` value of `true` will be
 * sent to Sentry.
 *
 * @param hub: The hub off of which to read config options
 * @param transaction: The transaction needing a sampling decision
 * @param samplingContext: Default and user-provided data which may be used to help make the decision
 *
 * @returns The given transaction with its `sampled` value set
 */
function sample<T extends Transaction>(hub: Hub, transaction: T, samplingContext: SamplingContext): T {
  const client = hub.getClient();
  const options = client?.options ?? {};

  // nothing to do if there's no client or if tracing is disabled
  if (!client || !hasTracingEnabled(options)) {
    transaction.sampled = false;
    return transaction;
  }

  // if the user has forced a sampling decision by passing a `sampled` value in their transaction context, go with that
  if (transaction.sampled !== undefined) {
    transaction.setMetadata({
      transactionSampling: { method: TransactionSamplingMethod.Explicit },
    });
    return transaction;
  }

  // we would have bailed already if neither `tracesSampler` nor `tracesSampleRate` were defined, so one of these should
  // work; prefer the hook if so
  let sampleRate;
  if (typeof options.tracesSampler === 'function') {
    sampleRate = options.tracesSampler(samplingContext);
    transaction.setMetadata({
      transactionSampling: {
        method: TransactionSamplingMethod.Sampler,
        // cast to number in case it's a boolean
        rate: Number(sampleRate),
      },
    });
  } else if (samplingContext.parentSampled !== undefined) {
    sampleRate = samplingContext.parentSampled;
    transaction.setMetadata({
      transactionSampling: { method: TransactionSamplingMethod.Inheritance },
    });
  } else {
    sampleRate = options.tracesSampleRate;
    transaction.setMetadata({
      transactionSampling: {
        method: TransactionSamplingMethod.Rate,
        // cast to number in case it's a boolean
        rate: Number(sampleRate),
      },
    });
  }

  // Since this is coming from the user (or from a function provided by the user), who knows what we might get. (The
  // only valid values are booleans or numbers between 0 and 1.)
  if (!isValidSampleRate(sampleRate)) {
    logger.warn(`[Tracing] Discarding transaction because of invalid sample rate.`);
    transaction.sampled = false;
    return transaction;
  }

  // if the function returned 0 (or false), or if `tracesSampleRate` is 0, it's a sign the transaction should be dropped
  if (!sampleRate) {
    logger.log(
      `[Tracing] Discarding transaction because ${
        typeof options.tracesSampler === 'function'
          ? 'tracesSampler returned 0 or false'
          : 'a negative sampling decision was inherited or tracesSampleRate is set to 0'
      }`,
    );
    transaction.sampled = false;
    return transaction;
  }

  // Now we roll the dice. Math.random is inclusive of 0, but not of 1, so strict < is safe here. In case sampleRate is
  // a boolean, the < comparison will cause it to be automatically cast to 1 if it's true and 0 if it's false.
  transaction.sampled = Math.random() < (sampleRate as number | boolean);

  // if we're not going to keep it, we're done
  if (!transaction.sampled) {
    logger.log(
      `[Tracing] Discarding transaction because it's not included in the random sample (sampling rate = ${Number(
        sampleRate,
      )})`,
    );
    return transaction;
  }

  // at this point we know we're keeping the transaction, whether because of an inherited decision or because it got
  // lucky with the dice roll
  transaction.initSpanRecorder(options._experiments?.maxSpans as number);

  logger.log(`[Tracing] starting ${transaction.op} transaction - ${transaction.name}`);
  return transaction;
}

/**
 * Checks the given sample rate to make sure it is valid type and value (a boolean, or a number between 0 and 1).
 */
function isValidSampleRate(rate: unknown): boolean {
  // we need to check NaN explicitly because it's of type 'number' and therefore wouldn't get caught by this typecheck
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (isNaN(rate as any) || !(typeof rate === 'number' || typeof rate === 'boolean')) {
    logger.warn(
      `[Tracing] Given sample rate is invalid. Sample rate must be a boolean or a number between 0 and 1. Got ${JSON.stringify(
        rate,
      )} of type ${JSON.stringify(typeof rate)}.`,
    );
    return false;
  }

  // in case sampleRate is a boolean, it will get automatically cast to 1 if it's true and 0 if it's false
  if (rate < 0 || rate > 1) {
    logger.warn(`[Tracing] Given sample rate is invalid. Sample rate must be between 0 and 1. Got ${rate}.`);
    return false;
  }
  return true;
}

/**
 * Creates a new transaction and adds a sampling decision if it doesn't yet have one.
 *
 * The Hub.startTransaction method delegates to this method to do its work, passing the Hub instance in as `this`, as if
 * it had been called on the hub directly. Exists as a separate function so that it can be injected into the class as an
 * "extension method."
 *
 * @param this: The Hub starting the transaction
 * @param transactionContext: Data used to configure the transaction
 * @param CustomSamplingContext: Optional data to be provided to the `tracesSampler` function (if any)
 *
 * @returns The new transaction
 *
 * @see {@link Hub.startTransaction}
 */
function _startTransaction(
  this: Hub,
  transactionContext: TransactionContext,
  customSamplingContext?: CustomSamplingContext,
): Transaction {
  const transaction = new Transaction(transactionContext, this);
  return sample(this, transaction, {
    parentSampled: transactionContext.parentSampled,
    transactionContext,
    ...customSamplingContext,
  });
}

/**
 * Create new idle transaction.
 */
export function startIdleTransaction(
  hub: Hub,
  transactionContext: TransactionContext,
  idleTimeout?: number,
  onScope?: boolean,
  customSamplingContext?: CustomSamplingContext,
): IdleTransaction {
  const transaction = new IdleTransaction(transactionContext, hub, idleTimeout, onScope);
  return sample(hub, transaction, {
    parentSampled: transactionContext.parentSampled,
    transactionContext,
    ...customSamplingContext,
  });
}

/**
 * @private
 */
export function _addTracingExtensions(): void {
  const carrier = getMainCarrier();
  if (carrier.__SENTRY__) {
    carrier.__SENTRY__.extensions = carrier.__SENTRY__.extensions || {};
    if (!carrier.__SENTRY__.extensions.startTransaction) {
      carrier.__SENTRY__.extensions.startTransaction = _startTransaction;
    }
    if (!carrier.__SENTRY__.extensions.traceHeaders) {
      carrier.__SENTRY__.extensions.traceHeaders = traceHeaders;
    }
  }
}

/**
 * This patches the global object and injects the Tracing extensions methods
 */
export function addExtensionMethods(): void {
  _addTracingExtensions();

  // If an error happens globally, we should make sure transaction status is set to error.
  registerErrorInstrumentation();
}
