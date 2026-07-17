import { describe, expect, it } from 'vitest'
import { effectiveFocusIndex, feedbackFor } from '../src/feedback.js'
import type { SessionSnapshot } from '../src/feedback.js'
import type { AgentState } from '../src/harness/types.js'

const LAYER_COLOR = { r: 10, g: 20, b: 30 }

describe('feedbackFor', () => {
  it('maps the focused session state to the matching lightbar color', () => {
    const sessions: SessionSnapshot[] = [{ state: 'executing' }, { state: 'error' }]
    expect(feedbackFor(sessions, 0, LAYER_COLOR).lightbar).toEqual({ r: 0, g: 0, b: 255 })
    expect(feedbackFor(sessions, 1, LAYER_COLOR).lightbar).toEqual({ r: 255, g: 0, b: 0 })
  })

  it('covers all state colors', () => {
    expect(feedbackFor([{ state: 'waiting' }], 0, LAYER_COLOR).lightbar).toEqual({
      r: 255,
      g: 176,
      b: 0,
    })
    expect(feedbackFor([{ state: 'idle' }], 0, LAYER_COLOR).lightbar).toEqual({
      r: 20,
      g: 20,
      b: 20,
    })
    expect(feedbackFor([{ state: 'complete' }], 0, LAYER_COLOR).lightbar).toEqual({
      r: 0,
      g: 255,
      b: 0,
    })
  })

  it('falls back to the layer color when there is no focused session', () => {
    expect(feedbackFor([], 0, LAYER_COLOR).lightbar).toEqual(LAYER_COLOR)
    expect(feedbackFor([{ state: 'idle' }], 5, LAYER_COLOR).lightbar).toEqual(LAYER_COLOR)
  })

  it('sets one player LED bit per occupied slot, in order', () => {
    const sessions: SessionSnapshot[] = [{ state: 'idle' }, { state: 'idle' }, { state: 'idle' }]
    expect(feedbackFor(sessions, 0, LAYER_COLOR).playerLeds).toBe(0b00000111)
  })

  it('caps player LEDs at 5 slots', () => {
    const sessions: SessionSnapshot[] = Array.from(
      { length: 8 },
      () => ({ state: 'idle' }) as const,
    )
    expect(feedbackFor(sessions, 0, LAYER_COLOR).playerLeds).toBe(0b00011111)
  })

  it('returns no LEDs for an empty session list', () => {
    expect(feedbackFor([], 0, LAYER_COLOR).playerLeds).toBe(0)
  })
})

describe('effectiveFocusIndex', () => {
  const s = (id: string, state: AgentState, order: number) => ({ id, state, order })

  it('returns -1 with no sessions', () => {
    expect(effectiveFocusIndex([], null, null)).toBe(-1)
  })

  it('manual focus wins over everything', () => {
    const sessions = [s('a', 'waiting', 1), s('b', 'executing', 2), s('c', 'idle', 3)]
    expect(effectiveFocusIndex(sessions, 'c', 'a')).toBe(2)
  })

  it('falls back to attention session when no manual focus', () => {
    const sessions = [s('a', 'waiting', 1), s('b', 'executing', 2)]
    expect(effectiveFocusIndex(sessions, null, 'a')).toBe(0)
  })

  it('ignores a manual/attention id that no longer exists', () => {
    const sessions = [s('a', 'executing', 1)]
    expect(effectiveFocusIndex(sessions, 'gone', 'gone-too')).toBe(0)
  })

  it('prefers the most recently updated executing session', () => {
    const sessions = [s('a', 'executing', 5), s('b', 'idle', 9), s('c', 'executing', 7)]
    expect(effectiveFocusIndex(sessions, null, null)).toBe(2)
  })

  it('falls back to the most recently updated session of any state', () => {
    const sessions = [s('a', 'idle', 5), s('b', 'complete', 9), s('c', 'idle', 7)]
    expect(effectiveFocusIndex(sessions, null, null)).toBe(1)
  })
})
