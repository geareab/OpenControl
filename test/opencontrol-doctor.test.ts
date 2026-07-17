import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdapterConnection, ControlEvent, FeedbackFrame } from '../src/input/types.js'
import { DEFAULT_CONFIG, type OpenControlConfig } from '../src/layers.js'
import {
  collectOpenControlDiagnostics,
  runHardwareDoctor,
  type DoctorQmkSelection,
  type HardwareDoctorAdapter,
} from '../src/opencontrol-doctor.js'

const temporaryDirectories: string[] = []
const ENROLLED_QMK = {
  fingerprint: 'a'.repeat(64),
  vendorId: 0x1234,
  productId: 0xabcd,
  transport: 'usb' as const,
  label: 'Test Keyboard',
  generic: false,
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function config(): OpenControlConfig {
  return {
    ...DEFAULT_CONFIG,
    inputs: {
      terminal: {
        enabled: true,
        escapeTimeoutMs: 25,
        bindings: { 'agent.1': 'G1syNX4=' },
      },
      qmk: {
        enabled: true,
        device: ENROLLED_QMK,
        serialNumber: 'deprecated-secret-serial',
      },
      gamepad: { enabled: true },
    },
    controls: { ...DEFAULT_CONFIG.controls },
  }
}

describe('OpenControl doctor report', () => {
  it('reports terminal, QMK, routing, hooks, and host without leaking sensitive fields', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-doctor-'))
    temporaryDirectories.push(home)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      '{"hooks":{"Stop":[{"hooks":[{"command":"opencontrol hook Stop"}]}]}}',
    )
    const report = await collectOpenControlDiagnostics({
      config: config(),
      homeDirectory: home,
      appVersion: 'test',
      enumerateDevices: () => [
        {
          path: '/secret/device/path',
          vendorId: 0x1234,
          productId: 0xabcd,
          release: 1,
          interface: 1,
          usagePage: 0xff60,
          usage: 0x61,
          serialNumber: 'secret-serial',
        },
      ],
      probeQmk: async () => ({
        connected: true,
        capabilities: {
          protocolVersion: { major: 1, minor: 0 },
          transport: 'usb',
          pressRelease: true,
          repeat: true,
          encoder: true,
          rgbFeedback: true,
          ledFeedback: false,
          taskSlots: 6,
        },
        device: {
          deviceId: 'secret-device-id',
          vendorId: 0x1234,
          productId: 0xabcd,
          serialNumber: 'secret-serial',
          manufacturer: 'Maker\u001b]0;owned\u0007',
          product: '\u001b]2;owned\u0007Test\n\u001b[31m Keyboard',
        },
      }),
      hookSelfTest: async () => true,
      hostStatus: async () => ({
        app: 'opencontrol',
        version: 1,
        pid: 1,
        port: 2,
        tasks: { slots: Array(6).fill(null), unassigned: [], selectedSlot: null },
        devices: [],
      }),
    })

    expect(report.terminal).toMatchObject({ status: 'pass', validControls: 1 })
    expect(report.qmk).toMatchObject({ status: 'pass', handshake: true })
    expect(report.hardware.requested).toBe(false)
    expect(report.hardware.handshake).toEqual({
      performed: false,
      skipped: true,
      pass: false,
      fail: false,
    })
    expect(report.taskRouting).toBe('pass')
    expect(report.authenticatedHookRelay).toBe('pass')
    expect(report.installedHooks.claude).toBe(true)
    expect(report.host.running).toBe(true)
    expect(report.qmk.device).toMatchObject({
      manufacturer: 'Maker',
      product: 'Test Keyboard',
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('/secret/device/path')
    expect(serialized).not.toContain('secret-serial')
    expect(serialized).not.toContain('secret-device-id')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('owned')
    expect(serialized).not.toContain('31m')
  })

  it('passes enrolled identity to the enhanced QMK probe instead of the legacy serial', async () => {
    let selected: DoctorQmkSelection | undefined
    await collectOpenControlDiagnostics({
      config: config(),
      enumerateDevices: () => [],
      probeQmk: async (selection) => {
        selected = selection
        return { connected: false }
      },
      hookSelfTest: async () => true,
      hostStatus: async () => {
        throw new Error('offline')
      },
      homeDirectory: '/nonexistent',
    })
    expect(selected).toEqual({ enrolledDevice: ENROLLED_QMK })
  })

  it('uses the legacy serial only when no enrolled identity is present', async () => {
    const legacy = config()
    legacy.inputs.qmk = { enabled: false, serialNumber: 'legacy-serial' }
    let selected: DoctorQmkSelection | undefined
    await collectOpenControlDiagnostics({
      config: legacy,
      enumerateDevices: () => [],
      probeQmk: async (selection) => {
        selected = selection
        return { connected: false }
      },
      hookSelfTest: async () => true,
      hostStatus: async () => {
        throw new Error('offline')
      },
      homeDirectory: '/nonexistent',
    })
    expect(selected).toEqual({ serialNumber: 'legacy-serial' })
  })

  it('returns a sanitized report when config validation fails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-doctor-invalid-'))
    temporaryDirectories.push(home)
    const configPath = path.join(home, 'config.json')
    fs.writeFileSync(configPath, '{"secret":"do-not-copy","inputs":')

    const report = await collectOpenControlDiagnostics({
      configPath,
      enumerateDevices: () => [],
      probeQmk: async () => ({ connected: false }),
      hookSelfTest: async () => true,
      hostStatus: async () => {
        throw new Error('offline')
      },
      homeDirectory: home,
    })

    expect(report.config).toMatchObject({ status: 'error', schemaVersion: null })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(configPath)
    expect(serialized).not.toContain('do-not-copy')
  })

  it('flags duplicate or malformed stock terminal bindings without copying bytes', async () => {
    const broken = config()
    broken.inputs.terminal.bindings = {
      'agent.1': 'G1syNX4=',
      'agent.2': 'G1syNX4=',
      'agent.3': 'not base64',
    }
    const report = await collectOpenControlDiagnostics({
      config: broken,
      enumerateDevices: () => [],
      probeQmk: async () => ({ connected: false }),
      hookSelfTest: async () => true,
      hostStatus: async () => {
        throw new Error('offline')
      },
      homeDirectory: '/nonexistent',
    })
    expect(report.terminal).toEqual({
      status: 'warning',
      configuredControls: 3,
      validControls: 1,
      duplicateSequences: 1,
    })
    expect(report.host.running).toBe(false)
  })
})

class FakeHardwareAdapter implements HardwareDoctorAdapter {
  connectedDevice = {
    deviceId: 'private-device-id',
    vendorId: 0x1234,
    productId: 0xabcd,
    serialNumber: 'private-serial',
  }

  capabilities = {
    protocolVersion: { major: 1, minor: 0 },
    transport: 'usb' as const,
    pressRelease: true,
    repeat: true,
    encoder: true,
    rgbFeedback: true,
    ledFeedback: false,
    taskSlots: 6,
  }

  readonly frames: FeedbackFrame[] = []
  stopped = false
  private readonly controls = new Set<(event: ControlEvent) => void>()
  private readonly connections = new Set<(event: AdapterConnection) => void>()

  start(): void {}

  stop(): void {
    this.stopped = true
  }

  onControl(listener: (event: ControlEvent) => void): () => void {
    this.controls.add(listener)
    return () => this.controls.delete(listener)
  }

  onConnectionChange(listener: (event: AdapterConnection) => void): () => void {
    this.connections.add(listener)
    return () => this.connections.delete(listener)
  }

  updateFeedbackAndWait(frame: FeedbackFrame): Promise<void> {
    this.frames.push(frame)
    return Promise.resolve()
  }

  emitControl(phase: ControlEvent['phase']): void {
    for (const listener of this.controls) {
      listener({ controlId: 'agent.1', phase, sourceId: 'private', timestamp: 1 })
    }
  }

  emitConnection(connected: boolean): void {
    for (const listener of this.connections) {
      listener({ connected, adapterId: 'qmk-raw-hid' })
    }
  }
}

describe('guided hardware doctor', () => {
  it('records ACK, input, hotplug, color, pulse, and timeout confirmation outcomes', async () => {
    const adapter = new FakeHardwareAdapter()
    let selected: DoctorQmkSelection | undefined
    const report = await runHardwareDoctor({
      enrolledDevice: ENROLLED_QMK,
      serialNumber: 'must-not-win',
      adapterFactory: (selection) => {
        selected = selection
        return adapter
      },
      wait: async () => undefined,
      prompt: {
        notify(message) {
          if (message.startsWith('Press and release')) {
            queueMicrotask(() => {
              adapter.emitControl('press')
              adapter.emitControl('release')
            })
          } else if (message.startsWith('Unplug')) {
            queueMicrotask(() => adapter.emitConnection(false))
          } else if (message.startsWith('Reconnect')) {
            queueMicrotask(() => adapter.emitConnection(true))
          }
        },
        confirm: async () => true,
      },
    })

    expect(report).toEqual({
      requested: true,
      handshake: passedCheck(),
      feedbackAcknowledgement: passedCheck(),
      pressRelease: passedCheck(),
      hotplug: passedCheck(),
      sixStateColors: passedCheck(),
      selectedPulse: passedCheck(),
      animationRestore: passedCheck(),
    })
    expect(selected).toEqual({ enrolledDevice: ENROLLED_QMK })
    expect(adapter.frames).toHaveLength(2)
    expect(adapter.frames[0]?.slots.map((slot) => slot.state)).toEqual([
      'off',
      'idle',
      'executing',
      'waiting',
      'complete',
      'error',
    ])
    expect(adapter.frames[1]?.selectedSlot).toBe(2)
    expect(adapter.stopped).toBe(true)
    expect(JSON.stringify(report)).not.toContain('private')
  })
})

function passedCheck(): {
  performed: true
  skipped: false
  pass: true
  fail: false
} {
  return { performed: true, skipped: false, pass: true, fail: false }
}
