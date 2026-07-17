import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harnessFor } from '../src/harness/index.js'
import { API_PATHS } from '../src/ports.js'
import { authorizationHeaders, readRuntimeDescriptor } from '../src/runtime.js'
import { appDataDirectory } from '../src/secure-files.js'
import { HostServer, HTTP_SERVER_LIMITS, WRAPPER_HEADER } from '../src/server.js'
import { TaskRegistry, type TaskStatus } from '../src/state.js'

const claude = harnessFor('claude')
let server: HostServer
let base: string

beforeEach(async () => {
  server = new HostServer(claude, { token: 'test-token-that-is-at-least-thirty-two-bytes' })
  await server.listen(0)
  base = `http://127.0.0.1:${server.boundPort}`
})

afterEach(async () => server.close())

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { ...authorizationHeaders(server.authToken), ...extra }
}

async function register(wrapperId: string, slot?: number | null, kind = 'claude') {
  return fetch(`${base}${API_PATHS.register}`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      wrapperId,
      name: wrapperId,
      kind,
      cwd: `/projects/${wrapperId}`,
      pid: 100,
      ...(slot === undefined ? {} : { slot }),
    }),
  })
}

async function postHook(event: string, sessionId: string, wrapperId: string, extra = {}) {
  return fetch(`${base}${API_PATHS.hookPrefix}${event}`, {
    method: 'POST',
    headers: auth({
      'Content-Type': 'application/json',
      [WRAPPER_HEADER]: wrapperId,
    }),
    body: JSON.stringify({ session_id: sessionId, ...extra }),
  })
}

async function nextFrame(
  body: ReadableStream<Uint8Array>,
  type?: string,
): Promise<Record<string, unknown>> {
  const reader = body.getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stream ended')
    buffer += new TextDecoder().decode(value)
    const matches = [...buffer.matchAll(/data: (.*)\n\n/g)]
    for (const match of matches) {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>
      if (!type || parsed.type === type) {
        reader.releaseLock()
        return parsed
      }
    }
  }
}

describe('HostServer security and discovery API', () => {
  it('keeps the configured HTTP resource limits bounded', () => {
    expect(HTTP_SERVER_LIMITS).toEqual({
      maxConnections: 128,
      maxHeadersCount: 32,
      maxHeaderSize: 16 * 1024,
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      keepAliveTimeout: 1_000,
    })
    expect(Object.isFrozen(HTTP_SERVER_LIMITS)).toBe(true)
  })

  it('requires its random bearer token on health, status, registration, hooks, and control', async () => {
    const checks: Array<[string, RequestInit]> = [
      [API_PATHS.health, {}],
      [API_PATHS.status, {}],
      [API_PATHS.register, { method: 'POST', body: '{}' }],
      [`${API_PATHS.hookPrefix}Stop`, { method: 'POST', body: '{}' }],
      [API_PATHS.control, { method: 'POST', body: '{}' }],
      [`${API_PATHS.instancePrefix}1`, { method: 'DELETE' }],
    ]
    for (const [path, init] of checks) {
      expect((await fetch(`${base}${path}`, init)).status, path).toBe(401)
      expect(
        (await fetch(`${base}${path}`, { ...init, headers: { Authorization: 'Bearer wrong' } }))
          .status,
        path,
      ).toBe(401)
    }
  })

  it('identifies only the authenticated OpenControl host', async () => {
    const response = await fetch(`${base}${API_PATHS.health}`, { headers: auth() })
    expect(await response.json()).toMatchObject({
      app: 'opencontrol',
      pid: process.pid,
      version: 1,
    })
  })

  it('publishes runtime discovery only after registry initialization completes', async () => {
    const temporaryRoot = process.platform === 'win32' ? appDataDirectory() : os.tmpdir()
    fs.mkdirSync(temporaryRoot, { recursive: true })
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'opencontrol-publish-order-'))
    const runtimePath = path.join(directory, 'runtime.json')
    const candidate = new HostServer(claude)
    let releaseInitialization = (): void => undefined
    let markInitializationStarted = (): void => undefined
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve
    })
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve
    })

    try {
      const listening = candidate.listenRuntime(runtimePath, async () => {
        markInitializationStarted()
        await initializationGate
        candidate.registerLocalWrapper({
          wrapperId: 'promoted',
          kind: 'claude',
          cwd: '/project',
          pid: 123,
          slot: 1,
        })
      })
      await initializationStarted
      expect(readRuntimeDescriptor(runtimePath)).toBeNull()
      releaseInitialization()
      await expect(listening).resolves.toBe(true)
      expect(readRuntimeDescriptor(runtimePath)).toMatchObject({
        pid: process.pid,
        port: candidate.boundPort,
      })
      expect(candidate.tasks.get('promoted')).toMatchObject({ slot: 1 })
    } finally {
      releaseInitialization()
      await candidate.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('HostServer task registration and status', () => {
  it('reserves explicit slots and rejects conflicts', async () => {
    const first = await register('wrapper-a', 2)
    expect(first.status).toBe(201)
    expect(((await first.json()) as { task: unknown }).task).toMatchObject({
      wrapperId: 'wrapper-a',
      slot: 2,
    })
    const conflict = await register('wrapper-b', 2)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'SLOT_OCCUPIED', slot: 2 })
    expect(server.tasks.get('wrapper-b')).toBeNull()
  })

  it('assigns six slots then registers additional wrappers unassigned', async () => {
    for (let index = 1; index <= 7; index += 1) {
      expect((await register(`wrapper-${index}`)).status).toBe(201)
    }
    const status = await fetch(`${base}${API_PATHS.status}`, { headers: auth() })
    const body = (await status.json()) as ReturnType<HostServer['status']>
    expect(body.tasks.slots.every(Boolean)).toBe(true)
    expect(body.tasks.unassigned).toHaveLength(1)
    expect(body.tasks.unassigned[0]?.wrapperId).toBe('wrapper-7')
  })

  it('uses unpredictable stream identifiers and enforces the task/stream ceiling', async () => {
    const identifiers: string[] = []
    for (let index = 0; index < 64; index += 1) {
      const response = await register(`capacity-${index}`)
      expect(response.status).toBe(201)
      identifiers.push(((await response.json()) as { instanceId: string }).instanceId)
    }
    expect(new Set(identifiers).size).toBe(64)
    expect(identifiers.every((id) => /^[A-Za-z0-9_-]{32}$/.test(id))).toBe(true)

    const overflow = await register('capacity-overflow')
    expect(overflow.status).toBe(429)
    expect(await overflow.json()).toMatchObject({ error: 'task_limit_exceeded', limit: 64 })
    expect(server.tasks.list()).toHaveLength(64)
  })

  it('bounds registration strings and rejects non-object JSON roots', async () => {
    const oversized = await fetch(`${base}${API_PATHS.register}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        wrapperId: 'x'.repeat(129),
        kind: 'claude',
        cwd: '/project',
        pid: 100,
      }),
    })
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toMatchObject({ error: 'invalid_registration' })

    const nullRoot = await fetch(`${base}${API_PATHS.register}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: 'null',
    })
    expect(nullRoot.status).toBe(400)
  })

  it('accepts an explicit null slot only with recovery registration metadata', async () => {
    expect((await register('invalid-overflow', null)).status).toBe(400)

    const overflow = await fetch(`${base}${API_PATHS.register}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        wrapperId: 'overflow',
        kind: 'claude',
        cwd: '/project',
        pid: 100,
        slot: null,
        recovery: {
          state: 'executing',
          unread: false,
          selected: false,
          sessionId: 'overflow-session',
          updatedAt: 10,
        },
      }),
    })
    expect(overflow.status).toBe(201)
    expect(((await overflow.json()) as { task: { slot: number | null } }).task.slot).toBeNull()
    expect(server.sessionOwners.get('overflow-session')).toBe('overflow')
    expect(server.tracker.list()).toEqual([
      expect.objectContaining({ id: 'overflow-session', state: 'executing' }),
    ])

    const malformed = await fetch(`${base}${API_PATHS.register}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        wrapperId: 'recovery',
        kind: 'claude',
        cwd: '/project',
        pid: 100,
        recovery: { state: 'executing' },
      }),
    })
    expect(malformed.status).toBe(400)
  })

  it('supports local pre-PTY registration and selected writer routing', () => {
    server.registerLocalWrapper({
      wrapperId: 'local',
      name: 'API',
      kind: 'claude',
      cwd: '/projects/api',
      pid: 123,
      slot: 1,
    })
    const writes: string[] = []
    server.attachWriter('local', (bytes) => writes.push(bytes))
    expect(server.sendKeysToSelected('/plan\r')).toBe(true)
    expect(writes).toEqual(['/plan\r'])
  })
})

describe('HostServer hooks, selection, and routing', () => {
  it('classifies hooks through each wrapper harness and keeps completion unread', async () => {
    await register('claude-wrapper', 1)
    await register('codex-wrapper', 2, 'codex')
    expect((await postHook('UserPromptSubmit', 'claude-session', 'claude-wrapper')).status).toBe(
      200,
    )
    expect((await postHook('PermissionRequest', 'codex-session', 'codex-wrapper')).status).toBe(200)
    expect(server.tasks.get('claude-wrapper')).toMatchObject({ state: 'executing' })
    expect(server.tasks.get('codex-wrapper')).toMatchObject({ state: 'waiting' })
    await postHook('Stop', 'codex-session', 'codex-wrapper')
    expect(server.tasks.get('codex-wrapper')).toMatchObject({ state: 'complete', unread: true })
    server.selectSlot(2)
    expect(server.tasks.get('codex-wrapper')).toMatchObject({ state: 'idle', unread: false })
  })

  it('rejects hooks for unregistered wrappers even with the bearer token', async () => {
    expect((await postHook('UserPromptSubmit', 'foreign', 'unknown-wrapper')).status).toBe(403)
    expect(server.sessionOwners.has('foreign')).toBe(false)
  })

  it('rejects unknown hooks before reading or allocating session state', async () => {
    await register('wrapper', 1)
    const response = await fetch(`${base}${API_PATHS.hookPrefix}FutureUnknownEvent`, {
      method: 'POST',
      headers: auth({
        'Content-Type': 'application/json',
        [WRAPPER_HEADER]: 'wrapper',
      }),
      body: 'x'.repeat(2 * 1024 * 1024),
    })
    expect(response.status).toBe(404)
    expect(server.sessionOwners.size).toBe(0)
  })

  it('keeps only one active hook session per wrapper', async () => {
    await register('wrapper', 1)
    expect((await postHook('UserPromptSubmit', 'first-session', 'wrapper')).status).toBe(200)
    expect((await postHook('Notification', 'second-session', 'wrapper')).status).toBe(200)
    expect(server.sessionOwners.has('first-session')).toBe(false)
    expect(server.sessionOwners.get('second-session')).toBe('wrapper')
    expect(server.tracker.list()).toEqual([
      expect.objectContaining({ id: 'second-session', state: 'waiting' }),
    ])
    expect(server.tasks.get('wrapper')?.sessionId).toBe('second-session')
  })

  it('selects an agent slot through the authenticated control endpoint', async () => {
    await register('wrapper-a', 1)
    await register('wrapper-b', 2)
    const response = await fetch(`${base}${API_PATHS.control}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        controlId: 'agent.2',
        phase: 'press',
        sourceId: 'test-keyboard',
        timestamp: 10,
      }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { selected: unknown }).selected).toMatchObject({
      wrapperId: 'wrapper-b',
      slot: 2,
    })
    expect(server.tasks.selected()?.wrapperId).toBe('wrapper-b')
  })

  it('rejects unknown semantic control IDs', async () => {
    const response = await fetch(`${base}${API_PATHS.control}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        controlId: 'keyboard.anything',
        phase: 'press',
        sourceId: 'spoof',
        timestamp: 10,
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_control_event' })
  })

  it('bounds control metadata and request bodies', async () => {
    const invalidControl = await fetch(`${base}${API_PATHS.control}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        controlId: 'command.fast',
        phase: 'press',
        sourceId: 'x'.repeat(129),
        timestamp: 10,
      }),
    })
    expect(invalidControl.status).toBe(400)

    const oversized = await fetch(`${base}${API_PATHS.control}`, {
      method: 'POST',
      headers: auth({
        'Content-Type': 'application/json',
      }),
      body: 'x'.repeat(1024 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: 'request_body_too_large' })
  })

  it('forwards bytes over authenticated SSE to the selected remote task', async () => {
    const registered = (await (await register('remote', 1)).json()) as { instanceId: string }
    const stream = await fetch(`${base}${API_PATHS.instancePrefix}${registered.instanceId}`, {
      headers: auth({ [WRAPPER_HEADER]: 'remote' }),
    })
    await postHook('Notification', 'remote-session', 'remote')
    expect(server.instanceForSession('remote-session')).toBe(registered.instanceId)
    expect(server.sendKeysToSelected('\r')).toBe(true)
    expect(await nextFrame(stream.body!, 'keys')).toEqual({
      type: 'keys',
      data: Buffer.from('\r').toString('base64'),
    })
    await stream.body?.cancel()
  })

  it('streams an initial full status and every subsequent task change', async () => {
    const registered = (await (await register('remote', 1)).json()) as { instanceId: string }
    const stream = await fetch(`${base}${API_PATHS.instancePrefix}${registered.instanceId}`, {
      headers: auth({ [WRAPPER_HEADER]: 'remote' }),
    })
    const initial = await nextFrame(stream.body!, 'status')
    expect(initial.type).toBe('status')
    expect(initial.status).toMatchObject({ selectedSlot: 1 })
    expect((initial.status as TaskStatus).slots[0]).toMatchObject({
      wrapperId: 'remote',
      connectionState: 'connected',
    })

    await postHook('UserPromptSubmit', 'session', 'remote')
    const changed = await nextFrame(stream.body!, 'status')
    expect((changed.status as TaskStatus).slots[0]).toMatchObject({
      wrapperId: 'remote',
      state: 'executing',
    })
    await stream.body?.cancel()
  })

  it('allows only the owning wrapper to delete its instance and releases its slot immediately', async () => {
    const registered = (await (await register('remote', 1)).json()) as { instanceId: string }
    const url = `${base}${API_PATHS.instancePrefix}${registered.instanceId}`
    expect((await fetch(url, { method: 'DELETE', headers: auth() })).status).toBe(403)
    expect(
      (
        await fetch(url, {
          method: 'DELETE',
          headers: auth({ [WRAPPER_HEADER]: 'someone-else' }),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(url, {
          method: 'DELETE',
          headers: auth({ [WRAPPER_HEADER]: 'remote' }),
        })
      ).status,
    ).toBe(200)
    expect(server.tasks.get('remote')).toBeNull()
    expect((await register('replacement', 1)).status).toBe(201)
    expect(
      (
        await fetch(url, {
          method: 'DELETE',
          headers: auth({ [WRAPPER_HEADER]: 'remote' }),
        })
      ).status,
    ).toBe(404)
  })

  it('requires the owning wrapper identity to open an event stream', async () => {
    const registered = (await (await register('remote', 1)).json()) as { instanceId: string }
    const url = `${base}${API_PATHS.instancePrefix}${registered.instanceId}`
    expect((await fetch(url, { headers: auth() })).status).toBe(403)
    expect((await fetch(url, { headers: auth({ [WRAPPER_HEADER]: 'someone-else' }) })).status).toBe(
      403,
    )

    const stream = await fetch(url, {
      headers: auth({ [WRAPPER_HEADER]: 'remote' }),
    })
    expect(stream.status).toBe(200)
    await stream.body?.cancel()
  })

  it('supersedes an older stream generation without letting its close remove the new one', async () => {
    const first = (await (await register('remote', 1)).json()) as { instanceId: string }
    const oldStream = await fetch(`${base}${API_PATHS.instancePrefix}${first.instanceId}`, {
      headers: auth({ [WRAPPER_HEADER]: 'remote' }),
    })
    await nextFrame(oldStream.body!, 'status')

    const second = (await (await register('remote', 1)).json()) as { instanceId: string }
    const newStream = await fetch(`${base}${API_PATHS.instancePrefix}${second.instanceId}`, {
      headers: auth({ [WRAPPER_HEADER]: 'remote' }),
    })
    const initial = await nextFrame(newStream.body!, 'status')
    expect((initial.status as TaskStatus).slots[0]).toMatchObject({
      wrapperId: 'remote',
      connectionState: 'connected',
    })
    await oldStream.body?.cancel().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(server.tasks.get('remote')).toMatchObject({ connectionState: 'connected', slot: 1 })
    expect(server.sendKeysToSelected('\r')).toBe(true)
    expect(await nextFrame(newStream.body!, 'keys')).toMatchObject({ type: 'keys' })
    await newStream.body?.cancel()
  })

  it('marks an unexpectedly closed stream reconnecting without losing process state', async () => {
    const registered = (await (await register('remote', 1)).json()) as { instanceId: string }
    await postHook('Notification', 'session', 'remote')
    const stream = await fetch(`${base}${API_PATHS.instancePrefix}${registered.instanceId}`, {
      headers: auth({ [WRAPPER_HEADER]: 'remote' }),
    })
    await nextFrame(stream.body!, 'status')
    await stream.body?.cancel()
    await waitFor(() => server.tasks.get('remote')?.connectionState === 'reconnecting')
    expect(server.tasks.get('remote')).toMatchObject({
      state: 'waiting',
      connectionState: 'reconnecting',
      selected: true,
    })
    expect(
      (
        await fetch(`${base}${API_PATHS.instancePrefix}${registered.instanceId}`, {
          method: 'DELETE',
          headers: auth({ [WRAPPER_HEADER]: 'remote' }),
        })
      ).status,
    ).toBe(200)
    expect(server.tasks.get('remote')).toBeNull()
  })

  it('clears ended hook sessions without releasing the wrapper slot', async () => {
    await register('wrapper', 1)
    await postHook('UserPromptSubmit', 'session', 'wrapper')
    await postHook('SessionEnd', 'session', 'wrapper')
    expect(server.sessionOwners.has('session')).toBe(false)
    expect(server.tasks.get('wrapper')).toMatchObject({ slot: 1, state: 'idle', sessionId: null })
  })
})

describe('HostServer recovery grace', () => {
  it('restores eight cached wrappers and expires only generations that do not reconnect', async () => {
    vi.useFakeTimers()
    try {
      const source = new TaskRegistry(() => 100)
      for (let index = 1; index <= 8; index += 1) {
        source.register({
          wrapperId: `wrapper-${index}`,
          kind: index % 2 ? 'codex' : 'claude',
          cwd: `/project/${index}`,
          pid: index,
        })
      }
      source.applyState('wrapper-2', 'executing', 'session-2')
      source.applyState('wrapper-3', 'waiting', 'session-3')
      source.applyState('wrapper-4', 'complete', 'session-4')
      source.selectSlot(4)
      source.applyState('wrapper-4', 'complete', 'session-4')
      const cached: TaskStatus = source.status()

      server.restoreTaskStatus(cached, 'wrapper-2')
      expect(server.tasks.list()).toHaveLength(8)
      expect(server.tasks.selected()?.wrapperId).toBe('wrapper-4')
      expect(server.tasks.get('wrapper-4')).toMatchObject({
        state: 'complete',
        unread: true,
        connectionState: 'reconnecting',
      })
      expect(server.tasks.get('wrapper-7')?.slot).toBeNull()

      server.registerLocalWrapper({
        wrapperId: 'wrapper-4',
        kind: 'claude',
        cwd: '/project/4',
        pid: 4,
        slot: 4,
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(
        server.tasks
          .list()
          .map((task) => task.wrapperId)
          .sort(),
      ).toEqual(['wrapper-2', 'wrapper-4'])
      expect(server.tasks.get('wrapper-4')).toMatchObject({
        state: 'complete',
        connectionState: 'connected',
      })
      expect(server.tasks.selected()?.wrapperId).toBe('wrapper-4')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('HostServer request rate limits', () => {
  it('does not let unauthorized requests consume an authenticated route budget', async () => {
    for (let index = 0; index < 121; index += 1) {
      expect((await fetch(`${base}${API_PATHS.status}`)).status).toBe(401)
    }
    expect((await fetch(`${base}${API_PATHS.status}`, { headers: auth() })).status).toBe(200)
  })

  it('returns 429 with a retry hint when a route exceeds its bounded budget', async () => {
    for (let index = 0; index < 120; index += 1) {
      expect((await fetch(`${base}${API_PATHS.status}`, { headers: auth() })).status).toBe(200)
    }
    const limited = await fetch(`${base}${API_PATHS.status}`, { headers: auth() })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' })
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
