import { describe, expect, it, vi } from 'vitest'
import { registerClientWhenReady } from '../src/client-registration.js'
import { HostRequestError, type ClientRegistration } from '../src/client.js'
import type { RuntimeDescriptor } from '../src/runtime.js'
import type { TaskRegistration } from '../src/state.js'

const registration: TaskRegistration = {
  wrapperId: 'wrapper',
  kind: 'codex',
  cwd: '/project',
  pid: 99,
  slot: 2,
}

const descriptor: RuntimeDescriptor = {
  version: 1,
  app: 'opencontrol',
  pid: 1,
  port: 12345,
  token: 'test-token-that-is-at-least-thirty-two-bytes',
  startedAt: '2026-01-01T00:00:00.000Z',
}

const connected = {
  descriptor,
  instanceId: '1',
  task: { wrapperId: 'wrapper', slot: 2 } as ClientRegistration['task'],
} satisfies ClientRegistration

describe('registerClientWhenReady', () => {
  it('fails an ordinary explicit slot conflict immediately', async () => {
    const register = vi.fn(async () => {
      throw new HostRequestError('occupied', 409, 'SLOT_OCCUPIED')
    })
    await expect(registerClientWhenReady(registration, { register })).rejects.toMatchObject({
      code: 'SLOT_OCCUPIED',
    })
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('retries a recovery-only slot conflict until the restored owner clears', async () => {
    let attempts = 0
    const register = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw new HostRequestError('occupied', 409, 'SLOT_OCCUPIED')
      return connected
    })
    await expect(
      registerClientWhenReady(registration, {
        recovery: true,
        register,
        wait: async () => undefined,
      }),
    ).resolves.toBe(connected)
    expect(register).toHaveBeenCalledTimes(3)
  })

  it('bounds a recovery conflict by the reconnect grace period', async () => {
    let now = 0
    const register = vi.fn(async () => {
      throw new HostRequestError('occupied', 409, 'SLOT_OCCUPIED')
    })
    await expect(
      registerClientWhenReady(registration, {
        recovery: true,
        recoveryGraceMs: 100,
        retryDelayMs: 50,
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        register,
      }),
    ).rejects.toMatchObject({ code: 'SLOT_OCCUPIED' })
    expect(now).toBe(150)
    expect(register).toHaveBeenCalledTimes(4)
  })

  it('briefly retries host discovery during ordinary startup', async () => {
    let attempts = 0
    const register = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw new HostRequestError('offline', 503, 'HOST_OFFLINE')
      return connected
    })
    await expect(
      registerClientWhenReady(registration, { register, wait: async () => undefined }),
    ).resolves.toBe(connected)
    expect(register).toHaveBeenCalledTimes(3)
  })
})
