import type { ReadStream, WriteStream } from 'node:tty'
import { createInterface } from 'node:readline/promises'
import { devices as enumerateHidDevices } from 'node-hid'
import { VIA_CONTROL_BINDINGS } from './control-map.js'
import { findGamepadCandidates, type GamepadCandidate } from './controller/hid-manager.js'
import { QmkRawHidAdapter } from './input/qmk-raw-hid-adapter.js'
import { terminalSequenceToBase64 } from './input/terminal-sequence-decoder.js'
import {
  defaultConfigPath,
  loadConfig,
  safeDeviceLabel,
  saveConfig,
  type EnrolledDevice,
} from './layers.js'
import { sanitizeTerminalText } from './terminal-sanitize.js'

const CAPTURE_QUIET_MS = 60

export interface EnhancedKeyboard extends EnrolledDevice {
  serialNumber?: string
  product?: string
}

export interface SetupOptions {
  input?: ReadStream
  output?: WriteStream
  configPath?: string
  detectEnhanced?: () => Promise<EnhancedKeyboard | readonly EnhancedKeyboard[] | null>
  selectEnhanced?: (keyboards: readonly EnhancedKeyboard[]) => Promise<EnhancedKeyboard>
  confirmEnhanced?: (keyboard: EnhancedKeyboard) => Promise<boolean>
  chooseMode?: () => Promise<'via' | 'gamepad'>
  detectGamepads?: () => Promise<readonly GamepadCandidate[]>
  selectGamepad?: (gamepads: readonly GamepadCandidate[]) => Promise<GamepadCandidate>
  confirmGamepad?: (gamepad: GamepadCandidate) => Promise<boolean>
  confirmGenericGamepad?: (gamepad: GamepadCandidate) => Promise<boolean>
  capture?: (label: string, keycode: string) => Promise<Buffer | null>
}

/** Capability-based detection: a Raw HID interface only counts after the v1 handshake. */
export async function detectEnhancedKeyboard(): Promise<
  EnhancedKeyboard | readonly EnhancedKeyboard[] | null
> {
  const adapter = new QmkRawHidAdapter()
  try {
    await adapter.start()
    const devices = adapter.compatibleDevices.map((device) => ({
      fingerprint: device.fingerprint,
      vendorId: device.vendorId,
      productId: device.productId,
      transport: device.transport,
      label: device.label,
      generic: false,
      ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
      ...(device.product ? { product: device.product } : {}),
    }))
    if (devices.length === 0) return null
    return devices.length === 1 ? devices[0]! : devices
  } finally {
    adapter.stop()
  }
}

export async function detectGamepads(): Promise<readonly GamepadCandidate[]> {
  return findGamepadCandidates(enumerateHidDevices())
}

export function viaSetupGuide(): string {
  const rows = VIA_CONTROL_BINDINGS.map(
    ({ label, viaKeycode }) => `  ${label.padEnd(18)} ${viaKeycode}`,
  )
  return [
    'In VIA, create a dedicated OpenControl layer and assign these standard keycodes:',
    '',
    ...rows,
    '',
    'Keep this terminal focused while capturing. Ordinary keys will remain local when OpenControl runs.',
  ].join('\n')
}

/**
 * Capture one terminal key sequence without interpreting it as UTF-8. The
 * first burst ends after a short quiet period, which preserves multi-byte CSI
 * sequences while keeping setup responsive.
 */
export function captureTerminalSequence(
  input: ReadStream,
  output: WriteStream,
  label: string,
  keycode: string,
  quietMs = CAPTURE_QUIET_MS,
): Promise<Buffer | null> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Terminal sequence capture requires an interactive TTY'))
  }

  output.write(`\n${label} (${keycode}) — press it once, or Enter to skip: `)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const wasRaw = input.isRaw

    const finish = (value: Buffer | null, error?: Error): void => {
      if (timer) clearTimeout(timer)
      input.off('data', onData)
      input.setRawMode(Boolean(wasRaw))
      output.write(value ? `${value.toString('hex')}\n` : 'skipped\n')
      if (error) reject(error)
      else resolve(value)
    }
    const settle = (): void => {
      const value = Buffer.concat(chunks)
      if (value.length === 1 && (value[0] === 0x0d || value[0] === 0x0a)) finish(null)
      else finish(value)
    }
    const onData = (data: Buffer | string): void => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (chunks.length === 0 && bytes.includes(0x03)) {
        finish(null, new Error('Setup cancelled'))
        return
      }
      chunks.push(bytes)
      if (timer) clearTimeout(timer)
      timer = setTimeout(settle, quietMs)
    }

    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

/** Run capability detection, then configure enhanced QMK or stock VIA mode. */
export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const input = options.input ?? (process.stdin as ReadStream)
  const output = options.output ?? (process.stdout as WriteStream)
  const configPath = options.configPath ?? defaultConfigPath()
  const config = loadConfig(configPath)
  const detected = await (options.detectEnhanced ?? detectEnhancedKeyboard)()
  const enhanced = isEnhancedList(detected)
    ? await (
        options.selectEnhanced ?? ((keyboards) => selectEnhancedKeyboard(input, output, keyboards))
      )(detected)
    : detected

  if (enhanced) {
    const confirmed = await (
      options.confirmEnhanced ??
      ((keyboard) =>
        confirmEnrollment(
          input,
          output,
          keyboard.label,
          'QMK keyboard',
          qmkSelectionHint(keyboard),
        ))
    )(enhanced)
    if (!confirmed) throw new Error('QMK keyboard enrollment was not confirmed')
    config.inputs.qmk.enabled = true
    config.inputs.qmk.device = enrollmentOnly(enhanced)
    delete config.inputs.qmk.serialNumber
    config.hardwareEnrollmentRequired = false
    saveConfig(config, configPath)
    output.write(
      `Enhanced OpenControl QMK firmware enrolled (${sanitizeTerminalText(enhanced.label, 80)}).\n` +
        `Raw HID input and task feedback are enabled in ${sanitizeTerminalText(configPath, 240)}.\n`,
    )
    return
  }

  output.write('No enhanced OpenControl QMK handshake was detected.\n\n')
  const mode = await (
    options.chooseMode ??
    (options.capture ? async () => 'via' as const : () => chooseFallbackMode(input, output))
  )()
  if (mode === 'gamepad') {
    const gamepads = await (options.detectGamepads ?? detectGamepads)()
    if (gamepads.length === 0) {
      throw new Error('No compatible gamepad was detected; connect one and rerun setup')
    }
    const fingerprints = new Set<string>()
    for (const candidate of gamepads) {
      if (fingerprints.has(candidate.device.fingerprint)) {
        throw new Error(
          'Multiple serial-less gamepads have the same identity; disconnect all but one and rerun setup',
        )
      }
      fingerprints.add(candidate.device.fingerprint)
    }
    const gamepad =
      gamepads.length === 1
        ? gamepads[0]!
        : await (
            options.selectGamepad ?? ((candidates) => selectGamepad(input, output, candidates))
          )(gamepads)
    const confirmed = await (
      options.confirmGamepad ??
      ((candidate) =>
        confirmEnrollment(
          input,
          output,
          candidate.device.label,
          'gamepad',
          candidate.selectionHint,
        ))
    )(gamepad)
    if (!confirmed) throw new Error('Gamepad enrollment was not confirmed')
    if (gamepad.device.generic) {
      const genericConfirmed = await (
        options.confirmGenericGamepad ??
        ((candidate) => confirmGenericEnrollment(input, output, candidate))
      )(gamepad)
      if (!genericConfirmed) throw new Error('Generic HID gamepad opt-in was not confirmed')
    }
    config.inputs.gamepad.enabled = true
    config.inputs.gamepad.device = enrollmentOnly(gamepad.device)
    config.hardwareEnrollmentRequired = false
    saveConfig(config, configPath)
    output.write(
      `${sanitizeTerminalText(gamepad.device.label, 80)} is enrolled in ${sanitizeTerminalText(configPath, 240)}. Run opencontrol doctor --gamepad for an interactive hardware check.\n`,
    )
    return
  }
  output.write(`${viaSetupGuide()}\n`)
  const capture =
    options.capture ??
    ((label: string, keycode: string) => captureTerminalSequence(input, output, label, keycode))
  const captured: Record<string, string> = {}
  const seen = new Map<string, string>()

  for (const binding of VIA_CONTROL_BINDINGS) {
    for (;;) {
      const sequence = await capture(binding.label, binding.viaKeycode)
      if (!sequence) break
      const hex = sequence.toString('hex')
      const duplicate = seen.get(hex)
      if (duplicate) {
        output.write(
          `That sequence is already assigned to ${duplicate}; configure a distinct VIA keycode and try again.\n`,
        )
        continue
      }
      seen.set(hex, binding.label)
      captured[binding.controlId] = terminalSequenceToBase64(sequence)
      break
    }
  }

  config.inputs.terminal.enabled = true
  config.inputs.terminal.bindings = captured
  saveConfig(config, configPath)
  output.write(
    `\nSaved ${Object.keys(captured).length} terminal controls to ${sanitizeTerminalText(configPath, 240)}.\n`,
  )
  if (Object.keys(captured).length === 0) {
    output.write('Hardware input remains disabled until a device is explicitly enrolled.\n')
  }
}

async function chooseFallbackMode(
  input: ReadStream,
  output: WriteStream,
): Promise<'via' | 'gamepad'> {
  if (!input.isTTY) return 'via'
  const rl = createInterface({ input, output })
  try {
    const answer = (await rl.question('Configure [V]IA terminal controls or [G]amepad only? [V]: '))
      .trim()
      .toLowerCase()
    return answer === 'g' || answer === 'gamepad' ? 'gamepad' : 'via'
  } finally {
    rl.close()
  }
}

function isEnhancedList(
  value: EnhancedKeyboard | readonly EnhancedKeyboard[] | null,
): value is readonly EnhancedKeyboard[] {
  return Array.isArray(value)
}

async function selectEnhancedKeyboard(
  input: ReadStream,
  output: WriteStream,
  keyboards: readonly EnhancedKeyboard[],
): Promise<EnhancedKeyboard> {
  if (keyboards.some((keyboard) => !keyboard.serialNumber)) {
    throw new Error(
      'Multiple enhanced QMK keyboards are connected but at least one has no serial number; disconnect all but one and rerun setup',
    )
  }
  const serialNumbers = keyboards.map((keyboard) => keyboard.serialNumber!)
  if (new Set(serialNumbers).size !== serialNumbers.length) {
    throw new Error(
      'Multiple enhanced QMK keyboards are connected with duplicate serial numbers; disconnect all but one and rerun setup',
    )
  }
  if (!input.isTTY) {
    throw new Error(
      'Multiple enhanced QMK keyboards are connected; rerun setup interactively to select a serial number',
    )
  }
  output.write('\nMultiple enhanced QMK keyboards were detected:\n')
  keyboards.forEach((keyboard, index) => {
    output.write(
      `  ${index + 1}. ${sanitizeTerminalText(keyboard.label, 80)} (${sanitizeTerminalText(keyboard.serialNumber ?? '', 80)})\n`,
    )
  })
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`Select keyboard [1-${keyboards.length}]: `)
    const index = Number(answer) - 1
    const keyboard = keyboards[index]
    if (!keyboard) throw new Error('Invalid enhanced keyboard selection')
    return keyboard
  } finally {
    rl.close()
  }
}

async function selectGamepad(
  input: ReadStream,
  output: WriteStream,
  gamepads: readonly GamepadCandidate[],
): Promise<GamepadCandidate> {
  if (!input.isTTY) {
    throw new Error('Multiple gamepads are connected; rerun setup interactively to select one')
  }
  output.write('\nMultiple gamepads were detected:\n')
  gamepads.forEach((candidate, index) => {
    output.write(
      `  ${index + 1}. ${describeGamepadForSetup(candidate)}${candidate.device.generic ? ' (generic HID)' : ''}\n`,
    )
  })
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`Select gamepad [1-${gamepads.length}]: `)
    const selected = gamepads[Number(answer) - 1]
    if (!selected) throw new Error('Invalid gamepad selection')
    return selected
  } finally {
    rl.close()
  }
}

async function confirmEnrollment(
  input: ReadStream,
  output: WriteStream,
  label: string,
  kind: string,
  selectionHint: string,
): Promise<boolean> {
  if (!input.isTTY) {
    throw new Error(`Enrolling a ${kind} requires an interactive terminal`)
  }
  const rl = createInterface({ input, output })
  try {
    const answer = (
      await rl.question(
        `Enroll ${sanitizeTerminalText(label, 80)} (${sanitizeTerminalText(selectionHint, 100)}) for OpenControl input? [y/N]: `,
      )
    )
      .trim()
      .toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function confirmGenericEnrollment(
  input: ReadStream,
  output: WriteStream,
  gamepad: GamepadCandidate,
): Promise<boolean> {
  if (!input.isTTY) {
    throw new Error('Generic HID enrollment requires an interactive terminal')
  }
  const rl = createInterface({ input, output })
  try {
    output.write(
      'This device uses the generic HID parser. Its button mapping is unverified and may trigger unexpected actions.\n',
    )
    const answer = (
      await rl.question(
        `Explicitly allow generic device ${describeGamepadForSetup(gamepad)}? [y/N]: `,
      )
    )
      .trim()
      .toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export function describeGamepadForSetup(gamepad: GamepadCandidate): string {
  return `${sanitizeTerminalText(gamepad.device.label, 80)} (${sanitizeTerminalText(gamepad.selectionHint, 100)})`
}

function qmkSelectionHint(keyboard: EnhancedKeyboard): string {
  const serial = safeDeviceLabel(keyboard.serialNumber, '')
  return serial ? `serial ${serial}` : `id ${keyboard.fingerprint.slice(0, 12)}`
}

function enrollmentOnly(device: EnrolledDevice): EnrolledDevice {
  return {
    fingerprint: device.fingerprint,
    vendorId: device.vendorId,
    productId: device.productId,
    transport: device.transport,
    label: safeDeviceLabel(device.label),
    generic: device.generic,
  }
}
