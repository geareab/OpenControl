import { EventEmitter } from 'node:events'
import { HID, devices as enumerateHidDevices } from 'node-hid'
import type { Device } from 'node-hid'
import {
  createDeviceFingerprint,
  safeDeviceLabel,
  type EnrolledDevice,
  type EnrolledDeviceTransport,
} from '../layers.js'
import type {
  AdapterCapabilities,
  AdapterConnection,
  ControlEvent,
  FeedbackAdapter,
  FeedbackFrame,
  InputAdapter,
  Unsubscribe,
} from './types.js'
import {
  decodeAcknowledgement,
  decodeControlEvent,
  decodeDeviceError,
  decodeHelloAck,
  decodeQmkPacket,
  encodeHello,
  encodePing,
  encodeTaskStates,
  OPENCONTROL_QMK_MAGIC,
  OPENCONTROL_QMK_NAMESPACE,
  OPENCONTROL_QMK_PROTOCOL_MAJOR,
  QMK_RAW_HID_REPORT_SIZE,
  QMK_RAW_HID_USAGE,
  QMK_RAW_HID_USAGE_PAGE,
  QmkCapabilityFlag,
  QmkMessageType,
  QmkPacketFlag,
  QmkProtocolError,
} from './qmk-protocol.js'

export interface QmkHidHandle {
  write(data: number[] | Buffer): number
  close(): void
  on(event: 'data', listener: (data: Buffer) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  off(event: 'data', listener: (data: Buffer) => void): this
  off(event: 'error', listener: (error: Error) => void): this
}

export interface QmkHidBackend {
  devices(): Device[]
  open(path: string): QmkHidHandle
}

export interface QmkRawHidAdapterOptions {
  /** Select a specific device only when more than one compatible board is present. */
  readonly serialNumber?: string
  /** Stable identity selected by setup; matched only after a successful handshake. */
  readonly enrolledDevice?: EnrolledDevice
  readonly pollIntervalMs?: number
  readonly handshakeTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly acknowledgementTimeoutMs?: number
  readonly protocolErrorFeedbackMs?: number
  readonly backend?: QmkHidBackend
  readonly now?: () => number
}

/** Public connection identity retained for diagnostic adapter compatibility. */
export interface QmkConnectedDevice {
  readonly deviceId: string
  readonly fingerprint?: string
  readonly vendorId: number
  readonly productId: number
  readonly transport?: EnrolledDeviceTransport
  readonly label?: string
  readonly generic?: boolean
  readonly serialNumber?: string
  readonly manufacturer?: string
  readonly product?: string
}

export type EnrollableQmkConnectedDevice = QmkConnectedDevice & EnrolledDevice

export type QmkAdapterHealth = 'connected' | 'degraded' | 'reconnecting'

export interface QmkAdapterHealthEvent {
  readonly health: QmkAdapterHealth
  readonly error?: Error
}

interface ProbeResult {
  readonly handle: QmkHidHandle
  readonly device: Device
  readonly capabilities: AdapterCapabilities
  readonly heartbeatIntervalMs: number
  readonly acknowledgementTimeoutMs: number
}

interface PendingAcknowledgement {
  readonly key: string
  readonly packet: Buffer
  readonly messageType: QmkMessageType
  readonly sequence: number
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

interface CompletedAcknowledgement {
  readonly sequence: number
  readonly timer: ReturnType<typeof setTimeout>
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 400
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000
const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 250
const DEFAULT_PROTOCOL_ERROR_FEEDBACK_MS = 2000
const MINIMUM_HEARTBEAT_INTERVAL_MS = 100
const MAXIMUM_RETRIES = 2

export const nodeHidQmkBackend: QmkHidBackend = {
  devices: () => enumerateHidDevices(),
  open: (path) => new HID(path, { nonExclusive: true }),
}

/** Return only the standard QMK Raw HID interface; VID/PID is never assumed. */
export function findQmkRawHidCandidates(
  devices: readonly Device[],
  serialNumber?: string,
): Device[] {
  return devices
    .filter(
      (device) =>
        device.path !== undefined &&
        device.usagePage === QMK_RAW_HID_USAGE_PAGE &&
        device.usage === QMK_RAW_HID_USAGE &&
        (serialNumber === undefined || device.serialNumber === serialNumber),
    )
    .sort((left, right) => {
      const leftKey = `${left.serialNumber ?? ''}\0${left.path ?? ''}`
      const rightKey = `${right.serialNumber ?? ''}\0${right.path ?? ''}`
      return leftKey.localeCompare(rightKey)
    })
}

/**
 * QMK Raw HID input and feedback adapter.
 *
 * Matching a HID usage page is only candidate discovery. A device is exposed
 * to OpenControl after it replies to our versioned HELLO with a valid
 * HELLO_ACK, preventing unrelated VIA devices from being claimed.
 */
export class QmkRawHidAdapter extends EventEmitter implements InputAdapter, FeedbackAdapter {
  readonly adapterId = 'qmk-raw-hid'

  private readonly backend: QmkHidBackend
  private readonly selectedSerial?: string
  private readonly enrolledDevice?: EnrolledDevice
  private readonly pollIntervalMs: number
  private readonly handshakeTimeoutMs: number
  private readonly requestedHeartbeatIntervalMs: number
  private readonly requestedAcknowledgementTimeoutMs: number
  private readonly protocolErrorFeedbackMs: number
  private readonly now: () => number

  private activeHandle: QmkHidHandle | null = null
  private activeDevice: EnrollableQmkConnectedDevice | null = null
  private activeCapabilities: AdapterCapabilities | null = null
  private ambiguousDevices: EnrollableQmkConnectedDevice[] = []
  private activeDataListener: ((data: Buffer) => void) | null = null
  private activeErrorListener: ((error: Error) => void) | null = null
  private probingHandle: QmkHidHandle | null = null
  private cancelProbe: (() => void) | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private protocolErrorFeedbackTimer: ReturnType<typeof setTimeout> | null = null
  private scanPromise: Promise<boolean> | null = null
  private stopped = true
  private generation = 0
  private sequence = 0
  private lastFeedback: FeedbackFrame | null = null
  private displayedFeedback: FeedbackFrame | null = null
  private activeHeartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS
  private activeAcknowledgementTimeoutMs = DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS
  private readonly pendingAcknowledgements = new Map<string, PendingAcknowledgement>()
  private readonly completedAcknowledgements = new Map<string, CompletedAcknowledgement>()
  private readonly pressedControls = new Set<string>()
  private readonly recentControlPackets = new Map<string, string>()
  private adapterHealth: QmkAdapterHealth = 'reconnecting'

  constructor(options: QmkRawHidAdapterOptions = {}) {
    super()
    this.backend = options.backend ?? nodeHidQmkBackend
    this.selectedSerial = options.serialNumber
    this.enrolledDevice = options.enrolledDevice
    this.pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    this.handshakeTimeoutMs = positiveDuration(
      options.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    )
    this.requestedHeartbeatIntervalMs = positiveDuration(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    )
    this.requestedAcknowledgementTimeoutMs = positiveDuration(
      options.acknowledgementTimeoutMs,
      DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS,
    )
    this.protocolErrorFeedbackMs = positiveDuration(
      options.protocolErrorFeedbackMs,
      DEFAULT_PROTOCOL_ERROR_FEEDBACK_MS,
    )
    this.now = options.now ?? Date.now
  }

  get capabilities(): AdapterCapabilities | null {
    return this.activeCapabilities
  }

  get connectedDevice(): QmkConnectedDevice | null {
    return this.activeDevice
  }

  get health(): QmkAdapterHealth {
    return this.adapterHealth
  }

  /** Compatible devices found during the last scan (more than one requires serial selection). */
  get compatibleDevices(): readonly EnrollableQmkConnectedDevice[] {
    if (this.activeDevice) return [this.activeDevice]
    return [...this.ambiguousDevices]
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.generation += 1
    const connected = await this.scanNow()
    if (!connected) this.schedulePoll()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    this.clearPoll()
    this.clearHeartbeat()
    this.clearProtocolErrorFeedback()
    this.cancelProbe?.()
    this.cancelProbe = null
    this.closeProbe()
    this.disconnect(false)
    this.ambiguousDevices = []
  }

  onControl(listener: (event: ControlEvent) => void): Unsubscribe {
    this.on('control', listener)
    return () => this.off('control', listener)
  }

  onConnectionChange(listener: (event: AdapterConnection) => void): Unsubscribe {
    this.on('connection', listener)
    return () => this.off('connection', listener)
  }

  onProtocolError(listener: (error: Error) => void): Unsubscribe {
    this.on('protocolError', listener)
    return () => this.off('protocolError', listener)
  }

  onHealthChange(listener: (event: QmkAdapterHealthEvent) => void): Unsubscribe {
    this.on('health', listener)
    return () => this.off('health', listener)
  }

  /** Immediately perform one enumeration/handshake pass (also used by doctor). */
  scanNow(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.activeHandle) return Promise.resolve(true)
    if (this.scanPromise) return this.scanPromise
    const generation = this.generation
    const scan = this.scanOnce(generation).finally(() => {
      if (this.scanPromise === scan) this.scanPromise = null
    })
    this.scanPromise = scan
    return scan
  }

  updateFeedback(frame: FeedbackFrame): void {
    this.lastFeedback = frame
    if (!this.activeHandle || this.protocolErrorFeedbackTimer) return
    void this.sendFeedback(frame).catch(() => {})
  }

  /** Send one atomic feedback frame and resolve only after its matching ACK. */
  updateFeedbackAndWait(frame: FeedbackFrame): Promise<void> {
    this.lastFeedback = frame
    if (!this.activeHandle) return Promise.reject(new Error('QMK Raw HID device is not connected'))
    this.clearProtocolErrorFeedback()
    return this.sendFeedback(frame)
  }

  ping(): void {
    if (!this.activeHandle) return
    void this.sendPing().catch(() => {})
  }

  /** Send a diagnostic PING and resolve only after its matching ACK. */
  pingAndWait(): Promise<void> {
    if (!this.activeHandle) return Promise.reject(new Error('QMK Raw HID device is not connected'))
    return this.sendPing()
  }

  private sendPing(): Promise<void> {
    const timestamp = Buffer.alloc(4)
    timestamp.writeUInt32LE(this.now() >>> 0)
    try {
      const sequence = this.nextSequence()
      return this.sendReliable(encodePing(sequence, timestamp), QmkMessageType.PING, sequence)
    } catch (error) {
      return Promise.reject(toError(error, 'Unable to allocate a QMK protocol sequence'))
    }
  }

  private sendFeedback(frame: FeedbackFrame): Promise<void> {
    try {
      const sequence = this.nextSequence()
      return this.sendReliable(
        encodeTaskStates(sequence, frame),
        QmkMessageType.TASK_STATES,
        sequence,
      )
    } catch (error) {
      return Promise.reject(toError(error, 'Unable to allocate a QMK protocol sequence'))
    }
  }

  private async scanOnce(generation: number): Promise<boolean> {
    let devices: Device[]
    try {
      devices = findQmkRawHidCandidates(this.backend.devices(), this.selectedSerial)
    } catch (error) {
      this.emitProtocolError(toError(error, 'Unable to enumerate HID devices'))
      return false
    }

    this.ambiguousDevices = []
    const compatible: ProbeResult[] = []
    for (const device of devices) {
      if (this.stopped || generation !== this.generation) {
        for (const result of compatible) safeClose(result.handle)
        return false
      }
      const result = await this.probe(device)
      if (!result) continue
      if (this.stopped || generation !== this.generation) {
        safeClose(result.handle)
        for (const previous of compatible) safeClose(previous.handle)
        return false
      }
      compatible.push(result)
    }
    if (compatible.length === 1) {
      const result = compatible[0]!
      if (this.enrolledDevice && !matchesEnrollment(result, this.enrolledDevice)) {
        safeClose(result.handle)
        this.emitProtocolError(new Error('The enrolled QMK keyboard is not connected'))
        return false
      }
      this.claim(result)
      return true
    }
    if (compatible.length > 1) {
      if (this.enrolledDevice) {
        const enrolledMatches = compatible.filter((result) =>
          matchesEnrollment(result, this.enrolledDevice!),
        )
        if (enrolledMatches.length === 1) {
          const selected = enrolledMatches[0]!
          for (const result of compatible) {
            if (result !== selected) safeClose(result.handle)
          }
          this.claim(selected)
          return true
        }
        for (const result of compatible) safeClose(result.handle)
        this.ambiguousDevices = enrolledMatches.map((result) =>
          publicDeviceIdentity(result.device, result.capabilities, true),
        )
        this.emitProtocolError(
          new Error(
            enrolledMatches.length > 1
              ? 'The enrolled QMK identity is ambiguous; disconnect duplicate serial-less devices'
              : 'The enrolled QMK keyboard is not connected',
          ),
        )
        return false
      }
      const serialCounts = new Map<string, number>()
      for (const result of compatible) {
        const serial = result.device.serialNumber
        if (serial) serialCounts.set(serial, (serialCounts.get(serial) ?? 0) + 1)
      }
      this.ambiguousDevices = compatible.map((result) =>
        publicDeviceIdentity(
          result.device,
          result.capabilities,
          !result.device.serialNumber || (serialCounts.get(result.device.serialNumber) ?? 0) > 1,
        ),
      )
      for (const result of compatible) safeClose(result.handle)
      const hasUnselectableSerial = compatible.some(
        (result) =>
          !result.device.serialNumber || (serialCounts.get(result.device.serialNumber) ?? 0) > 1,
      )
      this.emitProtocolError(
        new Error(
          hasUnselectableSerial
            ? 'Multiple OpenControl QMK keyboards have missing or duplicate serial numbers and cannot be selected safely'
            : 'Multiple OpenControl QMK keyboards are connected; select one by serial number',
        ),
      )
    }
    return false
  }

  private probe(device: Device): Promise<ProbeResult | null> {
    const path = device.path
    if (!path) return Promise.resolve(null)

    let handle: QmkHidHandle
    try {
      handle = this.backend.open(path)
      this.probingHandle = handle
    } catch {
      return Promise.resolve(null)
    }

    const sequence = this.nextSequence()
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: ProbeResult | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        handle.off('data', onData)
        handle.off('error', onError)
        if (this.probingHandle === handle) this.probingHandle = null
        if (this.cancelProbe === cancel) this.cancelProbe = null
        if (!result) safeClose(handle)
        resolve(result)
      }
      const cancel = (): void => finish(null)
      const onData = (data: Buffer): void => {
        const report = normalizeNodeHidReport(data)
        if (!report || !isOpenControlReport(report)) return
        try {
          const packet = decodeQmkPacket(report)
          if (
            packet.major !== OPENCONTROL_QMK_PROTOCOL_MAJOR ||
            packet.type !== QmkMessageType.HELLO_ACK ||
            packet.sequence !== sequence ||
            (packet.flags & QmkPacketFlag.RESPONSE) === 0
          ) {
            return
          }
          const acknowledgement = decodeHelloAck(packet)
          const heartbeatTimeoutMs = acknowledgement.heartbeatSeconds * 1000
          const heartbeatIntervalMs = Math.max(
            MINIMUM_HEARTBEAT_INTERVAL_MS,
            Math.min(this.requestedHeartbeatIntervalMs, Math.floor(heartbeatTimeoutMs / 2)),
          )
          if (heartbeatIntervalMs >= heartbeatTimeoutMs) {
            throw new QmkProtocolError(
              'QMK firmware heartbeat timeout is too short for a safe host cadence',
              'unsupported-value',
            )
          }
          const acknowledgementTimeoutMs = Math.min(
            this.requestedAcknowledgementTimeoutMs,
            Math.max(25, Math.floor(heartbeatIntervalMs / (MAXIMUM_RETRIES + 1))),
          )
          finish({
            handle,
            device,
            heartbeatIntervalMs,
            acknowledgementTimeoutMs,
            capabilities: {
              protocolVersion: {
                major: OPENCONTROL_QMK_PROTOCOL_MAJOR,
                minor: acknowledgement.protocolMinor,
              },
              transport:
                (acknowledgement.capabilityFlags & QmkCapabilityFlag.USB) !== 0 ? 'usb' : 'unknown',
              pressRelease:
                (acknowledgement.capabilityFlags & QmkCapabilityFlag.PRESS_RELEASE) !== 0,
              repeat: true,
              encoder: (acknowledgement.capabilityFlags & QmkCapabilityFlag.ENCODER) !== 0,
              rgbFeedback: (acknowledgement.capabilityFlags & QmkCapabilityFlag.RGB_MATRIX) !== 0,
              // Protocol v1 defines a six-color overlay and has no monochrome
              // renderer. Ignore bit 2 from early preview firmware rather than
              // exposing a functional feedback capability that does not exist.
              ledFeedback: false,
              taskSlots: acknowledgement.agentCount,
            },
          })
        } catch (error) {
          this.emitProtocolError(toError(error, 'Invalid QMK HELLO_ACK'), false, false)
          finish(null)
        }
      }
      const onError = (): void => finish(null)
      const timeout = setTimeout(() => finish(null), this.handshakeTimeoutMs)
      timeout.unref()
      this.cancelProbe = cancel
      handle.on('data', onData)
      handle.on('error', onError)

      try {
        writeNodeHidReport(handle, encodeHello(sequence))
      } catch {
        finish(null)
      }
    })
  }

  private claim(result: ProbeResult): void {
    this.clearPoll()
    this.activeHandle = result.handle
    this.activeCapabilities = result.capabilities
    this.activeHeartbeatIntervalMs = result.heartbeatIntervalMs
    this.activeAcknowledgementTimeoutMs = result.acknowledgementTimeoutMs
    this.activeDevice = publicDeviceIdentity(result.device, result.capabilities)
    this.pressedControls.clear()
    this.recentControlPackets.clear()
    this.activeDataListener = (data) => this.receive(data)
    this.activeErrorListener = (error) => {
      this.emitProtocolError(toError(error, 'QMK Raw HID device disconnected'), true, false)
      this.disconnect(true)
    }
    result.handle.on('data', this.activeDataListener)
    result.handle.on('error', this.activeErrorListener)
    this.setHealth('connected')
    this.emit('connection', {
      connected: true,
      adapterId: this.adapterId,
      deviceId: this.activeDevice.deviceId,
      capabilities: result.capabilities,
    } satisfies AdapterConnection)
    if (this.lastFeedback) void this.sendFeedback(this.lastFeedback).catch(() => {})
    this.startHeartbeat()
  }

  private receive(data: Buffer): void {
    const report = normalizeNodeHidReport(data)
    if (!report || !isOpenControlReport(report)) return
    try {
      const packet = decodeQmkPacket(report)
      if (packet.major !== OPENCONTROL_QMK_PROTOCOL_MAJOR) {
        throw new QmkProtocolError(
          `Unsupported QMK protocol major version: ${packet.major}`,
          'unsupported-value',
        )
      }
      if (packet.type === QmkMessageType.CONTROL_EVENT) {
        const control = decodeControlEvent(packet)
        const packetIdentity = report.toString('hex')
        if (this.recentControlPackets.has(packetIdentity)) return
        this.rememberControlPacket(packetIdentity, control.controlId)
        if (control.phase === 'press') {
          if (this.pressedControls.has(control.controlId)) return
          this.pressedControls.add(control.controlId)
        } else if (control.phase === 'release') {
          if (!this.pressedControls.delete(control.controlId)) return
          this.forgetControlPackets(control.controlId)
        }
        if (!this.protocolErrorFeedbackTimer) this.setHealth('connected')
        this.emit('control', {
          controlId: control.controlId,
          phase: control.phase,
          sourceId: this.activeDevice?.deviceId ?? this.adapterId,
          timestamp: this.now(),
        } satisfies ControlEvent)
      } else if (packet.type === QmkMessageType.ACK) {
        const acknowledgement = decodeAcknowledgement(packet)
        const key = acknowledgementKey(
          acknowledgement.acknowledgedType,
          acknowledgement.acknowledgedSequence,
        )
        const pending = this.pendingAcknowledgements.get(key)
        if (!pending) {
          if (this.completedAcknowledgements.has(key)) return
          throw new QmkProtocolError(
            `Unexpected ACK for message ${acknowledgement.acknowledgedType} sequence ${acknowledgement.acknowledgedSequence}`,
            'unsupported-value',
          )
        }
        this.completeAcknowledgement(pending)
        if (!this.protocolErrorFeedbackTimer) this.setHealth('connected')
      } else if (packet.type === QmkMessageType.ERROR) {
        const deviceError = decodeDeviceError(packet)
        const pending = this.pendingAcknowledgements.get(
          acknowledgementKey(deviceError.offendingType, packet.sequence),
        )
        if (pending) {
          const error = new Error(
            `QMK firmware rejected message ${deviceError.offendingType} (error ${deviceError.code}, detail ${deviceError.detail})`,
          )
          this.failAcknowledgement(pending, error)
        }
        this.emitProtocolError(
          new Error(
            `QMK firmware error ${deviceError.code} for message ${deviceError.offendingType} (detail ${deviceError.detail})`,
          ),
          true,
          deviceError.offendingType !== QmkMessageType.TASK_STATES,
        )
      }
    } catch (error) {
      this.emitProtocolError(toError(error, 'Invalid OpenControl QMK report'), true, true)
    }
  }

  private disconnect(reconnect: boolean): void {
    const handle = this.activeHandle
    const device = this.activeDevice
    if (!handle) return
    if (this.activeDataListener) handle.off('data', this.activeDataListener)
    if (this.activeErrorListener) handle.off('error', this.activeErrorListener)
    this.activeHandle = null
    this.activeDataListener = null
    this.activeErrorListener = null
    this.activeDevice = null
    this.ambiguousDevices = []
    this.activeCapabilities = null
    this.pressedControls.clear()
    this.recentControlPackets.clear()
    this.clearHeartbeat()
    this.clearProtocolErrorFeedback()
    const disconnectedError = new Error('QMK Raw HID device disconnected before acknowledgement')
    for (const pending of [...this.pendingAcknowledgements.values()]) {
      this.failAcknowledgement(pending, disconnectedError)
    }
    this.clearAcknowledgementTombstones()
    safeClose(handle)
    this.setHealth('reconnecting')
    this.emit('connection', {
      connected: false,
      adapterId: this.adapterId,
      ...(device ? { deviceId: device.deviceId } : {}),
    } satisfies AdapterConnection)
    if (reconnect && !this.stopped) this.schedulePoll()
  }

  private sendReliable(
    packet: Buffer,
    messageType: QmkMessageType,
    sequence: number,
  ): Promise<void> {
    if (!this.activeHandle) return Promise.reject(new Error('QMK Raw HID device is not connected'))
    const key = acknowledgementKey(messageType, sequence)
    if (this.pendingAcknowledgements.has(key)) {
      return Promise.reject(new Error(`QMK acknowledgement key collision for ${key}`))
    }
    return new Promise((resolve, reject) => {
      const pending: PendingAcknowledgement = {
        key,
        packet,
        messageType,
        sequence,
        resolve,
        reject,
        attempts: 0,
        timer: null,
      }
      this.pendingAcknowledgements.set(key, pending)
      this.transmitPending(pending)
    })
  }

  private transmitPending(pending: PendingAcknowledgement): void {
    if (this.pendingAcknowledgements.get(pending.key) !== pending) return
    const handle = this.activeHandle
    if (!handle) {
      this.failAcknowledgement(pending, new Error('QMK Raw HID device is not connected'))
      return
    }
    pending.attempts += 1
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    try {
      writeNodeHidReport(handle, pending.packet)
    } catch (error) {
      const writeError = toError(error, 'Unable to write QMK Raw HID report')
      this.emitProtocolError(writeError, true, false)
      this.retryOrFailAcknowledgement(pending, writeError, true)
      return
    }
    if (this.pendingAcknowledgements.get(pending.key) !== pending) return
    pending.timer = setTimeout(
      () => this.retryOrFailAcknowledgement(pending, acknowledgementTimeoutError(pending), false),
      this.activeAcknowledgementTimeoutMs,
    )
    pending.timer.unref()
  }

  private retryOrFailAcknowledgement(
    pending: PendingAcknowledgement,
    finalError: Error,
    delayRetry: boolean,
  ): void {
    if (this.pendingAcknowledgements.get(pending.key) !== pending) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = null
    if (pending.attempts <= MAXIMUM_RETRIES) {
      if (delayRetry) {
        pending.timer = setTimeout(
          () => this.transmitPending(pending),
          this.activeAcknowledgementTimeoutMs,
        )
        pending.timer.unref()
      } else {
        this.transmitPending(pending)
      }
      return
    }
    this.failAcknowledgement(pending, finalError)
    this.emitProtocolError(finalError, true, false)
    this.disconnect(true)
  }

  private completeAcknowledgement(pending: PendingAcknowledgement): void {
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingAcknowledgements.delete(pending.key)
    this.rememberCompletedAcknowledgement(pending)
    pending.resolve()
  }

  private failAcknowledgement(pending: PendingAcknowledgement, error: Error): void {
    if (pending.timer) clearTimeout(pending.timer)
    this.pendingAcknowledgements.delete(pending.key)
    pending.reject(error)
  }

  private nextSequence(): number {
    for (let count = 0; count <= 0xff; count += 1) {
      const current = this.sequence
      this.sequence = (this.sequence + 1) & 0xff
      const inUse = [...this.pendingAcknowledgements.values()].some(
        (pending) => pending.sequence === current,
      )
      const tombstoned = [...this.completedAcknowledgements.values()].some(
        (completed) => completed.sequence === current,
      )
      if (!inUse && !tombstoned) return current
    }
    throw new Error('All QMK protocol sequence numbers are pending or awaiting safe reuse')
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const heartbeatFeedback = this.displayedFeedback ?? this.lastFeedback
      if (heartbeatFeedback) {
        void this.sendFeedback(heartbeatFeedback).catch(() => {})
      } else {
        this.ping()
      }
    }, this.activeHeartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private schedulePoll(): void {
    if (this.stopped || this.pollTimer || this.activeHandle) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.scanNow().then((connected) => {
        if (!connected) this.schedulePoll()
      })
    }, this.pollIntervalMs)
    this.pollTimer.unref()
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private closeProbe(): void {
    if (this.probingHandle) safeClose(this.probingHandle)
    this.probingHandle = null
  }

  private clearProtocolErrorFeedback(): void {
    if (this.protocolErrorFeedbackTimer) clearTimeout(this.protocolErrorFeedbackTimer)
    this.protocolErrorFeedbackTimer = null
    this.displayedFeedback = null
  }

  private showProtocolErrorFeedback(): void {
    if (!this.activeHandle || !this.lastFeedback) return
    this.clearProtocolErrorFeedback()
    const errorFrame: FeedbackFrame = {
      selectedSlot: this.lastFeedback.selectedSlot,
      slots: this.lastFeedback.slots.map((slot) => ({
        ...slot,
        state: slot.state === 'off' ? 'off' : 'error',
      })),
    }
    this.displayedFeedback = errorFrame
    this.protocolErrorFeedbackTimer = setTimeout(() => {
      this.protocolErrorFeedbackTimer = null
      this.displayedFeedback = null
      if (this.activeHandle && this.lastFeedback) {
        void this.sendFeedback(this.lastFeedback).catch(() => {})
      }
    }, this.protocolErrorFeedbackMs)
    this.protocolErrorFeedbackTimer.unref()
    void this.sendFeedback(errorFrame).catch(() => {})
  }

  private rememberCompletedAcknowledgement(pending: PendingAcknowledgement): void {
    const existing = this.completedAcknowledgements.get(pending.key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(
      () => this.completedAcknowledgements.delete(pending.key),
      this.activeAcknowledgementTimeoutMs * (MAXIMUM_RETRIES + 1),
    )
    timer.unref()
    this.completedAcknowledgements.set(pending.key, { sequence: pending.sequence, timer })
  }

  private clearAcknowledgementTombstones(): void {
    for (const completed of this.completedAcknowledgements.values()) {
      clearTimeout(completed.timer)
    }
    this.completedAcknowledgements.clear()
  }

  private rememberControlPacket(identity: string, controlId: string): void {
    this.recentControlPackets.set(identity, controlId)
    while (this.recentControlPackets.size > 256) {
      const oldest = this.recentControlPackets.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.recentControlPackets.delete(oldest)
    }
  }

  private forgetControlPackets(controlId: string): void {
    for (const [identity, rememberedControl] of this.recentControlPackets) {
      if (rememberedControl === controlId) this.recentControlPackets.delete(identity)
    }
  }

  private setHealth(health: QmkAdapterHealth, error?: Error): void {
    if (this.adapterHealth === health && !error) return
    this.adapterHealth = health
    this.emit('health', {
      health,
      ...(error ? { error } : {}),
    } satisfies QmkAdapterHealthEvent)
  }

  private emitProtocolError(
    error: Error,
    degrade = this.activeHandle !== null,
    show = degrade,
  ): void {
    this.emit('protocolError', error)
    if (degrade) this.setHealth('degraded', error)
    if (show) this.showProtocolErrorFeedback()
  }
}

function normalizeNodeHidReport(data: Uint8Array): Buffer | null {
  if (data.length === QMK_RAW_HID_REPORT_SIZE) return Buffer.from(data)
  if (data.length === QMK_RAW_HID_REPORT_SIZE + 1 && data[0] === 0) {
    return Buffer.from(data.subarray(1))
  }
  return null
}

function isOpenControlReport(report: Uint8Array): boolean {
  return (
    report[0] === OPENCONTROL_QMK_NAMESPACE &&
    report[1] === OPENCONTROL_QMK_MAGIC[0] &&
    report[2] === OPENCONTROL_QMK_MAGIC[1]
  )
}

/** node-hid requires a report-ID byte before the fixed 32-byte Raw HID body. */
function writeNodeHidReport(handle: QmkHidHandle, packet: Uint8Array): void {
  if (packet.length !== QMK_RAW_HID_REPORT_SIZE) {
    throw new QmkProtocolError('Attempted to write a non-32-byte QMK report', 'invalid-length')
  }
  const report = Buffer.concat([Buffer.of(0), Buffer.from(packet)])
  const bytesWritten = handle.write(report)
  if (bytesWritten !== report.length) {
    throw new Error(
      `QMK Raw HID write was incomplete: expected ${report.length} bytes, wrote ${bytesWritten}`,
    )
  }
}

function publicDeviceIdentity(
  device: Device,
  capabilities: AdapterCapabilities,
  distinguishPath = false,
): EnrollableQmkConnectedDevice {
  const transport = enrollmentTransport(capabilities)
  const fingerprint = createDeviceFingerprint({
    vendorId: device.vendorId,
    productId: device.productId,
    transport,
    ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
  })
  const deviceId = distinguishPath
    ? `qmk:${fingerprint}:${shortIdentity(device.path ?? 'missing')}`
    : `qmk:${fingerprint}`
  return {
    deviceId,
    fingerprint,
    vendorId: device.vendorId,
    productId: device.productId,
    transport,
    label: safeDeviceLabel(device.product, 'OpenControl QMK keyboard'),
    generic: false,
    ...(device.serialNumber === undefined ? {} : { serialNumber: device.serialNumber }),
    ...(device.manufacturer === undefined
      ? {}
      : { manufacturer: safeDeviceLabel(device.manufacturer, 'Unknown manufacturer') }),
    ...(device.product === undefined
      ? {}
      : { product: safeDeviceLabel(device.product, 'OpenControl QMK keyboard') }),
  }
}

function matchesEnrollment(result: ProbeResult, enrolled: EnrolledDevice): boolean {
  const identity = publicDeviceIdentity(result.device, result.capabilities)
  return (
    enrolled.generic === false &&
    identity.fingerprint === enrolled.fingerprint &&
    identity.vendorId === enrolled.vendorId &&
    identity.productId === enrolled.productId &&
    identity.transport === enrolled.transport
  )
}

function enrollmentTransport(capabilities: AdapterCapabilities): EnrolledDeviceTransport {
  switch (capabilities.transport) {
    case 'usb':
    case 'bluetooth':
    case 'unknown':
      return capabilities.transport
    case '2.4ghz':
    case 'gamepad':
    case 'terminal':
      return 'unknown'
  }
}

function shortIdentity(value: string): string {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(value)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function acknowledgementKey(messageType: QmkMessageType, sequence: number): string {
  return `${messageType}:${sequence}`
}

function acknowledgementTimeoutError(pending: PendingAcknowledgement): Error {
  return new Error(
    `Timed out waiting for ACK of message ${pending.messageType} sequence ${pending.sequence}`,
  )
}

function safeClose(handle: QmkHidHandle): void {
  try {
    handle.close()
  } catch {
    // A disconnected HID handle is already closed from the OS perspective.
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) throw new Error('Timer durations must be positive')
  return value
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback)
}
