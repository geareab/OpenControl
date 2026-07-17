import type { Readable } from 'node:stream'
import { logger } from './logger.js'
import { API_PATHS } from './ports.js'
import {
  authorizationHeaders,
  discoverRuntime,
  runtimeDescriptorPath,
  runtimeUrl,
  type RuntimeDescriptor,
} from './runtime.js'
import { WRAPPER_HEADER, type HostControlEvent, type HostStatus } from './server.js'
import type { TaskRegistration, TaskSnapshot, TaskStatus } from './state.js'

export interface ClientRegistration {
  descriptor: RuntimeDescriptor
  instanceId: string
  task: TaskSnapshot
  /** Latest full registry snapshot received from the host event stream. */
  status?: TaskStatus
}

export interface ClientOptions {
  runtimePath?: string
  descriptor?: RuntimeDescriptor
  fetchImpl?: typeof fetch
}

export interface HookRelayOptions extends ClientOptions {
  body?: string
  wrapperId?: string
  stdin?: Readable
}

export interface ClientStreamOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onStatus?: (status: TaskStatus) => void
}

export const MAX_HOOK_BODY_BYTES = 1024 * 1024

export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

export async function isOpenControlHost(options: ClientOptions = {}): Promise<boolean> {
  return Boolean(await resolveDescriptor(options))
}

/** Temporary source-compatible alias. */
export const isOpenmicroHost = isOpenControlHost

/** Reserve a task slot before the caller starts its PTY. */
export async function registerClient(
  registration: TaskRegistration,
  options: ClientOptions = {},
): Promise<ClientRegistration> {
  const descriptor = await requiredDescriptor(options)
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${runtimeUrl(descriptor)}${API_PATHS.register}`, {
      method: 'POST',
      headers: {
        ...authorizationHeaders(descriptor.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(registration),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    throw new HostRequestError('OpenControl host is temporarily unreachable', 503, 'HOST_OFFLINE')
  }
  let body: {
    instanceId?: string
    task?: TaskSnapshot
    error?: string
  }
  try {
    body = (await response.json()) as typeof body
  } catch {
    if (response.ok) {
      // The host may have reserved the wrapper before the response body was
      // interrupted. Classify this as recoverable so a same-wrapper retry can
      // safely supersede that pending generation.
      throw new HostRequestError('OpenControl host is temporarily unreachable', 503, 'HOST_OFFLINE')
    }
    body = {}
  }
  if (response.ok && (!body.instanceId || !body.task)) {
    throw new HostRequestError('OpenControl host is temporarily unreachable', 503, 'HOST_OFFLINE')
  }
  if (!response.ok) {
    throw new HostRequestError(
      body.error ?? `Host registration failed (${response.status})`,
      response.status,
      body.error,
    )
  }
  return { descriptor, instanceId: body.instanceId!, task: body.task! }
}

/** Stream host-routed terminal bytes after the PTY has been attached. */
export async function streamClient(
  registration: ClientRegistration,
  write: (bytes: string) => void,
  options: ClientStreamOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(
    `${runtimeUrl(registration.descriptor)}${API_PATHS.instancePrefix}${encodeURIComponent(registration.instanceId)}`,
    {
      headers: {
        ...authorizationHeaders(registration.descriptor.token),
        [WRAPPER_HEADER]: registration.task.wrapperId,
      },
      signal: options.signal,
    },
  )
  if (!response.ok) {
    throw new HostRequestError(`Host event stream failed (${response.status})`, response.status)
  }
  if (!response.body) return

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let separator: number
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('')
      if (!data) continue
      try {
        const message = JSON.parse(data) as {
          type?: string
          data?: string
          status?: TaskStatus
        }
        if (message.type === 'keys' && message.data) {
          write(Buffer.from(message.data, 'base64').toString('utf8'))
        } else if (message.type === 'status' && isTaskStatus(message.status)) {
          registration.status = message.status
          options.onStatus?.(message.status)
        }
      } catch (error) {
        logger.warn('client: bad frame from host', error)
      }
    }
  }
  logger.info('host connection closed')
}

/** Explicitly release a reservation or active stream owned by this wrapper. */
export async function cancelClient(
  registration: ClientRegistration,
  options: Pick<ClientOptions, 'fetchImpl'> = {},
): Promise<boolean> {
  const response = await (options.fetchImpl ?? fetch)(
    `${runtimeUrl(registration.descriptor)}${API_PATHS.instancePrefix}${encodeURIComponent(registration.instanceId)}`,
    {
      method: 'DELETE',
      headers: {
        ...authorizationHeaders(registration.descriptor.token),
        [WRAPPER_HEADER]: registration.task.wrapperId,
      },
      signal: AbortSignal.timeout(2000),
    },
  )
  if (response.status === 404) return false
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) {
    throw new HostRequestError(
      body.error ?? `Host cancellation failed (${response.status})`,
      response.status,
      body.error,
    )
  }
  return true
}

/**
 * Compatibility helper. New callers should call registerClient before spawning
 * a PTY, then call streamClient after attaching its writer.
 */
export async function runAsClient(
  wrapperId: string,
  kind: string,
  write: (bytes: string) => void,
  options: ClientOptions & { name?: string; slot?: number; cwd?: string; pid?: number } = {},
): Promise<void> {
  const registration = await registerClient(
    {
      wrapperId,
      kind,
      name: options.name,
      slot: options.slot,
      cwd: options.cwd ?? process.cwd(),
      pid: options.pid ?? process.pid,
    },
    options,
  )
  logger.info('running as client instance', {
    instanceId: registration.instanceId,
    kind,
    slot: registration.task.slot,
  })
  await streamClient(registration, write, { fetchImpl: options.fetchImpl })
}

export async function fetchHostStatus(options: ClientOptions = {}): Promise<HostStatus> {
  const descriptor = await requiredDescriptor(options)
  const response = await (options.fetchImpl ?? fetch)(
    `${runtimeUrl(descriptor)}${API_PATHS.status}`,
    {
      headers: authorizationHeaders(descriptor.token),
      signal: AbortSignal.timeout(2000),
    },
  )
  if (!response.ok) throw new HostRequestError('Unable to read host status', response.status)
  return (await response.json()) as HostStatus
}

export async function postControlEvent(
  event: HostControlEvent,
  options: ClientOptions = {},
): Promise<TaskSnapshot | null> {
  const descriptor = await requiredDescriptor(options)
  const response = await (options.fetchImpl ?? fetch)(
    `${runtimeUrl(descriptor)}${API_PATHS.control}`,
    {
      method: 'POST',
      headers: {
        ...authorizationHeaders(descriptor.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    },
  )
  const body = (await response.json().catch(() => ({}))) as {
    selected?: TaskSnapshot | null
    error?: string
  }
  if (!response.ok) {
    throw new HostRequestError(body.error ?? 'Control event rejected', response.status, body.error)
  }
  return body.selected ?? null
}

/** Cross-platform entry point used by installed `opencontrol hook <event>` commands. */
export async function relayHookEvent(
  event: string,
  options: HookRelayOptions = {},
): Promise<boolean> {
  const descriptor = await resolveDescriptor(options)
  if (!descriptor) return false
  const wrapperId =
    options.wrapperId ??
    process.env.OPENCONTROL_WRAPPER_ID ??
    process.env.OPENCONTROL_INSTANCE_ID ??
    process.env.OPENMICRO_INSTANCE_ID ??
    ''
  if (!wrapperId) return false
  let body: string
  try {
    body = options.body ?? (await readStream(options.stdin ?? process.stdin, MAX_HOOK_BODY_BYTES))
    if (Buffer.byteLength(body, 'utf8') > MAX_HOOK_BODY_BYTES) return false
    const response = await (options.fetchImpl ?? fetch)(
      `${runtimeUrl(descriptor)}${API_PATHS.hookPrefix}${encodeURIComponent(event)}`,
      {
        method: 'POST',
        headers: {
          ...authorizationHeaders(descriptor.token),
          'Content-Type': 'application/json',
          [WRAPPER_HEADER]: wrapperId,
        },
        body: body || '{}',
        signal: AbortSignal.timeout(1000),
      },
    )
    return response.ok
  } catch {
    return false
  }
}

async function resolveDescriptor(options: ClientOptions): Promise<RuntimeDescriptor | null> {
  if (options.descriptor) return options.descriptor
  return discoverRuntime(options.runtimePath ?? runtimeDescriptorPath(), options.fetchImpl ?? fetch)
}

async function requiredDescriptor(options: ClientOptions): Promise<RuntimeDescriptor> {
  const descriptor = await resolveDescriptor(options)
  if (!descriptor) throw new HostRequestError('No running OpenControl host', 503, 'HOST_OFFLINE')
  return descriptor
}

function readStream(stream: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let settled = false
    stream.setEncoding('utf8')
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
    }
    const onData = (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxBytes) {
        settled = true
        cleanup()
        stream.pause()
        reject(new RangeError(`hook input exceeds ${maxBytes} bytes`))
        return
      }
      body += chunk
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(body)
    }
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}

function isTaskStatus(value: unknown): value is TaskStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<TaskStatus>
  return (
    Array.isArray(status.slots) &&
    status.slots.length === 6 &&
    Array.isArray(status.unassigned) &&
    (status.selectedSlot === null ||
      (Number.isInteger(status.selectedSlot) &&
        status.selectedSlot! >= 1 &&
        status.selectedSlot! <= 6))
  )
}
