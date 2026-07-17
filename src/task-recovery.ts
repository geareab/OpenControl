import type { TaskRecoveryMetadata, TaskRegistration, TaskSnapshot, TaskStatus } from './state.js'

export function taskFromStatus(status: TaskStatus | null, wrapperId: string): TaskSnapshot | null {
  if (!status) return null
  for (const task of [...status.slots, ...status.unassigned]) {
    if (task?.wrapperId === wrapperId) return task
  }
  return null
}

/** Build an explicit recovery registration; a null slot must remain overflow. */
export function recoveryRegistration(
  registration: Omit<TaskRegistration, 'slot' | 'recovery'>,
  task: TaskSnapshot,
): TaskRegistration {
  const recovery: TaskRecoveryMetadata = {
    state: task.state,
    unread: task.unread,
    selected: task.selected,
    sessionId: task.sessionId,
    registeredAt: task.registeredAt,
    updatedAt: task.updatedAt,
  }
  return { ...registration, slot: task.slot, recovery }
}

/**
 * Remove the wrapper process which owned the previous host before seeding a
 * promoted host. All other slot assignments and selection flags are retained.
 */
export function withoutProcess(status: TaskStatus, pid: number): TaskStatus {
  let removedSelected = false
  const slots = status.slots.map((task) => {
    if (!task || task.pid !== pid) return task
    removedSelected ||= task.selected
    return null
  })
  const unassigned = status.unassigned.filter((task) => {
    if (task.pid !== pid) return true
    removedSelected ||= task.selected
    return false
  })
  return {
    slots,
    unassigned,
    selectedSlot: removedSelected ? null : status.selectedSlot,
  }
}
