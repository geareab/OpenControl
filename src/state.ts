import type { AgentKind, AgentState } from './harness/types.js'

export interface Aggregate {
  /** True when at least one task is executing and none needs attention. */
  playing: boolean
  /** Hook session belonging to the explicitly selected task, when known. */
  focusSessionId: string | null
}

export interface SessionApplyOptions {
  /** Retained for source compatibility. Completion no longer steals focus. */
  focusOnStop?: boolean
}

interface Session {
  state: AgentState
  order: number
}

export interface SessionTrackerOptions {
  /** Retained for source compatibility with pre-v1 callers. */
  now?: () => number
  onChange?: () => void
}

/**
 * Compatibility view of hook sessions. TaskRegistry is the source of truth for
 * slot ownership and routing; this tracker remains useful to legacy feedback
 * renderers which expect stable hook-session rows.
 */
export class SessionTracker {
  private sessions = new Map<string, Session>()
  private order = 0

  constructor(_options: SessionTrackerOptions = {}) {}

  apply(sessionId: string, state: AgentState, _options: SessionApplyOptions = {}): boolean {
    const previous = this.sessions.get(sessionId)
    this.sessions.set(sessionId, { state, order: ++this.order })
    return previous?.state !== state
  }

  list(): { id: string; state: AgentState; order: number }[] {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      state: session.state,
      order: session.order,
    }))
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /** Completion is intentionally persistent in v1; this is now a no-op. */
  decay(): boolean {
    return false
  }

  aggregate(): Aggregate {
    let attention: { id: string; order: number } | null = null
    let anyExecuting = false
    for (const [id, session] of this.sessions) {
      if (
        (session.state === 'waiting' || session.state === 'error') &&
        (!attention || session.order > attention.order)
      ) {
        attention = { id, order: session.order }
      }
      if (session.state === 'executing') anyExecuting = true
    }
    return {
      playing: !attention && anyExecuting,
      focusSessionId: attention?.id ?? null,
    }
  }
}

export const TASK_SLOT_COUNT = 6

export type TaskState = AgentState | 'disconnected'
export type TaskConnectionState = 'connected' | 'reconnecting'

export interface TaskRecoveryMetadata {
  state?: TaskState
  unread?: boolean
  selected?: boolean
  sessionId?: string | null
  registeredAt?: number
  updatedAt?: number
}

export interface TaskRegistration {
  wrapperId: string
  name?: string
  kind: AgentKind
  cwd: string
  pid: number
  /** One-based slot. Omit for first-free allocation; null preserves an overflow task. */
  slot?: number | null
  /** Cached task metadata supplied only while recovering from a host exit. */
  recovery?: TaskRecoveryMetadata
}

export interface TaskSnapshot {
  wrapperId: string
  name: string
  kind: AgentKind
  cwd: string
  pid: number
  state: TaskState
  /** Omitted by pre-v1 peers; current hosts always include it. */
  connectionState?: TaskConnectionState
  slot: number | null
  selected: boolean
  unread: boolean
  sessionId: string | null
  registeredAt: number
  updatedAt: number
}

export interface TaskStatus {
  slots: Array<TaskSnapshot | null>
  unassigned: TaskSnapshot[]
  selectedSlot: number | null
}

type TaskRecord = Omit<TaskSnapshot, 'selected' | 'connectionState'> & {
  connectionState: TaskConnectionState
}

export class SlotConflictError extends Error {
  readonly code = 'SLOT_OCCUPIED'

  constructor(
    readonly slot: number,
    readonly ownerWrapperId: string,
  ) {
    super(`Task slot ${slot} is already occupied`)
    this.name = 'SlotConflictError'
  }
}

export class InvalidSlotError extends RangeError {
  readonly code = 'INVALID_SLOT'

  constructor(readonly slot: number) {
    super(`Task slot must be an integer from 1 to ${TASK_SLOT_COUNT}; received ${slot}`)
    this.name = 'InvalidSlotError'
  }
}

/** Six task slots with sticky, explicit selection and persistent unread state. */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()
  private selectedWrapperId: string | null = null

  constructor(private readonly now: () => number = Date.now) {}

  register(input: TaskRegistration): TaskSnapshot {
    const existing = this.tasks.get(input.wrapperId)
    if (existing) {
      const recovery = input.recovery
      const recoveryUpdatedAt = recovery?.updatedAt
      const hasNewerRecovery =
        typeof recoveryUpdatedAt === 'number' &&
        Number.isFinite(recoveryUpdatedAt) &&
        recoveryUpdatedAt > existing.updatedAt
      if (input.slot !== undefined && input.slot !== existing.slot) {
        if (input.slot !== null) {
          this.assertSlot(input.slot)
          const owner = this.taskAtSlot(input.slot)
          if (owner && owner.wrapperId !== input.wrapperId) {
            throw new SlotConflictError(input.slot, owner.wrapperId)
          }
        }
        existing.slot = input.slot
      }
      existing.name = normalizedName(input.name, input.kind, existing.slot)
      existing.kind = input.kind
      existing.cwd = input.cwd
      existing.pid = input.pid
      if (hasNewerRecovery && recovery) {
        if (recovery.state !== undefined) existing.state = recovery.state
        if (recovery.unread !== undefined) existing.unread = recovery.unread
        if (recovery.sessionId !== undefined) existing.sessionId = recovery.sessionId
        existing.registeredAt = validTimestamp(recovery.registeredAt, existing.registeredAt)
        if (recovery.selected && existing.slot !== null) {
          this.selectedWrapperId = input.wrapperId
        }
      }
      existing.connectionState = 'connected'
      existing.updatedAt = this.nextUpdatedAt(
        existing.updatedAt,
        hasNewerRecovery ? recoveryUpdatedAt! : undefined,
      )
      // Stale per-wrapper caches cannot steal selection; a genuinely newer
      // snapshot above can repair a promoter's older registry view.
      if (!this.selectedWrapperId && existing.slot !== null) {
        this.selectedWrapperId = input.wrapperId
      }
      return this.snapshot(existing)
    }

    const slot = this.allocateSlot(input.slot)
    const timestamp = this.now()
    const recovery = input.recovery
    const record: TaskRecord = {
      wrapperId: input.wrapperId,
      name: normalizedName(input.name, input.kind, slot),
      kind: input.kind,
      cwd: input.cwd,
      pid: input.pid,
      state: recovery?.state ?? 'idle',
      connectionState: 'connected',
      slot,
      unread: recovery?.unread ?? false,
      sessionId: recovery?.sessionId ?? null,
      registeredAt: validTimestamp(recovery?.registeredAt, timestamp),
      updatedAt: validTimestamp(recovery?.updatedAt, timestamp),
    }
    this.tasks.set(input.wrapperId, record)
    if (recovery?.selected && slot !== null) {
      this.selectedWrapperId = input.wrapperId
    } else if (!this.selectedWrapperId && slot !== null) {
      this.selectedWrapperId = input.wrapperId
      record.updatedAt = this.nextUpdatedAt(record.updatedAt)
    }
    return this.snapshot(record)
  }

  /** Restore an authenticated status snapshot into a freshly promoted host. */
  restore(status: TaskStatus, connectedWrapperId?: string): TaskSnapshot[] {
    if (this.tasks.size > 0) throw new Error('Task registry must be empty before recovery')
    if (!Array.isArray(status.slots) || status.slots.length !== TASK_SLOT_COUNT) {
      throw new Error(`Recovered task status must contain ${TASK_SLOT_COUNT} slots`)
    }

    const entries: Array<{ task: TaskSnapshot; slot: number | null }> = []
    status.slots.forEach((task, index) => {
      if (!task) return
      if (task.slot !== index + 1)
        throw new Error('Recovered task slot does not match its position')
      entries.push({ task, slot: index + 1 })
    })
    for (const task of status.unassigned) {
      if (task.slot !== null) throw new Error('Recovered overflow task must have a null slot')
      entries.push({ task, slot: null })
    }

    const seen = new Set<string>()
    const timestamp = this.now()
    for (const { task, slot } of entries) {
      if (!task.wrapperId || seen.has(task.wrapperId)) {
        throw new Error('Recovered task status contains a duplicate or empty wrapper id')
      }
      seen.add(task.wrapperId)
      const record: TaskRecord = {
        wrapperId: task.wrapperId,
        name: task.name,
        kind: task.kind,
        cwd: task.cwd,
        pid: task.pid,
        state: task.state,
        connectionState: task.wrapperId === connectedWrapperId ? 'connected' : 'reconnecting',
        slot,
        unread: task.unread,
        sessionId: task.sessionId,
        registeredAt: validTimestamp(task.registeredAt, timestamp),
        updatedAt: validTimestamp(task.updatedAt, timestamp),
      }
      this.tasks.set(record.wrapperId, record)
    }

    const selected = entries.find(
      ({ task, slot }) => task.selected || (slot !== null && slot === status.selectedSlot),
    )?.task.wrapperId
    if (selected && this.tasks.has(selected)) {
      this.selectedWrapperId = selected
    } else {
      this.selectFallback(undefined, true, false)
    }
    return this.list()
  }

  unregister(wrapperId: string): boolean {
    const existed = this.tasks.delete(wrapperId)
    if (!existed) return false
    if (this.selectedWrapperId === wrapperId) {
      this.selectFallback()
    }
    return true
  }

  applyState(wrapperId: string, state: AgentState, sessionId?: string): boolean {
    const task = this.tasks.get(wrapperId)
    if (!task) return false
    const nextUnread = state === 'complete' ? true : state === 'idle' ? false : task.unread
    const changed =
      task.state !== state ||
      task.unread !== nextUnread ||
      (sessionId !== undefined && task.sessionId !== sessionId)
    task.state = state
    task.unread = nextUnread
    if (sessionId !== undefined) task.sessionId = sessionId
    task.updatedAt = this.nextUpdatedAt(task.updatedAt)
    return changed
  }

  clearSession(wrapperId: string, sessionId: string): boolean {
    const task = this.tasks.get(wrapperId)
    if (!task || task.sessionId !== sessionId) return false
    task.sessionId = null
    if (task.state === 'waiting' || task.state === 'executing') task.state = 'idle'
    task.updatedAt = this.nextUpdatedAt(task.updatedAt)
    return true
  }

  markDisconnected(wrapperId: string): boolean {
    const task = this.tasks.get(wrapperId)
    if (!task) return false
    task.state = 'disconnected'
    task.connectionState = 'reconnecting'
    task.updatedAt = this.nextUpdatedAt(task.updatedAt)
    if (this.selectedWrapperId === wrapperId) {
      this.selectFallback(wrapperId)
    }
    return true
  }

  markReconnecting(wrapperId: string): boolean {
    const task = this.tasks.get(wrapperId)
    if (!task) return false
    const changed = task.connectionState !== 'reconnecting'
    task.connectionState = 'reconnecting'
    task.updatedAt = this.nextUpdatedAt(task.updatedAt)
    return changed
  }

  markConnected(wrapperId: string): boolean {
    const task = this.tasks.get(wrapperId)
    if (!task) return false
    const changed = task.connectionState !== 'connected'
    task.connectionState = 'connected'
    task.updatedAt = this.nextUpdatedAt(task.updatedAt)
    return changed
  }

  selectSlot(slot: number): TaskSnapshot | null {
    this.assertSlot(slot)
    const task = this.taskAtSlot(slot)
    if (!task || task.state === 'disconnected' || task.connectionState !== 'connected') return null
    this.selectRecord(task)
    return this.snapshot(task)
  }

  selectWrapper(wrapperId: string): TaskSnapshot | null {
    const task = this.tasks.get(wrapperId)
    if (
      !task ||
      task.slot === null ||
      task.state === 'disconnected' ||
      task.connectionState !== 'connected'
    )
      return null
    this.selectRecord(task)
    return this.snapshot(task)
  }

  selectRelative(delta: 1 | -1): TaskSnapshot | null {
    const occupied = [...this.tasks.values()]
      .filter(
        (task) =>
          task.slot !== null &&
          task.state !== 'disconnected' &&
          task.connectionState === 'connected',
      )
      .sort((a, b) => a.slot! - b.slot!)
    if (occupied.length === 0) return null
    const current = occupied.findIndex((task) => task.wrapperId === this.selectedWrapperId)
    const start = current < 0 ? (delta === 1 ? -1 : 0) : current
    const target = occupied[(start + delta + occupied.length) % occupied.length]!
    this.selectRecord(target)
    return this.snapshot(target)
  }

  get(wrapperId: string): TaskSnapshot | null {
    const task = this.tasks.get(wrapperId)
    return task ? this.snapshot(task) : null
  }

  selected(): TaskSnapshot | null {
    if (!this.selectedWrapperId) return null
    const task = this.tasks.get(this.selectedWrapperId)
    return task ? this.snapshot(task) : null
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((a, b) => {
        if (a.slot === null && b.slot === null) return a.registeredAt - b.registeredAt
        if (a.slot === null) return 1
        if (b.slot === null) return -1
        return a.slot - b.slot
      })
      .map((task) => this.snapshot(task))
  }

  status(): TaskStatus {
    const slots: Array<TaskSnapshot | null> = Array.from({ length: TASK_SLOT_COUNT }, () => null)
    const unassigned: TaskSnapshot[] = []
    for (const task of this.list()) {
      if (task.slot === null) unassigned.push(task)
      else slots[task.slot - 1] = task
    }
    return {
      slots,
      unassigned,
      selectedSlot: this.selected()?.slot ?? null,
    }
  }

  aggregate(): Aggregate {
    const active = [...this.tasks.values()].filter(
      (task) => task.state !== 'disconnected' && task.connectionState === 'connected',
    )
    const attention = active.some((task) => task.state === 'waiting' || task.state === 'error')
    const executing = active.some((task) => task.state === 'executing')
    return {
      playing: executing && !attention,
      focusSessionId: this.selected()?.sessionId ?? null,
    }
  }

  private allocateSlot(requested?: number | null): number | null {
    if (requested !== undefined) {
      if (requested === null) return null
      this.assertSlot(requested)
      const owner = this.taskAtSlot(requested)
      if (owner) throw new SlotConflictError(requested, owner.wrapperId)
      return requested
    }
    for (let slot = 1; slot <= TASK_SLOT_COUNT; slot += 1) {
      if (!this.taskAtSlot(slot)) return slot
    }
    return null
  }

  private taskAtSlot(slot: number): TaskRecord | null {
    for (const task of this.tasks.values()) {
      if (task.slot === slot) return task
    }
    return null
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > TASK_SLOT_COUNT) {
      throw new InvalidSlotError(slot)
    }
  }

  private selectRecord(task: TaskRecord): void {
    this.selectedWrapperId = task.wrapperId
    if (task.unread) task.unread = false
    if (task.state === 'complete') task.state = 'idle'
    task.updatedAt = this.nextUpdatedAt(task.updatedAt)
  }

  private nextUpdatedAt(previous: number, floor?: number): number {
    return Math.max(this.now(), previous + 1, floor ?? 0)
  }

  private selectFallback(
    exclude?: string,
    includeReconnecting = false,
    touchSelection = true,
  ): void {
    this.selectedWrapperId = this.fallbackWrapperId(exclude, includeReconnecting)
    if (!this.selectedWrapperId || !touchSelection) return
    const task = this.tasks.get(this.selectedWrapperId)
    if (task) task.updatedAt = this.nextUpdatedAt(task.updatedAt)
  }

  private fallbackWrapperId(exclude?: string, includeReconnecting = false): string | null {
    const candidates = [...this.tasks.values()]
      .filter(
        (task) => task.wrapperId !== exclude && task.slot !== null && task.state !== 'disconnected',
      )
      .filter((task) => includeReconnecting || task.connectionState === 'connected')
    const ranked = (state: TaskState): TaskRecord | undefined =>
      candidates.filter((task) => task.state === state).sort((a, b) => a.slot! - b.slot!)[0]
    return (
      (
        ranked('waiting') ??
        ranked('executing') ??
        candidates.sort((a, b) => a.slot! - b.slot!)[0] ??
        null
      )?.wrapperId ?? null
    )
  }

  private snapshot(task: TaskRecord): TaskSnapshot {
    return { ...task, selected: task.wrapperId === this.selectedWrapperId }
  }
}

function normalizedName(name: string | undefined, kind: AgentKind, slot: number | null): string {
  const trimmed = name?.trim()
  if (trimmed) return trimmed
  return slot === null ? String(kind) : `${String(kind)} ${slot}`
}

function validTimestamp(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
