// Idempotent hook registration for Claude Code (~/.claude/settings.json) and
// Codex (~/.codex/hooks.json). Hook commands call the OpenControl executable;
// it discovers the ephemeral authenticated host from the per-user runtime
// descriptor, so no shell-specific curl command or fixed port is required.
//
// COEXISTENCE WITH VIBESENSE: vibesense's Claude installer identifies "its own"
// entries by the bare substring `/hook/` and purges everything matching it. If
// OpenMicro used `/hook/` too, vibesense would delete those entries on its next
// run. The legacy path was `/om-hook/` (which does NOT contain the substring
// `/hook/`) and identified its own entries by the full base-URL
// marker `127.0.0.1:48762/om-hook/`. Neither tool matches the other's entries.

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  privateReplacementMode,
  readOwnedRegularFile,
  SecureFileError,
} from './secure-files.js'

interface HookEntry {
  type: string
  command: string
}

interface HookGroup {
  matcher?: string
  hooks: HookEntry[]
}

interface HookSettings {
  hooks?: Record<string, HookGroup[] | undefined>
  [key: string]: unknown
}

export type HookWriteResult = 'changed' | 'unchanged' | 'failed'

interface HookFileOptions {
  target: string
  parseWarning: string
  writeWarning: string
  successMessage: string
  merge(settings: HookSettings): boolean
}

/** Shared read/merge/atomic-write lifecycle for every harness hook file. */
function updateHookFile(options: HookFileOptions, attempt = 0): HookWriteResult {
  let settings: HookSettings = {}
  let existing: ReturnType<typeof readOwnedRegularFile> = null
  try {
    ensurePrivateDirectory(path.dirname(options.target))
    existing = readOwnedRegularFile(options.target)
    if (existing) {
      const parsed = JSON.parse(existing.contents.toString('utf8')) as unknown
      if (!isRecord(parsed)) {
        logger.warn(options.parseWarning, new Error('hook settings root must be a JSON object'))
        return 'failed'
      }
      settings = parsed as HookSettings
    }
  } catch (err) {
    if (isRetryableRace(err) && attempt < 3) return updateHookFile(options, attempt + 1)
    logger.warn(options.parseWarning, err)
    return 'failed'
  }

  let contentChanged: boolean
  try {
    contentChanged = options.merge(settings)
  } catch (err) {
    logger.warn(options.parseWarning, err)
    return 'failed'
  }

  const finalMode = privateReplacementMode(existing?.stats ?? null)
  const modeNeedsHardening =
    process.platform !== 'win32' && existing !== null && (existing.stats.mode & 0o777) !== finalMode
  if (!contentChanged && !modeNeedsHardening) return 'unchanged'

  try {
    atomicWritePrivateFile(options.target, JSON.stringify(settings, null, 2) + '\n', {
      overwrite: existing !== null,
      mode: finalMode,
    })
    if (contentChanged) logger.info(options.successMessage, { target: options.target })
    return contentChanged ? 'changed' : 'unchanged'
  } catch (err) {
    if (isRetryableRace(err) && attempt < 3) return updateHookFile(options, attempt + 1)
    logger.warn(options.writeWarning, err)
    return 'failed'
  }
}

const COMMAND_MARKER = 'opencontrol hook '
const LEGACY_COMMAND_MARKER = '127.0.0.1:48762/om-hook/'
const LEGACY_HEADER = 'X-Openmicro-Instance-Id'
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')

function hookCommand(event: string): string {
  return `${quoteShellArgument(path.resolve(process.execPath))} ${quoteShellArgument(CLI_PATH)} hook ${event}`
}

/** Event name → matcher (undefined = all). PreToolUse only fires for AskUserQuestion. */
const HOOK_EVENTS: Record<string, string | undefined> = {
  UserPromptSubmit: undefined,
  Stop: undefined,
  Notification: undefined,
  PreToolUse: 'AskUserQuestion',
  PermissionRequest: undefined,
  PostToolUse: undefined, // resume signal after question answers / permission grants
  PostToolUseFailure: undefined,
  StopFailure: undefined,
  SessionEnd: undefined,
}

function isOurs(group: HookGroup): boolean {
  return (
    group.hooks?.some((h) => typeof h.command === 'string' && isOpenControlCommand(h.command)) ??
    false
  )
}

/**
 * Merge OpenControl Claude hook entries into settingsPath (default
 * ~/.claude/settings.json), replacing stale OpenMicro entries and preserving
 * everything else. Atomic write via tmp + rename. Never throws.
 *
 * Args:
 *     settingsPath (string | undefined): Override target path (tests). Defaults to ~/.claude/settings.json.
 *
 * Returns:
 *     HookWriteResult: 'changed' | 'unchanged' | 'failed'.
 */
export function installClaudeHooks(settingsPath?: string): HookWriteResult {
  const target = settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json')

  return updateHookFile({
    target,
    parseWarning: 'hooks-install: could not parse settings.json — leaving it untouched',
    writeWarning: 'hooks-install: failed to write settings.json',
    successMessage: 'hooks-install: Claude Code hooks registered',
    merge(settings) {
      if (!isRecord(settings.hooks)) settings.hooks = {}

      let changed = false
      for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
        const value = settings.hooks[event]
        const groups = (Array.isArray(value) ? value : []).filter(
          (g) => g && Array.isArray(g.hooks),
        )
        const foreign = groups.filter((g) => !isOurs(g))
        const desired: HookGroup = {
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: [{ type: 'command', command: hookCommand(event) }],
        }
        const existingOurs = groups.filter(isOurs)
        const upToDate =
          existingOurs.length === 1 && JSON.stringify(existingOurs[0]) === JSON.stringify(desired)
        if (!upToDate) {
          settings.hooks[event] = [...foreign, desired]
          changed = true
        }
      }
      return changed
    },
  })
}

const CODEX_HOOK_EVENTS = ['UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'] as const

function codexHookCommand(event: string): string {
  return hookCommand(event)
}

function isCodexOurs(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false
  const hooks = (group as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((hook: unknown) => {
    if (!hook || typeof hook !== 'object') return false
    const command = (hook as { command?: unknown }).command
    return (
      typeof command === 'string' &&
      (isOpenControlCommand(command) || command.includes(LEGACY_HEADER))
    )
  })
}

/**
 * Register Codex hooks. Codex trust is definition-hash based, so unchanged
 * input must produce no write at all.
 *
 * Args:
 *     hooksPath (string | undefined): Override target path (tests). Defaults to $CODEX_HOME/hooks.json.
 *
 * Returns:
 *     HookWriteResult: 'changed' | 'unchanged' | 'failed'.
 */
export function installCodexHooks(hooksPath?: string): HookWriteResult {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  const target = hooksPath ?? path.join(codexHome, 'hooks.json')

  return updateHookFile({
    target,
    parseWarning: 'hooks-install: could not parse Codex hooks.json — leaving it untouched',
    writeWarning: 'hooks-install: failed to write Codex hooks.json',
    successMessage: 'hooks-install: Codex hooks registered',
    merge(settings) {
      if (!isRecord(settings.hooks)) settings.hooks = {}
      const before = JSON.stringify(settings)

      // Purge only positively identified OpenControl/OpenMicro entries. Preserve every
      // foreign array element verbatim, including extension shapes we do not know.
      for (const [event, value] of Object.entries(settings.hooks)) {
        if (!Array.isArray(value)) continue
        const foreign = value.filter((group) => !isCodexOurs(group))
        if (foreign.length > 0) {
          settings.hooks[event] = foreign as HookGroup[]
        } else {
          delete settings.hooks[event]
        }
      }

      for (const event of CODEX_HOOK_EVENTS) {
        const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
        settings.hooks[event] = [
          ...groups,
          { hooks: [{ type: 'command', command: codexHookCommand(event) }] },
        ]
      }

      return JSON.stringify(settings) !== before
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isOpenControlCommand(command: string): boolean {
  if (command.includes(COMMAND_MARKER) || command.includes(LEGACY_COMMAND_MARKER)) return true
  return (
    command.toLowerCase().includes('opencontrol') &&
    /[\\/]cli\.(?:js|ts)["']?\s+hook\s+/.test(command)
  )
}

/** Quote an absolute executable/script path for the platform's command shell. */
function quoteShellArgument(argument: string): string {
  if (argument.includes('\0') || /[\r\n]/.test(argument)) {
    throw new Error('hook command path contains an unsafe control character')
  }
  if (process.platform === 'win32') {
    // Windows filenames cannot contain quotes. Percent and delayed-expansion
    // markers are rejected because cmd expands them even inside double quotes.
    if (/["%!]/.test(argument)) {
      throw new Error('hook command path contains a character unsafe for cmd.exe')
    }
    return `"${argument}"`
  }
  return `'${argument.replaceAll("'", "'\"'\"'")}'`
}

function isRetryableRace(error: unknown): boolean {
  return (
    error instanceof SecureFileError && (error.code === 'EEXIST' || error.code === 'ESECURERACE')
  )
}
