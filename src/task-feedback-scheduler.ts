import type { TaskStatus } from './state.js'

export interface TaskFeedbackScheduler {
  schedule(): void
  cancel(): void
}

/**
 * Coalesce bursts of task updates while always publishing the newest registry
 * snapshot when the debounce window expires.
 */
export function createTaskFeedbackScheduler(
  readStatus: () => TaskStatus,
  publish: (status: TaskStatus) => void,
  delayMs: number,
): TaskFeedbackScheduler {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('feedback debounce delay must be a non-negative finite number')
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(): void {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        publish(readStatus())
      }, delayMs)
      timer.unref?.()
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
