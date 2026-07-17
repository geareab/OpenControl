import {
  isControlId,
  TerminalInputAdapter,
  terminalSequenceFromBase64,
  type ControlEvent,
} from './input/index.js'
import type { OpenControlConfig } from './layers.js'
import { logger } from './logger.js'

export type TerminalInputRelay = (
  data: string | Uint8Array,
  writeLocal: (bytes: string | Buffer) => void,
) => void

/** Build the stock VIA input interceptor, or undefined when it is not configured. */
export function createTerminalInputRelay(
  config: OpenControlConfig,
  wrapperId: string,
  sendControl: (event: ControlEvent) => void,
): TerminalInputRelay | undefined {
  if (!config.inputs.terminal.enabled) return undefined
  const bindings = Object.entries(config.inputs.terminal.bindings).flatMap(
    ([controlId, encoded]) => {
      if (!isControlId(controlId)) {
        logger.warn(`Ignoring unknown terminal control ID: ${controlId}`)
        return []
      }
      const sequence = terminalSequenceFromBase64(encoded)
      if (sequence.length === 0) return []
      return [{ controlId, sequence }]
    },
  )
  if (bindings.length === 0) return undefined

  const adapter = new TerminalInputAdapter(bindings, {
    sourceId: `terminal:${wrapperId}`,
    ambiguityTimeoutMs: config.inputs.terminal.escapeTimeoutMs,
  })
  adapter.onControl(sendControl)
  adapter.start()
  let timer: ReturnType<typeof setTimeout> | null = null
  const armTimer = (writeLocal: (bytes: string | Buffer) => void): void => {
    if (timer) clearTimeout(timer)
    const deadline = adapter.flushDeadline
    if (deadline === null) {
      timer = null
      return
    }
    timer = setTimeout(
      () => {
        timer = null
        adapter.flushExpired(writeLocal)
        armTimer(writeLocal)
      },
      Math.max(0, deadline - Date.now()),
    )
    timer.unref?.()
  }

  return (data, writeLocal) => {
    adapter.consume(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, writeLocal)
    armTimer(writeLocal)
  }
}
