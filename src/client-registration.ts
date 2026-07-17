import { HostRequestError, registerClient, type ClientRegistration } from './client.js'
import { RECONNECT_GRACE_MS } from './server.js'
import type { TaskRegistration } from './state.js'

export interface RegisterClientWhenReadyOptions {
  recovery?: boolean
  register?: (registration: TaskRegistration) => Promise<ClientRegistration>
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  retryDelayMs?: number
  recoveryGraceMs?: number
  ordinaryAttempts?: number
}

/**
 * Wait for a concurrently promoted host to publish its descriptor. Explicit
 * slot conflicts are fatal during ordinary startup, but recovery retries them
 * through the old host's reconnect grace so restored stale owners can expire.
 */
export async function registerClientWhenReady(
  registration: TaskRegistration,
  options: RegisterClientWhenReadyOptions = {},
): Promise<ClientRegistration> {
  const recovery = options.recovery ?? false
  const register = options.register ?? ((input) => registerClient(input))
  const now = options.now ?? Date.now
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const retryDelayMs = options.retryDelayMs ?? 50
  const ordinaryAttempts = options.ordinaryAttempts ?? 10
  const deadline = now() + (options.recoveryGraceMs ?? RECONNECT_GRACE_MS) + retryDelayMs
  let lastError: unknown

  for (let attempt = 0; recovery || attempt < ordinaryAttempts; attempt += 1) {
    try {
      return await register(registration)
    } catch (error) {
      lastError = error
      const retryable =
        error instanceof HostRequestError &&
        (error.code === 'HOST_OFFLINE' || (recovery && error.code === 'SLOT_OCCUPIED'))
      if (!retryable || (recovery && now() >= deadline)) throw error
      await wait(retryDelayMs)
    }
  }
  throw lastError
}
