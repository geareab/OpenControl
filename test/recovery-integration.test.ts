import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harnessFor } from '../src/harness/index.js'
import { HostServer, RECONNECT_GRACE_MS } from '../src/server.js'
import { recoveryRegistration, taskFromStatus, withoutProcess } from '../src/task-recovery.js'
import { TaskRegistry, type TaskSnapshot, type TaskStatus } from '../src/state.js'

const claude = harnessFor('claude')

function registration(index: number, pid = 4_000 + index) {
  return {
    wrapperId: `wrapper-${index}`,
    name: `Task ${index}`,
    kind: index % 2 === 0 ? ('claude' as const) : ('codex' as const),
    cwd: `/projects/task-${index}`,
    pid,
  }
}

function recoveryIdentity(task: TaskSnapshot) {
  return {
    wrapperId: task.wrapperId,
    name: task.name,
    kind: task.kind,
    cwd: task.cwd,
    pid: task.pid,
  }
}

function buildEightTaskStatus(oldHostPid: number): TaskStatus {
  const source = new TaskRegistry(() => 100)
  for (let index = 1; index <= 8; index += 1) {
    source.register(registration(index, index === 1 ? oldHostPid : 4_000 + index))
  }
  source.applyState('wrapper-2', 'executing', 'session-executing')
  source.applyState('wrapper-3', 'waiting', 'session-waiting')
  source.selectSlot(4)
  source.applyState('wrapper-4', 'complete', 'session-complete')
  return source.status()
}

describe('host-promotion recovery integration', () => {
  let promoted: HostServer

  beforeEach(() => {
    vi.useFakeTimers()
    promoted = new HostServer(claude, {
      token: 'recovery-test-token-that-is-at-least-thirty-two-bytes',
    })
  })

  afterEach(async () => {
    await promoted.close()
    vi.useRealTimers()
  })

  it('restores eight-wrapper state and preserves overflow slots through out-of-order reconnects', async () => {
    const oldHostPid = 9_001
    const cached = buildEightTaskStatus(oldHostPid)

    expect(cached.slots.map((task) => task?.wrapperId)).toEqual([
      'wrapper-1',
      'wrapper-2',
      'wrapper-3',
      'wrapper-4',
      'wrapper-5',
      'wrapper-6',
    ])
    expect(cached.unassigned.map((task) => task.wrapperId)).toEqual(['wrapper-7', 'wrapper-8'])

    const survivors = withoutProcess(cached, oldHostPid)
    expect(survivors.slots[0]).toBeNull()
    expect(survivors.selectedSlot).toBe(4)
    expect(taskFromStatus(survivors, 'wrapper-1')).toBeNull()

    promoted.restoreTaskStatus(survivors, 'wrapper-5')
    expect(promoted.tasks.list()).toHaveLength(7)
    expect(promoted.tasks.get('wrapper-2')).toMatchObject({
      state: 'executing',
      sessionId: 'session-executing',
      connectionState: 'reconnecting',
    })
    expect(promoted.tasks.get('wrapper-3')).toMatchObject({
      state: 'waiting',
      sessionId: 'session-waiting',
      connectionState: 'reconnecting',
    })
    expect(promoted.tasks.get('wrapper-4')).toMatchObject({
      state: 'complete',
      unread: true,
      selected: true,
      sessionId: 'session-complete',
      connectionState: 'reconnecting',
    })
    expect(promoted.tasks.get('wrapper-5')).toMatchObject({ connectionState: 'connected' })

    // Overflow wrappers deliberately reconnect first. Their explicit null slots
    // must not consume the free slot left behind by the previous host process.
    for (const wrapperId of [
      'wrapper-8',
      'wrapper-3',
      'wrapper-7',
      'wrapper-2',
      'wrapper-6',
      'wrapper-4',
    ]) {
      const cachedTask = taskFromStatus(survivors, wrapperId)
      expect(cachedTask, wrapperId).not.toBeNull()
      promoted.registerLocalWrapper(
        recoveryRegistration(recoveryIdentity(cachedTask!), cachedTask!),
      )
    }

    const restored = promoted.tasks.status()
    expect(restored.slots[0]).toBeNull()
    expect(restored.unassigned.map((task) => task.wrapperId)).toEqual(['wrapper-7', 'wrapper-8'])
    expect(restored.unassigned.every((task) => task.slot === null)).toBe(true)
    expect(promoted.tasks.list().every((task) => task.connectionState === 'connected')).toBe(true)
    expect(promoted.tasks.get('wrapper-2')).toMatchObject({
      state: 'executing',
      sessionId: 'session-executing',
    })
    expect(promoted.tasks.get('wrapper-3')).toMatchObject({
      state: 'waiting',
      sessionId: 'session-waiting',
    })
    expect(promoted.tasks.get('wrapper-4')).toMatchObject({
      state: 'complete',
      unread: true,
      selected: true,
      sessionId: 'session-complete',
    })
    expect(promoted.tasks.selected()?.wrapperId).toBe('wrapper-4')

    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS)
    expect(promoted.tasks.list()).toHaveLength(7)
    expect(promoted.tasks.status().slots[0]).toBeNull()
  })

  it('falls back from an exited selected host to waiting, then a connected executing task', async () => {
    const oldHostPid = 9_002
    const source = new TaskRegistry(() => 100)
    source.register(registration(1, oldHostPid))
    source.register(registration(2))
    source.register(registration(3))
    source.register(registration(4))
    source.applyState('wrapper-2', 'executing', 'session-executing')
    source.applyState('wrapper-3', 'waiting', 'session-waiting')

    const survivors = withoutProcess(source.status(), oldHostPid)
    expect(survivors.selectedSlot).toBeNull()

    promoted.restoreTaskStatus(survivors, 'wrapper-4')
    expect(promoted.tasks.selected()).toMatchObject({
      wrapperId: 'wrapper-3',
      state: 'waiting',
      connectionState: 'reconnecting',
    })

    const executing = taskFromStatus(survivors, 'wrapper-2')!
    promoted.registerLocalWrapper(recoveryRegistration(recoveryIdentity(executing), executing))

    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS)
    expect(promoted.tasks.get('wrapper-3')).toBeNull()
    expect(promoted.tasks.selected()).toMatchObject({
      wrapperId: 'wrapper-2',
      state: 'executing',
      connectionState: 'connected',
    })
  })
})
