#!/usr/bin/env node
// OpenControl wraps one Codex CLI or Claude Code process in a PTY. The first
// wrapper owns the authenticated task host and hardware; later wrappers
// reserve a task slot before their PTY is spawned and stream routed actions
// back to their own process.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  cancelClient,
  fetchHostStatus,
  HostRequestError,
  postControlEvent,
  relayHookEvent,
  streamClient,
  type ClientRegistration,
} from './client.js'
import { registerClientWhenReady } from './client-registration.js'
import type { Harness } from './harness/types.js'
import { harnessFor } from './harness/index.js'
import { LegacyGamepadAdapter, QmkRawHidAdapter, type ControlEvent } from './input/index.js'
import { HidManager } from './controller/hid-manager.js'
import { parseInvocation, USAGE } from './invocation.js'
import { loadConfig, type OpenControlConfig } from './layers.js'
import { logger } from './logger.js'
import { AgentPty } from './pty.js'
import { LayerRouter } from './router.js'
import { HostServer, type HostControlEvent } from './server.js'
import { runSetup } from './setup.js'
import { STATE_COLOR, type RGB } from './feedback.js'
import { formatHostStatus } from './status.js'
import { feedbackFrameForTasks } from './task-feedback.js'
import { createTaskFeedbackScheduler } from './task-feedback-scheduler.js'
import { recoveryRegistration, taskFromStatus, withoutProcess } from './task-recovery.js'
import { TaskActionRouter } from './task-action-router.js'
import { createTerminalInputRelay } from './terminal-input-relay.js'
import { sanitizeTerminalText } from './terminal-sanitize.js'
import type { TaskRegistration, TaskStatus } from './state.js'
import type { ControllerEvent, ControllerType } from './types.js'

const FEEDBACK_DEBOUNCE_MS = 50
const LAYER_FLASH_MS = 600
async function main(): Promise<void> {
  let invocation
  try {
    invocation = parseInvocation(process.argv.slice(2))
  } catch (error) {
    console.error(safeErrorMessage(error))
    process.exitCode = 2
    return
  }

  if (invocation.help) {
    console.log(USAGE)
    return
  }
  if (invocation.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    console.log(pkg.version)
    return
  }

  if (invocation.command === 'setup') {
    await runSetup()
    return
  }
  if (invocation.command === 'doctor') {
    const overwrite = invocation.agentArgs.includes('--overwrite')
    if (invocation.agentArgs.includes('--gamepad')) {
      const { runDoctor } = await import('./doctor.js')
      await runDoctor({ overwrite })
    } else {
      const { runOpenControlDoctor } = await import('./opencontrol-doctor.js')
      await runOpenControlDoctor({
        hardware: invocation.agentArgs.includes('--hardware'),
        overwrite,
      })
    }
    return
  }
  if (invocation.command === 'status') {
    try {
      console.log(formatHostStatus(await fetchHostStatus()))
    } catch (error) {
      if (error instanceof HostRequestError && error.code === 'HOST_OFFLINE') {
        console.error('No OpenControl host is running.')
        process.exitCode = 1
        return
      }
      throw error
    }
    return
  }
  if (invocation.command === 'hook') {
    await relayHookEvent(invocation.hookEvent!)
    // Hook subprocesses must always emit valid JSON and never block the agent
    // merely because no OpenControl wrapper is running.
    console.log('{}')
    return
  }

  await runWrappedAgent(invocation.kind, invocation.agentArgs, invocation.slot, invocation.name)
}

async function runWrappedAgent(
  kind: string,
  agentArgs: string[],
  requestedSlot: number | null,
  name: string | null,
): Promise<void> {
  let harness: Harness
  let config: OpenControlConfig
  try {
    harness = harnessFor(kind)
    config = loadConfig()
  } catch (error) {
    console.error(safeErrorMessage(error))
    process.exitCode = 1
    return
  }

  const wrapperId = randomUUID()
  const baseRegistration: Omit<TaskRegistration, 'slot' | 'recovery'> = {
    wrapperId,
    kind: harness.kind,
    cwd: process.cwd(),
    pid: process.pid,
    ...(name === null ? {} : { name }),
  }
  const registration: TaskRegistration = {
    ...baseRegistration,
    ...(requestedSlot === null ? {} : { slot: requestedSlot }),
  }
  let server = new HostServer(harness)
  let isHost = false
  let client: ClientRegistration | null = null

  const sendTerminalControl = (event: ControlEvent): void => {
    if (isHost) {
      server.dispatchControl(event)
      return
    }
    if (!client) return
    void postControlEvent(event, { descriptor: client.descriptor }).catch((error) =>
      logger.warn('terminal control relay failed', error),
    )
  }

  // Binding validation must happen before a slot is reserved. A malformed
  // terminal sequence can therefore never strand a remote reservation.
  let terminalInput:
    ((data: Buffer, writeLocal: (bytes: string | Buffer) => void) => void) | undefined
  try {
    terminalInput = createTerminalInputRelay(config, wrapperId, sendTerminalControl)
  } catch (error) {
    console.error(`opencontrol: invalid terminal bindings: ${safeErrorMessage(error)}`)
    process.exitCode = 1
    return
  }

  try {
    isHost = await server.listenRuntime(undefined, () => {
      server.registerLocalWrapper(registration, harness)
    })
    if (!isHost) client = await registerClientWhenReady(registration)
  } catch (error) {
    await server.close()
    if (error instanceof HostRequestError && error.code === 'SLOT_OCCUPIED') {
      console.error(`OpenControl task slot ${requestedSlot} is already occupied.`)
    } else {
      console.error(safeErrorMessage(error))
    }
    process.exitCode = 1
    return
  }

  let install: ReturnType<Harness['installHooks']>
  try {
    install = harness.installHooks()
  } catch (error) {
    if (isHost) {
      server.unregisterWrapper(wrapperId)
      await server.close()
    } else if (client) {
      try {
        await cancelClient(client)
      } catch (cancelError) {
        logger.warn('could not release task slot after hook installation failure', cancelError)
      }
    }
    console.error(`opencontrol: could not install agent hooks: ${safeErrorMessage(error)}`)
    process.exitCode = 1
    return
  }
  if (install.trustNotice) console.error(install.trustNotice)

  let agent: AgentPty | null = null
  let hid: LegacyGamepadAdapter | null = null
  let qmk: QmkRawHidAdapter | null = null
  let detachWriter: (() => void) | null = null
  let closing = false
  const streamAbort = new AbortController()

  const shutdown = async (code: number): Promise<void> => {
    if (closing) return
    closing = true
    if (code !== 0) {
      if (isHost) server.reportTaskState(wrapperId, 'error')
      else if (client) {
        await relayHookEvent('ProcessFailure', {
          descriptor: client.descriptor,
          wrapperId,
          body: JSON.stringify({ exit_code: code }),
        })
      }
      // Let the debounced feedback adapter publish red before this slot is
      // released. This delay only runs for a failed child process.
      await new Promise((resolve) => setTimeout(resolve, FEEDBACK_DEBOUNCE_MS * 2))
    }
    if (!isHost && client) {
      try {
        await cancelClient(client)
      } catch (error) {
        logger.warn('could not explicitly release remote task slot', error)
      }
    }
    streamAbort.abort()
    detachWriter?.()
    qmk?.stop()
    hid?.stop()
    if (isHost) {
      server.unregisterWrapper(wrapperId)
      await server.close()
    }
    agent?.dispose()
    process.exit(code)
  }

  try {
    agent = new AgentPty(
      harness.command,
      harness.buildArgs(agentArgs),
      wrapperId,
      (code) => void shutdown(code),
      terminalInput ? { onInput: terminalInput } : {},
    )
  } catch (error) {
    if (isHost) {
      server.unregisterWrapper(wrapperId)
      await server.close()
    } else if (client) {
      try {
        await cancelClient(client)
      } catch (cancelError) {
        logger.warn('could not release task slot after PTY startup failure', cancelError)
      }
    }
    console.error(
      `opencontrol: could not start ${sanitizeTerminalText(harness.command, 80)}: ${safeErrorMessage(error)}`,
    )
    process.exitCode = 1
    return
  }

  process.on('SIGINT', () => agent?.write('\x03'))
  process.on('SIGTERM', () => void shutdown(0))

  if (isHost) {
    detachWriter = server.attachWriter(wrapperId, (bytes) => agent?.write(bytes))
    const hardware = startHostHardware(server, config)
    hid = hardware.hid
    qmk = hardware.qmk
  } else if (client) {
    let activeRegistration = client
    let lastStatus: TaskStatus | null = activeRegistration.status ?? null
    void (async () => {
      while (!closing && !streamAbort.signal.aborted) {
        try {
          await streamClient(activeRegistration, (bytes) => agent?.write(bytes), {
            signal: streamAbort.signal,
            onStatus: (status) => {
              lastStatus = status
            },
          })
        } catch (error) {
          if (closing || streamAbort.signal.aborted) return
          logger.warn('client stream failed; attempting host recovery', error)
        }
        if (closing || streamAbort.signal.aborted) return

        // Every surviving wrapper participates in a deterministic lease race.
        // One promotes itself; the rest re-register with that new host.
        try {
          const cachedTask = taskFromStatus(lastStatus, wrapperId) ?? activeRegistration.task
          const reconnectRegistration = recoveryRegistration(baseRegistration, cachedTask)
          const recoveredStatus = lastStatus
            ? withoutProcess(lastStatus, activeRegistration.descriptor.pid)
            : null
          const restoredTask = taskFromStatus(recoveredStatus, wrapperId) ?? cachedTask
          const promoted = await server.listenRuntime(undefined, () => {
            if (recoveredStatus) server.restoreTaskStatus(recoveredStatus, wrapperId)
            server.registerLocalWrapper(
              recoveryRegistration(baseRegistration, restoredTask),
              harness,
            )
          })
          if (promoted) {
            isHost = true
            detachWriter = server.attachWriter(wrapperId, (bytes) => agent?.write(bytes))
            try {
              const hardware = startHostHardware(server, config)
              hid = hardware.hid
              qmk = hardware.qmk
            } catch (error) {
              detachWriter?.()
              detachWriter = null
              qmk?.stop()
              hid?.stop()
              qmk = null
              hid = null
              isHost = false
              await server.close()
              server = new HostServer(harness)
              throw error
            }
            client = null
            logger.info('client promoted to OpenControl host after host exit')
            return
          }
          activeRegistration = await registerClientWhenReady(reconnectRegistration, {
            recovery: true,
          })
          client = activeRegistration
        } catch (error) {
          if (!isHost && server.boundPort !== 0) {
            await server.close()
            server = new HostServer(harness)
          }
          if (!closing) logger.warn('host recovery attempt failed', error)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    })()
  }

  logger.info(`opencontrol started (${isHost ? 'host' : 'client'}, kind: ${harness.kind})`)
}

function startHostHardware(
  server: HostServer,
  config: OpenControlConfig,
): { hid: LegacyGamepadAdapter | null; qmk: QmkRawHidAdapter | null } {
  const router = new LayerRouter(config)
  const connectedDevices = new Map<string, unknown>()
  let hid: LegacyGamepadAdapter | null = null
  let qmk: QmkRawHidAdapter | null = null
  let flashUntil = 0
  let flashColor: RGB | null = null

  const publishDevices = (): void => server.setDevices([...connectedDevices.values()])
  const actionRouter = new TaskActionRouter(server, config, {
    setLayer: (index) => router.setLayer(index),
  })
  server.on('control', (event: HostControlEvent) => actionRouter.handleControl(event))

  const applyFeedback = (tasks: TaskStatus = server.tasks.status()): void => {
    qmk?.updateFeedback(feedbackFrameForTasks(tasks))
    if (!hid?.output) return
    const selected = server.tasks.selected()
    const layerColor = config.layers[router.currentLayer]?.color ?? { r: 0, g: 0, b: 0 }
    const base = selected
      ? selected.state === 'disconnected' || selected.connectionState === 'reconnecting'
        ? STATE_COLOR.error
        : STATE_COLOR[selected.state]
      : layerColor
    const lightbar = Date.now() < flashUntil && flashColor ? flashColor : base
    hid.output.setLightbar(lightbar)
    const playerLeds = tasks.slots
      .slice(0, 5)
      .reduce((mask, task, index) => (task ? mask | (1 << index) : mask), 0)
    hid.output.setPlayerLeds(playerLeds)
  }
  const feedbackScheduler = createTaskFeedbackScheduler(
    () => server.tasks.status(),
    applyFeedback,
    FEEDBACK_DEBOUNCE_MS,
  )
  const scheduleFeedback = (): void => feedbackScheduler.schedule()
  server.on('tasks', scheduleFeedback)

  router.onLayerChange = (index) => {
    flashColor = config.layers[index]?.color ?? null
    flashUntil = Date.now() + LAYER_FLASH_MS
    applyFeedback()
    const timer = setTimeout(() => applyFeedback(), LAYER_FLASH_MS)
    timer.unref?.()
  }

  if (config.hardwareEnrollmentRequired) {
    logger.warn(
      'Hardware input was disabled during the schema v2 migration; rerun opencontrol setup',
    )
  }

  if (config.inputs.qmk.enabled && !config.inputs.qmk.device) {
    logger.warn('QMK input is enabled without an enrolled device; rerun opencontrol setup')
  } else if (config.inputs.qmk.enabled && config.inputs.qmk.device) {
    qmk = new QmkRawHidAdapter({ enrolledDevice: config.inputs.qmk.device })
    let qmkIdentity: Record<string, unknown> = { adapterId: qmk.adapterId }
    const publishQmkHealth = (): void => {
      connectedDevices.set(qmk!.adapterId, { ...qmkIdentity, health: qmk!.health })
      publishDevices()
    }
    qmk.onControl((event) => server.dispatchControl(event))
    qmk.onConnectionChange((event) => {
      if (event.connected) {
        qmkIdentity = {
          adapterId: event.adapterId,
          deviceId: event.deviceId,
          capabilities: event.capabilities,
        }
      }
      publishQmkHealth()
      scheduleFeedback()
    })
    qmk.onHealthChange(() => publishQmkHealth())
    qmk.onProtocolError((error) => logger.warn('QMK Raw HID adapter error', error))
    publishQmkHealth()
    void qmk.start().catch((error) => logger.warn('QMK Raw HID adapter failed to start', error))
  }

  if (config.inputs.gamepad.enabled && !config.inputs.gamepad.device) {
    logger.warn('Gamepad input is enabled without an enrolled device; rerun opencontrol setup')
  } else if (config.inputs.gamepad.enabled && config.inputs.gamepad.device) {
    hid = new LegacyGamepadAdapter(new HidManager(config.inputs.gamepad.device))
    hid.onLegacyEvent((event: ControllerEvent) => {
      try {
        if (event.kind === 'connected') {
          connectedDevices.set('gamepad', describeController(event.controllerType))
          publishDevices()
          scheduleFeedback()
          return
        }
        if (event.kind === 'disconnected') {
          router.resetInputState()
          connectedDevices.delete('gamepad')
          publishDevices()
          return
        }
        const action = router.route(event)
        if (!action) return
        if (event.kind === 'button' && !event.pressed) return
        actionRouter.dispatch(action)
      } catch (error) {
        logger.error('gamepad event handling failed', error)
      }
    })
    hid.start()
  }

  applyFeedback()
  return { hid, qmk }
}

function describeController(controllerType: ControllerType): unknown {
  return { adapterId: 'gamepad', controllerType, health: 'connected' }
}

main().catch((error) => {
  console.error(safeErrorMessage(error))
  logger.error('fatal OpenControl error', error)
  process.exitCode = 1
})

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error), 500)
}
