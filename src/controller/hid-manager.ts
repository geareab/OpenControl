// Device detection, driver factory, and reconnect lifecycle. Exposes a single
// deduplicated ControllerEvent stream regardless of which driver is active.

import { EventEmitter } from 'node:events'
import { devices as hidDevices } from 'node-hid'
import type { Device } from 'node-hid'
import { logger } from '../logger.js'
import { Deduper } from './hal.js'
import type { ControllerHAL } from './hal.js'
import type { ControllerOutput } from './output.js'
import { DualSenseDriver } from './dualsense-driver.js'
import { DS4_PIDS, DS4_VID, parseDs4Report } from './ds4-driver.js'
import { parseGenericReport } from './generic-driver.js'
import { RawHidDriver } from './raw-hid-driver.js'
import { parseXboxReport, XBOX_PIDS, XBOX_VID } from './xbox-driver.js'
import type { ControllerEvent } from '../types.js'
import type { ControllerType } from '../types.js'
import { createDeviceFingerprint, safeDeviceLabel, type EnrolledDevice } from '../layers.js'

export const DUALSENSE_VID = 0x054c
export const DUALSENSE_PIDS = [0x0ce6, 0x0df2] // DualSense, DualSense Edge

const RECONNECT_POLL_MS = 2000

export interface GamepadCandidate {
  readonly device: EnrolledDevice
  readonly controllerType: ControllerType
  /** Sanitized, non-path hint used to distinguish same-label devices in setup. */
  readonly selectionHint: string
}

interface InternalGamepadCandidate extends GamepadCandidate {
  readonly path: string
  readonly serialBacked: boolean
}

/** Enumerate enrollable controllers without exposing their operating-system paths. */
export function findGamepadCandidates(devices: readonly Device[]): GamepadCandidate[] {
  return internalGamepadCandidates(devices).map(({ device, controllerType, selectionHint }) => ({
    device,
    controllerType,
    selectionHint,
  }))
}

/** Detect the best matching device: DualSense > DS4 > Xbox > generic gamepad. */
export function createDriver(enrolledDevice?: EnrolledDevice): ControllerHAL | null {
  let devices: Device[]
  try {
    devices = hidDevices()
  } catch (err) {
    logger.error('HID enumeration failed', err)
    return null
  }
  return createDriverFromDevices(devices, enrolledDevice)
}

/** Deterministic selection boundary, exported for hardware regression tests. */
export function createDriverFromDevices(
  devices: readonly Device[],
  enrolledDevice?: EnrolledDevice,
): ControllerHAL | null {
  const candidates = internalGamepadCandidates(devices)
  if (enrolledDevice) {
    if (!['usb', 'bluetooth', 'unknown'].includes(enrolledDevice.transport)) {
      logger.error('Refusing gamepad enrollment with an incompatible transport')
      return null
    }
    const matches = candidates.filter(
      (candidate) =>
        candidate.device.fingerprint === enrolledDevice.fingerprint &&
        candidate.device.vendorId === enrolledDevice.vendorId &&
        candidate.device.productId === enrolledDevice.productId &&
        candidate.device.transport === enrolledDevice.transport &&
        candidate.device.generic === enrolledDevice.generic,
    )
    if (matches.length !== 1) {
      if (matches.length > 1) logger.error('Enrolled gamepad identity is ambiguous')
      return null
    }
    return driverForCandidate(matches[0]!)
  }
  return candidates.length > 0 ? driverForCandidate(candidates[0]!) : null
}

/**
 * Emits deduplicated ControllerEvents on 'data'. Polls for a controller until
 * one appears, and resumes polling after a disconnect — plugging a controller
 * in or waking it mid-session just works.
 */
export class HidManager extends EventEmitter {
  private driver: ControllerHAL | null = null
  private deduper = new Deduper()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly enrolledDevice?: EnrolledDevice) {
    super()
  }

  /** Live output surface of the active driver (DualSense only), or undefined. */
  get output(): ControllerOutput | undefined {
    return this.driver?.output
  }

  start(): void {
    this.stopped = false
    this.attach()
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.driver?.stop()
    this.driver = null
  }

  private attach(): void {
    if (this.stopped) return
    this.driver = createDriver(this.enrolledDevice)
    if (!this.driver) {
      this.pollUntilFound()
      return
    }
    this.deduper = new Deduper()
    this.driver.on('data', (e: ControllerEvent) => {
      const filtered = this.deduper.filter(e)
      if (!filtered) return
      this.emit('data', filtered)
      if (filtered.kind === 'disconnected') {
        this.driver?.stop()
        this.driver = null
        this.pollUntilFound()
      }
    })
    this.driver.start()
  }

  private pollUntilFound(): void {
    if (this.pollTimer || this.stopped) return
    logger.info('No controller found — polling')
    this.pollTimer = setInterval(() => {
      if (createDriver(this.enrolledDevice)) {
        clearInterval(this.pollTimer!)
        this.pollTimer = null
        this.attach()
      }
    }, RECONNECT_POLL_MS)
    this.pollTimer.unref()
  }
}

function internalGamepadCandidates(devices: readonly Device[]): InternalGamepadCandidate[] {
  const candidates = devices
    .flatMap((device): InternalGamepadCandidate[] => {
      if (!device.path) return []
      let controllerType: ControllerType
      let fallbackLabel: string
      let generic = false
      if (device.vendorId === DUALSENSE_VID && DUALSENSE_PIDS.includes(device.productId)) {
        controllerType = 'dualsense'
        fallbackLabel = 'Sony DualSense'
      } else if (device.vendorId === DS4_VID && DS4_PIDS.includes(device.productId)) {
        controllerType = 'ds4'
        fallbackLabel = 'Sony DualShock 4'
      } else if (device.vendorId === XBOX_VID && XBOX_PIDS.includes(device.productId)) {
        controllerType = 'xbox'
        fallbackLabel = 'Xbox controller'
      } else if (device.usagePage === 0x01 && (device.usage === 0x04 || device.usage === 0x05)) {
        controllerType = 'generic-hid'
        fallbackLabel = 'Generic HID gamepad'
        generic = true
      } else {
        return []
      }
      const transport = physicalTransport(device)
      const enrollment: EnrolledDevice = {
        fingerprint: createDeviceFingerprint({
          vendorId: device.vendorId,
          productId: device.productId,
          transport,
          ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
        }),
        vendorId: device.vendorId,
        productId: device.productId,
        transport,
        label: safeDeviceLabel(device.product, fallbackLabel),
        generic,
      }
      const serialHint = safeDeviceLabel(device.serialNumber, '')
      const selectionHint = `${transport} · ${
        serialHint ? `serial ${serialHint}` : `id ${enrollment.fingerprint.slice(0, 12)}`
      }`
      return [
        {
          device: enrollment,
          controllerType,
          selectionHint,
          path: device.path,
          serialBacked: Boolean(device.serialNumber),
        },
      ]
    })
    .sort((left, right) => {
      const priority: Record<ControllerType, number> = {
        dualsense: 0,
        ds4: 1,
        xbox: 2,
        'generic-hid': 3,
      }
      return (
        priority[left.controllerType] - priority[right.controllerType] ||
        left.device.label.localeCompare(right.device.label)
      )
    })

  // hidapi may expose several interfaces for one physical controller.
  // A serial-backed identity can safely collapse those interfaces. Identical
  // serial-less identities must remain duplicated so enrollment refuses them.
  const byFingerprint = new Map<string, InternalGamepadCandidate[]>()
  for (const candidate of candidates) {
    const group = byFingerprint.get(candidate.device.fingerprint) ?? []
    group.push(candidate)
    byFingerprint.set(candidate.device.fingerprint, group)
  }
  return [...byFingerprint.values()].flatMap((group) =>
    group.every((candidate) => candidate.serialBacked) ? [group[0]!] : group,
  )
}

function physicalTransport(device: Device): EnrolledDevice['transport'] {
  const metadata = device as Device & {
    busType?: unknown
    transport?: unknown
  }
  const value = metadata.busType ?? metadata.transport
  if (value === 1) return 'usb'
  if (value === 2) return 'bluetooth'
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.includes('bluetooth') || normalized === 'ble') return 'bluetooth'
    if (normalized.includes('usb')) return 'usb'
  }
  return 'unknown'
}

function driverForCandidate(candidate: InternalGamepadCandidate): ControllerHAL {
  switch (candidate.controllerType) {
    case 'dualsense':
      return new DualSenseDriver(candidate.path)
    case 'ds4':
      return new RawHidDriver('ds4', candidate.path, parseDs4Report)
    case 'xbox':
      return new RawHidDriver('xbox', candidate.path, parseXboxReport)
    case 'generic-hid':
      logger.warn('Unknown enrolled controller, using generic HID driver')
      return new RawHidDriver('generic-hid', candidate.path, parseGenericReport)
  }
}
