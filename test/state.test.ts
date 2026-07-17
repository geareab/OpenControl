import { describe, expect, it } from 'vitest'
import { InvalidSlotError, SessionTracker, SlotConflictError, TaskRegistry } from '../src/state.js'

describe('SessionTracker compatibility view', () => {
  it('reports executing and attention states without decaying completion', () => {
    const tracker = new SessionTracker()
    tracker.apply('running', 'executing')
    expect(tracker.aggregate()).toEqual({ playing: true, focusSessionId: null })
    tracker.apply('waiting', 'waiting')
    expect(tracker.aggregate()).toEqual({ playing: false, focusSessionId: 'waiting' })
    tracker.apply('waiting', 'complete', { focusOnStop: true })
    expect(tracker.list().find((item) => item.id === 'waiting')?.state).toBe('complete')
    expect(tracker.decay()).toBe(false)
  })
})

function registration(wrapperId: string, slot?: number) {
  return {
    wrapperId,
    kind: 'claude' as const,
    cwd: `/projects/${wrapperId}`,
    pid: Number(wrapperId.replace(/\D/g, '')) + 100 || 100,
    ...(slot === undefined ? {} : { slot }),
  }
}

describe('TaskRegistry registration', () => {
  it('allocates six stable slots then leaves later tasks unassigned', () => {
    const tasks = new TaskRegistry()
    for (let index = 1; index <= 8; index += 1) tasks.register(registration(`w${index}`))
    expect(tasks.list().map((task) => task.slot)).toEqual([1, 2, 3, 4, 5, 6, null, null])
    expect(tasks.status().slots).toHaveLength(6)
    expect(tasks.status().unassigned.map((task) => task.wrapperId)).toEqual(['w7', 'w8'])
  })

  it('keeps an explicit null recovery slot unassigned even when a slot is free', () => {
    const tasks = new TaskRegistry()
    const restored = tasks.register({
      ...registration('w7'),
      slot: null,
      recovery: { state: 'complete', unread: true, selected: false, sessionId: 'session-7' },
    })
    expect(restored).toMatchObject({
      slot: null,
      state: 'complete',
      connectionState: 'connected',
      unread: true,
      sessionId: 'session-7',
    })
    expect(tasks.register(registration('w1')).slot).toBe(1)
  })

  it('selects the first assigned task during cacheless recovery', () => {
    const tasks = new TaskRegistry()
    tasks.register({
      ...registration('w3', 3),
      recovery: { state: 'executing', selected: false, updatedAt: 10 },
    })
    expect(tasks.selected()).toMatchObject({ wrapperId: 'w3', slot: 3 })
  })

  it('rejects an explicit occupied or invalid slot before process startup', () => {
    const tasks = new TaskRegistry()
    tasks.register(registration('w1', 3))
    expect(() => tasks.register(registration('w2', 3))).toThrowError(SlotConflictError)
    expect(() => tasks.register(registration('w2', 0))).toThrowError(InvalidSlotError)
    expect(() => tasks.register(registration('w2', 7))).toThrowError(InvalidSlotError)
  })

  it('is idempotent for a repeated wrapper registration', () => {
    const tasks = new TaskRegistry()
    const first = tasks.register(registration('w1'))
    const again = tasks.register({ ...registration('w1'), name: 'API', pid: 999 })
    expect(again.slot).toBe(first.slot)
    expect(again.name).toBe('API')
    expect(again.pid).toBe(999)
    expect(tasks.list()).toHaveLength(1)
  })
})

describe('TaskRegistry selection and state', () => {
  it('selects the first task and keeps selection sticky through attention changes', () => {
    const tasks = new TaskRegistry()
    tasks.register(registration('w1'))
    tasks.register(registration('w2'))
    tasks.applyState('w2', 'waiting', 'session-2')
    expect(tasks.selected()?.wrapperId).toBe('w1')
    expect(tasks.aggregate()).toEqual({ playing: false, focusSessionId: null })
    tasks.applyState('w1', 'executing', 'session-1')
    expect(tasks.aggregate()).toEqual({ playing: false, focusSessionId: 'session-1' })
  })

  it('keeps complete unread until its agent slot is selected', () => {
    const tasks = new TaskRegistry()
    tasks.register(registration('w1'))
    tasks.register(registration('w2'))
    tasks.selectSlot(1)
    tasks.applyState('w2', 'complete', 'session-2')
    expect(tasks.get('w2')).toMatchObject({ state: 'complete', unread: true, selected: false })
    expect(tasks.selectSlot(2)).toMatchObject({ state: 'idle', unread: false, selected: true })
  })

  it('cycles only occupied slots', () => {
    const tasks = new TaskRegistry()
    tasks.register(registration('w1', 1))
    tasks.register(registration('w4', 4))
    expect(tasks.selectRelative(1)?.wrapperId).toBe('w4')
    expect(tasks.selectRelative(1)?.wrapperId).toBe('w1')
    expect(tasks.selectRelative(-1)?.wrapperId).toBe('w4')
  })

  it('falls back to waiting, then executing, then the lowest occupied slot', () => {
    const tasks = new TaskRegistry()
    tasks.register(registration('w1', 1))
    tasks.register(registration('w2', 2))
    tasks.register(registration('w3', 3))
    tasks.applyState('w2', 'executing')
    tasks.applyState('w3', 'waiting')
    tasks.unregister('w1')
    expect(tasks.selected()?.wrapperId).toBe('w3')
    tasks.unregister('w3')
    expect(tasks.selected()?.wrapperId).toBe('w2')
    tasks.register(registration('w4', 1))
    tasks.applyState('w2', 'idle')
    tasks.unregister('w2')
    expect(tasks.selected()?.wrapperId).toBe('w4')
  })

  it('does not select unassigned or disconnected tasks', () => {
    const tasks = new TaskRegistry()
    for (let index = 1; index <= 7; index += 1) tasks.register(registration(`w${index}`))
    expect(tasks.selectWrapper('w7')).toBeNull()
    tasks.markDisconnected('w1')
    expect(tasks.selected()?.wrapperId).toBe('w2')
    expect(tasks.selectWrapper('w1')).toBeNull()
  })

  it('preserves process state and sticky selection while a connection is recovering', () => {
    const tasks = new TaskRegistry()
    tasks.register(registration('w1', 1))
    tasks.register(registration('w2', 2))
    tasks.applyState('w1', 'waiting', 'session-1')
    expect(tasks.markReconnecting('w1')).toBe(true)
    expect(tasks.get('w1')).toMatchObject({
      state: 'waiting',
      connectionState: 'reconnecting',
      selected: true,
    })
    expect(tasks.selectSlot(1)).toBeNull()
    expect(tasks.selected()?.wrapperId).toBe('w1')

    tasks.register(registration('w1', 1))
    expect(tasks.get('w1')).toMatchObject({
      state: 'waiting',
      connectionState: 'connected',
      selected: true,
    })
  })

  it('restores assigned and overflow tasks with cached selection and metadata', () => {
    const source = new TaskRegistry(() => 100)
    for (let index = 1; index <= 8; index += 1) source.register(registration(`w${index}`))
    source.applyState('w2', 'executing', 'session-2')
    source.applyState('w4', 'complete', 'session-4')
    source.selectSlot(4)
    source.applyState('w4', 'complete', 'session-4')
    const cached = source.status()

    const restored = new TaskRegistry(() => 200)
    restored.restore(cached, 'w2')
    expect(restored.list()).toHaveLength(8)
    expect(restored.selected()?.wrapperId).toBe('w4')
    expect(restored.get('w2')).toMatchObject({
      state: 'executing',
      connectionState: 'connected',
      sessionId: 'session-2',
    })
    expect(restored.get('w4')).toMatchObject({
      state: 'complete',
      connectionState: 'reconnecting',
      unread: true,
      selected: true,
    })
    expect(restored.get('w7')?.slot).toBeNull()
    expect(restored.get('w8')?.slot).toBeNull()
  })

  it('merges only fresher per-wrapper recovery metadata into a restored task', () => {
    let timestamp = 10
    const source = new TaskRegistry(() => timestamp)
    source.register(registration('w1', 1))
    timestamp = 20
    source.register(registration('w2', 2))
    timestamp = 30
    source.selectSlot(2)
    const cached = source.status()

    const restored = new TaskRegistry(() => 100)
    restored.restore(cached, 'w2')
    const w1 = restored.get('w1')!
    restored.register({
      ...registration('w1', 1),
      recovery: {
        state: 'waiting',
        unread: true,
        selected: true,
        sessionId: 'newer-session',
        registeredAt: w1.registeredAt,
        updatedAt: w1.updatedAt + 50,
      },
    })
    expect(restored.get('w1')).toMatchObject({
      state: 'waiting',
      unread: true,
      sessionId: 'newer-session',
      selected: true,
    })

    const staleW2 = cached.slots[1]!
    restored.register({
      ...registration('w2', 2),
      recovery: {
        state: 'error',
        unread: true,
        selected: true,
        sessionId: 'stale-session',
        updatedAt: staleW2.updatedAt,
      },
    })
    expect(restored.selected()?.wrapperId).toBe('w1')
    expect(restored.get('w2')).toMatchObject({ state: 'idle', sessionId: null })
  })

  it('uses strictly monotonic task timestamps for same-millisecond recovery updates', () => {
    const source = new TaskRegistry(() => 100)
    source.register(registration('w1', 1))
    source.applyState('w1', 'executing', 'session-1')
    const older = source.status()
    source.applyState('w1', 'waiting', 'session-1')
    const newer = source.status().slots[0]!
    expect(newer.updatedAt).toBeGreaterThan(older.slots[0]!.updatedAt)

    const restored = new TaskRegistry(() => 100)
    restored.restore(older, 'w1')
    restored.register({
      ...registration('w1', 1),
      recovery: {
        state: newer.state,
        unread: newer.unread,
        selected: newer.selected,
        sessionId: newer.sessionId,
        registeredAt: newer.registeredAt,
        updatedAt: newer.updatedAt,
      },
    })
    expect(restored.get('w1')).toMatchObject({
      state: 'waiting',
      sessionId: 'session-1',
    })
  })

  it('revisions a same-millisecond fallback selection for recovery merging', () => {
    const source = new TaskRegistry(() => 100)
    source.register(registration('w1', 1))
    source.register(registration('w2', 2))
    const older = source.status()
    source.unregister('w1')
    const newerW2 = source.status().slots[1]!
    expect(newerW2.updatedAt).toBeGreaterThan(older.slots[1]!.updatedAt)
    expect(newerW2.selected).toBe(true)

    const restored = new TaskRegistry(() => 100)
    restored.restore(older, 'w1')
    restored.register({
      ...registration('w2', 2),
      recovery: {
        state: newerW2.state,
        unread: newerW2.unread,
        selected: newerW2.selected,
        sessionId: newerW2.sessionId,
        registeredAt: newerW2.registeredAt,
        updatedAt: newerW2.updatedAt,
      },
    })
    expect(restored.selected()?.wrapperId).toBe('w2')
  })

  it('keeps restore fallback revision-neutral so a fresher task cache can merge', () => {
    const source = new TaskRegistry(() => 100)
    source.register(registration('w1', 1))
    source.register(registration('w2', 2))
    const promoterCache = source.status()
    promoterCache.slots[0] = null
    promoterCache.selectedSlot = null
    source.applyState('w2', 'waiting', 'session-2')
    const fresherW2 = source.status().slots[1]!

    const restored = new TaskRegistry(() => 1_000)
    restored.restore(promoterCache, 'w2')
    restored.register({
      ...registration('w2', 2),
      recovery: {
        state: fresherW2.state,
        unread: fresherW2.unread,
        selected: fresherW2.selected,
        sessionId: fresherW2.sessionId,
        registeredAt: fresherW2.registeredAt,
        updatedAt: fresherW2.updatedAt,
      },
    })
    expect(restored.get('w2')).toMatchObject({
      state: 'waiting',
      sessionId: 'session-2',
      selected: true,
    })
  })

  it('uses waiting and executing recovery priority when the cached selection is absent', () => {
    const source = new TaskRegistry()
    source.register(registration('w1', 1))
    source.register(registration('w2', 2))
    source.register(registration('w3', 3))
    source.register(registration('w4', 4))
    source.applyState('w2', 'executing')
    source.applyState('w3', 'waiting')
    const cached = source.status()
    cached.slots[0] = null

    const restored = new TaskRegistry()
    restored.restore(cached, 'w4')
    expect(restored.selected()).toMatchObject({
      wrapperId: 'w3',
      state: 'waiting',
      connectionState: 'reconnecting',
    })
  })
})
