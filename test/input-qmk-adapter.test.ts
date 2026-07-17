import { EventEmitter } from 'node:events'
import type { Device } from 'node-hid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findQmkRawHidCandidates, QmkRawHidAdapter } from '../src/input/qmk-raw-hid-adapter.js'
import type { QmkHidBackend, QmkHidHandle } from '../src/input/qmk-raw-hid-adapter.js'
import { createDeviceFingerprint } from '../src/layers.js'
import {
  decodeQmkPacket,
  encodeAcknowledgement,
  encodeControlEvent,
  encodeHelloAck,
  QMK_RAW_HID_USAGE,
  QMK_RAW_HID_USAGE_PAGE,
  QmkCapabilityFlag,
  QmkMessageType,
} from '../src/input/qmk-protocol.js'

interface FakeHidOptions {
  readonly respondHello?: boolean
  readonly acknowledgeMessages?: boolean
  readonly helloAck?: Parameters<typeof encodeHelloAck>[1]
}

class FakeHidHandle extends EventEmitter implements QmkHidHandle {
  readonly writes: Buffer[] = []
  readonly writeResults: number[] = []
  closed = false

  constructor(private readonly options: boolean | FakeHidOptions = true) {
    super()
  }

  write(data: number[] | Buffer): number {
    const report = Buffer.from(data)
    this.writes.push(report)
    const writeResult = this.writeResults.shift()
    if (writeResult !== undefined && writeResult <= 0) return writeResult
    const packet = decodeQmkPacket(report.subarray(1))
    const respondHello =
      typeof this.options === 'boolean' ? this.options : (this.options.respondHello ?? true)
    if (respondHello && packet.type === QmkMessageType.HELLO) {
      queueMicrotask(() => {
        this.emit(
          'data',
          encodeHelloAck(
            packet.sequence,
            typeof this.options === 'boolean'
              ? defaultHelloAck()
              : (this.options.helloAck ?? defaultHelloAck()),
          ),
        )
      })
    } else if (
      typeof this.options !== 'boolean' &&
      this.options.acknowledgeMessages &&
      (packet.type === QmkMessageType.PING || packet.type === QmkMessageType.TASK_STATES)
    ) {
      queueMicrotask(() => {
        this.emit('data', encodeAcknowledgement(packet.sequence, packet.type, packet.sequence))
      })
    }
    return writeResult ?? report.length
  }

  close(): void {
    this.closed = true
  }
}

function defaultHelloAck(): Parameters<typeof encodeHelloAck>[1] {
  return {
    capabilityFlags:
      QmkCapabilityFlag.RGB_MATRIX |
      QmkCapabilityFlag.ENCODER |
      QmkCapabilityFlag.PRESS_RELEASE |
      QmkCapabilityFlag.USB,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

function device(overrides: Partial<Device> = {}): Device {
  return {
    vendorId: 0x3434,
    productId: 0x0abc,
    path: 'qmk-path',
    serialNumber: 'SERIAL-1',
    manufacturer: 'Example',
    product: 'QMK board',
    release: 1,
    interface: 1,
    usagePage: QMK_RAW_HID_USAGE_PAGE,
    usage: QMK_RAW_HID_USAGE,
    ...overrides,
  }
}

function backendFor(devices: Device[], factory: (path: string) => FakeHidHandle): QmkHidBackend {
  return { devices: () => devices, open: factory }
}

function qmkFingerprint(serialNumber = 'SERIAL-1'): string {
  return createDeviceFingerprint({
    vendorId: 0x3434,
    productId: 0x0abc,
    transport: 'usb',
    serialNumber,
  })
}

describe('QmkRawHidAdapter discovery and handshake', () => {
  it('filters by QMK usage without hard-coding a VID/PID', () => {
    const unexpectedVendor = device({ vendorId: 0xbeef, productId: 0xcafe, path: 'valid' })
    expect(
      findQmkRawHidCandidates([
        device({ path: 'wrong-page', usagePage: 0x01 }),
        device({ path: 'wrong-usage', usage: 0x62 }),
        device({ path: undefined }),
        unexpectedVendor,
      ]),
    ).toEqual([unexpectedVendor])
  })

  it('claims a candidate only after a matching HELLO_ACK', async () => {
    const silent = new FakeHidHandle(false)
    const connections: boolean[] = []
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => silent),
      handshakeTimeoutMs: 5,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    adapter.onConnectionChange((connection) => connections.push(connection.connected))

    await adapter.start()
    expect(adapter.connectedDevice).toBeNull()
    expect(adapter.capabilities).toBeNull()
    expect(connections).toEqual([])
    expect(silent.writes).toHaveLength(1)
    expect(decodeQmkPacket(silent.writes[0]!.subarray(1)).type).toBe(QmkMessageType.HELLO)
    expect(silent.closed).toBe(true)
    adapter.stop()
  })

  it('skips a non-responsive interface and claims a compatible one', async () => {
    const silent = new FakeHidHandle(false)
    const compatible = new FakeHidHandle(true)
    const opened: string[] = []
    const adapter = new QmkRawHidAdapter({
      backend: backendFor(
        [
          device({ serialNumber: 'A', path: 'a-path' }),
          device({ serialNumber: 'B', path: 'b-path' }),
        ],
        (path) => {
          opened.push(path)
          return path === 'a-path' ? silent : compatible
        },
      ),
      handshakeTimeoutMs: 5,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })

    await adapter.start()
    expect(opened).toEqual(['a-path', 'b-path'])
    expect(silent.closed).toBe(true)
    expect(adapter.connectedDevice?.serialNumber).toBe('B')
    expect(adapter.capabilities).toEqual({
      protocolVersion: { major: 1, minor: 0 },
      transport: 'usb',
      pressRelease: true,
      repeat: true,
      encoder: true,
      rgbFeedback: true,
      ledFeedback: false,
      taskSlots: 6,
    })
    adapter.stop()
  })

  it('uses an explicit serial number to disambiguate candidates', async () => {
    const opened: string[] = []
    const adapter = new QmkRawHidAdapter({
      serialNumber: 'B',
      backend: backendFor(
        [
          device({ serialNumber: 'A', path: 'a-path' }),
          device({ serialNumber: 'B', path: 'b-path' }),
        ],
        (path) => {
          opened.push(path)
          return new FakeHidHandle(true)
        },
      ),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })

    await adapter.start()
    expect(opened).toEqual(['b-path'])
    expect(adapter.connectedDevice?.serialNumber).toBe('B')
    adapter.stop()
  })

  it('matches an enrolled fingerprint only after compatible handshakes complete', async () => {
    const opened: string[] = []
    const adapter = new QmkRawHidAdapter({
      enrolledDevice: {
        fingerprint: qmkFingerprint('B'),
        vendorId: 0x3434,
        productId: 0x0abc,
        transport: 'usb',
        label: 'Board B',
        generic: false,
      },
      backend: backendFor(
        [
          device({ serialNumber: 'A', path: 'a-path' }),
          device({ serialNumber: 'B', path: 'b-path' }),
        ],
        (path) => {
          opened.push(path)
          return new FakeHidHandle(true)
        },
      ),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })

    await adapter.start()
    expect(opened).toEqual(['a-path', 'b-path'])
    expect(adapter.connectedDevice?.fingerprint).toBe(qmkFingerprint('B'))
    expect(adapter.connectedDevice?.serialNumber).toBe('B')
    adapter.stop()
  })

  it('refuses to choose arbitrarily when multiple compatible devices are connected', async () => {
    const handles = [new FakeHidHandle(true), new FakeHidHandle(true)]
    const errors: Error[] = []
    let opened = 0
    const adapter = new QmkRawHidAdapter({
      backend: backendFor(
        [
          device({ serialNumber: 'A', path: 'a-path' }),
          device({ serialNumber: 'B', path: 'b-path' }),
        ],
        () => handles[opened++]!,
      ),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    adapter.onProtocolError((error) => errors.push(error))

    await adapter.start()
    expect(adapter.connectedDevice).toBeNull()
    expect(adapter.compatibleDevices.map((candidate) => candidate.serialNumber)).toEqual(['A', 'B'])
    expect(handles.every((handle) => handle.closed)).toBe(true)
    expect(errors[0]?.message).toMatch(/serial number/)
    adapter.stop()
  })

  it('rejects incompatible report, slot, control, and heartbeat cardinalities', async () => {
    const invalidAcknowledgements: Parameters<typeof encodeHelloAck>[1][] = [
      { ...defaultHelloAck(), reportSize: 31 },
      { ...defaultHelloAck(), agentCount: 5 },
      { ...defaultHelloAck(), controlCount: 18 },
      { ...defaultHelloAck(), heartbeatSeconds: 0 },
    ]

    for (const helloAck of invalidAcknowledgements) {
      const handle = new FakeHidHandle({ helloAck })
      const errors: Error[] = []
      const adapter = new QmkRawHidAdapter({
        backend: backendFor([device()], () => handle),
        pollIntervalMs: 60_000,
      })
      adapter.onProtocolError((error) => errors.push(error))

      await adapter.start()
      expect(adapter.connectedDevice).toBeNull()
      expect(handle.closed).toBe(true)
      expect(errors).toHaveLength(1)
      adapter.stop()
    }
  })

  it('rejects missing and duplicate serials while exposing distinct candidate identities', async () => {
    const cases: Device[][] = [
      [
        device({ serialNumber: undefined, path: 'missing-a' }),
        device({ serialNumber: undefined, path: 'missing-b' }),
      ],
      [
        device({ serialNumber: 'DUPLICATE', path: 'duplicate-a' }),
        device({ serialNumber: 'DUPLICATE', path: 'duplicate-b' }),
      ],
    ]

    for (const devices of cases) {
      const adapter = new QmkRawHidAdapter({
        backend: backendFor(devices, () => new FakeHidHandle(true)),
        pollIntervalMs: 60_000,
      })
      const errors: Error[] = []
      adapter.onProtocolError((error) => errors.push(error))
      await adapter.start()

      expect(adapter.connectedDevice).toBeNull()
      expect(new Set(adapter.compatibleDevices.map((candidate) => candidate.deviceId)).size).toBe(2)
      expect(errors.at(-1)?.message).toMatch(/missing or duplicate serial/)
      adapter.stop()
    }
  })

  it('reports encoder support only when firmware advertises Encoder Map capability', async () => {
    const handle = new FakeHidHandle({
      helloAck: {
        ...defaultHelloAck(),
        capabilityFlags: QmkCapabilityFlag.PRESS_RELEASE | QmkCapabilityFlag.USB,
      },
    })
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      pollIntervalMs: 60_000,
    })

    await adapter.start()
    expect(adapter.capabilities?.encoder).toBe(false)
    adapter.stop()
  })

  it('does not claim monochrome feedback for the reserved preview LED Matrix bit', async () => {
    const handle = new FakeHidHandle({
      helloAck: {
        ...defaultHelloAck(),
        capabilityFlags:
          QmkCapabilityFlag.PRESS_RELEASE | QmkCapabilityFlag.LED_MATRIX | QmkCapabilityFlag.USB,
      },
    })
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      pollIntervalMs: 60_000,
    })

    await adapter.start()
    expect(adapter.capabilities).toMatchObject({
      rgbFeedback: false,
      ledFeedback: false,
    })
    adapter.stop()
  })
})

describe('QmkRawHidAdapter events and feedback', () => {
  it('emits semantic control events from 32- and 33-byte reports', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      now: () => 1234,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    const controls: unknown[] = []
    adapter.onControl((event) => controls.push(event))
    await adapter.start()

    handle.emit('data', encodeControlEvent(10, 'agent.4', 'press'))
    handle.emit('data', Buffer.concat([Buffer.of(0), encodeControlEvent(11, 'dial.cw', 'repeat')]))

    expect(controls).toEqual([
      {
        controlId: 'agent.4',
        phase: 'press',
        sourceId: `qmk:${qmkFingerprint()}`,
        timestamp: 1234,
      },
      {
        controlId: 'dial.cw',
        phase: 'repeat',
        sourceId: `qmk:${qmkFingerprint()}`,
        timestamp: 1234,
      },
    ])
    adapter.stop()
  })

  it('drops replayed packets and repeated presses until a release edge', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    const phases: string[] = []
    adapter.onControl((event) => phases.push(`${event.controlId}:${event.phase}`))
    await adapter.start()

    const firstPress = encodeControlEvent(10, 'command.approve', 'press')
    handle.emit('data', firstPress)
    handle.emit('data', firstPress)
    handle.emit('data', encodeControlEvent(11, 'command.approve', 'press'))
    handle.emit('data', encodeControlEvent(12, 'command.approve', 'release'))
    handle.emit('data', encodeControlEvent(13, 'command.approve', 'press'))

    expect(phases).toEqual([
      'command.approve:press',
      'command.approve:release',
      'command.approve:press',
    ])
    adapter.stop()
  })

  it('writes task feedback as a report-ID byte plus a 32-byte packet', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    await adapter.start()
    adapter.updateFeedback({
      selectedSlot: 1,
      slots: [{ slot: 1, state: 'executing', unread: false }],
    })

    const write = handle.writes.at(-1)!
    expect(write).toHaveLength(33)
    expect(write[0]).toBe(0)
    const packet = decodeQmkPacket(write.subarray(1))
    expect(packet.type).toBe(QmkMessageType.TASK_STATES)
    expect([...packet.payload]).toEqual([0, 2, 0, 0, 0, 0, 0, 0])
    adapter.stop()
  })

  it('matches acknowledgements by both message type and sequence', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      acknowledgementTimeoutMs: 1000,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    await adapter.start()
    let settled = false
    const acknowledged = adapter
      .updateFeedbackAndWait({
        selectedSlot: 1,
        slots: [{ slot: 1, state: 'executing', unread: false }],
      })
      .then(() => {
        settled = true
      })
    const taskPacket = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))

    handle.emit(
      'data',
      encodeAcknowledgement(taskPacket.sequence, QmkMessageType.PING, taskPacket.sequence),
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    handle.emit(
      'data',
      encodeAcknowledgement(taskPacket.sequence, QmkMessageType.TASK_STATES, taskPacket.sequence),
    )
    await acknowledged
    expect(settled).toBe(true)
    adapter.stop()
  })

  it('ignores a delayed duplicate ACK after a retry completes', async () => {
    const handle = new FakeHidHandle(true)
    const errors: Error[] = []
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      acknowledgementTimeoutMs: 10,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    adapter.onProtocolError((error) => errors.push(error))
    await adapter.start()
    vi.useFakeTimers()

    const acknowledged = adapter.pingAndWait()
    const ping = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))
    await vi.advanceTimersByTimeAsync(10)
    expect(
      handle.writes
        .map((write) => decodeQmkPacket(write.subarray(1)).type)
        .filter((type) => type === QmkMessageType.PING),
    ).toHaveLength(2)

    const acknowledgement = encodeAcknowledgement(ping.sequence, QmkMessageType.PING, ping.sequence)
    handle.emit('data', acknowledgement)
    await acknowledged
    handle.emit('data', acknowledgement)
    handle.emit('data', acknowledgement)

    expect(errors).toEqual([])
    expect(adapter.health).toBe('connected')
    adapter.stop()
  })

  it('does not reuse wrapped sequence numbers until ACK tombstones expire', async () => {
    vi.useFakeTimers()
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      acknowledgementTimeoutMs: 10,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    const started = adapter.start()
    await vi.advanceTimersByTimeAsync(0)
    await started

    const sequences = new Set<number>()
    for (let index = 0; index < 256; index += 1) {
      const acknowledged = adapter.pingAndWait()
      const ping = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))
      sequences.add(ping.sequence)
      handle.emit('data', encodeAcknowledgement(ping.sequence, QmkMessageType.PING, ping.sequence))
      await acknowledged
    }
    expect(sequences.size).toBe(256)
    await expect(adapter.pingAndWait()).rejects.toThrow(/safe reuse/)

    await vi.advanceTimersByTimeAsync(30)
    const reused = adapter.pingAndWait()
    const ping = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))
    handle.emit('data', encodeAcknowledgement(ping.sequence, QmkMessageType.PING, ping.sequence))
    await reused
    adapter.stop()
  })

  it('retries a missing acknowledgement twice, then disconnects and reprobes', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      acknowledgementTimeoutMs: 10,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    await adapter.start()
    vi.useFakeTimers()
    const result = adapter
      .updateFeedbackAndWait({
        selectedSlot: null,
        slots: [{ slot: 1, state: 'idle', unread: false }],
      })
      .then(
        () => null,
        (error: unknown) => error,
      )

    await vi.advanceTimersByTimeAsync(30)
    expect(await result).toBeInstanceOf(Error)
    expect(
      handle.writes
        .map((write) => decodeQmkPacket(write.subarray(1)).type)
        .filter((type) => type === QmkMessageType.TASK_STATES),
    ).toHaveLength(3)
    expect(handle.closed).toBe(true)
    expect(adapter.connectedDevice).toBeNull()
    expect(adapter.health).toBe('reconnecting')
    adapter.stop()
  })

  it('retries positive partial and nonpositive HID writes as incomplete reports', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      acknowledgementTimeoutMs: 10,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    await adapter.start()
    handle.writeResults.push(32, 1, 0)
    vi.useFakeTimers()
    const result = adapter.pingAndWait().then(
      () => null,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toBeInstanceOf(Error)
    expect(
      handle.writes
        .map((write) => decodeQmkPacket(write.subarray(1)).type)
        .filter((type) => type === QmkMessageType.PING),
    ).toHaveLength(3)
    expect(handle.closed).toBe(true)
    adapter.stop()
  })

  it('negotiates a safe cadence and resends cached task state on every heartbeat', async () => {
    vi.useFakeTimers()
    const handle = new FakeHidHandle({ acknowledgeMessages: true })
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      heartbeatIntervalMs: 60_000,
      pollIntervalMs: 60_000,
    })
    const started = adapter.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    await adapter.updateFeedbackAndWait({
      selectedSlot: 2,
      slots: [{ slot: 2, state: 'waiting', unread: false }],
    })
    handle.writes.length = 0

    await vi.advanceTimersByTimeAsync(2499)
    expect(handle.writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(handle.writes).toHaveLength(1)
    const heartbeat = decodeQmkPacket(handle.writes[0]!.subarray(1))
    expect(heartbeat.type).toBe(QmkMessageType.TASK_STATES)
    expect([...heartbeat.payload]).toEqual([1, 0, 3, 0, 0, 0, 0, 0])
    adapter.stop()
  })

  it('heartbeats a long-lived red error frame, then restores the latest normal feedback', async () => {
    vi.useFakeTimers()
    const handle = new FakeHidHandle({ acknowledgeMessages: true })
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      heartbeatIntervalMs: 60_000,
      pollIntervalMs: 60_000,
      protocolErrorFeedbackMs: 6000,
    })
    const health: string[] = []
    adapter.onHealthChange((event) => health.push(event.health))
    const started = adapter.start()
    await vi.advanceTimersByTimeAsync(0)
    await started
    await adapter.updateFeedbackAndWait({
      selectedSlot: 1,
      slots: [
        { slot: 1, state: 'executing', unread: false },
        { slot: 2, state: 'off', unread: false },
      ],
    })
    handle.writes.length = 0

    const malformed = encodeControlEvent(1, 'agent.1', 'press')
    malformed[6] = 24
    handle.emit('data', malformed)
    await vi.advanceTimersByTimeAsync(0)
    const errorFeedback = decodeQmkPacket(handle.writes[0]!.subarray(1))
    expect(errorFeedback.type).toBe(QmkMessageType.TASK_STATES)
    expect([...errorFeedback.payload.subarray(1, 3)]).toEqual([5, 0])
    expect(health).toContain('degraded')

    await vi.advanceTimersByTimeAsync(2500)
    let heartbeat = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))
    expect([...heartbeat.payload.subarray(1, 3)]).toEqual([5, 0])

    adapter.updateFeedback({
      selectedSlot: 1,
      slots: [
        { slot: 1, state: 'waiting', unread: false },
        { slot: 2, state: 'off', unread: false },
      ],
    })
    await vi.advanceTimersByTimeAsync(2500)
    heartbeat = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))
    expect([...heartbeat.payload.subarray(1, 3)]).toEqual([5, 0])

    await vi.advanceTimersByTimeAsync(1000)
    const restored = decodeQmkPacket(handle.writes.at(-1)!.subarray(1))
    expect([...restored.payload.subarray(1, 3)]).toEqual([3, 0])
    expect(adapter.health).toBe('connected')
    adapter.stop()
  })

  it('ignores foreign VIA traffic and reports malformed OpenControl packets', async () => {
    const handle = new FakeHidHandle(true)
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => handle),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    const errors: Error[] = []
    adapter.onProtocolError((error) => errors.push(error))
    await adapter.start()

    handle.emit('data', Buffer.alloc(32))
    expect(errors).toEqual([])

    const malformed = encodeControlEvent(1, 'agent.1', 'press')
    malformed[6] = 24
    handle.emit('data', malformed)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/ten payload bytes/)
    adapter.stop()
  })

  it('disconnects cleanly on a HID error and can hotplug a replacement', async () => {
    const first = new FakeHidHandle(true)
    const replacement = new FakeHidHandle(true)
    let opens = 0
    const states: boolean[] = []
    const adapter = new QmkRawHidAdapter({
      backend: backendFor([device()], () => (opens++ === 0 ? first : replacement)),
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    adapter.onConnectionChange((connection) => states.push(connection.connected))
    await adapter.start()
    first.emit('error', new Error('unplugged'))
    expect(adapter.connectedDevice).toBeNull()

    expect(await adapter.scanNow()).toBe(true)
    expect(adapter.connectedDevice?.serialNumber).toBe('SERIAL-1')
    expect(states).toEqual([true, false, true])
    adapter.stop()
  })
})
