import { getCurrentHub, Hub } from '@sentry/hub';
import { Options, TraceparentData, Transaction } from '@sentry/types';
import { SentryError, unicodeToBase64 } from '@sentry/utils';

export const TRACEPARENT_REGEXP = new RegExp(
  '^[ \\t]*' + // whitespace
  '([0-9a-f]{32})?' + // trace_id
  '-?([0-9a-f]{16})?' + // span_id
  '-?([01])?' + // sampled
    '[ \\t]*$', // whitespace
);

/**
 * Determines if tracing is currently enabled.
 *
 * Tracing is enabled when at least one of `tracesSampleRate` and `tracesSampler` is defined in the SDK config.
 */
export function hasTracingEnabled(options: Options): boolean {
  return 'tracesSampleRate' in options || 'tracesSampler' in options;
}

/**
 * Extract transaction context data from a `sentry-trace` header.
 *
 * @param traceparent Traceparent string
 *
 * @returns Object containing data from the header, or undefined if traceparent string is malformed
 */
export function extractTraceparentData(traceparent: string): TraceparentData | undefined {
  const matches = traceparent.match(TRACEPARENT_REGEXP);
  if (matches) {
    let parentSampled: boolean | undefined;
    if (matches[3] === '1') {
      parentSampled = true;
    } else if (matches[3] === '0') {
      parentSampled = false;
    }
    return {
      traceId: matches[1],
      parentSampled,
      parentSpanId: matches[2],
    };
  }
  return undefined;
}

/** Grabs active transaction off scope, if any */
export function getActiveTransaction<T extends Transaction>(hub: Hub = getCurrentHub()): T | undefined {
  return hub?.getScope()?.getTransaction() as T | undefined;
}

/**
 * Converts from milliseconds to seconds
 * @param time time in ms
 */
export function msToSec(time: number): number {
  return time / 1000;
}

/**
 * Converts from seconds to milliseconds
 * @param time time in seconds
 */
export function secToMs(time: number): number {
  return time * 1000;
}

// so it can be used in manual instrumentation without necessitating a hard dependency on @sentry/utils
export { stripUrlQueryAndFragment } from '@sentry/utils';

/**
 * Compute the value of a tracestate header.
 *
 * @throws SentryError (because using the logger creates a circular dependency)
 * @returns the base64-encoded header value
 */
// Note: this is here instead of in the tracing package since @sentry/core tests rely on it
export function computeTracestateValue(tracestateData: {
  trace_id: string;
  environment: string | undefined | null;
  release: string | undefined | null;
  public_key: string;
}): string {
  // `JSON.stringify` will drop keys with undefined values, but not ones with null values
  tracestateData.environment = tracestateData.environment || null;
  tracestateData.release = tracestateData.release || null;

  // See https://www.w3.org/TR/trace-context/#tracestate-header-field-values
  // The spec for tracestate header values calls for a string of the form
  //
  //    identifier1=value1,identifier2=value2,...
  //
  // which means the value can't include any equals signs, since they already have meaning. Equals signs are commonly
  // used to pad the end of base64 values though, so to avoid confusion, we strip them off. (Most languages' base64
  // decoding functions (including those in JS) are able to function without the padding.)
  try {
    return unicodeToBase64(JSON.stringify(tracestateData)).replace(/={1,2}$/, '');
  } catch (err) {
    throw new SentryError(`[Tracing] Error creating tracestate header: ${err}`);
  }
}
