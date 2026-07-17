import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LegacyGamepadAdapter } from '../src/input/legacy-gamepad-adapter.js'

describe('LegacyGamepadAdapter', () => {
  it('owns lifecycle and preserves native controller events behind one adapter boundary', () => {
    class Backend extends EventEmitter {
      start = vi.fn()
      stop = vi.fn()
    }
    const backend = new Backend()
    const adapter = new LegacyGamepadAdapter(backend)
    const events: unknown[] = []
    const connections: unknown[] = []
    adapter.onLegacyEvent((event) => events.push(event))
    adapter.onConnectionChange((event) => connections.push(event))

    adapter.start()
    backend.emit('data', { kind: 'connected', controllerType: 'dualsense' })
    backend.emit('data', { kind: 'button', button: 'south', pressed: true })
    backend.emit('data', { kind: 'disconnected' })
    adapter.stop()

    expect(backend.start).toHaveBeenCalledOnce()
    expect(backend.stop).toHaveBeenCalledOnce()
    expect(events).toHaveLength(3)
    expect(connections).toMatchObject([
      { connected: true, adapterId: 'legacy-gamepad', deviceId: 'gamepad:dualsense' },
      { connected: false, adapterId: 'legacy-gamepad' },
    ])
    expect(adapter.capabilities.transport).toBe('gamepad')
  })
})
