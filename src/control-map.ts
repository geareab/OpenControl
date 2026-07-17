import type { Action } from './harness/types.js'
import type { OpenControlConfig } from './layers.js'

export interface ViaControlBinding {
  controlId: string
  viaKeycode: string
  label: string
}

/** Standard keycodes shared by stock terminal mode and enhanced QMK mode. */
export const VIA_CONTROL_BINDINGS: readonly ViaControlBinding[] = [
  ...Array.from({ length: 6 }, (_, index) => ({
    controlId: `agent.${index + 1}`,
    viaKeycode: `F${index + 13}`,
    label: `Agent ${index + 1}`,
  })),
  { controlId: 'command.fast', viaKeycode: 'F19', label: 'Fast' },
  { controlId: 'command.approve', viaKeycode: 'F20', label: 'Approve' },
  { controlId: 'command.decline', viaKeycode: 'F21', label: 'Decline' },
  { controlId: 'command.fork', viaKeycode: 'F22', label: 'Fork' },
  { controlId: 'command.mic', viaKeycode: 'F23', label: 'Mic (reserved)' },
  { controlId: 'command.send', viaKeycode: 'F24', label: 'Send' },
  { controlId: 'nav.up', viaKeycode: 'Shift+F13', label: 'Plan' },
  { controlId: 'nav.right', viaKeycode: 'Shift+F14', label: 'Next task' },
  { controlId: 'nav.down', viaKeycode: 'Shift+F15', label: 'Skills' },
  { controlId: 'nav.left', viaKeycode: 'Shift+F16', label: 'Previous task' },
  { controlId: 'dial.ccw', viaKeycode: 'Shift+F17', label: 'Reasoning down' },
  { controlId: 'dial.cw', viaKeycode: 'Shift+F18', label: 'Reasoning up' },
  { controlId: 'dial.press', viaKeycode: 'Shift+F19', label: 'Model picker' },
]

export type RoutedControl =
  { type: 'select_slot'; slot: number } | { type: 'action'; action: Action } | { type: 'unbound' }

export function routeSemanticControl(controlId: string, config: OpenControlConfig): RoutedControl {
  const agent = /^agent\.([1-6])$/.exec(controlId)
  if (agent) return { type: 'select_slot', slot: Number(agent[1]) }
  const action = config.controls[controlId]
  return action ? { type: 'action', action } : { type: 'unbound' }
}
