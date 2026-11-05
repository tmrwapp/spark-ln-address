/**
 * Helpers for writing request-supplied values to the logs (issue 34).
 *
 * Anything a caller controls (query parameters, path segments, headers) can
 * carry CR/LF or ANSI escapes that forge extra log lines, or be megabytes long.
 * Log such values through sanitizeForLog, and log secrets and signatures only
 * through describeSecret, which never includes their content.
 */

/** Default number of characters kept from a sanitised value. */
export const LOG_VALUE_MAX_LENGTH = 32

/** Longest error message kept by errorForLog. */
export const LOG_ERROR_MAX_LENGTH = 200

// C0 and C1 control characters, DEL, and the Unicode line/paragraph separators.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/**
 * Returns `value` as a single printable line: control characters escaped as
 * \uXXXX, then cut to `maxLength` characters with the original length noted.
 */
export function sanitizeForLog(
  value: unknown,
  maxLength = LOG_VALUE_MAX_LENGTH,
): string {
  const text = typeof value === 'string' ? value : String(value)
  const escaped = text.replace(
    CONTROL_CHARACTERS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  if (escaped.length <= maxLength) {
    return escaped
  }
  return `${escaped.slice(0, maxLength)}...[${text.length} chars]`
}

/** Describes a secret or signature for the logs by its length only. */
export function describeSecret(value: unknown): { length: number } {
  return { length: typeof value === 'string' ? value.length : 0 }
}

/** An error's message, escaped and bounded, for logging. */
export function errorForLog(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error')
  return sanitizeForLog(message, LOG_ERROR_MAX_LENGTH)
}
