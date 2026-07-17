import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTROL_IDS } from '../src/input/types.js'
import type { ControlPhase, FeedbackFrame } from '../src/input/types.js'
import {
  decodeAcknowledgement,
  decodeControlEvent,
  decodeDeviceError,
  decodeHelloAck,
  decodeQmkPacket,
  decodeTaskStates,
  encodeAcknowledgement,
  encodeControlEvent,
  encodeDeviceError,
  encodeHello,
  encodeHelloAck,
  encodePing,
  encodeQmkPacket,
  encodeTaskStates,
  OPENCONTROL_QMK_PROTOCOL_MAJOR,
  QMK_ALL_CAPABILITIES,
  QMK_RAW_HID_REPORT_SIZE,
  QmkErrorCode,
  QmkMessageType,
  QmkPacketFlag,
} from '../src/input/qmk-protocol.js'

interface SharedProtocolVectors {
  readonly protocol: number
  readonly reportSize: number
  readonly vectors: readonly {
    readonly name: string
    readonly direction: 'host-to-device' | 'device-to-host'
    readonly bytes: readonly number[]
  }[]
}

const sharedVectors = JSON.parse(
  readFileSync(new URL('../firmware/tests/protocol_vectors.json', import.meta.url), 'utf8'),
) as SharedProtocolVectors

function firmwareVector(name: string): Buffer {
  const vector = sharedVectors.vectors.find((candidate) => candidate.name === name)
  if (!vector) throw new Error(`Missing firmware protocol vector: ${name}`)
  return Buffer.from(vector.bytes)
}

describe('QMK Raw HID protocol v1', () => {
  it('uses the same protocol and report size as the firmware vectors', () => {
    expect(sharedVectors.protocol).toBe(OPENCONTROL_QMK_PROTOCOL_MAJOR)
    expect(sharedVectors.reportSize).toBe(QMK_RAW_HID_REPORT_SIZE)
    for (const vector of sharedVectors.vectors) expect(vector.bytes).toHaveLength(32)
  })

  it('matches the firmware HELLO vector with a one-byte minor version', () => {
    const encoded = encodeHello(42)
    expect(encoded).toEqual(firmwareVector('hello_host_to_device'))
    expect(decodeQmkPacket(encoded)).toMatchObject({
      major: OPENCONTROL_QMK_PROTOCOL_MAJOR,
      type: QmkMessageType.HELLO,
      sequence: 42,
      flags: 0,
      payload: Buffer.of(0),
    })
  })

  it('matches and decodes the canonical eight-byte HELLO_ACK', () => {
    const encoded = encodeHelloAck(42, {
      capabilityFlags: QMK_ALL_CAPABILITIES,
      configuredLayer: 3,
    })
    expect(encoded).toEqual(firmwareVector('hello_ack_all_capabilities'))
    const packet = decodeQmkPacket(encoded)
    expect(packet.flags).toBe(QmkPacketFlag.RESPONSE)
    expect(decodeHelloAck(packet)).toEqual({
      protocolMinor: 0,
      capabilityFlags: 0x3b,
      agentCount: 6,
      controlCount: 19,
      reportSize: 32,
      configuredLayer: 3,
      heartbeatSeconds: 5,
    })
  })

  it('rejects incompatible protocol-v1 HELLO_ACK cardinalities', () => {
    const invalid = [
      encodeHelloAck(1, { capabilityFlags: 0, reportSize: 31 }),
      encodeHelloAck(1, { capabilityFlags: 0, agentCount: 5 }),
      encodeHelloAck(1, { capabilityFlags: 0, controlCount: 18 }),
      encodeHelloAck(1, { capabilityFlags: 0, heartbeatSeconds: 0 }),
    ]
    for (const report of invalid) {
      expect(() => decodeHelloAck(decodeQmkPacket(report))).toThrow()
    }
  })

  it('matches and decodes the canonical ten-byte flat control event', () => {
    const encoded = encodeControlEvent(7, 'agent.1', 'press', {
      row: 2,
      column: 4,
      qmkEventType: 1,
      layer: 3,
      deviceTimestamp: 0x12345678,
    })
    expect(encoded).toEqual(firmwareVector('agent_1_press'))
    const packet = decodeQmkPacket(encoded)
    expect(packet.flags).toBe(QmkPacketFlag.ASYNC)
    expect(decodeControlEvent(packet)).toEqual({
      controlId: 'agent.1',
      phase: 'press',
      row: 2,
      column: 4,
      qmkEventType: 1,
      layer: 3,
      deviceTimestamp: 0x12345678,
    })
  })

  it('round-trips every firmware control ID and phase', () => {
    const phases: readonly ControlPhase[] = ['press', 'release', 'repeat']
    for (const controlId of CONTROL_IDS) {
      for (const phase of phases) {
        expect(
          decodeControlEvent(decodeQmkPacket(encodeControlEvent(255, controlId, phase))),
        ).toEqual({
          controlId,
          phase,
          row: 0,
          column: 0,
          qmkEventType: 0,
          layer: 0,
          deviceTimestamp: 0,
        })
      }
    }
  })

  it('matches zero-based selection, six states, and unread-mask firmware layout', () => {
    const frame: FeedbackFrame = {
      selectedSlot: 2,
      slots: [
        { slot: 1, state: 'idle', unread: false },
        { slot: 2, state: 'executing', unread: false },
        { slot: 3, state: 'waiting', unread: false },
        { slot: 4, state: 'complete', unread: true },
        { slot: 5, state: 'error', unread: false },
      ],
    }
    const encoded = encodeTaskStates(8, frame)
    expect(encoded).toEqual(firmwareVector('task_states'))
    expect(decodeTaskStates(decodeQmkPacket(encoded))).toEqual({
      selectedSlot: 2,
      slots: [
        { slot: 1, state: 'idle', unread: false },
        { slot: 2, state: 'executing', unread: false },
        { slot: 3, state: 'waiting', unread: false },
        { slot: 4, state: 'complete', unread: true },
        { slot: 5, state: 'error', unread: false },
        { slot: 6, state: 'off', unread: false },
      ],
    })
  })

  it('uses 0xFF for no selected task', () => {
    const packet = decodeQmkPacket(encodeTaskStates(1, { selectedSlot: null, slots: [] }))
    expect(packet.payload[0]).toBe(0xff)
    expect(decodeTaskStates(packet).selectedSlot).toBeNull()
  })

  it('matches firmware PING, ACK, and ERROR vectors', () => {
    const timestamp = Buffer.alloc(4)
    timestamp.writeUInt32LE(0x12345678)
    expect(encodePing(9, timestamp)).toEqual(firmwareVector('ping'))

    const acknowledgement = encodeAcknowledgement(9, QmkMessageType.PING)
    expect(acknowledgement).toEqual(firmwareVector('ping_ack'))
    expect(decodeAcknowledgement(decodeQmkPacket(acknowledgement))).toEqual({
      acknowledgedType: QmkMessageType.PING,
      acknowledgedSequence: 9,
    })

    const deviceError = encodeDeviceError(
      10,
      QmkErrorCode.MALFORMED_PAYLOAD,
      QmkMessageType.TASK_STATES,
      8,
    )
    expect(deviceError).toEqual(firmwareVector('malformed_task_states_error'))
    expect(decodeDeviceError(decodeQmkPacket(deviceError))).toEqual({
      code: QmkErrorCode.MALFORMED_PAYLOAD,
      offendingType: QmkMessageType.TASK_STATES,
      detail: 8,
    })
  })

  it('rejects duplicate feedback slots', () => {
    expect(() =>
      encodeTaskStates(1, {
        selectedSlot: null,
        slots: [
          { slot: 1, state: 'idle', unread: false },
          { slot: 1, state: 'error', unread: false },
        ],
      }),
    ).toThrow(/Duplicate task slot/)
  })

  it('rejects malformed frames without reading beyond the report', () => {
    expect(() => decodeQmkPacket(Buffer.alloc(31))).toThrow(/exactly 32 bytes/)
    expect(() => decodeQmkPacket(Buffer.alloc(32))).toThrow(/namespace/)

    const oversized = encodeHello(1)
    oversized[6] = 25
    expect(() => decodeQmkPacket(oversized)).toThrow(/payload length/)
    expect(() =>
      encodeQmkPacket({
        type: QmkMessageType.PING,
        sequence: 1,
        payload: Buffer.alloc(25),
      }),
    ).toThrow(/cannot exceed 24/)
  })

  it('rejects unknown flat controls, phases, states, and selected indexes', () => {
    const unknownControl = encodeQmkPacket({
      type: QmkMessageType.CONTROL_EVENT,
      sequence: 1,
      payload: Buffer.from([0x07, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
    })
    expect(() => decodeControlEvent(decodeQmkPacket(unknownControl))).toThrow(/control ID/)

    const unknownPhase = encodeQmkPacket({
      type: QmkMessageType.CONTROL_EVENT,
      sequence: 1,
      payload: Buffer.from([0x01, 9, 0, 0, 0, 0, 0, 0, 0, 0]),
    })
    expect(() => decodeControlEvent(decodeQmkPacket(unknownPhase))).toThrow(/phase/)

    const invalidStates = encodeQmkPacket({
      type: QmkMessageType.TASK_STATES,
      sequence: 1,
      payload: Buffer.from([6, 9, 0, 0, 0, 0, 0, 0]),
    })
    expect(() => decodeTaskStates(decodeQmkPacket(invalidStates))).toThrow(/selected task index/)
  })
})
