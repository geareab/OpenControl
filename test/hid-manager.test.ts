import type { Device } from 'node-hid'
import { NodeHIDProvider } from 'dualsense-ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDriverFromDevices,
  DUALSENSE_PIDS,
  DUALSENSE_VID,
  findGamepadCandidates,
} from '../src/controller/hid-manager.js'
import { XBOX_PIDS, XBOX_VID } from '../src/controller/xbox-driver.js'

type DeviceMetadata = Device & { busType?: string | number; transport?: string }

function hid(overrides: Partial<DeviceMetadata>): Device {
  return {
    vendorId: 0,
    productId: 0,
    release: 1,
    interface: 0,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gamepad enrollment discovery', () => {
  it('returns stable safe identities without exposing HID paths', () => {
    const [candidate] = findGamepadCandidates([
      hid({
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0]!,
        path: '/dev/hidraw-secret',
        serialNumber: 'PAD-1',
        product: '\u001b[31mXbox\u0007 controller',
        busType: 'USB',
      }),
    ])

    expect(candidate).toMatchObject({
      controllerType: 'xbox',
      device: {
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0],
        transport: 'usb',
        generic: false,
      },
    })
    expect(candidate?.device.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(
      [...(candidate?.device.label ?? '')].every((character) => {
        const code = character.codePointAt(0)!
        return code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)
      }),
    ).toBe(true)
    expect(candidate?.device.label).toBe('Xbox controller')
    expect(candidate?.selectionHint).toBe('usb · serial PAD-1')
    expect(JSON.stringify(candidate)).not.toContain('/dev/hidraw-secret')
  })

  it('marks unknown gamepad-usage devices as generic for the extra setup opt-in', () => {
    const [candidate] = findGamepadCandidates([
      hid({
        vendorId: 0xbeef,
        productId: 0xcafe,
        path: 'private-path',
        usagePage: 0x01,
        usage: 0x05,
      }),
    ])

    expect(candidate).toMatchObject({
      controllerType: 'generic-hid',
      device: { generic: true, label: 'Generic HID gamepad', transport: 'unknown' },
    })
    expect(candidate?.selectionHint).toMatch(/^unknown · id [a-f0-9]{12}$/)
  })

  it('preserves duplicate serial-less identities so enrollment can refuse ambiguity', () => {
    const candidates = findGamepadCandidates([
      hid({
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0]!,
        path: 'first-private-path',
        usagePage: 0x01,
        usage: 0x05,
        busType: 2,
      }),
      hid({
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0]!,
        path: 'second-private-path',
        usagePage: 0x01,
        usage: 0x05,
        busType: 2,
      }),
    ])

    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.device.transport).toBe('bluetooth')
    expect(candidates[0]?.device.fingerprint).toBe(candidates[1]?.device.fingerprint)
  })

  it('deduplicates serial-backed interfaces of one stable gamepad identity', () => {
    const candidates = findGamepadCandidates([
      hid({
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0]!,
        path: 'interface-1',
        serialNumber: 'PAD-1',
        busType: 'usb',
      }),
      hid({
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0]!,
        path: 'interface-2',
        serialNumber: 'PAD-1',
        busType: 'usb',
      }),
    ])

    expect(candidates).toHaveLength(1)
  })

  it('requires the discovered transport to equal the enrolled transport directly', () => {
    const devices = [
      hid({
        vendorId: XBOX_VID,
        productId: XBOX_PIDS[0]!,
        path: 'private-xbox-path',
        serialNumber: 'PAD-1',
        busType: 'usb',
      }),
    ]
    const [candidate] = findGamepadCandidates(devices)
    expect(candidate).toBeDefined()

    expect(
      createDriverFromDevices(devices, {
        ...candidate!.device,
        transport: 'bluetooth',
      }),
    ).toBeNull()
  })

  it('opens the exact enrolled DualSense path without exposing it through discovery', () => {
    const devices = [
      hid({
        vendorId: DUALSENSE_VID,
        productId: DUALSENSE_PIDS[0]!,
        path: 'first-private-dualsense-path',
        serialNumber: 'DUALSENSE-A',
        product: 'Wireless Controller',
        busType: 'usb',
      }),
      hid({
        vendorId: DUALSENSE_VID,
        productId: DUALSENSE_PIDS[0]!,
        path: 'selected-private-dualsense-path',
        serialNumber: 'DUALSENSE-B',
        product: 'Wireless Controller',
        busType: 'usb',
      }),
    ]
    const candidates = findGamepadCandidates(devices)
    const selected = candidates.find((candidate) => candidate.selectionHint.includes('DUALSENSE-B'))
    expect(selected).toBeDefined()
    expect(JSON.stringify(candidates)).not.toContain('private-dualsense-path')

    const connect = vi.spyOn(NodeHIDProvider.prototype, 'connect').mockResolvedValue(undefined)
    const driver = createDriverFromDevices(devices, selected!.device)
    expect(driver?.controllerType).toBe('dualsense')

    try {
      driver?.start()
      expect(connect).toHaveBeenCalledOnce()
      const provider = connect.mock.contexts[0] as NodeHIDProvider | undefined
      expect(provider?.targetPath).toBe('selected-private-dualsense-path')
    } finally {
      driver?.stop()
    }
  })
})
