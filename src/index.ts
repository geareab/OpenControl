/** Public, side-effect-free OpenControl extension API. */
export * from './harness/index.js'
export * from './input/index.js'
export {
  InvalidSlotError,
  SlotConflictError,
  TaskRegistry,
  TASK_SLOT_COUNT,
  type TaskConnectionState,
  type TaskRegistration,
  type TaskRecoveryMetadata,
  type TaskSnapshot,
  type TaskState,
  type TaskStatus,
} from './state.js'
