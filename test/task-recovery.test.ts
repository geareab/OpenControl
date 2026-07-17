import { describe, expect, it } from 'vitest'
import type { TaskSnapshot, TaskStatus } from '../src/state.js'
import { recoveryRegistration, taskFromStatus, withoutProcess } from '../src/task-recovery.js'

function task(wrapperId: string, slot: number | null, pid: number, selected = false): TaskSnapshot {
  return {
    wrapperId,
    name: wrapperId,
    kind: 'codex',
    cwd: '/work',
    pid,
    state: 'waiting',
    connectionState: 'connected',
    slot,
    selected,
    unread: true,
    sessionId: `${wrapperId}-session`,
    registeredAt: 10,
    updatedAt: 20,
  }
}

describe('task recovery helpers', () => {
  it('preserves an explicit null overflow slot and cached state', () => {
    const overflow = task('overflow', null, 8)
    expect(
      recoveryRegistration(
        { wrapperId: 'overflow', kind: 'codex', cwd: '/work', pid: 8 },
        overflow,
      ),
    ).toEqual({
      wrapperId: 'overflow',
      kind: 'codex',
      cwd: '/work',
      pid: 8,
      slot: null,
      recovery: {
        state: 'waiting',
        unread: true,
        selected: false,
        sessionId: 'overflow-session',
        registeredAt: 10,
        updatedAt: 20,
      },
    })
  })

  it('finds assigned and overflow wrappers in a full status snapshot', () => {
    const assigned = task('assigned', 1, 1)
    const overflow = task('overflow', null, 7)
    const status: TaskStatus = {
      slots: [assigned, null, null, null, null, null],
      unassigned: [overflow],
      selectedSlot: 1,
    }
    expect(taskFromStatus(status, 'assigned')).toBe(assigned)
    expect(taskFromStatus(status, 'overflow')).toBe(overflow)
    expect(taskFromStatus(status, 'missing')).toBeNull()
  })

  it('removes only the exited host process before promotion', () => {
    const host = task('host', 1, 100, true)
    const survivor = task('survivor', 2, 200)
    const overflow = task('overflow', null, 300)
    const status: TaskStatus = {
      slots: [host, survivor, null, null, null, null],
      unassigned: [overflow],
      selectedSlot: 1,
    }
    expect(withoutProcess(status, 100)).toEqual({
      slots: [null, survivor, null, null, null, null],
      unassigned: [overflow],
      selectedSlot: null,
    })
  })
})
