import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appDataDirectory } from '../src/secure-files.js'
import {
  acquireRuntimeLease,
  authorizationHeaders,
  discoverRuntime,
  probeRuntime,
  readRuntimeDescriptor,
  removeRuntimeDescriptor,
} from '../src/runtime.js'

let directory: string
let runtimePath: string

beforeEach(() => {
  const temporaryRoot = process.platform === 'win32' ? appDataDirectory() : os.tmpdir()
  fs.mkdirSync(temporaryRoot, { recursive: true })
  directory = fs.mkdtempSync(path.join(temporaryRoot, 'opencontrol-runtime-'))
  runtimePath = path.join(directory, 'nested', 'runtime.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('runtime descriptor', () => {
  it('publishes an owner-only descriptor and removes it with its lease', async () => {
    const lease = await acquireRuntimeLease({
      file: runtimePath,
      token: 'token-that-is-at-least-thirty-two-characters',
    })
    expect(lease).not.toBeNull()
    const descriptor = lease!.publish(43210)
    expect(readRuntimeDescriptor(runtimePath)).toEqual(descriptor)
    if (process.platform !== 'win32') {
      expect(fs.statSync(runtimePath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(runtimePath)).mode & 0o777).toBe(0o700)
    }
    lease!.release()
    expect(fs.existsSync(runtimePath)).toBe(false)
    expect(fs.existsSync(`${runtimePath}.lock`)).toBe(false)
  })

  it('does not chmod or use an unsafe custom runtime parent', async () => {
    if (process.platform === 'win32') return
    const shared = path.join(directory, 'shared')
    fs.mkdirSync(shared, { mode: 0o755 })
    fs.chmodSync(shared, 0o755)

    await expect(
      acquireRuntimeLease({ file: path.join(shared, 'runtime.json') }),
    ).rejects.toMatchObject({ code: 'ESECUREDIR' })
    expect(fs.statSync(shared).mode & 0o777).toBe(0o755)
    expect(fs.existsSync(path.join(shared, 'runtime.json.lock'))).toBe(false)
  })

  it('rejects a private parent exposed through a non-sticky writable ancestor', async () => {
    if (process.platform === 'win32') return
    const exposed = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-exposed-runtime-'))
    fs.chmodSync(exposed, 0o777)
    const privateParent = path.join(exposed, 'private')
    fs.mkdirSync(privateParent, { mode: 0o700 })

    try {
      await expect(
        acquireRuntimeLease({ file: path.join(privateParent, 'runtime.json') }),
      ).rejects.toMatchObject({ code: 'ESECUREDIR' })
      expect(fs.existsSync(path.join(privateParent, 'runtime.json.lock'))).toBe(false)
    } finally {
      fs.rmSync(exposed, { recursive: true, force: true })
    }
  })

  it('rejects a custom path beneath an ancestor owned by another user', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return
    const privateParent = path.join(directory, 'private')
    fs.mkdirSync(privateParent, { mode: 0o700 })
    const originalLstat = fs.lstatSync.bind(fs)
    vi.spyOn(fs, 'lstatSync').mockImplementation((target) => {
      const stats = originalLstat(target)
      if (typeof target === 'string' && path.resolve(target) === path.resolve(directory)) {
        Object.defineProperty(stats, 'uid', { value: process.getuid!() + 1 })
      }
      return stats
    })

    await expect(
      acquireRuntimeLease({ file: path.join(privateParent, 'runtime.json') }),
    ).rejects.toMatchObject({ code: 'ESECUREDIR' })
    expect(fs.existsSync(path.join(privateParent, 'runtime.json.lock'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')(
    'rejects Windows custom runtime paths outside the profile application directory',
    async () => {
      const outside = path.join(os.tmpdir(), `opencontrol-outside-${process.pid}`, 'runtime.json')
      await expect(acquireRuntimeLease({ file: outside })).rejects.toMatchObject({
        code: 'ESECUREDIR',
      })
      expect(fs.existsSync(`${outside}.lock`)).toBe(false)
    },
  )

  it('rejects symbolic-link custom parents and descriptor destinations', async () => {
    if (process.platform === 'win32') return
    const privateParent = path.join(directory, 'private')
    const target = path.join(directory, 'target')
    fs.mkdirSync(privateParent, { mode: 0o700 })
    fs.mkdirSync(target, { mode: 0o700 })
    const linkedParent = path.join(privateParent, 'linked')
    fs.symlinkSync(target, linkedParent, 'dir')

    await expect(
      acquireRuntimeLease({ file: path.join(linkedParent, 'runtime.json') }),
    ).rejects.toMatchObject({ code: 'ESECUREDIR' })

    const descriptorLink = path.join(privateParent, 'runtime.json')
    const targetFile = path.join(target, 'descriptor-target')
    fs.writeFileSync(targetFile, '{}', { mode: 0o600 })
    fs.symlinkSync(targetFile, descriptorLink)
    await expect(acquireRuntimeLease({ file: descriptorLink })).rejects.toMatchObject({
      code: 'ESECUREFILE',
    })
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('{}')
  })

  it('allows only one live lease and reclaims a dead-owner lock', async () => {
    const first = await acquireRuntimeLease({ file: runtimePath })
    expect(first).not.toBeNull()
    expect(await acquireRuntimeLease({ file: runtimePath })).toBeNull()
    first!.release()

    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(`${runtimePath}.lock`, JSON.stringify({ pid: 2_000_000_000, token: 'dead' }), {
      mode: 0o600,
    })
    const reclaimed = await acquireRuntimeLease({ file: runtimePath })
    expect(reclaimed).not.toBeNull()
    reclaimed!.release()
  })

  it('reclaims a lock whose PID belongs to a different process incarnation', async () => {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      `${runtimePath}.lock`,
      JSON.stringify({
        pid: process.pid,
        token: 'stale-owner',
        processStartId: 'stale-process-start-identity',
      }),
      { mode: 0o600 },
    )

    const reclaimed = await acquireRuntimeLease({ file: runtimePath })
    expect(reclaimed).not.toBeNull()
    reclaimed!.release()
  })

  it('retains the PID-only behavior for a live legacy lock', async () => {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      `${runtimePath}.lock`,
      JSON.stringify({ pid: process.pid, token: 'legacy-owner' }),
      { mode: 0o600 },
    )

    expect(await acquireRuntimeLease({ file: runtimePath })).toBeNull()
    expect(fs.existsSync(`${runtimePath}.lock`)).toBe(true)
  })

  it('reclaims an aged legacy lock instead of trusting a reused live PID forever', async () => {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    const lockPath = `${runtimePath}.lock`
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'legacy-owner' }), {
      mode: 0o600,
    })
    const stale = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, stale, stale)

    const reclaimed = await acquireRuntimeLease({ file: runtimePath })
    expect(reclaimed).not.toBeNull()
    reclaimed!.release()
  })

  it('allows exactly one concurrent reclaimer to replace a stale generation', async () => {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      `${runtimePath}.lock`,
      JSON.stringify({ pid: 2_000_000_000, token: 'dead-generation' }),
      { mode: 0o600 },
    )

    const workerPath = fileURLToPath(new URL('./fixtures/runtime-lease-worker.ts', import.meta.url))
    const workers = Array.from({ length: 4 }, (_, index) =>
      fork(
        workerPath,
        [runtimePath, `contender-${index}-token-that-is-at-least-thirty-two-bytes`],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      ),
    )

    try {
      await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, 'ready')))
      const results = workers.map((worker) => waitForWorkerMessage(worker, 'result'))
      for (const worker of workers) worker.send('start')
      const outcomes = await Promise.all(results)
      expect(outcomes.filter((outcome) => outcome.won)).toHaveLength(1)
      expect(fs.existsSync(`${runtimePath}.lock`)).toBe(true)
    } finally {
      for (const worker of workers) {
        if (worker.connected && worker.exitCode === null && worker.signalCode === null) {
          worker.send('release', () => undefined)
        }
      }
      await Promise.all(workers.map(waitForWorkerExit))
    }
  })

  it('never unlinks a fresh incomplete lock observed during owner publication', async () => {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    const lockPath = `${runtimePath}.lock`
    fs.writeFileSync(lockPath, '', { mode: 0o600 })
    expect(await acquireRuntimeLease({ file: runtimePath })).toBeNull()
    expect(fs.existsSync(lockPath)).toBe(true)

    const stale = new Date(Date.now() - 10_000)
    fs.utimesSync(lockPath, stale, stale)
    const reclaimed = await acquireRuntimeLease({ file: runtimePath })
    expect(reclaimed).not.toBeNull()
    reclaimed!.release()
  })

  it('does not remove a descriptor replaced by a later owner', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const first = lease!.publish(40001)
    const replacement = { ...first, token: `${first.token}-replacement`, port: 40002 }
    fs.writeFileSync(runtimePath, JSON.stringify(replacement), { mode: 0o600 })
    expect(removeRuntimeDescriptor(runtimePath, first)).toBe(false)
    expect(fs.existsSync(runtimePath)).toBe(true)
    lease!.release()
  })

  it('restores a descriptor replaced during expected-value removal', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const first = lease!.publish(40003)
    const replacement = {
      ...first,
      token: `${first.token}-replacement`,
      port: 40004,
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    }
    const originalRename = fs.renameSync.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (!replaced && source === runtimePath) {
        replaced = true
        const displaced = `${runtimePath}.displaced`
        originalRename(runtimePath, displaced)
        fs.unlinkSync(displaced)
        fs.writeFileSync(runtimePath, JSON.stringify(replacement), { mode: 0o600 })
      }
      originalRename(source, destination)
    })

    expect(removeRuntimeDescriptor(runtimePath, first)).toBe(false)
    expect(readRuntimeDescriptor(runtimePath)).toEqual(replacement)
    expect(
      fs.readdirSync(path.dirname(runtimePath)).filter((entry) => entry.endsWith('.quarantine')),
    ).toEqual([])
    lease!.release()
  })

  it('discovers a live authenticated host and removes an unreachable stale descriptor', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const descriptor = lease!.publish(42123)
    const liveFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(authorizationHeaders(descriptor.token))
      return new Response(
        JSON.stringify({
          app: 'opencontrol',
          pid: descriptor.pid,
          processStartId: descriptor.processStartId,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as typeof fetch
    expect(await discoverRuntime(runtimePath, liveFetch)).toEqual(descriptor)

    const deadFetch = (async () => new Response('', { status: 401 })) as typeof fetch
    expect(await discoverRuntime(runtimePath, deadFetch)).toBeNull()
    expect(fs.existsSync(runtimePath)).toBe(false)
    lease!.release()
  })

  it('rejects a descriptor from a reused PID with a different process identity', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const descriptor = lease!.publish(42129)
    const reused = {
      ...descriptor,
      processStartId: 'stale-process-start-identity',
    }
    fs.writeFileSync(runtimePath, JSON.stringify(reused), { mode: 0o600 })
    const unavailableFetch = (async () => {
      throw new TypeError('connection refused')
    }) as typeof fetch

    expect(await probeRuntime(reused, unavailableFetch)).toBe('stale')
    expect(await discoverRuntime(runtimePath, unavailableFetch)).toBeNull()
    expect(fs.existsSync(runtimePath)).toBe(false)
    lease!.release()
  })

  it('distinguishes transient live-process failures from stale descriptors', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const descriptor = lease!.publish(42124)
    const unavailableFetch = (async () => {
      throw new TypeError('connection refused')
    }) as typeof fetch

    expect(await probeRuntime(descriptor, unavailableFetch)).toBe('temporarily-unreachable')
    expect(await discoverRuntime(runtimePath, unavailableFetch)).toBeNull()
    expect(readRuntimeDescriptor(runtimePath)).toEqual(descriptor)

    const deadDescriptor = { ...descriptor, pid: 2_000_000_000 }
    expect(await probeRuntime(deadDescriptor, unavailableFetch)).toBe('stale')
    lease!.release()
  })

  it('treats a temporary server failure as unreachable while its process is alive', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const descriptor = lease!.publish(42125)
    const unavailableFetch = (async () => new Response('', { status: 503 })) as typeof fetch
    expect(await probeRuntime(descriptor, unavailableFetch)).toBe('temporarily-unreachable')
    expect(fs.existsSync(runtimePath)).toBe(true)
    lease!.release()
  })

  it('treats an authenticated health rate limit as transient while its process is alive', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const descriptor = lease!.publish(42128)
    const limitedFetch = (async () => new Response('', { status: 429 })) as typeof fetch
    expect(await probeRuntime(descriptor, limitedFetch)).toBe('temporarily-unreachable')
    expect(await discoverRuntime(runtimePath, limitedFetch)).toBeNull()
    expect(readRuntimeDescriptor(runtimePath)).toEqual(descriptor)
    lease!.release()
  })

  it('keeps a live descriptor when health headers arrive but the body is unreadable', async () => {
    const lease = await acquireRuntimeLease({ file: runtimePath })
    const descriptor = lease!.publish(42127)
    const interruptedBody = (async () =>
      new Response('{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    expect(await probeRuntime(descriptor, interruptedBody)).toBe('temporarily-unreachable')
    expect(await discoverRuntime(runtimePath, interruptedBody)).toBeNull()
    expect(readRuntimeDescriptor(runtimePath)).toEqual(descriptor)
    lease!.release()
  })

  it('does not replace a temporarily unreachable live descriptor while acquiring a lease', async () => {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true, mode: 0o700 })
    const descriptor = {
      version: 1 as const,
      app: 'opencontrol' as const,
      pid: process.pid,
      port: 42126,
      token: 'existing-token-that-is-at-least-thirty-two-bytes',
      startedAt: new Date().toISOString(),
    }
    fs.writeFileSync(runtimePath, JSON.stringify(descriptor), { mode: 0o600 })
    const unavailableFetch = (async () => {
      throw new TypeError('connection refused')
    }) as typeof fetch

    expect(await acquireRuntimeLease({ file: runtimePath, fetchImpl: unavailableFetch })).toBeNull()
    expect(readRuntimeDescriptor(runtimePath)).toEqual(descriptor)
    expect(fs.existsSync(`${runtimePath}.lock`)).toBe(false)
  })

  it('rejects descriptors readable by other users', async () => {
    if (process.platform === 'win32') return
    const lease = await acquireRuntimeLease({ file: runtimePath })
    lease!.publish(43211)
    fs.chmodSync(runtimePath, 0o644)
    expect(readRuntimeDescriptor(runtimePath)).toBeNull()
    lease!.release()
  })
})

function waitForWorkerMessage(
  worker: ChildProcess,
  type: 'ready' | 'result',
): Promise<{ type: string; won?: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Runtime lock worker did not report ${type}`)),
      5_000,
    )
    const onMessage = (message: { type?: string; won?: boolean }) => {
      if (message?.type !== type) return
      clearTimeout(timeout)
      worker.off('error', onError)
      resolve({ type, won: message.won })
    }
    const onError = (error: Error) => {
      clearTimeout(timeout)
      worker.off('message', onMessage)
      reject(error)
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
  })
}

function waitForWorkerExit(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => worker.once('exit', () => resolve()))
}
