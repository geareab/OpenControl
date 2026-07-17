import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { harnessFor } from './harness/index.js'
import type { AgentKind, AgentState, Harness } from './harness/types.js'
import { isControlId } from './input/types.js'
import { logger } from './logger.js'
import { API_PATHS, HOOK_PATH } from './ports.js'
import {
  acquireRuntimeLease,
  createRuntimeToken,
  runtimeProcessStartId,
  type RuntimeDescriptor,
  type RuntimeLease,
} from './runtime.js'
import {
  InvalidSlotError,
  SessionTracker,
  SlotConflictError,
  TaskRegistry,
  type Aggregate,
  type TaskRegistration,
  type TaskSnapshot,
  type TaskStatus,
} from './state.js'

export const WRAPPER_HEADER = 'x-opencontrol-wrapper-id'
export const LEGACY_WRAPPER_HEADER = 'x-openmicro-instance-id'

export type ControlPhase = 'press' | 'release' | 'repeat'

export interface HostControlEvent {
  controlId: string
  phase: ControlPhase
  sourceId: string
  timestamp: number
}

export interface HostStatus {
  app: 'opencontrol'
  version: 1
  pid: number
  port: number
  tasks: TaskStatus
  devices: unknown[]
}

export interface HostServerOptions {
  /** Compatibility owner for old callers. Prefer registerLocalWrapper. */
  hostWrapperId?: string
  token?: string
}

interface InstanceRecord {
  id: string
  res: http.ServerResponse | null
  wrapperId: string
  cwd: string
  generation: number
  explicitClose: boolean
  opened: boolean
  expires: ReturnType<typeof setTimeout> | null
}

interface ReconnectLease {
  generation: number
  timer: ReturnType<typeof setTimeout>
}

const MAX_BODY_BYTES = 1024 * 1024
export const MAX_TASKS = 64
export const MAX_STREAMS = 64
const MAX_WRAPPER_ID_LENGTH = 128
const MAX_SESSION_ID_LENGTH = 256
const MAX_SOURCE_ID_LENGTH = 128
const MAX_KIND_LENGTH = 64
const MAX_TASK_NAME_LENGTH = 256
const MAX_CWD_LENGTH = 4096
const MAX_HOOK_EVENT_LENGTH = 64
const PENDING_REGISTRATION_MS = 30_000
export const RECONNECT_GRACE_MS = 5_000
const KNOWN_HOOK_EVENTS = new Set([
  'UserPromptSubmit',
  'Stop',
  'Notification',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'StopFailure',
  'ProcessFailure',
  'SessionEnd',
])

const ROUTE_RATE_LIMITS = {
  health: { requests: 120, windowMs: 60_000 },
  status: { requests: 120, windowMs: 60_000 },
  register: { requests: 128, windowMs: 10_000 },
  hook: { requests: 256, windowMs: 1_000 },
  control: { requests: 512, windowMs: 1_000 },
  instance: { requests: 128, windowMs: 10_000 },
  other: { requests: 120, windowMs: 60_000 },
} as const

export const HTTP_SERVER_LIMITS = Object.freeze({
  maxConnections: 128,
  maxHeadersCount: 32,
  maxHeaderSize: 16 * 1024,
  headersTimeout: 5_000,
  requestTimeout: 10_000,
  keepAliveTimeout: 1_000,
})

type RouteClass = keyof typeof ROUTE_RATE_LIMITS

interface RateBucket {
  count: number
  startedAt: number
}

class RequestBodyTooLargeError extends RangeError {}

function startSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  res.write('retry: 1000\n\n')
}

function sendSse(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let settled = false
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      req.resume()
      reject(new RequestBodyTooLargeError('request body too large'))
      return
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        settled = true
        reject(new RequestBodyTooLargeError('request body too large'))
        req.resume()
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (!settled) resolve(body)
    })
    req.on('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

export class HostServer extends EventEmitter {
  /** Hook-session compatibility view used by existing gamepad feedback. */
  readonly tracker = new SessionTracker()
  readonly tasks = new TaskRegistry()
  readonly sessionOwners = new Map<string, string>()
  readonly authToken: string

  private readonly hostWrapperId?: string
  private readonly wrapperHarness = new Map<string, Harness>()
  private readonly localWriters = new Map<string, (bytes: string) => void>()
  private readonly instances = new Map<string, InstanceRecord>()
  private readonly currentInstanceByWrapper = new Map<string, string>()
  private readonly wrapperGenerations = new Map<string, number>()
  private readonly reconnectLeases = new Map<string, ReconnectLease>()
  private readonly rateBuckets = new Map<RouteClass, RateBucket>()
  private readonly devices: unknown[] = []
  private server: http.Server | null = null
  private runtimeLease: RuntimeLease | null = null
  private runtimeDescriptor: RuntimeDescriptor | null = null

  boundPort = 0

  constructor(
    private readonly hostHarness: Harness,
    options: string | HostServerOptions = {},
  ) {
    super()
    const normalized = typeof options === 'string' ? { hostWrapperId: options } : options
    this.hostWrapperId = normalized.hostWrapperId
    this.authToken = normalized.token ?? createRuntimeToken()
    if (this.hostWrapperId) this.wrapperHarness.set(this.hostWrapperId, hostHarness)
  }

  /** Bind a loopback port. Prefer port 0; production discovery uses listenRuntime. */
  listen(port = 0): Promise<boolean> {
    if (this.server) return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      const server = http.createServer(
        {
          maxHeaderSize: HTTP_SERVER_LIMITS.maxHeaderSize,
          requireHostHeader: true,
        },
        (req, res) => {
          this.handle(req, res).catch((error) => {
            logger.error('server request failed', error)
            if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
            else res.end()
          })
        },
      )
      server.maxConnections = HTTP_SERVER_LIMITS.maxConnections
      server.maxHeadersCount = HTTP_SERVER_LIMITS.maxHeadersCount
      server.headersTimeout = HTTP_SERVER_LIMITS.headersTimeout
      server.requestTimeout = HTTP_SERVER_LIMITS.requestTimeout
      server.keepAliveTimeout = HTTP_SERVER_LIMITS.keepAliveTimeout
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const address = server.address()
        this.boundPort = typeof address === 'object' && address ? address.port : port
        resolve(true)
      })
    })
  }

  /**
   * Acquire the singleton lease and bind an ephemeral port. Initialization is
   * completed while the descriptor is still private, so no peer can register
   * against a host whose recovered registry has not been seeded yet.
   */
  async listenRuntime(
    runtimePath?: string,
    initialize?: () => void | Promise<void>,
  ): Promise<boolean> {
    const lease = await acquireRuntimeLease({ file: runtimePath, token: this.authToken })
    if (!lease) return false
    try {
      const listening = await this.listen(0)
      if (!listening) {
        lease.release()
        return false
      }
      await initialize?.()
      this.runtimeLease = lease
      this.runtimeDescriptor = lease.publish(this.boundPort)
      return true
    } catch (error) {
      lease.release()
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    for (const lease of this.reconnectLeases.values()) clearTimeout(lease.timer)
    this.reconnectLeases.clear()
    for (const instance of [...this.instances.values()]) this.closeInstance(instance)
    this.instances.clear()
    this.currentInstanceByWrapper.clear()
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
    this.runtimeLease?.release()
    this.runtimeLease = null
    this.runtimeDescriptor = null
  }

  registerLocalWrapper(
    registration: TaskRegistration,
    harness: Harness = this.harnessForKind(registration.kind),
  ): TaskSnapshot {
    if (!isTaskRegistration(registration)) throw new TypeError('Invalid local task registration')
    if (!this.tasks.get(registration.wrapperId) && this.tasks.list().length >= MAX_TASKS) {
      throw new RangeError(`OpenControl supports at most ${MAX_TASKS} tasks`)
    }
    const previousSessionId = this.tasks.get(registration.wrapperId)?.sessionId ?? null
    const task = this.tasks.register(registration)
    this.advanceWrapperGeneration(registration.wrapperId)
    this.supersedeCurrentInstance(registration.wrapperId)
    this.wrapperHarness.set(registration.wrapperId, harness)
    this.syncTaskSession(task, previousSessionId)
    this.notifyStateChange()
    return task
  }

  /** Attach the host PTY only after registration succeeds. */
  attachWriter(wrapperId: string, write: (bytes: string) => void): () => void {
    if (!this.tasks.get(wrapperId)) throw new Error(`Unknown wrapper: ${wrapperId}`)
    this.localWriters.set(wrapperId, write)
    return () => {
      if (this.localWriters.get(wrapperId) === write) this.localWriters.delete(wrapperId)
    }
  }

  unregisterWrapper(wrapperId: string): boolean {
    return this.removeWrapper(wrapperId)
  }

  /** Seed a freshly promoted host from the last full status received over SSE. */
  restoreTaskStatus(status: TaskStatus, connectedWrapperId: string): TaskSnapshot[] {
    if (this.instances.size > 0 || this.localWriters.size > 0) {
      throw new Error('Task status must be restored before attaching wrappers')
    }
    const taskCount =
      (Array.isArray(status.slots) ? status.slots.filter(Boolean).length : 0) +
      (Array.isArray(status.unassigned) ? status.unassigned.length : 0)
    if (taskCount > MAX_TASKS) {
      throw new RangeError(`OpenControl supports at most ${MAX_TASKS} restored tasks`)
    }
    const restored = this.tasks.restore(status, connectedWrapperId)
    this.wrapperGenerations.clear()
    for (const task of restored) {
      this.wrapperGenerations.set(task.wrapperId, 0)
      this.wrapperHarness.set(task.wrapperId, this.harnessForKind(task.kind))
      if (task.sessionId) {
        this.sessionOwners.set(task.sessionId, task.wrapperId)
        if (task.state !== 'disconnected') this.tracker.apply(task.sessionId, task.state)
      }
      if (task.wrapperId !== connectedWrapperId) this.scheduleReconnectExpiry(task.wrapperId, 0)
    }
    this.notifyStateChange()
    return restored
  }

  /** Record an internal wrapper/process failure outside the agent hook surface. */
  reportTaskState(wrapperId: string, state: AgentState): boolean {
    const changed = this.tasks.applyState(wrapperId, state)
    if (changed) this.notifyStateChange()
    return changed
  }

  selectSlot(slot: number): TaskSnapshot | null {
    const selected = this.tasks.selectSlot(slot)
    if (selected) this.notifyStateChange()
    return selected
  }

  selectRelative(delta: 1 | -1): TaskSnapshot | null {
    const selected = this.tasks.selectRelative(delta)
    if (selected) this.notifyStateChange()
    return selected
  }

  dispatchControl(event: HostControlEvent): TaskSnapshot | null {
    let selected: TaskSnapshot | null = null
    const match = /^agent\.([1-6])$/.exec(event.controlId)
    if (match && event.phase === 'press') selected = this.selectSlot(Number(match[1]))
    this.emit('control', event)
    return selected
  }

  status(): HostStatus {
    return {
      app: 'opencontrol',
      version: 1,
      pid: process.pid,
      port: this.boundPort,
      tasks: this.tasks.status(),
      devices: [...this.devices],
    }
  }

  setDevices(devices: readonly unknown[]): void {
    this.devices.splice(0, this.devices.length, ...devices)
    this.emit('status', this.status())
  }

  sendKeysToWrapper(wrapperId: string, bytes: string): boolean {
    const local = this.localWriters.get(wrapperId)
    if (local) {
      local(bytes)
      return true
    }
    for (const instance of this.instances.values()) {
      if (instance.wrapperId !== wrapperId || !instance.res) continue
      sendSse(instance.res, { type: 'keys', data: Buffer.from(bytes, 'utf8').toString('base64') })
      return true
    }
    return false
  }

  sendKeysToSelected(bytes: string): boolean {
    const selected = this.tasks.selected()
    return selected ? this.sendKeysToWrapper(selected.wrapperId, bytes) : false
  }

  /** Compatibility route for the pre-v1 CLI. */
  sendKeysToInstance(instanceId: string, bytes: string): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance?.res) return false
    sendSse(instance.res, { type: 'keys', data: Buffer.from(bytes, 'utf8').toString('base64') })
    return true
  }

  instanceForSession(sessionId: string): string | null {
    const owner = this.sessionOwners.get(sessionId)
    if (!owner) return null
    for (const [id, instance] of this.instances) {
      if (instance.wrapperId === owner && instance.res) return id
    }
    return null
  }

  removeSessionsForOwner(wrapperId: string): boolean {
    let changed = false
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner !== wrapperId) continue
      changed = this.tracker.remove(sessionId) || changed
      changed = this.tasks.clearSession(wrapperId, sessionId) || changed
      this.sessionOwners.delete(sessionId)
    }
    return changed
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname

    if (!this.isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    const retryAfter = this.rateLimitRetryAfter(this.routeClass(pathname))
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter))
      sendJson(res, 429, { error: 'rate_limited' })
      return
    }

    if (req.method === 'GET' && pathname === API_PATHS.health) {
      sendJson(res, 200, {
        app: 'opencontrol',
        pid: process.pid,
        version: 1,
        processStartId: runtimeProcessStartId(),
      })
      return
    }
    if (req.method === 'GET' && pathname === API_PATHS.status) {
      sendJson(res, 200, this.status())
      return
    }
    const hookEvent = req.method === 'POST' ? this.hookEvent(pathname) : null
    if (hookEvent !== null) {
      await this.handleHook(hookEvent, req, res)
      return
    }
    if (req.method === 'POST' && pathname === API_PATHS.register) {
      await this.handleRegister(req, res)
      return
    }
    if (req.method === 'POST' && pathname === API_PATHS.control) {
      await this.handleControl(req, res)
      return
    }
    if (req.method === 'DELETE' && pathname.startsWith(API_PATHS.instancePrefix)) {
      this.handleInstanceDelete(pathname.slice(API_PATHS.instancePrefix.length), req, res)
      return
    }
    if (req.method === 'GET' && pathname.startsWith(API_PATHS.instancePrefix)) {
      this.handleInstanceStream(pathname.slice(API_PATHS.instancePrefix.length), req, res)
      return
    }
    sendJson(res, 404, { error: 'not_found' })
  }

  private async handleHook(
    event: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const wrapperId = this.wrapperIdFrom(req)
    if (!wrapperId || !this.isActiveOwner(wrapperId)) {
      sendJson(res, 403, { error: 'unknown_wrapper' })
      return
    }

    let payload: unknown = {}
    try {
      const body = await readBody(req)
      if (body) payload = JSON.parse(body)
    } catch (error) {
      this.sendBodyError(res, error)
      return
    }
    if (
      !isRecord(payload) ||
      (event !== 'ProcessFailure' && !isIdentifier(payload.session_id, MAX_SESSION_ID_LENGTH)) ||
      (event === 'ProcessFailure' &&
        payload.session_id !== undefined &&
        !isIdentifier(payload.session_id, MAX_SESSION_ID_LENGTH))
    ) {
      sendJson(res, 400, { error: 'invalid_hook_event' })
      return
    }
    const sessionId = payload.session_id === undefined ? null : (payload.session_id as string)

    const harness = this.wrapperHarness.get(wrapperId) ?? this.hostHarness
    let changed = false
    if (event === 'SessionEnd') {
      if (sessionId === null) {
        sendJson(res, 400, { error: 'invalid_hook_event' })
        return
      }
      const owner = this.sessionOwners.get(sessionId)
      if (owner && owner !== wrapperId) {
        sendJson(res, 403, { error: 'session_not_owned' })
        return
      }
      changed = this.tracker.remove(sessionId)
      changed = this.tasks.clearSession(wrapperId, sessionId) || changed
      this.sessionOwners.delete(sessionId)
    } else {
      const state = harness.stateForHookEvent(event, payload)
      if (state !== null) {
        if (sessionId === null) {
          changed = this.tasks.applyState(wrapperId, state) || changed
          if (changed) this.notifyStateChange()
          sendJson(res, 200, { ok: true })
          return
        }
        const owner = this.sessionOwners.get(sessionId)
        if (owner && owner !== wrapperId) {
          sendJson(res, 409, { error: 'session_already_owned' })
          return
        }
        changed = this.removeOtherSessionsForOwner(wrapperId, sessionId) || changed
        this.sessionOwners.set(sessionId, wrapperId)
        changed = this.tracker.apply(sessionId, state) || changed
        changed = this.tasks.applyState(wrapperId, state, sessionId) || changed
      }
    }
    if (changed) this.notifyStateChange()
    sendJson(res, 200, { ok: true })
  }

  private async handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown
    try {
      body = JSON.parse(await readBody(req)) as unknown
    } catch (error) {
      this.sendBodyError(res, error)
      return
    }
    if (!isTaskRegistration(body)) {
      sendJson(res, 400, { error: 'invalid_registration' })
      return
    }
    const existingTask = this.tasks.get(body.wrapperId)
    if (!existingTask && this.tasks.list().length >= MAX_TASKS) {
      sendJson(res, 429, { error: 'task_limit_exceeded', limit: MAX_TASKS })
      return
    }
    const currentInstanceId = this.currentInstanceByWrapper.get(body.wrapperId)
    if (!currentInstanceId && this.instances.size >= MAX_STREAMS) {
      sendJson(res, 429, { error: 'stream_limit_exceeded', limit: MAX_STREAMS })
      return
    }

    try {
      const registration = body
      const previousSessionId = this.tasks.get(registration.wrapperId)?.sessionId ?? null
      const task = this.tasks.register(registration)
      this.wrapperHarness.set(registration.wrapperId, this.harnessForKind(registration.kind))
      this.syncTaskSession(task, previousSessionId)
      const generation = this.advanceWrapperGeneration(registration.wrapperId)
      this.supersedeCurrentInstance(registration.wrapperId)
      const instanceId = this.createInstanceId()
      const instance: InstanceRecord = {
        id: instanceId,
        res: null,
        wrapperId: registration.wrapperId,
        cwd: registration.cwd,
        generation,
        explicitClose: false,
        opened: false,
        expires: null,
      }
      instance.expires = setTimeout(() => {
        const current = this.instances.get(instanceId)
        if (current !== instance || current.res) return
        this.closeInstance(instance)
        this.removeWrapper(instance.wrapperId, instance.generation)
      }, PENDING_REGISTRATION_MS)
      instance.expires.unref?.()
      this.instances.set(instanceId, instance)
      this.currentInstanceByWrapper.set(registration.wrapperId, instanceId)
      this.notifyStateChange()
      sendJson(res, 201, { instanceId, task })
      logger.info('client task registered', {
        instanceId,
        wrapperId: registration.wrapperId,
        slot: task.slot,
        kind: registration.kind,
      })
    } catch (error) {
      if (error instanceof SlotConflictError) {
        sendJson(res, 409, {
          error: error.code,
          slot: error.slot,
          ownerWrapperId: error.ownerWrapperId,
        })
        return
      }
      if (error instanceof InvalidSlotError) {
        sendJson(res, 400, { error: error.code, slot: error.slot })
        return
      }
      throw error
    }
  }

  private handleInstanceStream(
    instanceId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const instance = this.instances.get(instanceId)
    if (
      !instance ||
      instance.res ||
      instance.opened ||
      this.currentInstanceByWrapper.get(instance.wrapperId) !== instanceId
    ) {
      sendJson(res, 404, { error: 'unknown_instance' })
      return
    }
    if (this.wrapperIdFrom(req) !== instance.wrapperId) {
      sendJson(res, 403, { error: 'instance_not_owned' })
      return
    }
    if (instance.expires) clearTimeout(instance.expires)
    instance.expires = null
    instance.res = res
    instance.opened = true
    startSse(res)
    sendSse(res, { type: 'status', status: this.tasks.status() })
    res.once('close', () => {
      const current = this.instances.get(instanceId)
      if (
        current !== instance ||
        instance.explicitClose ||
        this.currentInstanceByWrapper.get(instance.wrapperId) !== instanceId ||
        this.wrapperGenerations.get(instance.wrapperId) !== instance.generation
      )
        return
      instance.res = null
      if (this.tasks.markReconnecting(instance.wrapperId)) this.notifyStateChange()
      this.scheduleReconnectExpiry(instance.wrapperId, instance.generation)
    })
  }

  private handleInstanceDelete(
    instanceId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const instance = this.instances.get(instanceId)
    if (!instance || this.currentInstanceByWrapper.get(instance.wrapperId) !== instanceId) {
      sendJson(res, 404, { error: 'unknown_instance' })
      return
    }
    if (this.wrapperIdFrom(req) !== instance.wrapperId) {
      sendJson(res, 403, { error: 'instance_not_owned' })
      return
    }
    this.closeInstance(instance)
    this.removeWrapper(instance.wrapperId, instance.generation)
    sendJson(res, 200, { ok: true })
  }

  private async handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown
    try {
      body = JSON.parse(await readBody(req)) as unknown
    } catch (error) {
      this.sendBodyError(res, error)
      return
    }
    if (
      !isRecord(body) ||
      !isControlId(body.controlId) ||
      !isControlPhase(body.phase) ||
      (body.sourceId !== undefined && !isIdentifier(body.sourceId, MAX_SOURCE_ID_LENGTH)) ||
      (body.timestamp !== undefined &&
        (!Number.isSafeInteger(body.timestamp) || (body.timestamp as number) < 0))
    ) {
      sendJson(res, 400, { error: 'invalid_control_event' })
      return
    }
    const event: HostControlEvent = {
      controlId: body.controlId,
      phase: body.phase,
      sourceId: body.sourceId === undefined ? 'http' : body.sourceId,
      timestamp: body.timestamp === undefined ? Date.now() : (body.timestamp as number),
    }
    const selected = this.dispatchControl(event)
    sendJson(res, 200, { ok: true, selected })
  }

  private hookEvent(pathname: string): string | null {
    let encoded: string | null = null
    if (pathname.startsWith(API_PATHS.hookPrefix)) {
      encoded = pathname.slice(API_PATHS.hookPrefix.length)
    }
    // Authenticated compatibility path for hooks installed by OpenMicro.
    if (encoded === null && pathname.startsWith(HOOK_PATH)) {
      encoded = pathname.slice(HOOK_PATH.length)
    }
    if (!encoded || encoded.length > MAX_HOOK_EVENT_LENGTH * 3) return null
    try {
      const event = decodeURIComponent(encoded)
      return event.length <= MAX_HOOK_EVENT_LENGTH && KNOWN_HOOK_EVENTS.has(event) ? event : null
    } catch {
      return null
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return false
    const supplied = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(this.authToken)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  private wrapperIdFrom(req: http.IncomingMessage): string | null {
    const value = req.headers[WRAPPER_HEADER] ?? req.headers[LEGACY_WRAPPER_HEADER]
    const wrapperId = (Array.isArray(value) ? value[0] : value) ?? null
    return isIdentifier(wrapperId, MAX_WRAPPER_ID_LENGTH) ? wrapperId : null
  }

  private routeClass(pathname: string): RouteClass {
    if (pathname === API_PATHS.health) return 'health'
    if (pathname === API_PATHS.status) return 'status'
    if (pathname === API_PATHS.register) return 'register'
    if (pathname === API_PATHS.control) return 'control'
    if (pathname.startsWith(API_PATHS.hookPrefix) || pathname.startsWith(HOOK_PATH)) return 'hook'
    if (pathname.startsWith(API_PATHS.instancePrefix)) return 'instance'
    return 'other'
  }

  private rateLimitRetryAfter(route: RouteClass): number | null {
    const now = Date.now()
    const limit = ROUTE_RATE_LIMITS[route]
    const current = this.rateBuckets.get(route)
    if (!current || now - current.startedAt >= limit.windowMs) {
      this.rateBuckets.set(route, { count: 1, startedAt: now })
      return null
    }
    current.count += 1
    if (current.count <= limit.requests) return null
    return Math.max(1, Math.ceil((limit.windowMs - (now - current.startedAt)) / 1000))
  }

  private sendBodyError(res: http.ServerResponse, error: unknown): void {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(res, 413, { error: 'request_body_too_large' })
    } else {
      sendJson(res, 400, { error: 'invalid_json' })
    }
  }

  private createInstanceId(): string {
    for (;;) {
      const id = randomBytes(24).toString('base64url')
      if (!this.instances.has(id)) return id
    }
  }

  private removeOtherSessionsForOwner(wrapperId: string, keepSessionId: string): boolean {
    let changed = false
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner !== wrapperId || sessionId === keepSessionId) continue
      changed = this.tracker.remove(sessionId) || changed
      changed = this.tasks.clearSession(wrapperId, sessionId) || changed
      this.sessionOwners.delete(sessionId)
    }
    return changed
  }

  private isActiveOwner(wrapperId: string): boolean {
    return Boolean(this.tasks.get(wrapperId)) || wrapperId === this.hostWrapperId
  }

  private harnessForKind(kind: AgentKind): Harness {
    try {
      return harnessFor(kind)
    } catch {
      return this.hostHarness
    }
  }

  private syncTaskSession(task: TaskSnapshot, previousSessionId: string | null): void {
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner !== task.wrapperId || sessionId === task.sessionId) continue
      this.sessionOwners.delete(sessionId)
      this.tracker.remove(sessionId)
    }
    if (previousSessionId && previousSessionId !== task.sessionId) {
      this.sessionOwners.delete(previousSessionId)
      this.tracker.remove(previousSessionId)
    }
    if (!task.sessionId) return
    this.sessionOwners.set(task.sessionId, task.wrapperId)
    if (task.state === 'disconnected') this.tracker.remove(task.sessionId)
    else this.tracker.apply(task.sessionId, task.state)
  }

  private advanceWrapperGeneration(wrapperId: string): number {
    const generation = (this.wrapperGenerations.get(wrapperId) ?? 0) + 1
    this.wrapperGenerations.set(wrapperId, generation)
    const reconnect = this.reconnectLeases.get(wrapperId)
    if (reconnect) clearTimeout(reconnect.timer)
    this.reconnectLeases.delete(wrapperId)
    return generation
  }

  private supersedeCurrentInstance(wrapperId: string): void {
    const currentId = this.currentInstanceByWrapper.get(wrapperId)
    const current = currentId ? this.instances.get(currentId) : undefined
    if (current) this.closeInstance(current)
  }

  private closeInstance(instance: InstanceRecord): void {
    instance.explicitClose = true
    if (instance.expires) clearTimeout(instance.expires)
    instance.expires = null
    if (this.instances.get(instance.id) === instance) this.instances.delete(instance.id)
    if (this.currentInstanceByWrapper.get(instance.wrapperId) === instance.id) {
      this.currentInstanceByWrapper.delete(instance.wrapperId)
    }
    instance.res?.end()
    instance.res = null
  }

  private scheduleReconnectExpiry(wrapperId: string, generation: number): void {
    const previous = this.reconnectLeases.get(wrapperId)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      const current = this.reconnectLeases.get(wrapperId)
      if (current?.generation !== generation) return
      this.reconnectLeases.delete(wrapperId)
      this.removeWrapper(wrapperId, generation)
    }, RECONNECT_GRACE_MS)
    timer.unref?.()
    this.reconnectLeases.set(wrapperId, { generation, timer })
  }

  private removeWrapper(wrapperId: string, expectedGeneration?: number): boolean {
    if (
      expectedGeneration !== undefined &&
      this.wrapperGenerations.get(wrapperId) !== expectedGeneration
    ) {
      return false
    }
    this.advanceWrapperGeneration(wrapperId)
    this.localWriters.delete(wrapperId)
    this.wrapperHarness.delete(wrapperId)
    for (const instance of [...this.instances.values()]) {
      if (instance.wrapperId === wrapperId) this.closeInstance(instance)
    }
    this.removeSessionsForOwner(wrapperId)
    const removed = this.tasks.unregister(wrapperId)
    if (removed) this.notifyStateChange()
    return removed
  }

  private notifyStateChange(): void {
    const tasks = this.tasks.status()
    const aggregate =
      this.tasks.list().length > 0 ? this.tasks.aggregate() : this.tracker.aggregate()
    this.emit('aggregate', aggregate satisfies Aggregate)
    this.emit('tasks', tasks)
    for (const instance of this.instances.values()) {
      if (instance.res) sendSse(instance.res, { type: 'status', status: tasks })
    }
    this.emit('status', this.status())
  }
}

function isTaskRegistration(value: unknown): value is TaskRegistration {
  if (!isRecord(value)) return false
  if (
    !isIdentifier(value.wrapperId, MAX_WRAPPER_ID_LENGTH) ||
    !isIdentifier(value.kind, MAX_KIND_LENGTH) ||
    !isBoundedString(value.cwd, MAX_CWD_LENGTH) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    (value.name !== undefined && !isBoundedString(value.name, MAX_TASK_NAME_LENGTH)) ||
    (value.slot !== undefined && value.slot !== null && !Number.isInteger(value.slot)) ||
    !isRecoveryMetadata(value.recovery) ||
    (value.recovery !== undefined && value.slot === undefined) ||
    (value.slot === null && value.recovery === undefined)
  ) {
    return false
  }
  return true
}

function isRecoveryMetadata(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const recovery = value
  if (
    recovery.state !== undefined &&
    !['idle', 'executing', 'waiting', 'complete', 'error', 'disconnected'].includes(
      String(recovery.state),
    )
  )
    return false
  if (recovery.unread !== undefined && typeof recovery.unread !== 'boolean') return false
  if (recovery.selected !== undefined && typeof recovery.selected !== 'boolean') return false
  if (
    recovery.sessionId !== undefined &&
    recovery.sessionId !== null &&
    !isIdentifier(recovery.sessionId, MAX_SESSION_ID_LENGTH)
  )
    return false
  for (const key of ['registeredAt', 'updatedAt']) {
    const timestamp = recovery[key]
    if (
      timestamp !== undefined &&
      (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0)
    ) {
      return false
    }
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isControlPhase(value: unknown): value is ControlPhase {
  return value === 'press' || value === 'release' || value === 'repeat'
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    Buffer.byteLength(value, 'utf8') <= maxLength * 4 &&
    !value.includes('\0')
  )
}

function isIdentifier(value: unknown, maxLength: number): value is string {
  if (
    !isBoundedString(value, maxLength) ||
    value.length === 0 ||
    value !== value.trim() ||
    hasTerminalControl(value)
  ) {
    return false
  }
  return true
}

function hasTerminalControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}
