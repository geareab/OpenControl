import { routeSemanticControl } from './control-map.js'
import { isRepeatableAction } from './action-policy.js'
import { dispatchAction } from './dispatch.js'
import { harnessFor } from './harness/index.js'
import type { Action, Harness } from './harness/types.js'
import type { OpenControlConfig } from './layers.js'
import { logger } from './logger.js'
import type { HostControlEvent, HostServer } from './server.js'

const DEFAULT_THINKING_LEVEL = 2

export interface TaskActionRouterOptions {
  setLayer?: (index: number) => void
}

/** Resolve semantic or legacy actions against the currently selected task. */
export class TaskActionRouter {
  private readonly thinkingLevels = new Map<string, number>()

  constructor(
    private readonly server: HostServer,
    private readonly config: OpenControlConfig,
    private readonly options: TaskActionRouterOptions = {},
  ) {}

  handleControl(event: HostControlEvent): void {
    if (event.phase === 'release') return
    const routed = routeSemanticControl(event.controlId, this.config)
    // HostServer owns Agent-key selection before emitting the event.
    if (routed.type !== 'action') return
    if (event.phase === 'repeat' && !isRepeatableAction(routed.action)) return
    this.dispatch(routed.action)
  }

  dispatch(action: Action): boolean {
    const selected = this.server.tasks.selected()
    if (!selected) return false
    let harness: Harness
    try {
      harness = harnessFor(selected.kind)
    } catch (error) {
      logger.warn('selected task has no harness', error)
      return false
    }
    dispatchAction(action, {
      harness,
      config: this.config,
      getThinkingLevel: () => this.thinkingLevels.get(selected.wrapperId) ?? DEFAULT_THINKING_LEVEL,
      setThinkingLevel: (level) => this.thinkingLevels.set(selected.wrapperId, level),
      write: (bytes) => {
        if (!this.server.sendKeysToSelected(bytes)) {
          logger.warn('selected task has no attached PTY')
        }
      },
      focusSession: (index) => {
        if (index < 0) this.server.selectRelative(1)
        else this.server.selectSlot(index + 1)
      },
      focusRelative: (delta) => this.server.selectRelative(delta),
      setLayer: (index) => this.options.setLayer?.(index),
    })
    return true
  }
}
