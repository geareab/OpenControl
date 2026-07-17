import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeviceFingerprint, DEFAULT_CONFIG } from '../src/layers.js'
import type { GamepadCandidate } from '../src/controller/hid-manager.js'
import {
  captureTerminalSequence,
  describeGamepadForSetup,
  runSetup,
  viaSetupGuide,
  type EnhancedKeyboard,
} from '../src/setup.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryConfig(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-setup-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'config.json')
}

function keyboard(serialNumber: string, label = 'Test Board'): EnhancedKeyboard {
  return {
    fingerprint: createDeviceFingerprint({
      vendorId: 0x3434,
      productId: 0x0abc,
      transport: 'usb',
      serialNumber,
    }),
    vendorId: 0x3434,
    productId: 0x0abc,
    transport: 'usb',
    label,
    generic: false,
    serialNumber,
    product: label,
  }
}

function gamepad(generic = false): GamepadCandidate {
  return {
    controllerType: generic ? 'generic-hid' : 'xbox',
    selectionHint: 'usb · serial PAD-1',
    device: {
      fingerprint: createDeviceFingerprint({
        vendorId: 0x045e,
        productId: generic ? 0xffff : 0x0b12,
        transport: 'usb',
        serialNumber: 'PAD-1',
      }),
      vendorId: 0x045e,
      productId: generic ? 0xffff : 0x0b12,
      transport: 'usb',
      label: generic ? 'Generic pad' : 'Xbox controller',
      generic,
    },
  }
}

describe('VIA setup', () => {
  it('prints every portable VIA assignment', () => {
    const guide = viaSetupGuide()
    expect(guide).toContain('Agent 1')
    expect(guide).toContain('F13')
    expect(guide).toContain('Fast')
    expect(guide).toContain('F19')
    expect(guide).toContain('Model picker')
    expect(guide).toContain('Shift+F19')
  })

  it('selects enhanced QMK mode after a successful handshake', async () => {
    const configPath = temporaryConfig()
    const output = { write: vi.fn(() => true) }
    const enhanced = keyboard('kbd-123')

    await runSetup({
      configPath,
      output: output as never,
      detectEnhanced: async () => enhanced,
      confirmEnhanced: async () => true,
    })

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    expect(saved.inputs.qmk).toEqual({
      enabled: true,
      device: expect.objectContaining({
        fingerprint: enhanced.fingerprint,
        label: 'Test Board',
      }),
    })
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('Test Board'))
  })

  it('captures binary terminal sequences as base64', async () => {
    const configPath = temporaryConfig()
    let index = 0
    await runSetup({
      configPath,
      output: { write: vi.fn(() => true) } as never,
      detectEnhanced: async () => null,
      capture: async () => (index++ === 0 ? Buffer.from([0x1b, 0x5b, 0x32, 0x35, 0x7e]) : null),
    })

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    expect(saved.inputs.terminal.bindings['agent.1']).toBe('G1syNX4=')
    expect(Object.keys(saved.inputs.terminal.bindings)).toHaveLength(1)
  })

  it('persists a serial selection when several enhanced boards answer the handshake', async () => {
    const configPath = temporaryConfig()
    await runSetup({
      configPath,
      output: { write: vi.fn(() => true) } as never,
      detectEnhanced: async () => [keyboard('A', 'Board A'), keyboard('B', 'Board B')],
      selectEnhanced: async (keyboards) => keyboards[1]!,
      confirmEnhanced: async () => true,
    })
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    expect(saved.inputs.qmk.device?.fingerprint).toBe(keyboard('B', 'Board B').fingerprint)
  })

  it('rejects duplicate serial numbers before offering a device selection', async () => {
    const configPath = temporaryConfig()
    await expect(
      runSetup({
        configPath,
        input: { isTTY: false } as never,
        output: { write: vi.fn(() => true) } as never,
        detectEnhanced: async () => [
          keyboard('duplicate', 'Board A'),
          keyboard('duplicate', 'Board B'),
        ],
      }),
    ).rejects.toThrow('duplicate serial numbers')
  })

  it('offers a gamepad-only fallback without forcing terminal capture', async () => {
    const configPath = temporaryConfig()
    const capture = vi.fn()
    await runSetup({
      configPath,
      output: { write: vi.fn(() => true) } as never,
      detectEnhanced: async () => null,
      chooseMode: async () => 'gamepad',
      detectGamepads: async () => [gamepad()],
      confirmGamepad: async () => true,
      capture,
    })
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    expect(saved.inputs.gamepad.enabled).toBe(true)
    expect(capture).not.toHaveBeenCalled()
  })

  it('requires a second explicit opt-in for a generic HID gamepad', async () => {
    const configPath = temporaryConfig()
    const genericOptIn = vi.fn(async () => false)
    await expect(
      runSetup({
        configPath,
        output: { write: vi.fn(() => true) } as never,
        detectEnhanced: async () => null,
        chooseMode: async () => 'gamepad',
        detectGamepads: async () => [gamepad(true)],
        confirmGamepad: async () => true,
        confirmGenericGamepad: genericOptIn,
      }),
    ).rejects.toThrow(/opt-in was not confirmed/)
    expect(genericOptIn).toHaveBeenCalledOnce()
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof DEFAULT_CONFIG
    expect(saved.inputs.gamepad.enabled).toBe(false)
  })

  it('refuses ambiguous serial-less gamepads before offering enrollment', async () => {
    const configPath = temporaryConfig()
    const candidate = gamepad()
    const confirm = vi.fn(async () => true)
    await expect(
      runSetup({
        configPath,
        output: { write: vi.fn(() => true) } as never,
        detectEnhanced: async () => null,
        chooseMode: async () => 'gamepad',
        detectGamepads: async () => [
          candidate,
          {
            ...candidate,
            device: { ...candidate.device },
          },
        ],
        confirmGamepad: confirm,
      }),
    ).rejects.toThrow(/Multiple serial-less gamepads/)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('distinguishes same-label gamepads with safe non-path enrollment hints', () => {
    const first = gamepad()
    const second: GamepadCandidate = {
      ...gamepad(),
      selectionHint: 'usb · serial PAD-2',
      device: {
        ...gamepad().device,
        fingerprint: createDeviceFingerprint({
          vendorId: 0x045e,
          productId: 0x0b12,
          transport: 'usb',
          serialNumber: 'PAD-2',
        }),
      },
    }

    expect(first.device.label).toBe(second.device.label)
    expect(describeGamepadForSetup(first)).toBe('Xbox controller (usb · serial PAD-1)')
    expect(describeGamepadForSetup(second)).toBe('Xbox controller (usb · serial PAD-2)')
    expect(describeGamepadForSetup(first)).not.toContain('/dev/')
    expect(describeGamepadForSetup(second)).not.toContain('/dev/')
  })
})

describe('terminal capture', () => {
  it('retains a chunked escape sequence and restores terminal raw mode', async () => {
    class FakeInput extends EventEmitter {
      isTTY = true
      isRaw = false
      setRawMode(value: boolean): void {
        this.isRaw = value
      }
      resume(): void {}
    }
    const input = new FakeInput()
    const output = { write: vi.fn(() => true) }
    const capture = captureTerminalSequence(input as never, output as never, 'Agent 1', 'F13', 5)
    input.emit('data', Buffer.from([0x1b, 0x5b]))
    input.emit('data', Buffer.from('25~'))

    await expect(capture).resolves.toEqual(Buffer.from('\x1b[25~'))
    expect(input.isRaw).toBe(false)
  })
})
