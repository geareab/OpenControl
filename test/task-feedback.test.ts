import { describe, expect, it } from 'vitest'
import { feedbackFrameForTasks } from '../src/task-feedback.js'
import type { TaskStatus } from '../src/state.js'

describe('feedbackFrameForTasks', () => {
  it('maps all six task slots and treats disconnects as errors', () => {
    const now = Date.now()
    const disconnected = {
      wrapperId: 'one',
      name: 'api',
      kind: 'codex',
      cwd: '/work',
      pid: 1,
      state: 'disconnected' as const,
      slot: 1,
      selected: false,
      unread: false,
      sessionId: null,
      registeredAt: now,
      updatedAt: now,
    }
    const reconnecting = {
      ...disconnected,
      wrapperId: 'two',
      state: 'executing' as const,
      connectionState: 'reconnecting' as const,
      slot: 2,
    }
    const status: TaskStatus = {
      slots: [disconnected, reconnecting, null, null, null, null],
      unassigned: [],
      selectedSlot: null,
    }
    expect(feedbackFrameForTasks(status)).toEqual({
      selectedSlot: null,
      slots: [
        { slot: 1, state: 'error', unread: false },
        { slot: 2, state: 'error', unread: false },
        { slot: 3, state: 'off', unread: false },
        { slot: 4, state: 'off', unread: false },
        { slot: 5, state: 'off', unread: false },
        { slot: 6, state: 'off', unread: false },
      ],
    })
  })
})
