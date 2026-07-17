import type {
  ControlId,
  ControlPhase,
  FeedbackFrame,
  TaskFeedbackState,
  TaskSlotFeedback,
} from './types.js'
import { isTaskSlot } from './types.js'

export const QMK_RAW_HID_USAGE_PAGE = 0xff60
export const QMK_RAW_HID_USAGE = 0x61
export const QMK_RAW_HID_REPORT_SIZE = 32
export const QMK_RAW_HID_HEADER_SIZE = 8
export const QMK_RAW_HID_MAX_PAYLOAD = QMK_RAW_HID_REPORT_SIZE - QMK_RAW_HID_HEADER_SIZE

export const OPENCONTROL_QMK_NAMESPACE = 0xe0
export const OPENCONTROL_QMK_MAGIC = Buffer.from('OC', 'ascii')
export const OPENCONTROL_QMK_PROTOCOL_MAJOR = 1
export const OPENCONTROL_QMK_PROTOCOL_MINOR = 0
export const OPENCONTROL_QMK_AGENT_COUNT = 6
export const OPENCONTROL_QMK_CONTROL_COUNT = 19
export const OPENCONTROL_QMK_SELECTED_NONE = 0xff

export enum QmkMessageType {
  HELLO = 0x01,
  HELLO_ACK = 0x02,
  CONTROL_EVENT = 0x03,
  TASK_STATES = 0x04,
  PING = 0x05,
  ACK = 0x06,
  ERROR = 0x7f,
}

export enum QmkPacketFlag {
  RESPONSE = 1 << 0,
  ASYNC = 1 << 1,
}

/** Capability bit assignments are shared verbatim with firmware/opencontrol.h. */
export enum QmkCapabilityFlag {
  PRESS_RELEASE = 1 << 0,
  RGB_MATRIX = 1 << 1,
  /** Reserved in protocol v1. Early preview firmware used this for LED Matrix presence. */
  LED_MATRIX = 1 << 2,
  ENCODER = 1 << 3,
  USB = 1 << 4,
  DYNAMIC_MAP = 1 << 5,
}

export const QMK_ALL_CAPABILITIES =
  QmkCapabilityFlag.PRESS_RELEASE |
  QmkCapabilityFlag.RGB_MATRIX |
  QmkCapabilityFlag.ENCODER |
  QmkCapabilityFlag.USB |
  QmkCapabilityFlag.DYNAMIC_MAP

export enum QmkControlPhaseCode {
  PRESS = 1,
  RELEASE = 2,
  REPEAT = 3,
}

export enum QmkTaskStateCode {
  OFF = 0,
  IDLE = 1,
  EXECUTING = 2,
  WAITING = 3,
  COMPLETE = 4,
  ERROR = 5,
}

export enum QmkErrorCode {
  UNSUPPORTED_VERSION = 1,
  UNKNOWN_MESSAGE = 2,
  MALFORMED_PAYLOAD = 3,
  INVALID_STATE = 4,
}

export const QMK_CONTROL_CODES: Readonly<Record<ControlId, number>> = {
  'agent.1': 0x01,
  'agent.2': 0x02,
  'agent.3': 0x03,
  'agent.4': 0x04,
  'agent.5': 0x05,
  'agent.6': 0x06,
  'command.fast': 0x10,
  'command.approve': 0x11,
  'command.decline': 0x12,
  'command.fork': 0x13,
  'command.mic': 0x14,
  'command.send': 0x15,
  'nav.up': 0x20,
  'nav.right': 0x21,
  'nav.down': 0x22,
  'nav.left': 0x23,
  'dial.ccw': 0x30,
  'dial.cw': 0x31,
  'dial.press': 0x32,
}

const CONTROL_IDS_BY_CODE = new Map<number, ControlId>(
  Object.entries(QMK_CONTROL_CODES).map(([controlId, code]) => [code, controlId as ControlId]),
)

export interface QmkPacket {
  readonly major: number
  readonly type: QmkMessageType
  readonly sequence: number
  readonly flags: number
  readonly payload: Buffer
}

export interface QmkPacketInput {
  readonly major?: number
  readonly type: QmkMessageType
  readonly sequence: number
  readonly flags?: number
  readonly payload?: Uint8Array
}

export interface QmkHelloAck {
  readonly protocolMinor: number
  readonly capabilityFlags: number
  readonly agentCount: number
  readonly controlCount: number
  readonly reportSize: number
  readonly configuredLayer: number
  readonly heartbeatSeconds: number
}

export interface QmkControlMetadata {
  readonly row: number
  readonly column: number
  readonly qmkEventType: number
  readonly layer: number
  /** QMK's wrapping 32-bit millisecond timer, not a Unix timestamp. */
  readonly deviceTimestamp: number
}

export interface QmkDecodedControl extends QmkControlMetadata {
  readonly controlId: ControlId
  readonly phase: ControlPhase
}

export interface QmkAcknowledgement {
  readonly acknowledgedType: QmkMessageType
  readonly acknowledgedSequence: number
}

export interface QmkDeviceError {
  readonly code: QmkErrorCode
  readonly offendingType: QmkMessageType
  readonly detail: number
}

export class QmkProtocolError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-length' | 'invalid-header' | 'invalid-payload' | 'unsupported-value',
  ) {
    super(message)
    this.name = 'QmkProtocolError'
  }
}

export function encodeQmkPacket(packet: QmkPacketInput): Buffer {
  assertByte(packet.sequence, 'sequence')
  assertByte(packet.type, 'message type')
  const major = packet.major ?? OPENCONTROL_QMK_PROTOCOL_MAJOR
  const flags = packet.flags ?? 0
  assertByte(major, 'major')
  assertByte(flags, 'flags')
  const payload = Buffer.from(packet.payload ?? [])
  if (payload.length > QMK_RAW_HID_MAX_PAYLOAD) {
    throw new QmkProtocolError(
      `Raw HID payload cannot exceed ${QMK_RAW_HID_MAX_PAYLOAD} bytes`,
      'invalid-payload',
    )
  }

  const report = Buffer.alloc(QMK_RAW_HID_REPORT_SIZE)
  report[0] = OPENCONTROL_QMK_NAMESPACE
  report[1] = OPENCONTROL_QMK_MAGIC[0]!
  report[2] = OPENCONTROL_QMK_MAGIC[1]!
  report[3] = major
  report[4] = packet.type
  report[5] = packet.sequence
  report[6] = payload.length
  report[7] = flags
  payload.copy(report, QMK_RAW_HID_HEADER_SIZE)
  return report
}

export function decodeQmkPacket(report: Uint8Array): QmkPacket {
  if (report.length !== QMK_RAW_HID_REPORT_SIZE) {
    throw new QmkProtocolError(
      `Raw HID report must be exactly ${QMK_RAW_HID_REPORT_SIZE} bytes`,
      'invalid-length',
    )
  }
  if (
    report[0] !== OPENCONTROL_QMK_NAMESPACE ||
    report[1] !== OPENCONTROL_QMK_MAGIC[0] ||
    report[2] !== OPENCONTROL_QMK_MAGIC[1]
  ) {
    throw new QmkProtocolError(
      'Report does not use the OpenControl QMK namespace',
      'invalid-header',
    )
  }
  const payloadLength = report[6]!
  if (payloadLength > QMK_RAW_HID_MAX_PAYLOAD) {
    throw new QmkProtocolError(
      'Raw HID report declares an invalid payload length',
      'invalid-payload',
    )
  }
  return {
    major: report[3]!,
    type: report[4]! as QmkMessageType,
    sequence: report[5]!,
    flags: report[7]!,
    payload: Buffer.from(
      report.subarray(QMK_RAW_HID_HEADER_SIZE, QMK_RAW_HID_HEADER_SIZE + payloadLength),
    ),
  }
}

export function encodeHello(
  sequence: number,
  protocolMinor = OPENCONTROL_QMK_PROTOCOL_MINOR,
): Buffer {
  assertByte(protocolMinor, 'protocol minor')
  return encodeQmkPacket({
    type: QmkMessageType.HELLO,
    sequence,
    payload: Buffer.of(protocolMinor),
  })
}

export function encodeHelloAck(
  sequence: number,
  options: {
    readonly protocolMinor?: number
    readonly capabilityFlags: number
    readonly agentCount?: number
    readonly controlCount?: number
    readonly reportSize?: number
    readonly configuredLayer?: number
    readonly heartbeatSeconds?: number
  },
): Buffer {
  const protocolMinor = options.protocolMinor ?? OPENCONTROL_QMK_PROTOCOL_MINOR
  const agentCount = options.agentCount ?? OPENCONTROL_QMK_AGENT_COUNT
  const controlCount = options.controlCount ?? OPENCONTROL_QMK_CONTROL_COUNT
  const reportSize = options.reportSize ?? QMK_RAW_HID_REPORT_SIZE
  const configuredLayer = options.configuredLayer ?? 3
  const heartbeatSeconds = options.heartbeatSeconds ?? 5
  assertByte(protocolMinor, 'protocol minor')
  assertUint16(options.capabilityFlags, 'capability flags')
  assertByte(agentCount, 'agent count')
  assertByte(controlCount, 'control count')
  assertByte(reportSize, 'report size')
  assertByte(configuredLayer, 'configured layer')
  assertByte(heartbeatSeconds, 'heartbeat seconds')
  return encodeQmkPacket({
    type: QmkMessageType.HELLO_ACK,
    sequence,
    flags: QmkPacketFlag.RESPONSE,
    payload: Buffer.from([
      protocolMinor,
      options.capabilityFlags & 0xff,
      (options.capabilityFlags >>> 8) & 0xff,
      agentCount,
      controlCount,
      reportSize,
      configuredLayer,
      heartbeatSeconds,
    ]),
  })
}

export function decodeHelloAck(packet: QmkPacket): QmkHelloAck {
  if (packet.type !== QmkMessageType.HELLO_ACK || packet.payload.length !== 8) {
    throw new QmkProtocolError(
      'HELLO_ACK must contain exactly eight payload bytes',
      'invalid-payload',
    )
  }
  const acknowledgement: QmkHelloAck = {
    protocolMinor: packet.payload[0]!,
    capabilityFlags: packet.payload.readUInt16LE(1),
    agentCount: packet.payload[3]!,
    controlCount: packet.payload[4]!,
    reportSize: packet.payload[5]!,
    configuredLayer: packet.payload[6]!,
    heartbeatSeconds: packet.payload[7]!,
  }
  validateHelloAck(acknowledgement)
  return acknowledgement
}

/** Validate the fixed cardinalities required by protocol v1. */
export function validateHelloAck(acknowledgement: QmkHelloAck): void {
  if (acknowledgement.reportSize !== QMK_RAW_HID_REPORT_SIZE) {
    throw new QmkProtocolError(
      `QMK firmware report size ${acknowledgement.reportSize} is incompatible with the required ${QMK_RAW_HID_REPORT_SIZE} bytes`,
      'unsupported-value',
    )
  }
  if (acknowledgement.agentCount !== OPENCONTROL_QMK_AGENT_COUNT) {
    throw new QmkProtocolError(
      `QMK firmware exposes ${acknowledgement.agentCount} Agent slots; protocol v1 requires exactly ${OPENCONTROL_QMK_AGENT_COUNT}`,
      'unsupported-value',
    )
  }
  if (acknowledgement.controlCount < OPENCONTROL_QMK_CONTROL_COUNT) {
    throw new QmkProtocolError(
      `QMK firmware exposes ${acknowledgement.controlCount} controls; protocol v1 requires at least ${OPENCONTROL_QMK_CONTROL_COUNT}`,
      'unsupported-value',
    )
  }
  if (acknowledgement.heartbeatSeconds === 0) {
    throw new QmkProtocolError(
      'QMK firmware advertised a zero-second heartbeat timeout',
      'unsupported-value',
    )
  }
}

export function encodeControlEvent(
  sequence: number,
  controlId: ControlId,
  phase: ControlPhase,
  metadata: Partial<QmkControlMetadata> = {},
): Buffer {
  const row = metadata.row ?? 0
  const column = metadata.column ?? 0
  const qmkEventType = metadata.qmkEventType ?? 0
  const layer = metadata.layer ?? 0
  const deviceTimestamp = metadata.deviceTimestamp ?? 0
  assertByte(row, 'matrix row')
  assertByte(column, 'matrix column')
  assertByte(qmkEventType, 'QMK event type')
  assertByte(layer, 'layer')
  assertUint32(deviceTimestamp, 'device timestamp')
  const payload = Buffer.alloc(10)
  payload[0] = encodeControlId(controlId)
  payload[1] = encodePhase(phase)
  payload[2] = row
  payload[3] = column
  payload[4] = qmkEventType
  payload[5] = layer
  payload.writeUInt32LE(deviceTimestamp, 6)
  return encodeQmkPacket({
    type: QmkMessageType.CONTROL_EVENT,
    sequence,
    flags: QmkPacketFlag.ASYNC,
    payload,
  })
}

export function decodeControlEvent(packet: QmkPacket): QmkDecodedControl {
  if (packet.type !== QmkMessageType.CONTROL_EVENT || packet.payload.length !== 10) {
    throw new QmkProtocolError(
      'CONTROL_EVENT must contain exactly ten payload bytes',
      'invalid-payload',
    )
  }
  return {
    controlId: decodeControlId(packet.payload[0]!),
    phase: decodePhase(packet.payload[1]!),
    row: packet.payload[2]!,
    column: packet.payload[3]!,
    qmkEventType: packet.payload[4]!,
    layer: packet.payload[5]!,
    deviceTimestamp: packet.payload.readUInt32LE(6),
  }
}

export function encodeTaskStates(sequence: number, frame: FeedbackFrame): Buffer {
  if (frame.selectedSlot !== null && !isTaskSlot(frame.selectedSlot)) {
    throw new QmkProtocolError(
      `Invalid selected task slot: ${frame.selectedSlot}`,
      'unsupported-value',
    )
  }
  const normalized = normalizeFeedback(frame)
  let unreadMask = 0
  for (const feedback of normalized) {
    if (feedback.unread) unreadMask |= 1 << (feedback.slot - 1)
  }
  return encodeQmkPacket({
    type: QmkMessageType.TASK_STATES,
    sequence,
    payload: Buffer.from([
      frame.selectedSlot === null ? OPENCONTROL_QMK_SELECTED_NONE : frame.selectedSlot - 1,
      ...normalized.map((feedback) => encodeTaskState(feedback.state)),
      unreadMask,
    ]),
  })
}

export function decodeTaskStates(packet: QmkPacket): FeedbackFrame {
  if (packet.type !== QmkMessageType.TASK_STATES || packet.payload.length !== 8) {
    throw new QmkProtocolError(
      'TASK_STATES must contain the selected slot, six states, and unread mask',
      'invalid-payload',
    )
  }
  const selectedIndex = packet.payload[0]!
  if (
    selectedIndex !== OPENCONTROL_QMK_SELECTED_NONE &&
    selectedIndex >= OPENCONTROL_QMK_AGENT_COUNT
  ) {
    throw new QmkProtocolError(`Invalid selected task index: ${selectedIndex}`, 'unsupported-value')
  }
  const unreadMask = packet.payload[7]!
  const slots: TaskSlotFeedback[] = []
  for (let index = 0; index < OPENCONTROL_QMK_AGENT_COUNT; index += 1) {
    slots.push({
      slot: (index + 1) as TaskSlotFeedback['slot'],
      state: decodeTaskState(packet.payload[index + 1]!),
      unread: (unreadMask & (1 << index)) !== 0,
    })
  }
  return {
    selectedSlot:
      selectedIndex === OPENCONTROL_QMK_SELECTED_NONE
        ? null
        : ((selectedIndex + 1) as TaskSlotFeedback['slot']),
    slots,
  }
}

export function encodePing(sequence: number, opaque: Uint8Array = new Uint8Array()): Buffer {
  return encodeQmkPacket({ type: QmkMessageType.PING, sequence, payload: opaque })
}

export function encodeAcknowledgement(
  sequence: number,
  acknowledgedType: QmkMessageType,
  acknowledgedSequence = sequence,
): Buffer {
  assertByte(acknowledgedSequence, 'acknowledged sequence')
  return encodeQmkPacket({
    type: QmkMessageType.ACK,
    sequence,
    flags: QmkPacketFlag.RESPONSE,
    payload: Buffer.of(acknowledgedType, acknowledgedSequence),
  })
}

export function decodeAcknowledgement(packet: QmkPacket): QmkAcknowledgement {
  if (packet.type !== QmkMessageType.ACK || packet.payload.length !== 2) {
    throw new QmkProtocolError('ACK must contain exactly two payload bytes', 'invalid-payload')
  }
  return {
    acknowledgedType: packet.payload[0]! as QmkMessageType,
    acknowledgedSequence: packet.payload[1]!,
  }
}

export function encodeDeviceError(
  sequence: number,
  code: QmkErrorCode,
  offendingType: QmkMessageType,
  detail: number,
): Buffer {
  assertByte(detail, 'error detail')
  return encodeQmkPacket({
    type: QmkMessageType.ERROR,
    sequence,
    flags: QmkPacketFlag.RESPONSE,
    payload: Buffer.of(code, offendingType, detail),
  })
}

export function decodeDeviceError(packet: QmkPacket): QmkDeviceError {
  if (packet.type !== QmkMessageType.ERROR || packet.payload.length !== 3) {
    throw new QmkProtocolError('ERROR must contain exactly three payload bytes', 'invalid-payload')
  }
  return {
    code: packet.payload[0]! as QmkErrorCode,
    offendingType: packet.payload[1]! as QmkMessageType,
    detail: packet.payload[2]!,
  }
}

function encodeControlId(controlId: ControlId): number {
  const code = QMK_CONTROL_CODES[controlId]
  if (code === undefined) {
    throw new QmkProtocolError(
      `Control ID cannot be encoded: ${String(controlId)}`,
      'unsupported-value',
    )
  }
  return code
}

function decodeControlId(code: number): ControlId {
  const controlId = CONTROL_IDS_BY_CODE.get(code)
  if (!controlId) {
    throw new QmkProtocolError(`Unknown QMK control ID: ${code}`, 'unsupported-value')
  }
  return controlId
}

function encodePhase(phase: ControlPhase): QmkControlPhaseCode {
  switch (phase) {
    case 'press':
      return QmkControlPhaseCode.PRESS
    case 'release':
      return QmkControlPhaseCode.RELEASE
    case 'repeat':
      return QmkControlPhaseCode.REPEAT
    default:
      throw new QmkProtocolError(`Unknown QMK control phase: ${String(phase)}`, 'unsupported-value')
  }
}

function decodePhase(code: number): ControlPhase {
  switch (code) {
    case QmkControlPhaseCode.PRESS:
      return 'press'
    case QmkControlPhaseCode.RELEASE:
      return 'release'
    case QmkControlPhaseCode.REPEAT:
      return 'repeat'
    default:
      throw new QmkProtocolError(`Unknown QMK control phase: ${code}`, 'unsupported-value')
  }
}

function normalizeFeedback(frame: FeedbackFrame): TaskSlotFeedback[] {
  const bySlot = new Map<number, TaskSlotFeedback>()
  for (const feedback of frame.slots) {
    if (!isTaskSlot(feedback.slot)) {
      throw new QmkProtocolError(`Invalid task slot: ${feedback.slot}`, 'unsupported-value')
    }
    if (bySlot.has(feedback.slot)) {
      throw new QmkProtocolError(`Duplicate task slot: ${feedback.slot}`, 'invalid-payload')
    }
    bySlot.set(feedback.slot, feedback)
  }
  return Array.from(
    { length: OPENCONTROL_QMK_AGENT_COUNT },
    (_, index) =>
      bySlot.get(index + 1) ?? {
        slot: (index + 1) as TaskSlotFeedback['slot'],
        state: 'off',
        unread: false,
      },
  )
}

function encodeTaskState(state: TaskFeedbackState): QmkTaskStateCode {
  switch (state) {
    case 'off':
      return QmkTaskStateCode.OFF
    case 'idle':
      return QmkTaskStateCode.IDLE
    case 'executing':
      return QmkTaskStateCode.EXECUTING
    case 'waiting':
      return QmkTaskStateCode.WAITING
    case 'complete':
      return QmkTaskStateCode.COMPLETE
    case 'error':
      return QmkTaskStateCode.ERROR
    default:
      throw new QmkProtocolError(`Unknown QMK task state: ${String(state)}`, 'unsupported-value')
  }
}

function decodeTaskState(code: number): TaskFeedbackState {
  switch (code) {
    case QmkTaskStateCode.OFF:
      return 'off'
    case QmkTaskStateCode.IDLE:
      return 'idle'
    case QmkTaskStateCode.EXECUTING:
      return 'executing'
    case QmkTaskStateCode.WAITING:
      return 'waiting'
    case QmkTaskStateCode.COMPLETE:
      return 'complete'
    case QmkTaskStateCode.ERROR:
      return 'error'
    default:
      throw new QmkProtocolError(`Unknown QMK task state: ${code}`, 'unsupported-value')
  }
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new QmkProtocolError(`${label} must be an unsigned byte`, 'unsupported-value')
  }
}

function assertUint16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new QmkProtocolError(`${label} must be an unsigned 16-bit integer`, 'unsupported-value')
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new QmkProtocolError(`${label} must be an unsigned 32-bit integer`, 'unsupported-value')
  }
}
