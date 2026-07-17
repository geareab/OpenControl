import { describe, expect, it } from 'vitest'
import { routeSemanticControl, VIA_CONTROL_BINDINGS } from '../src/control-map.js'
import { DEFAULT_CONFIG } from '../src/layers.js'

describe('VIA semantic control map', () => {
  it('defines unique portable keycodes for all v1 controls', () => {
    expect(VIA_CONTROL_BINDINGS).toHaveLength(19)
    expect(new Set(VIA_CONTROL_BINDINGS.map((binding) => binding.controlId)).size).toBe(19)
    expect(VIA_CONTROL_BINDINGS.slice(0, 6).map((binding) => binding.viaKeycode)).toEqual([
      'F13',
      'F14',
      'F15',
      'F16',
      'F17',
      'F18',
    ])
  })

  it('keeps Agent keys dedicated to task slots', () => {
    expect(routeSemanticControl('agent.4', DEFAULT_CONFIG)).toEqual({
      type: 'select_slot',
      slot: 4,
    })
  })

  it('resolves portable commands through config and leaves unknown controls alone', () => {
    expect(routeSemanticControl('command.fork', DEFAULT_CONFIG)).toEqual({
      type: 'action',
      action: { type: 'agent_command', command: 'fork' },
    })
    expect(routeSemanticControl('future.control', DEFAULT_CONFIG)).toEqual({ type: 'unbound' })
  })
})
