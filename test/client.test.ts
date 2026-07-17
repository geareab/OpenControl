import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  cancelClient,
  HostRequestError,
  fetchHostStatus,
  postControlEvent,
  registerClient,
  relayHookEvent,
  streamClient,
  type ClientRegistration,
} from '../src/client.js'
import type { RuntimeDescriptor } from '../src/runtime.js'

const descriptor: RuntimeDescriptor = {
  version: 1,
  app: 'opencontrol',
  pid: 123,
  port: 45678,
  token: 'test-token-that-is-at-least-thirty-two-bytes',
  startedAt: '2026-01-01T00:00:00.000Z',
}

describe('host client API', () => {
  it('registers before streaming with bearer authentication', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${descriptor.token}`)
      expect(JSON.parse(String(init?.body))).toMatchObject({ wrapperId: 'wrapper', slot: 3 })
      return new Response(
        JSON.stringify({
          instanceId: '9',
          task: {
            wrapperId: 'wrapper',
            name: 'API',
            kind: 'codex',
            cwd: '/project',
            pid: 99,
            state: 'idle',
            slot: 3,
            selected: true,
            unread: false,
            sessionId: null,
            registeredAt: 1,
            updatedAt: 1,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const result = await registerClient(
      { wrapperId: 'wrapper', name: 'API', kind: 'codex', cwd: '/project', pid: 99, slot: 3 },
      { descriptor, fetchImpl },
    )
    expect(result.instanceId).toBe('9')
    expect(result.task.slot).toBe(3)
  })

  it('surfaces an explicit slot conflict', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'SLOT_OCCUPIED' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    await expect(
      registerClient(
        { wrapperId: 'wrapper', kind: 'codex', cwd: '/project', pid: 99, slot: 3 },
        { descriptor, fetchImpl },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_OCCUPIED',
    } satisfies Partial<HostRequestError>)
  })

  it('normalizes registration transport failures for safe same-wrapper retries', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('connection reset')
    }) as typeof fetch
    await expect(
      registerClient(
        { wrapperId: 'wrapper', kind: 'codex', cwd: '/project', pid: 99, slot: 3 },
        { descriptor, fetchImpl },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'HOST_OFFLINE',
    } satisfies Partial<HostRequestError>)
  })

  it.each([
    ['an interrupted successful response body', new Response('{', { status: 201 })],
    [
      'a successful response missing reservation fields',
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ],
  ])('normalizes %s for safe same-wrapper retries', async (_label, response) => {
    const fetchImpl = (async () => response) as typeof fetch
    await expect(
      registerClient(
        { wrapperId: 'wrapper', kind: 'codex', cwd: '/project', pid: 99, slot: 3 },
        { descriptor, fetchImpl },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'HOST_OFFLINE',
    } satisfies Partial<HostRequestError>)
  })

  it('decodes routed SSE bytes', async () => {
    const encoded = Buffer.from('/plan\r').toString('base64')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`retry: 1000\n\ndata: {"type":"keys",`))
        controller.enqueue(new TextEncoder().encode(`"data":"${encoded}"}\n\n`))
        controller.close()
      },
    })
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-opencontrol-wrapper-id')).toBe('wrapper')
      return new Response(stream, { status: 200 })
    }) as typeof fetch
    const writes: string[] = []
    await streamClient(
      { descriptor, instanceId: '1', task: { wrapperId: 'wrapper' } as never },
      (bytes) => writes.push(bytes),
      { fetchImpl },
    )
    expect(writes).toEqual(['/plan\r'])
  })

  it('caches full status frames and reports them to the caller', async () => {
    const status = {
      slots: Array(6).fill(null),
      unassigned: [],
      selectedSlot: null,
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ type: 'status', status })}\n\n`),
        )
        controller.close()
      },
    })
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as typeof fetch
    const registration: ClientRegistration = {
      descriptor,
      instanceId: '1',
      task: { wrapperId: 'wrapper' } as never,
    }
    const received: unknown[] = []
    await streamClient(registration, () => undefined, {
      fetchImpl,
      onStatus: (next) => received.push(next),
    })
    expect(registration.status).toEqual(status)
    expect(received).toEqual([status])
  })

  it('cancels a reservation with bearer authentication and wrapper ownership', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://127.0.0.1:${descriptor.port}/api/v1/instances/instance%2Fone`,
      )
      expect(init?.method).toBe('DELETE')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${descriptor.token}`)
      expect(headers.get('x-opencontrol-wrapper-id')).toBe('wrapper')
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await expect(
      cancelClient(
        {
          descriptor,
          instanceId: 'instance/one',
          task: { wrapperId: 'wrapper' } as never,
        },
        { fetchImpl },
      ),
    ).resolves.toBe(true)
  })

  it('relays hook stdin with the bearer token and wrapper identity', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input).endsWith('/api/v1/hooks/Stop')).toBe(true)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${descriptor.token}`)
      expect(headers.get('x-opencontrol-wrapper-id')).toBe('wrapper')
      expect(init?.body).toBe('{"session_id":"session"}')
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    expect(
      await relayHookEvent('Stop', {
        descriptor,
        wrapperId: 'wrapper',
        body: '{"session_id":"session"}',
        fetchImpl,
      }),
    ).toBe(true)
  })

  it('refuses hook stdin larger than the server body limit without making a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const stdin = Readable.from([Buffer.alloc(1024 * 1024 + 1, 0x61)])
    await expect(
      relayHookEvent('Stop', {
        descriptor,
        wrapperId: 'wrapper',
        stdin,
        fetchImpl,
      }),
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads status and posts semantic controls', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/status')) {
        return new Response(
          JSON.stringify({
            app: 'opencontrol',
            version: 1,
            pid: 123,
            port: 45678,
            tasks: { slots: Array(6).fill(null), unassigned: [], selectedSlot: null },
            devices: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ ok: true, selected: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    expect((await fetchHostStatus({ descriptor, fetchImpl })).app).toBe('opencontrol')
    expect(
      await postControlEvent(
        { controlId: 'command.fast', phase: 'press', sourceId: 'stock-via', timestamp: 10 },
        { descriptor, fetchImpl },
      ),
    ).toBeNull()
  })
})
