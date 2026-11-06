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

/** Characters kept from a public key: a whole uncompressed key (130 hex). */
export const LOG_PUBKEY_MAX_LENGTH = 130

/** Longest error message kept by errorForLog. */
export const LOG_ERROR_MAX_LENGTH = 200

// C0 and C1 control characters, DEL, the Unicode line/paragraph separators,
// and invisible or bidi-override format characters that scramble rendered logs.
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g

/**
 * Returns `value` as a single printable line: cut to `maxLength` characters
 * (original length noted), then backslashes and control characters escaped.
 */
export function sanitizeForLog(
  value: unknown,
  maxLength = LOG_VALUE_MAX_LENGTH,
): string {
  const text = typeof value === 'string' ? value : String(value)
  // Cut before escaping, so an escape sequence is never split and the limit
  // counts input characters. Backslash is escaped too, so a literal
  // "\u000a" in the input cannot pass for an escaped newline.
  // Code points, so a surrogate pair is never split; pre-slice bounds the work.
  const kept = Array.from(text.slice(0, maxLength * 2))
    .slice(0, maxLength)
    .join('')
  const escaped = kept
    .replace(/\\/g, '\\\\')
    .replace(
      CONTROL_CHARACTERS,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
  if (kept.length >= text.length) {
    return escaped
  }
  return `${escaped}...[${Array.from(text).length} chars]`
}

/**
 * Describes a caller-supplied signature or token by its length only. Do not
 * use it for a server-held secret of variable length: the length itself
 * would leak.
 */
export function describeSecret(value: unknown): { length: number } {
  return { length: typeof value === 'string' ? value.length : 0 }
}

/** An error's message, escaped and bounded, for logging. */
export function errorForLog(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? 'unknown error')
  return sanitizeForLog(message, LOG_ERROR_MAX_LENGTH)
}

/**
 * One structured log event as a single-line JSON string. Nest's ConsoleLogger
 * prints an object message across several lines, which splits it in grep,
 * journald and CloudWatch; a string stays on one line. JSON.stringify escapes
 * quotes and control characters again, so values already passed through
 * sanitizeForLog show escapes doubled (`\\u000a`): the sanitiser is kept as
 * defence in depth and for its truncation.
 */
export function logLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields)
}
