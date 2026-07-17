// Pure mapping from session state to controller output. No side effects — the
// cli (later phase) debounces this and pushes the result through
// `driver.output`.

import type { AgentState } from './harness/types.js'

export interface RGB {
  r: number
  g: number
  b: number
}

export interface SessionSnapshot {
  state: AgentState
}

export interface Feedback {
  lightbar: RGB
  playerLeds: number
}

export const STATE_COLOR: Record<AgentState, RGB> = {
  executing: { r: 0, g: 0, b: 255 }, // blue
  waiting: { r: 255, g: 176, b: 0 }, // amber
  idle: { r: 20, g: 20, b: 20 }, // dim white
  complete: { r: 0, g: 255, b: 0 }, // green
  error: { r: 255, g: 0, b: 0 }, // red
}

const MAX_LEDS = 5

/**
 * Maps session state to controller feedback.
 *
 * Args:
 *     sessions (SessionSnapshot[]): occupied session slots, in slot order.
 *     focusedIndex (number): index into `sessions` of the focused session.
 *     layerColor (RGB): current layer's tint, used as the lightbar color when there is no focused session (e.g. before any session exists).
 *
 * Returns:
 *     Feedback: lightbar color for the focused session's state, and a bitmask of occupied slots (capped at 5 player LEDs).
 */
export function feedbackFor(
  sessions: SessionSnapshot[],
  focusedIndex: number,
  layerColor: RGB,
): Feedback {
  const focused = sessions[focusedIndex]
  const lightbar = focused ? STATE_COLOR[focused.state] : layerColor
  const playerLeds = sessions.slice(0, MAX_LEDS).reduce((mask: number, _s, i) => mask | (1 << i), 0)
  return { lightbar, playerLeds }
}

/**
 * Picks which session the lightbar should mirror when the user hasn't chosen one.
 *
 * Priority: manual focus (touchpad) > attention (waiting/error, from `SessionTracker.aggregate()`) > most recently executing > most recently updated. Without this, the lightbar sat on the layer color until the first touchpad click and never showed agent state.
 *
 * Args:
 *     sessions ({ id: string; state: AgentState; order: number }[]): tracked sessions in slot order, `order` = recency of last state change.
 *     manualId (string | null): session pinned via touchpad focus cycling, if any.
 *     attentionId (string | null): session demanding attention per the tracker aggregate, if any.
 *
 * Returns:
 *     number: index into `sessions` to focus, or -1 when there are no sessions.
 */
export function effectiveFocusIndex(
  sessions: { id: string; state: AgentState; order: number }[],
  manualId: string | null,
  attentionId: string | null,
): number {
  for (const id of [manualId, attentionId]) {
    if (!id) continue
    const i = sessions.findIndex((s) => s.id === id)
    if (i >= 0) return i
  }
  const latest = (indices: number[]): number =>
    indices.reduce((a, i) => (a < 0 || sessions[i]!.order > sessions[a]!.order ? i : a), -1)
  const executing = sessions.flatMap((s, i) => (s.state === 'executing' ? [i] : []))
  if (executing.length > 0) return latest(executing)
  return latest(sessions.map((_s, i) => i))
}
