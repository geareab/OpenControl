import { EventEmitter } from 'node:events'
import { HidManager } from '../controller/hid-manager.js'
import type { ControllerOutput } from '../controller/output.js'
import type { ControllerEvent } from '../types.js'
import type { AdapterCapabilities, AdapterConnection, Unsubscribe } from './types.js'

export interface LegacyGamepadBackend extends EventEmitter {
  readonly output?: ControllerOutput
  start(): void
  stop(): void
}

/**
 * Compatibility boundary for OpenMicro's configurable gamepad layers.
 *
 * Gamepads intentionally retain native ControllerEvent routing because their
 * six-layer bindings predate the stable keyboard control IDs. New adapters
 * should implement InputAdapter; this wrapper keeps the legacy exception out
 * of the host lifecycle and feedback wiring.
 */
export class LegacyGamepadAdapter extends EventEmitter {
  readonly adapterId = 'legacy-gamepad'
  private readonly backend: LegacyGamepadBackend

  constructor(backend: LegacyGamepadBackend = new HidManager()) {
    super()
    this.backend = backend
    this.backend.on('data', (event: ControllerEvent) => this.receive(event))
  }

  get capabilities(): AdapterCapabilities {
    return {
      transport: 'gamepad',
      pressRelease: true,
      repeat: false,
      encoder: false,
      rgbFeedback: this.backend.output !== undefined,
      ledFeedback: this.backend.output !== undefined,
      taskSlots: 6,
    }
  }

  get output(): ControllerOutput | undefined {
    return this.backend.output
  }

  start(): void {
    this.backend.start()
  }

  stop(): void {
    this.backend.stop()
  }

  onLegacyEvent(listener: (event: ControllerEvent) => void): Unsubscribe {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  onConnectionChange(listener: (event: AdapterConnection) => void): Unsubscribe {
    this.on('connection', listener)
    return () => this.off('connection', listener)
  }

  private receive(event: ControllerEvent): void {
    if (event.kind === 'connected') {
      this.emit('connection', {
        connected: true,
        adapterId: this.adapterId,
        deviceId: `gamepad:${event.controllerType}`,
        capabilities: this.capabilities,
      } satisfies AdapterConnection)
    } else if (event.kind === 'disconnected') {
      this.emit('connection', {
        connected: false,
        adapterId: this.adapterId,
      } satisfies AdapterConnection)
    }
    this.emit('event', event)
  }
}
