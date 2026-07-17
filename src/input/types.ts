/**
 * Device-neutral input and feedback contracts.
 *
 * Physical adapters translate their native reports into these stable control
 * IDs. The rest of OpenControl never needs to know whether a control came from
 * a terminal sequence, QMK Raw HID, or a legacy gamepad.
 */

export const CONTROL_IDS = [
  'agent.1',
  'agent.2',
  'agent.3',
  'agent.4',
  'agent.5',
  'agent.6',
  'command.fast',
  'command.approve',
  'command.decline',
  'command.fork',
  'command.mic',
  'command.send',
  'nav.up',
  'nav.right',
  'nav.down',
  'nav.left',
  'dial.ccw',
  'dial.cw',
  'dial.press',
] as const

export type ControlId = (typeof CONTROL_IDS)[number]
export type ControlPhase = 'press' | 'release' | 'repeat'
export type TaskSlot = 1 | 2 | 3 | 4 | 5 | 6

const CONTROL_ID_SET: ReadonlySet<string> = new Set(CONTROL_IDS)

export function isControlId(value: unknown): value is ControlId {
  return typeof value === 'string' && CONTROL_ID_SET.has(value)
}

export function isTaskSlot(value: number): value is TaskSlot {
  return Number.isInteger(value) && value >= 1 && value <= 6
}

export interface ControlEvent {
  readonly controlId: ControlId
  readonly phase: ControlPhase
  readonly sourceId: string
  /** Milliseconds since the Unix epoch on the host receiving the event. */
  readonly timestamp: number
}

export type InputTransport = 'terminal' | 'usb' | 'bluetooth' | '2.4ghz' | 'gamepad' | 'unknown'

export interface ProtocolVersion {
  readonly major: number
  readonly minor: number
}

/** Capabilities negotiated for one currently connected adapter. */
export interface AdapterCapabilities {
  readonly protocolVersion?: ProtocolVersion
  readonly transport: InputTransport
  readonly pressRelease: boolean
  readonly repeat: boolean
  readonly encoder: boolean
  readonly rgbFeedback: boolean
  readonly ledFeedback: boolean
  readonly taskSlots: number
}

export interface AdapterConnection {
  readonly connected: boolean
  readonly adapterId: string
  readonly deviceId?: string
  readonly capabilities?: AdapterCapabilities
}

export type Unsubscribe = () => void

export interface InputAdapter {
  readonly adapterId: string
  readonly capabilities: AdapterCapabilities | null
  start(): void | Promise<void>
  stop(): void | Promise<void>
  onControl(listener: (event: ControlEvent) => void): Unsubscribe
  onConnectionChange(listener: (event: AdapterConnection) => void): Unsubscribe
}

export type TaskFeedbackState = 'off' | 'idle' | 'executing' | 'waiting' | 'complete' | 'error'

export interface TaskSlotFeedback {
  readonly slot: TaskSlot
  readonly state: TaskFeedbackState
  readonly unread: boolean
}

export interface FeedbackFrame {
  readonly selectedSlot: TaskSlot | null
  readonly slots: readonly TaskSlotFeedback[]
}

export interface FeedbackAdapter {
  readonly adapterId: string
  readonly capabilities: AdapterCapabilities | null
  updateFeedback(frame: FeedbackFrame): void | Promise<void>
}
