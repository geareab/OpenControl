import type { Action } from './harness/types.js'

/** Actions that are safe to emit repeatedly from an encoder/continuous gesture. */
export function isRepeatableAction(action: Action): boolean {
  return action.type === 'focus_relative' || action.type === 'thinking_depth'
}
