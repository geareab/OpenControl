import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Device } from 'node-hid'
import { fetchHostStatus, relayHookEvent } from './client.js'
import { harnessFor } from './harness/index.js'
import {
  findQmkRawHidCandidates,
  isControlId,
  nodeHidQmkBackend,
  QmkRawHidAdapter,
  terminalSequenceFromBase64,
  type AdapterCapabilities,
  type AdapterConnection,
  type ControlEvent,
  type FeedbackFrame,
  type QmkConnectedDevice,
} from './input/index.js'
import {
  DEFAULT_CONFIG,
  defaultConfigPath,
  loadConfig,
  type EnrolledDevice,
  type OpenControlConfig,
} from './layers.js'
import { createRuntimeToken, type RuntimeDescriptor } from './runtime.js'
import { atomicWritePrivateFile, readOwnedRegularFile } from './secure-files.js'
import { HostServer } from './server.js'
import type { HostStatus } from './server.js'
import { sanitizeTerminalText } from './terminal-sanitize.js'

type CheckStatus = 'pass' | 'warning' | 'not-detected' | 'error'

export interface DoctorCheckOutcome {
  performed: boolean
  skipped: boolean
  pass: boolean
  fail: boolean
}

export interface HardwareDoctorReport {
  requested: boolean
  handshake: DoctorCheckOutcome
  feedbackAcknowledgement: DoctorCheckOutcome
  pressRelease: DoctorCheckOutcome
  hotplug: DoctorCheckOutcome
  sixStateColors: DoctorCheckOutcome
  selectedPulse: DoctorCheckOutcome
  animationRestore: DoctorCheckOutcome
}

export interface OpenControlDoctorReport {
  schemaVersion: 1
  app: 'opencontrol'
  appVersion: string
  platform: string
  osVersion: string
  nodeVersion: string
  timestamp: string
  config: {
    status: CheckStatus
    schemaVersion: number | null
    terminalEnabled: boolean
    qmkEnabled: boolean
    gamepadEnabled: boolean
  }
  terminal: {
    status: CheckStatus
    configuredControls: number
    validControls: number
    duplicateSequences: number
  }
  qmk: {
    status: CheckStatus
    rawHidCandidates: number
    handshake: boolean
    viaEndpointContention: 'none' | 'possible' | 'not-applicable'
    capabilities?: AdapterCapabilities
    device?: {
      vendorId: string
      productId: string
      manufacturer?: string
      product?: string
    }
  }
  gamepad: {
    status: CheckStatus
    candidates: number
  }
  taskRouting: CheckStatus
  authenticatedHookRelay: CheckStatus
  hardware: HardwareDoctorReport
  installedHooks: {
    claude: boolean
    codex: boolean
  }
  host: {
    running: boolean
    tasks: number
    devices: number
  }
}

export interface DoctorOptions {
  configPath?: string
  config?: OpenControlConfig
  enumerateDevices?: () => Device[]
  probeQmk?: (selection: DoctorQmkSelection) => Promise<{
    connected: boolean
    capabilities?: AdapterCapabilities
    device?: QmkConnectedDevice
  }>
  hardware?: boolean
  hardwareProbe?: (selection: DoctorQmkSelection) => Promise<HardwareDoctorReport>
  hookSelfTest?: () => Promise<boolean>
  hostStatus?: () => Promise<HostStatus>
  homeDirectory?: string
  appVersion?: string
}

export interface HardwareDoctorAdapter {
  readonly connectedDevice: QmkConnectedDevice | null
  readonly capabilities: AdapterCapabilities | null
  start(): void | Promise<void>
  stop(): void | Promise<void>
  onControl(listener: (event: ControlEvent) => void): () => void
  onConnectionChange(listener: (event: AdapterConnection) => void): () => void
  updateFeedbackAndWait(frame: FeedbackFrame): Promise<void>
}

export interface HardwareDoctorPrompt {
  notify(message: string): void
  confirm(question: string): Promise<boolean>
}

export interface HardwareDoctorOptions {
  enrolledDevice?: EnrolledDevice
  /** @deprecated Used only when no enrolled device is available. */
  serialNumber?: string
  adapterFactory?: (selection: DoctorQmkSelection) => HardwareDoctorAdapter
  prompt?: HardwareDoctorPrompt
  eventTimeoutMs?: number
  heartbeatRestoreMs?: number
  wait?: (milliseconds: number) => Promise<void>
}

export interface RunDoctorOptions {
  hardware?: boolean
  reportPath?: string
  overwrite?: boolean
}

export interface DoctorQmkSelection {
  enrolledDevice?: EnrolledDevice
  /** @deprecated Used only as a compatibility fallback without enrollment. */
  serialNumber?: string
}

export async function collectOpenControlDiagnostics(
  options: DoctorOptions = {},
): Promise<OpenControlDoctorReport> {
  let config = options.config ?? DEFAULT_CONFIG
  let configFailed = false
  if (!options.config) {
    try {
      config = loadConfig(options.configPath ?? defaultConfigPath())
    } catch {
      // Diagnostics must remain useful when the config itself is broken. The
      // report records only the validation failure, never its path or content.
      configFailed = true
    }
  }
  const enumerate = options.enumerateDevices ?? nodeHidQmkBackend.devices
  let devices: Device[] = []
  let enumerationFailed = false
  try {
    devices = enumerate()
  } catch {
    enumerationFailed = true
  }

  const terminal = inspectTerminalBindings(config)
  const qmkSelection = doctorQmkSelection(config)
  const candidates = enumerationFailed
    ? []
    : findQmkRawHidCandidates(devices, qmkSelection.serialNumber)
  let qmkProbe: Awaited<ReturnType<NonNullable<DoctorOptions['probeQmk']>>> = {
    connected: false,
  }
  let qmkFailed = false
  try {
    qmkProbe = await (options.probeQmk ?? probeEnhancedQmk)(qmkSelection)
  } catch {
    qmkFailed = true
  }

  let hardware = skippedHardwareReport(options.hardware ?? false)
  if (options.hardware) {
    try {
      hardware = options.hardwareProbe
        ? await options.hardwareProbe(qmkSelection)
        : await runHardwareDoctor(qmkSelection)
    } catch {
      hardware = failedHardwareReport()
    }
  }

  let host: HostStatus | null = null
  try {
    host = await (options.hostStatus ?? fetchHostStatus)()
  } catch {
    // A standalone doctor is expected to work without a running wrapper.
  }

  const home = options.homeDirectory ?? os.homedir()
  const gamepadCandidates = devices.filter(
    (device) => device.usagePage === 0x01 && (device.usage === 0x04 || device.usage === 0x05),
  ).length
  let hookRelay: CheckStatus = 'error'
  try {
    hookRelay = (await (options.hookSelfTest ?? authenticatedHookSelfTest)()) ? 'pass' : 'error'
  } catch {
    // Keep writing the sanitized report even if the isolated relay check fails.
  }

  return {
    schemaVersion: 1,
    app: 'opencontrol',
    appVersion: options.appVersion ?? packageVersion(),
    platform: process.platform,
    osVersion: os.version() || os.release(),
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    config: {
      status: configFailed ? 'error' : 'pass',
      schemaVersion: configFailed ? null : config.schemaVersion,
      terminalEnabled: !configFailed && config.inputs.terminal.enabled,
      qmkEnabled: !configFailed && config.inputs.qmk.enabled,
      gamepadEnabled: !configFailed && config.inputs.gamepad.enabled,
    },
    terminal,
    qmk: {
      status: qmkFailed
        ? 'error'
        : qmkProbe.connected
          ? 'pass'
          : enumerationFailed
            ? 'error'
            : 'not-detected',
      rawHidCandidates: candidates.length,
      handshake: qmkProbe.connected,
      viaEndpointContention:
        candidates.length > 0 && !qmkProbe.connected
          ? 'possible'
          : candidates.length === 0
            ? 'not-applicable'
            : 'none',
      ...(qmkProbe.capabilities ? { capabilities: qmkProbe.capabilities } : {}),
      ...(qmkProbe.device ? { device: sanitizeQmkDevice(qmkProbe.device) } : {}),
    },
    gamepad: {
      status: enumerationFailed ? 'error' : gamepadCandidates > 0 ? 'pass' : 'not-detected',
      candidates: gamepadCandidates,
    },
    taskRouting: selectedTaskRoutingSelfTest() ? 'pass' : 'error',
    authenticatedHookRelay: hookRelay,
    hardware,
    installedHooks: {
      claude: fileContains(path.join(home, '.claude', 'settings.json'), 'opencontrol hook '),
      codex: fileContains(path.join(home, '.codex', 'hooks.json'), 'opencontrol hook '),
    },
    host: {
      running: host !== null,
      tasks: host ? host.tasks.slots.filter(Boolean).length + host.tasks.unassigned.length : 0,
      devices: host?.devices.length ?? 0,
    },
  }
}

export async function runOpenControlDoctor(options: RunDoctorOptions = {}): Promise<void> {
  const report = await collectOpenControlDiagnostics({ hardware: options.hardware })
  const reportPath = options.reportPath ?? path.join(process.cwd(), 'opencontrol-doctor.json')
  writeOpenControlDiagnosticReport(report, reportPath, {
    overwrite: options.overwrite,
  })

  console.log('OpenControl diagnostics')
  console.log(
    `  Terminal controls: ${report.terminal.status} (${report.terminal.validControls} valid)`,
  )
  console.log(
    `  Enhanced QMK:      ${report.qmk.status}${report.qmk.handshake ? ' (v1 handshake passed)' : ''}`,
  )
  console.log(`  Gamepad:           ${report.gamepad.status}`)
  console.log(`  Task routing:      ${report.taskRouting}`)
  console.log(`  Hook relay:        ${report.authenticatedHookRelay}`)
  console.log(`  Running host:      ${report.host.running ? 'yes' : 'no'}`)
  if (report.hardware.requested) {
    console.log(`  Hardware checks:   ${hardwareSummary(report.hardware)}`)
  }
  console.log(`\nSanitized report written to ${sanitizeTerminalText(reportPath, 240)}`)
  if (report.qmk.viaEndpointContention === 'possible') {
    console.log(
      'A QMK Raw HID interface was present but did not complete the OpenControl handshake; close VIA and retry if enhanced firmware is installed.',
    )
  }
}

/** Write a sanitized diagnostic report without following or replacing unsafe paths. */
export function writeOpenControlDiagnosticReport(
  report: OpenControlDoctorReport,
  reportPath: string,
  options: Pick<RunDoctorOptions, 'overwrite'> = {},
): void {
  atomicWritePrivateFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    overwrite: options.overwrite ?? false,
  })
}

/**
 * Guided physical acceptance checks for one enhanced QMK keyboard.
 *
 * This is deliberately separate from the default doctor path: it waits for
 * physical input, hotplug events, and human visual confirmation. The returned
 * object contains booleans only, so it is safe to include in issue reports.
 */
export async function runHardwareDoctor(
  options: HardwareDoctorOptions = {},
): Promise<HardwareDoctorReport> {
  const report = skippedHardwareReport(true)
  const selection: DoctorQmkSelection = options.enrolledDevice
    ? { enrolledDevice: options.enrolledDevice }
    : options.serialNumber
      ? { serialNumber: options.serialNumber }
      : {}
  const adapter =
    options.adapterFactory?.(selection) ??
    (new QmkRawHidAdapter(selection) as HardwareDoctorAdapter)
  const eventTimeoutMs = positiveMilliseconds(options.eventTimeoutMs, 45_000)
  const heartbeatRestoreMs = positiveMilliseconds(options.heartbeatRestoreMs, 5_500)
  const wait = options.wait ?? delay
  const consolePrompt = options.prompt ? null : createConsoleHardwarePrompt()
  const prompt = options.prompt ?? consolePrompt!.prompt
  let stopped = false

  try {
    try {
      await adapter.start()
    } catch {
      report.handshake = failedOutcome()
      return report
    }
    if (!adapter.connectedDevice) {
      report.handshake = failedOutcome()
      return report
    }
    report.handshake = passedOutcome()

    const stateFrame = sixStateFeedbackFrame()
    try {
      await adapter.updateFeedbackAndWait(stateFrame)
      report.feedbackAcknowledgement = passedOutcome()
    } catch {
      report.feedbackAcknowledgement = failedOutcome()
    }

    if (adapter.capabilities?.pressRelease) {
      const controlPair = waitForControlPair(adapter, eventTimeoutMs)
      prompt.notify(
        'Press and release one OpenControl key on the enhanced layer (waiting up to 45 seconds).',
      )
      report.pressRelease = outcomeFor(await controlPair)
    }

    const canInspectRgb =
      adapter.capabilities?.rgbFeedback === true && report.feedbackAcknowledgement.pass
    if (canInspectRgb) {
      report.sixStateColors = outcomeFor(
        await prompt.confirm(
          'Do Agent keys 1–6 show Off, White, Blue, Amber, Green, and Red respectively?',
        ),
      )
      try {
        await adapter.updateFeedbackAndWait({ ...stateFrame, selectedSlot: 2 })
        report.selectedPulse = outcomeFor(
          await prompt.confirm('Is Agent key 2 pulsing while keeping its white task-state color?'),
        )
      } catch {
        report.selectedPulse = failedOutcome()
      }
    }

    const disconnected = waitForConnectionState(adapter, false, eventTimeoutMs)
    prompt.notify('Unplug the enhanced keyboard now (waiting up to 45 seconds).')
    if (await disconnected) {
      const reconnected = waitForConnectionState(adapter, true, eventTimeoutMs)
      prompt.notify('Reconnect the same keyboard now (waiting up to 45 seconds).')
      report.hotplug = outcomeFor(await reconnected)
    } else {
      report.hotplug = failedOutcome()
    }

    if (canInspectRgb) {
      prompt.notify(
        `OpenControl will stop sending heartbeats. Wait ${Math.ceil(heartbeatRestoreMs / 1000)} seconds for the normal RGB animation to return.`,
      )
      await adapter.stop()
      stopped = true
      await wait(heartbeatRestoreMs)
      report.animationRestore = outcomeFor(
        await prompt.confirm('Did the original RGB animation return with no task overlay?'),
      )
    }
    return report
  } finally {
    if (!stopped) await adapter.stop()
    consolePrompt?.close()
  }
}

function sixStateFeedbackFrame(): FeedbackFrame {
  return {
    selectedSlot: null,
    slots: [
      { slot: 1, state: 'off', unread: false },
      { slot: 2, state: 'idle', unread: false },
      { slot: 3, state: 'executing', unread: false },
      { slot: 4, state: 'waiting', unread: false },
      { slot: 5, state: 'complete', unread: true },
      { slot: 6, state: 'error', unread: false },
    ],
  }
}

function waitForControlPair(adapter: HardwareDoctorAdapter, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let pressedControl: ControlEvent['controlId'] | null = null
    let settled = false
    let unsubscribe = (): void => undefined
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    unsubscribe = adapter.onControl((event) => {
      if (event.phase === 'press') pressedControl = event.controlId
      if (event.phase === 'release' && event.controlId === pressedControl) finish(true)
    })
  })
}

function waitForConnectionState(
  adapter: HardwareDoctorAdapter,
  connected: boolean,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = (): void => undefined
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    unsubscribe = adapter.onConnectionChange((event) => {
      if (event.connected === connected) finish(true)
    })
  })
}

function createConsoleHardwarePrompt(): {
  prompt: HardwareDoctorPrompt
  close: () => void
} {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  return {
    prompt: {
      notify: (message) => console.log(`\n${message}`),
      confirm: async (question) => {
        const answer = await readline.question(`${question} [y/N] `)
        return /^(?:y|yes)$/i.test(answer.trim())
      },
    },
    close: () => readline.close(),
  }
}

function skippedHardwareReport(requested: boolean): HardwareDoctorReport {
  return {
    requested,
    handshake: skippedOutcome(),
    feedbackAcknowledgement: skippedOutcome(),
    pressRelease: skippedOutcome(),
    hotplug: skippedOutcome(),
    sixStateColors: skippedOutcome(),
    selectedPulse: skippedOutcome(),
    animationRestore: skippedOutcome(),
  }
}

function failedHardwareReport(): HardwareDoctorReport {
  return { ...skippedHardwareReport(true), handshake: failedOutcome() }
}

function passedOutcome(): DoctorCheckOutcome {
  return { performed: true, skipped: false, pass: true, fail: false }
}

function failedOutcome(): DoctorCheckOutcome {
  return { performed: true, skipped: false, pass: false, fail: true }
}

function skippedOutcome(): DoctorCheckOutcome {
  return { performed: false, skipped: true, pass: false, fail: false }
}

function outcomeFor(value: boolean): DoctorCheckOutcome {
  return value ? passedOutcome() : failedOutcome()
}

function hardwareSummary(report: HardwareDoctorReport): string {
  const checks = [
    report.handshake,
    report.feedbackAcknowledgement,
    report.pressRelease,
    report.hotplug,
    report.sixStateColors,
    report.selectedPulse,
    report.animationRestore,
  ]
  const passed = checks.filter((result) => result.pass).length
  const failed = checks.filter((result) => result.fail).length
  const skipped = checks.filter((result) => result.skipped).length
  return `${passed} passed, ${failed} failed, ${skipped} skipped`
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function inspectTerminalBindings(config: OpenControlConfig): OpenControlDoctorReport['terminal'] {
  const entries = Object.entries(config.inputs.terminal.bindings)
  const seen = new Set<string>()
  let valid = 0
  let duplicates = 0
  for (const [controlId, encoded] of entries) {
    if (!isControlId(controlId)) continue
    try {
      const sequence = terminalSequenceFromBase64(encoded)
      if (sequence.length === 0) continue
      const hex = sequence.toString('hex')
      if (seen.has(hex)) duplicates += 1
      else {
        seen.add(hex)
        valid += 1
      }
    } catch {
      // Invalid entries are counted by the status but never copied to the report.
    }
  }
  return {
    status:
      !config.inputs.terminal.enabled || entries.length === 0
        ? 'not-detected'
        : valid === entries.length && duplicates === 0
          ? 'pass'
          : 'warning',
    configuredControls: entries.length,
    validControls: valid,
    duplicateSequences: duplicates,
  }
}

async function probeEnhancedQmk(selection: DoctorQmkSelection = {}): Promise<{
  connected: boolean
  capabilities?: AdapterCapabilities
  device?: QmkConnectedDevice
}> {
  const adapter = new QmkRawHidAdapter(selection)
  try {
    await adapter.start()
    return {
      connected: adapter.connectedDevice !== null,
      ...(adapter.capabilities ? { capabilities: adapter.capabilities } : {}),
      ...(adapter.connectedDevice ? { device: adapter.connectedDevice } : {}),
    }
  } finally {
    adapter.stop()
  }
}

function doctorQmkSelection(config: OpenControlConfig): DoctorQmkSelection {
  if (config.inputs.qmk.device) return { enrolledDevice: config.inputs.qmk.device }
  return config.inputs.qmk.serialNumber ? { serialNumber: config.inputs.qmk.serialNumber } : {}
}

function selectedTaskRoutingSelfTest(): boolean {
  const server = new HostServer(harnessFor('codex'))
  server.registerLocalWrapper({ wrapperId: 'a', kind: 'codex', cwd: '', pid: 1, slot: 1 })
  server.registerLocalWrapper({ wrapperId: 'b', kind: 'claude', cwd: '', pid: 2, slot: 2 })
  const a: string[] = []
  const b: string[] = []
  server.attachWriter('a', (bytes) => a.push(bytes))
  server.attachWriter('b', (bytes) => b.push(bytes))
  server.selectSlot(2)
  return server.sendKeysToSelected('doctor') && a.length === 0 && b[0] === 'doctor'
}

async function authenticatedHookSelfTest(): Promise<boolean> {
  const token = createRuntimeToken()
  const server = new HostServer(harnessFor('codex'), { token })
  try {
    await server.listen(0)
    server.registerLocalWrapper({
      wrapperId: 'doctor',
      kind: 'codex',
      cwd: '',
      pid: process.pid,
      slot: 1,
    })
    const descriptor: RuntimeDescriptor = {
      version: 1,
      app: 'opencontrol',
      pid: process.pid,
      port: server.boundPort,
      token,
      startedAt: new Date().toISOString(),
    }
    const delivered = await relayHookEvent('UserPromptSubmit', {
      descriptor,
      wrapperId: 'doctor',
      body: '{"session_id":"doctor"}',
    })
    return delivered && server.tasks.get('doctor')?.state === 'executing'
  } catch {
    return false
  } finally {
    await server.close()
  }
}

function sanitizeQmkDevice(
  device: QmkConnectedDevice,
): NonNullable<OpenControlDoctorReport['qmk']['device']> {
  const manufacturer = sanitizeHidDisplayText(device.manufacturer)
  const product = sanitizeHidDisplayText(device.product)
  return {
    vendorId: `0x${device.vendorId.toString(16).padStart(4, '0')}`,
    productId: `0x${device.productId.toString(16).padStart(4, '0')}`,
    ...(manufacturer ? { manufacturer } : {}),
    ...(product ? { product } : {}),
  }
}

function sanitizeHidDisplayText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const sanitized = sanitizeTerminalText(value, 80).replace(/\s+/gu, ' ').trim()
  return sanitized || undefined
}

function fileContains(file: string, needle: string): boolean {
  try {
    return readOwnedRegularFile(file)?.contents.includes(Buffer.from(needle, 'utf8')) ?? false
  } catch {
    return false
  }
}

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
