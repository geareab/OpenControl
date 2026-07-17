// Pure command-line parsing. The explicit `run` form reserves OpenControl
// options before `--`; the legacy shorthand continues to forward everything
// after the harness name unchanged.

export type InvocationCommand = 'run' | 'setup' | 'doctor' | 'status' | 'hook'

export interface ParsedInvocation {
  command: InvocationCommand
  /** Harness kind for `run`; defaults to Claude for the legacy no-arg form. */
  kind: string
  /** Arguments forwarded verbatim to the agent CLI. */
  agentArgs: string[]
  /** Requested task slot (1-6), or null for first-free assignment. */
  slot: number | null
  /** Optional human-readable task name. */
  name: string | null
  /** Lifecycle event used by the internal `hook` relay. */
  hookEvent: string | null
  help: boolean
  version: boolean
  /** Backward-compatible convenience flag used by older callers/tests. */
  doctor: boolean
}

const DEFAULT_KIND = 'claude'

function base(command: InvocationCommand = 'run'): ParsedInvocation {
  return {
    command,
    kind: DEFAULT_KIND,
    agentArgs: [],
    slot: null,
    name: null,
    hookEvent: null,
    help: false,
    version: false,
    doctor: command === 'doctor',
  }
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value === '--') throw new Error(`opencontrol: ${option} requires a value`)
  return value
}

function parseRun(args: string[]): ParsedInvocation {
  const parsed = base('run')
  let index = 0

  if (args[index] && args[index] !== '--' && !args[index]!.startsWith('-')) {
    parsed.kind = args[index]!
    index += 1
  }

  for (; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') {
      parsed.agentArgs = args.slice(index + 1)
      return parsed
    }
    if (arg === '--slot') {
      const raw = valueAfter(args, index, '--slot')
      const slot = Number(raw)
      if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
        throw new Error('opencontrol: --slot must be an integer from 1 to 6')
      }
      parsed.slot = slot
      index += 1
      continue
    }
    if (arg === '--name') {
      parsed.name = valueAfter(args, index, '--name')
      index += 1
      continue
    }
    throw new Error(
      `opencontrol: unknown run option '${arg}'; put agent arguments after a standalone --`,
    )
  }
  return parsed
}

function parseDoctor(args: string[]): ParsedInvocation {
  const allowed = new Set(['--hardware', '--gamepad', '--overwrite'])
  for (const arg of args) {
    if (!allowed.has(arg)) throw new Error(`opencontrol: unknown doctor option '${arg}'`)
  }
  if (args.includes('--hardware') && args.includes('--gamepad')) {
    throw new Error('opencontrol: --hardware and --gamepad cannot be used together')
  }
  return { ...base('doctor'), agentArgs: args }
}

export function parseInvocation(args: string[]): ParsedInvocation {
  if (args[0] === '--help' || args[0] === '-h') return { ...base(), help: true }
  if (args[0] === '--version' || args[0] === '-V' || args[0] === '-v') {
    return { ...base(), version: true }
  }

  switch (args[0]) {
    case 'setup':
      return base('setup')
    case 'doctor':
      return parseDoctor(args.slice(1))
    case 'status':
      return base('status')
    case 'hook': {
      const event = args[1]
      if (!event) throw new Error('opencontrol: hook requires an event name')
      return { ...base('hook'), hookEvent: event }
    }
    case 'run':
      return parseRun(args.slice(1))
    default:
      break
  }

  // Compatibility surface: `opencontrol codex --foo`, `openmicro claude`,
  // and the historical no-argument/leading-flag Claude invocation.
  const parsed = base('run')
  if (args.length > 0 && args[0] && !args[0].startsWith('-')) {
    parsed.kind = args[0]
    parsed.agentArgs = args.slice(1)
  } else {
    parsed.agentArgs = args
  }
  return parsed
}

export const USAGE = `opencontrol — tactile task controls for Codex CLI and Claude Code.

Usage:
  opencontrol run <claude|codex> [--slot 1-6] [--name NAME] -- [...agent args]
  opencontrol [claude|codex] [...agent args]   Compatibility shorthand
  opencontrol setup                            Configure a QMK/VIA keyboard
  opencontrol doctor [--overwrite]             Diagnose inputs, hooks, and feedback
  opencontrol doctor --hardware [--overwrite]  Run guided enhanced-keyboard checks
  opencontrol doctor --gamepad [--overwrite]   Run legacy interactive gamepad capture
  opencontrol status                           Show task slots and connected inputs
  opencontrol --version                        Show the OpenControl version
  opencontrol --help                           Show this message

The first wrapped agent becomes the local host. Later wrappers register as
tasks, while ordinary terminal typing always stays in its local session.`
