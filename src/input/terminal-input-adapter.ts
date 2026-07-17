import { EventEmitter } from 'node:events'
import {
  TerminalSequenceDecoder,
  type TerminalDecoderEmission,
  type TerminalSequenceBinding,
  type TerminalSequenceDecoderOptions,
} from './terminal-sequence-decoder.js'
import type {
  AdapterCapabilities,
  AdapterConnection,
  ControlEvent,
  InputAdapter,
  Unsubscribe,
} from './types.js'

// Terminals do not expose key-up events. Treat a same-control burst as repeat
// so held F-keys cannot repeatedly approve/send prompts. A deliberate second
// press after the quiet window is a new edge.
export const TERMINAL_REPEAT_WINDOW_MS = 2_000

/** Terminal-local stock VIA adapter with ordered passthrough delivery. */
export class TerminalInputAdapter extends EventEmitter implements InputAdapter {
  readonly adapterId: string
  readonly capabilities: AdapterCapabilities = {
    transport: 'terminal',
    pressRelease: false,
    repeat: true,
    encoder: false,
    rgbFeedback: false,
    ledFeedback: false,
    taskSlots: 6,
  }

  private readonly decoder: TerminalSequenceDecoder
  private readonly lastControlAt = new Map<string, number>()
  private started = false

  constructor(
    bindings: readonly TerminalSequenceBinding[],
    options: TerminalSequenceDecoderOptions = {},
  ) {
    super()
    this.decoder = new TerminalSequenceDecoder(bindings, options)
    this.adapterId = options.sourceId ?? 'terminal'
  }

  get flushDeadline(): number | null {
    return this.decoder.flushDeadline
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.emit('connection', {
      connected: true,
      adapterId: this.adapterId,
      deviceId: this.adapterId,
      capabilities: this.capabilities,
    } satisfies AdapterConnection)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.lastControlAt.clear()
    this.emit('connection', {
      connected: false,
      adapterId: this.adapterId,
      deviceId: this.adapterId,
    } satisfies AdapterConnection)
  }

  onControl(listener: (event: ControlEvent) => void): Unsubscribe {
    this.on('control', listener)
    return () => this.off('control', listener)
  }

  onConnectionChange(listener: (event: AdapterConnection) => void): Unsubscribe {
    this.on('connection', listener)
    return () => this.off('connection', listener)
  }

  consume(chunk: Uint8Array, writePassthrough: (bytes: Buffer) => void, now = Date.now()): void {
    this.deliver(this.decoder.push(chunk, now), writePassthrough)
  }

  flushExpired(writePassthrough: (bytes: Buffer) => void, now = Date.now()): void {
    this.deliver(this.decoder.flushExpired(now), writePassthrough)
  }

  flush(writePassthrough: (bytes: Buffer) => void, now = Date.now()): void {
    this.deliver(this.decoder.flush(now), writePassthrough)
  }

  private deliver(
    emissions: readonly TerminalDecoderEmission[],
    writePassthrough: (bytes: Buffer) => void,
  ): void {
    for (const emission of emissions) {
      if (emission.kind === 'control') {
        const event = emission.event
        if (event.phase === 'release') {
          this.lastControlAt.delete(event.controlId)
          this.emit('control', event)
          continue
        }
        if (event.phase !== 'press') {
          this.emit('control', event)
          continue
        }
        const previous = this.lastControlAt.get(event.controlId)
        this.lastControlAt.set(event.controlId, event.timestamp)
        const repeated =
          previous !== undefined &&
          event.timestamp >= previous &&
          event.timestamp - previous <= TERMINAL_REPEAT_WINDOW_MS
        this.emit('control', repeated ? { ...event, phase: 'repeat' } : event)
      } else {
        writePassthrough(emission.data)
      }
    }
  }
}
