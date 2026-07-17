// Versioned user config. OpenControl keeps OpenMicro's six gamepad layers and
// workflows while adding semantic keyboard bindings and device preferences.
// A missing config is seeded atomically; a legacy ~/.openmicro/config.json is
// imported once without modifying the original file.

import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { RGB } from './feedback.js'
import type { Action } from './harness/types.js'
import {
  appDataDirectory,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readOwnedRegularFile,
} from './secure-files.js'
import { sanitizeTerminalText } from './terminal-sanitize.js'
import type { ButtonId } from './types.js'

export type StickControlId =
  | 'lstick_up'
  | 'lstick_down'
  | 'lstick_left'
  | 'lstick_right'
  | 'lstick_cw'
  | 'lstick_ccw'
  | 'rstick_up'
  | 'rstick_down'
  | 'rstick_left'
  | 'rstick_right'
  | 'rstick_cw'
  | 'rstick_ccw'

export type ControlId = ButtonId | StickControlId

export interface Layer {
  name: string
  color: RGB
  bindings: Partial<Record<ControlId, Action>>
}

export interface TerminalInputConfig {
  enabled: boolean
  /** semantic control id -> exact terminal sequence, base64 encoded */
  bindings: Record<string, string>
  escapeTimeoutMs: number
}

export type EnrolledDeviceTransport = 'usb' | 'bluetooth' | 'unknown'

/**
 * Stable, non-path hardware identity persisted by setup.
 *
 * The fingerprint is an identifier, not a cryptographic authentication
 * credential. Device paths are intentionally never stored because they may
 * contain user-specific information and are not stable across reconnects.
 */
export interface EnrolledDevice {
  fingerprint: string
  vendorId: number
  productId: number
  transport: EnrolledDeviceTransport
  label: string
  generic: boolean
}

export interface OpenControlConfig {
  schemaVersion: 2
  /** Set by a v1 migration until setup explicitly enrolls new hardware. */
  hardwareEnrollmentRequired: boolean
  inputs: {
    terminal: TerminalInputConfig
    qmk: {
      enabled: boolean
      device?: EnrolledDevice
      /** @deprecated Accepted temporarily for diagnostic compatibility only. */
      serialNumber?: string
    }
    gamepad: { enabled: boolean; device?: EnrolledDevice }
  }
  /** Semantic command/navigation/dial controls; Agent keys are always task slots. */
  controls: Record<string, Action>
  /** Exactly 6 layers, index = layer number (0-5). */
  layers: [Layer, Layer, Layer, Layer, Layer, Layer]
  /** presetId -> prompt template text, referenced by `{ type: 'workflow', presetId }` bindings. */
  workflows: Record<string, string>
}

/** @deprecated Kept for the OpenMicro compatibility release. */
export type OpenMicroConfig = OpenControlConfig

const CONTROL_IDS: readonly ControlId[] = [
  'south',
  'east',
  'west',
  'north',
  'dpad_up',
  'dpad_down',
  'dpad_left',
  'dpad_right',
  'l1',
  'r1',
  'l2',
  'r2',
  'l3',
  'r3',
  'menu',
  'view',
  'touchpad',
  'lstick_up',
  'lstick_down',
  'lstick_left',
  'lstick_right',
  'lstick_cw',
  'lstick_ccw',
  'rstick_up',
  'rstick_down',
  'rstick_left',
  'rstick_right',
  'rstick_cw',
  'rstick_ccw',
]
const CONTROL_ID_SET: ReadonlySet<string> = new Set(CONTROL_IDS)

const rgbSchema = z.object({ r: z.number(), g: z.number(), b: z.number() })

// Mirrors src/harness/types.ts `Action` exactly. Kept in sync by hand — the
// harness contract is the source of truth and rarely changes.
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accept') }),
  z.object({ type: z.literal('reject') }),
  z.object({ type: z.literal('push_to_talk') }),
  z.object({ type: z.literal('new_chat') }),
  z.object({ type: z.literal('thinking_depth'), delta: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({
    type: z.literal('agent_command'),
    command: z.enum([
      'fast',
      'approve',
      'decline',
      'fork',
      'mic',
      'send',
      'plan',
      'skills',
      'model_picker',
    ]),
  }),
  z.object({ type: z.literal('focus_relative'), delta: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ type: z.literal('workflow'), presetId: z.string() }),
  z.object({ type: z.literal('prompt'), text: z.string() }),
  z.object({ type: z.literal('focus_session'), index: z.number() }),
  z.object({ type: z.literal('layer'), index: z.number() }),
  z.object({ type: z.literal('keys'), bytes: z.string() }),
])

// z.record with an enum key schema requires every enum key present (not what
// we want for a Partial<Record<...>>), so validate keys loosely + a refine.
const bindingsSchema = z
  .record(z.string(), actionSchema)
  .refine((bindings) => Object.keys(bindings).every((key) => CONTROL_ID_SET.has(key)), {
    message: `binding keys must be one of: ${CONTROL_IDS.join(', ')}`,
  })

const layerSchema = z.object({
  name: z.string(),
  color: rgbSchema,
  bindings: bindingsSchema,
})

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)
const enrolledDeviceSchema = z.object({
  fingerprint: fingerprintSchema,
  vendorId: z.number().int().min(0).max(0xffff),
  productId: z.number().int().min(0).max(0xffff),
  transport: z.enum(['usb', 'bluetooth', 'unknown']),
  label: z
    .string()
    .min(1)
    .max(80)
    .refine((label) => label === safeDeviceLabel(label), {
      message: 'device label must not contain terminal control sequences',
    }),
  generic: z.boolean(),
})

const terminalInputSchema = z.object({
  enabled: z.boolean(),
  bindings: z.record(z.string(), z.string()),
  escapeTimeoutMs: z.number().int().min(1).max(1000),
})

const configSchema = z
  .object({
    schemaVersion: z.literal(2),
    hardwareEnrollmentRequired: z.boolean(),
    inputs: z.object({
      terminal: terminalInputSchema,
      qmk: z.object({
        enabled: z.boolean(),
        device: enrolledDeviceSchema.optional(),
        serialNumber: z.string().optional(),
      }),
      gamepad: z.object({ enabled: z.boolean(), device: enrolledDeviceSchema.optional() }),
    }),
    controls: z.record(z.string(), actionSchema),
    layers: z.array(layerSchema).length(6),
    workflows: z.record(z.string(), z.string()),
  })
  .superRefine((config, context) => {
    if (config.inputs.qmk.enabled && !config.inputs.qmk.device) {
      context.addIssue({
        code: 'custom',
        path: ['inputs', 'qmk', 'device'],
        message: 'an enabled QMK input requires an enrolled device',
      })
    }
    if (config.inputs.gamepad.enabled && !config.inputs.gamepad.device) {
      context.addIssue({
        code: 'custom',
        path: ['inputs', 'gamepad', 'device'],
        message: 'an enabled gamepad input requires an enrolled device',
      })
    }
  })

const versionOneConfigSchema = z.object({
  schemaVersion: z.literal(1),
  inputs: z.object({
    terminal: terminalInputSchema,
    qmk: z.object({ enabled: z.boolean(), serialNumber: z.string().optional() }),
    gamepad: z.object({ enabled: z.boolean() }),
  }),
  controls: z.record(z.string(), actionSchema),
  layers: z.array(layerSchema).length(6),
  workflows: z.record(z.string(), z.string()),
})

const legacyConfigSchema = z
  .object({
    layers: z.array(layerSchema).length(6),
    workflows: z.record(z.string(), z.string()),
  })
  .strict()

// touchpad cycles focus across occupied session slots. `focus_session` is a
// core-handled action (never reaches a Harness); index -1 is a sentinel this
// binding uses to mean "cycle to the next session" rather than "jump to slot N".
const TOUCHPAD_CYCLE: Action = { type: 'focus_session', index: -1 }

const LAYER_COLORS: RGB[] = [
  { r: 255, g: 255, b: 255 }, // Layer 1 (default) — white
  { r: 160, g: 32, b: 240 }, // Layer 2 — purple
  { r: 0, g: 255, b: 255 }, // Layer 3 — cyan
  { r: 255, g: 140, b: 0 }, // Layer 4 — orange
  { r: 255, g: 20, b: 147 }, // Layer 5 — pink
  { r: 255, g: 255, b: 0 }, // Layer 6 — yellow
]

function blankLayer(index: number): Layer {
  return { name: `Layer ${index + 1}`, color: LAYER_COLORS[index]!, bindings: {} }
}

const DEFAULT_SEMANTIC_CONTROLS: Record<string, Action> = {
  'command.fast': { type: 'agent_command', command: 'fast' },
  'command.approve': { type: 'agent_command', command: 'approve' },
  'command.decline': { type: 'agent_command', command: 'decline' },
  'command.fork': { type: 'agent_command', command: 'fork' },
  'command.mic': { type: 'agent_command', command: 'mic' },
  'command.send': { type: 'agent_command', command: 'send' },
  'nav.up': { type: 'agent_command', command: 'plan' },
  'nav.right': { type: 'focus_relative', delta: 1 },
  'nav.down': { type: 'agent_command', command: 'skills' },
  'nav.left': { type: 'focus_relative', delta: -1 },
  'dial.ccw': { type: 'thinking_depth', delta: -1 },
  'dial.cw': { type: 'thinking_depth', delta: 1 },
  'dial.press': { type: 'agent_command', command: 'model_picker' },
}

export const DEFAULT_CONFIG: OpenControlConfig = {
  schemaVersion: 2,
  hardwareEnrollmentRequired: false,
  inputs: {
    terminal: { enabled: true, bindings: {}, escapeTimeoutMs: 25 },
    qmk: { enabled: false },
    gamepad: { enabled: false },
  },
  controls: DEFAULT_SEMANTIC_CONTROLS,
  layers: [
    {
      name: 'Layer 1',
      color: LAYER_COLORS[0]!,
      bindings: {
        south: { type: 'accept' },
        east: { type: 'reject' },
        north: { type: 'push_to_talk' },
        west: { type: 'new_chat' },
        dpad_up: { type: 'keys', bytes: '\x1b[A' },
        dpad_down: { type: 'keys', bytes: '\x1b[B' },
        dpad_right: { type: 'keys', bytes: '\x1b[C' },
        dpad_left: { type: 'keys', bytes: '\x1b[D' },
        lstick_up: { type: 'workflow', presetId: 'review-pr' },
        lstick_down: { type: 'workflow', presetId: 'debug' },
        lstick_left: { type: 'workflow', presetId: 'refactor' },
        lstick_right: { type: 'workflow', presetId: 'write-tests' },
        rstick_cw: { type: 'thinking_depth', delta: 1 },
        rstick_ccw: { type: 'thinking_depth', delta: -1 },
        touchpad: TOUCHPAD_CYCLE,
      },
    },
    blankLayer(1),
    blankLayer(2),
    blankLayer(3),
    blankLayer(4),
    blankLayer(5),
  ],
  workflows: {
    'review-pr':
      'Review this PR for correctness, security, and style issues. Cite file paths and line numbers, and call out anything you are unsure about.',
    debug:
      'Help me debug the current issue. Start by asking what is failing and what you have already tried, then investigate the root cause before proposing a fix.',
    refactor:
      'Refactor the current code for clarity and simplicity without changing its behavior. Explain each change and keep the diff minimal.',
    'write-tests':
      'Write tests for the current code, covering the happy path plus the edge cases most likely to break in production.',
  },
}

/**
 * Derive the enrollment fingerprint from stable identity fields only.
 * Omitting paths deliberately makes serial-less identical devices ambiguous.
 */
export function createDeviceFingerprint(identity: {
  vendorId: number
  productId: number
  transport: EnrolledDeviceTransport
  serialNumber?: string
}): string {
  const serial = identity.serialNumber?.normalize('NFKC').trim() ?? ''
  const canonical = [
    'opencontrol-device-v1',
    identity.transport,
    identity.vendorId.toString(16).padStart(4, '0'),
    identity.productId.toString(16).padStart(4, '0'),
    serial,
  ].join('\0')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** Strip terminal control characters and bound untrusted HID display text. */
export function safeDeviceLabel(value: string | undefined, fallback = 'Unknown device'): string {
  const printable = sanitizeTerminalText(value ?? '', 80)
    .replace(/\s+/g, ' ')
    .trim()
  return sanitizeTerminalText(printable || fallback, 80)
}

export function defaultConfigPath(): string {
  return path.join(appDataDirectory(), 'config.json')
}

export function legacyConfigPath(): string {
  return path.join(os.homedir(), '.openmicro', 'config.json')
}

/**
 * Atomically write a config to disk (tmp file + rename, same pattern as hooks-install.ts).
 *
 * Args:
 *     config (OpenControlConfig): Config to persist.
 *     configPath (string): Target path. Defaults to ~/.opencontrol/config.json.
 *
 * Returns:
 *     None.
 */
export function saveConfig(
  config: OpenControlConfig,
  configPath: string = defaultConfigPath(),
): void {
  const directory = path.dirname(configPath)
  ensurePrivateDirectory(directory)
  atomicWritePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    overwrite: true,
  })
}

/**
 * Load the config, seeding a fresh DEFAULT_CONFIG file when none exists.
 *
 * Args:
 *     configPath (string): Target path. Defaults to ~/.opencontrol/config.json.
 *
 * Returns:
 *     OpenControlConfig: The loaded (or freshly-seeded default) config.
 *
 * Throws:
 *     Error: The file exists but is not valid JSON or fails schema validation. The file is left untouched.
 */
function migrateVersionOne(value: z.infer<typeof versionOneConfigSchema>): OpenControlConfig {
  return {
    schemaVersion: 2,
    hardwareEnrollmentRequired: true,
    inputs: {
      terminal: {
        ...value.inputs.terminal,
        bindings: { ...value.inputs.terminal.bindings },
      },
      qmk: { enabled: false },
      gamepad: { enabled: false },
    },
    controls: { ...value.controls },
    layers: value.layers as OpenControlConfig['layers'],
    workflows: value.workflows,
  }
}

function migrateLegacy(value: z.infer<typeof legacyConfigSchema>): OpenControlConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    hardwareEnrollmentRequired: true,
    layers: value.layers as OpenControlConfig['layers'],
    workflows: value.workflows,
  }
}

interface ValidatedConfig {
  config: OpenControlConfig
  migrated: boolean
}

function readAndValidate(raw: string, source: string): ValidatedConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`opencontrol: config at ${source} is not valid JSON: ${(err as Error).message}`)
  }

  const current = configSchema.safeParse(parsed)
  if (current.success) return { config: current.data as OpenControlConfig, migrated: false }

  const versionOne = versionOneConfigSchema.safeParse(parsed)
  if (versionOne.success) return { config: migrateVersionOne(versionOne.data), migrated: true }

  const legacy = legacyConfigSchema.safeParse(parsed)
  if (legacy.success) return { config: migrateLegacy(legacy.data), migrated: true }

  const issues = current.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  throw new Error(`opencontrol: invalid config at ${source}:\n${issues.join('\n')}`)
}

export function loadConfig(configPath: string = defaultConfigPath()): OpenControlConfig {
  const stored = readOwnedRegularFile(configPath)
  if (stored) {
    const validated = readAndValidate(stored.contents.toString('utf8'), configPath)
    if (validated.migrated) saveConfig(validated.config, configPath)
    return validated.config
  }

  if (configPath === defaultConfigPath()) {
    const legacyPath = legacyConfigPath()
    const legacyStored = readOwnedRegularFile(legacyPath)
    if (legacyStored) {
      const legacy = readAndValidate(legacyStored.contents.toString('utf8'), legacyPath).config
      saveConfig(legacy, configPath)
      return legacy
    }
  }
  const seeded = structuredClone(DEFAULT_CONFIG)
  saveConfig(seeded, configPath)
  return seeded
}
