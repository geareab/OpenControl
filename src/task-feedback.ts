import type { FeedbackFrame, TaskFeedbackState, TaskSlot } from './input/types.js'
import type { TaskConnectionState, TaskState, TaskStatus } from './state.js'

export function feedbackFrameForTasks(tasks: TaskStatus): FeedbackFrame {
  return {
    selectedSlot: tasks.selectedSlot as TaskSlot | null,
    slots: tasks.slots.map((task, index) => ({
      slot: (index + 1) as TaskSlot,
      state: task ? feedbackState(task.state, task.connectionState) : 'off',
      unread: task?.unread ?? false,
    })),
  }
}

export function feedbackState(
  state: TaskState,
  connectionState: TaskConnectionState = 'connected',
): TaskFeedbackState {
  return state === 'disconnected' || connectionState === 'reconnecting' ? 'error' : state
}
