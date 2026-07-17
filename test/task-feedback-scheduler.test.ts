import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskStatus } from '../src/state.js'
import { createTaskFeedbackScheduler } from '../src/task-feedback-scheduler.js'

function status(selectedSlot: number | null): TaskStatus {
  return { slots: Array(6).fill(null), unassigned: [], selectedSlot }
}

describe('task feedback scheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes the latest snapshot after coalescing a burst', () => {
    vi.useFakeTimers()
    let current = status(1)
    const published: TaskStatus[] = []
    const scheduler = createTaskFeedbackScheduler(
      () => current,
      (value) => published.push(value),
      50,
    )

    scheduler.schedule()
    current = status(2)
    scheduler.schedule()
    vi.advanceTimersByTime(50)

    expect(published).toEqual([current])
  })

  it('can cancel a pending publication', () => {
    vi.useFakeTimers()
    const published: TaskStatus[] = []
    const scheduler = createTaskFeedbackScheduler(
      () => status(1),
      (value) => published.push(value),
      10,
    )
    scheduler.schedule()
    scheduler.cancel()
    vi.runAllTimers()
    expect(published).toEqual([])
  })
})
