// File logger. stdout belongs to the wrapped agent TUI, so diagnostics are
// written to a private, bounded per-user log.

import fs from 'node:fs'
import path from 'node:path'
import { appDataDirectory, inspectOwnedRegularFile, openPrivateAppendFile } from './secure-files.js'

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024
const MAX_MESSAGE_CHARACTERS = 4096
const MAX_DETAIL_CHARACTERS = 32 * 1024
const MAX_DETAIL_DEPTH = 8
const MAX_COLLECTION_ITEMS = 64
const REDACTED = '[REDACTED]'
const ACTION_TYPES: ReadonlySet<string> = new Set([
  'accept',
  'agent_command',
  'focus_relative',
  'focus_session',
  'keys',
  'layer',
  'new_chat',
  'prompt',
  'push_to_talk',
  'reject',
  'thinking_depth',
  'workflow',
])

const SENSITIVE_KEY =
  /(?:action|authorization|body|cookie|credential|password|passwd|payload|prompt|secret|token|api[-_]?key|command|text)/i
const SENSITIVE_STRING_FIELD =
  '(?:proxy-authorization|authorization|cookie|set-cookie|action|body|command|credential|password|passwd|payload|prompt|secret|text|token|api[-_]?key)'
const JSON_SENSITIVE_VALUE = new RegExp(
  `("${SENSITIVE_STRING_FIELD}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  'gi',
)
const ESCAPED_JSON_SENSITIVE_VALUE = new RegExp(
  `(\\\\"${SENSITIVE_STRING_FIELD}\\\\"\\s*:\\s*)\\\\"[\\s\\S]*?\\\\"(?=\\s*(?:,\\s*\\\\"|}))`,
  'gi',
)
const CREDENTIAL_HEADER =
  /\b((?:proxy-)?authorization|(?:set-)?cookie)(\s*[:=]\s*)[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:)((?:\\?\/){2})([^@\s/?#\\]+)@/gi

export interface FileLogger {
  info(msg: string, detail?: unknown): void
  warn(msg: string, detail?: unknown): void
  error(msg: string, detail?: unknown): void
}

export interface FileLoggerOptions {
  logFile?: string
  maxBytes?: number
  now?: () => Date
}

/** Build an isolated logger (also useful to embedders and regression tests). */
export function createFileLogger(options: FileLoggerOptions = {}): FileLogger {
  const logFile = options.logFile ?? path.join(appDataDirectory(), 'opencontrol.log')
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_LOG_BYTES)
  const now = options.now ?? (() => new Date())
  let previous:
    | {
        signature: string
        level: 'warn' | 'error'
        repetitions: number
      }
    | undefined

  const write = (level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void => {
    try {
      const safeMessage = truncate(redactString(message), MAX_MESSAGE_CHARACTERS)
      const safeDetail = serializeDetail(detail)
      const signature = `${level}\0${safeMessage}\0${safeDetail}`

      if (level !== 'info' && previous?.signature === signature) {
        previous.repetitions += 1
        return
      }

      if (previous?.repetitions) {
        appendLine(
          logFile,
          maxBytes,
          `${now().toISOString()} [${previous.level}] previous log message repeated ${previous.repetitions} times\n`,
        )
      }
      previous =
        level === 'info'
          ? undefined
          : {
              signature,
              level,
              repetitions: 0,
            }

      const suffix = safeDetail.length === 0 ? '' : ` ${safeDetail}`
      appendLine(logFile, maxBytes, `${now().toISOString()} [${level}] ${safeMessage}${suffix}\n`)
    } catch {
      // Logging must never take the application down.
    }
  }

  return {
    info: (msg, detail): void => write('info', msg, detail),
    warn: (msg, detail): void => write('warn', msg, detail),
    error: (msg, detail): void => write('error', msg, detail),
  }
}

export const logger = createFileLogger()

function appendLine(logFile: string, maxBytes: number, line: string): void {
  const bytes = Buffer.from(line, 'utf8')
  let descriptor: number | null = openPrivateAppendFile(logFile)
  try {
    const current = fs.fstatSync(descriptor)
    if (current.size > 0 && current.size + bytes.length > maxBytes) {
      fs.closeSync(descriptor)
      descriptor = null
      rotateLog(logFile, current)
      descriptor = openPrivateAppendFile(logFile)
    }
    fs.writeSync(descriptor, bytes)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function rotateLog(logFile: string, observed: fs.Stats): void {
  const backup = `${logFile}.1`
  const existingBackup = inspectOwnedRegularFile(backup)
  if (existingBackup) fs.unlinkSync(backup)

  const current = inspectOwnedRegularFile(logFile)
  if (!current || current.dev !== observed.dev || current.ino !== observed.ino) {
    throw new Error(`log file changed during rotation: ${logFile}`)
  }
  fs.renameSync(logFile, backup)
}

function serializeDetail(detail: unknown): string {
  if (detail === undefined) return ''
  try {
    const sanitized = sanitizeValue(detail, undefined, new WeakSet<object>(), 0)
    const serialized =
      typeof sanitized === 'string' ? sanitized : (JSON.stringify(sanitized) ?? String(sanitized))
    return truncate(serialized, MAX_DETAIL_CHARACTERS)
  } catch {
    return '[unserializable detail]'
  }
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED
  if (typeof value === 'string') return truncate(redactString(value), MAX_MESSAGE_CHARACTERS)
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`
  if (depth >= MAX_DETAIL_DEPTH) return '[truncated]'
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: truncate(redactString(value.stack), MAX_DETAIL_CHARACTERS) } : {}),
    }
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((item) => sanitizeValue(item, undefined, seen, depth + 1))
    }
    if (
      'type' in value &&
      typeof (value as { type?: unknown }).type === 'string' &&
      ACTION_TYPES.has((value as { type: string }).type)
    ) {
      return { type: (value as { type: string }).type, payload: REDACTED }
    }
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
      output[childKey] = sanitizeValue(childValue, childKey, seen, depth + 1)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function redactString(value: string): string {
  return value
    .replace(ESCAPED_JSON_SENSITIVE_VALUE, `$1\\"${REDACTED}\\"`)
    .replace(JSON_SENSITIVE_VALUE, `$1"${REDACTED}"`)
    .replace(URL_USERINFO, `$1$2${REDACTED}@`)
    .replace(CREDENTIAL_HEADER, (_match, name: string, separator: string) => {
      return `${name}${separator}${REDACTED}`
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /((?:"|')?(?:action|authorization|body|command|cookie|credential|password|passwd|payload|prompt|secret|text|token|api[-_]?key)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&](?:authorization|password|passwd|secret|token|api[-_]?key)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  return `${value.slice(0, maximum)}…[truncated]`
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}
