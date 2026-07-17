import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cancelClient,
  registerClient,
  streamClient,
  type ClientRegistration,
} from '../src/client.js'
import { harnessFor } from '../src/harness/index.js'
import { appDataDirectory } from '../src/secure-files.js'
import { HostServer } from '../src/server.js'
import { recoveryRegistration, taskFromStatus, withoutProcess } from '../src/task-recovery.js'
import type { TaskRegistration, TaskStatus } from '../src/state.js'

const claude = harnessFor('claude')

describe('host-exit recovery integration', () => {
  it('restores assigned and overflow wrappers from live SSE caches after host exit', async () => {
    const temporaryRoot = process.platform === 'win32' ? appDataDirectory() : os.tmpdir()
    fs.mkdirSync(temporaryRoot, { recursive: true })
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'opencontrol-host-recovery-'))
    const runtimePath = path.join(directory, 'runtime.json')
    const oldHost = new HostServer(claude)
    let promotedHost: HostServer | null = null
    const streams: Promise<void>[] = []
    const aborters: AbortController[] = []
    const cached = new Map<string, TaskStatus>()

    try {
      await expect(
        oldHost.listenRuntime(runtimePath, () => {
          oldHost.registerLocalWrapper({
            wrapperId: 'old-host',
            kind: 'claude',
            cwd: '/projects/host',
            pid: process.pid,
            slot: 1,
          })
        }),
      ).resolves.toBe(true)

      const clients = new Map<string, ClientRegistration>()
      const registrations = new Map<string, TaskRegistration>()
      for (let index = 2; index <= 8; index += 1) {
        const wrapperId = `wrapper-${index}`
        const registration: TaskRegistration = {
          wrapperId,
          kind: index % 2 === 0 ? 'codex' : 'claude',
          cwd: `/projects/${index}`,
          pid: 10_000 + index,
        }
        registrations.set(wrapperId, registration)
        const client = await registerClient(registration, { runtimePath })
        clients.set(wrapperId, client)
        const aborter = new AbortController()
        aborters.push(aborter)
        streams.push(
          streamClient(client, () => undefined, {
            signal: aborter.signal,
            onStatus: (status) => cached.set(wrapperId, status),
          }).catch(() => undefined),
        )
        await waitFor(() => cached.has(wrapperId))
      }

      oldHost.reportTaskState('wrapper-3', 'executing')
      oldHost.reportTaskState('wrapper-4', 'waiting')
      oldHost.reportTaskState('wrapper-5', 'complete')
      oldHost.selectSlot(4)
      await waitFor(() =>
        [...cached.values()].every(
          (status) =>
            status.slots[2]?.state === 'executing' &&
            status.slots[3]?.state === 'waiting' &&
            status.slots[4]?.unread === true &&
            status.selectedSlot === 4,
        ),
      )

      await oldHost.close()
      await Promise.all(streams)

      const promoterId = 'wrapper-2'
      const promoterStatus = withoutProcess(cached.get(promoterId)!, process.pid)
      const promoterTask = taskFromStatus(promoterStatus, promoterId)!
      promotedHost = new HostServer(claude)
      await expect(
        promotedHost.listenRuntime(runtimePath, () => {
          promotedHost!.restoreTaskStatus(promoterStatus, promoterId)
          promotedHost!.registerLocalWrapper(
            recoveryRegistration(registrations.get(promoterId)!, promoterTask),
            harnessFor(promoterTask.kind),
          )
        }),
      ).resolves.toBe(true)

      const reconnected: ClientRegistration[] = []
      for (const wrapperId of [
        'wrapper-7',
        'wrapper-8',
        'wrapper-3',
        'wrapper-4',
        'wrapper-5',
        'wrapper-6',
      ]) {
        const task = taskFromStatus(cached.get(wrapperId)!, wrapperId)!
        reconnected.push(
          await registerClient(recoveryRegistration(registrations.get(wrapperId)!, task), {
            runtimePath,
          }),
        )
      }

      const status = promotedHost.tasks.status()
      expect(status.slots[0]).toBeNull()
      expect(status.slots[1]?.wrapperId).toBe('wrapper-2')
      expect(status.unassigned.map((task) => task.wrapperId)).toEqual(['wrapper-7', 'wrapper-8'])
      expect(promotedHost.tasks.get('wrapper-3')).toMatchObject({
        state: 'executing',
        connectionState: 'connected',
      })
      expect(promotedHost.tasks.get('wrapper-4')).toMatchObject({
        state: 'waiting',
        selected: true,
        connectionState: 'connected',
      })
      expect(promotedHost.tasks.get('wrapper-5')).toMatchObject({
        state: 'complete',
        unread: true,
      })

      for (const client of reconnected) await cancelClient(client)
    } finally {
      for (const aborter of aborters) aborter.abort()
      await oldHost.close()
      await promotedHost?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
