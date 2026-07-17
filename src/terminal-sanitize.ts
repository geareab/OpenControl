/**
 * Convert untrusted labels into a single inert terminal line.
 *
 * ANSI escape sequences are removed before the remaining C0/C1 controls so
 * that an escape character cannot be stripped while leaving a meaningful CSI
 * or OSC payload behind. The limit is counted in Unicode code points.
 */
export function sanitizeTerminalText(value: string, maxLength = 120): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer')
  }

  const sanitized = value
    // Operating System Commands, including an unterminated command.
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\][\s\S]*$/gu, '')
    // CSI sequences introduced by ESC [ or the single-byte C1 CSI.
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    // Remaining two-byte/multi-byte ANSI escape sequences.
    .replace(/\u001B[ -/]*[@-~]/gu, '')
    // All remaining C0, DEL, and C1 controls (including line breaks).
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, '')

  const codePoints = [...sanitized]
  return codePoints.length <= maxLength
    ? sanitized
    : `${codePoints.slice(0, maxLength - 1).join('')}…`
}
