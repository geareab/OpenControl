import { describe, expect, it } from 'vitest'
import { harnessFor } from '../src/harness/index.js'
import { DEFAULT_CONFIG, type OpenControlConfig } from '../src/layers.js'
import { HostServer } from '../src/server.js'
import { TaskActionRouter } from '../src/task-action-router.js'

function config(): OpenControlConfig {
  return {
    ...DEFAULT_CONFIG,
    inputs: {
      terminal: { ...DEFAULT_CONFIG.inputs.terminal, bindings: {} },
      qmk: { ...DEFAULT_CONFIG.inputs.qmk },
      gamepad: { ...DEFAULT_CONFIG.inputs.gamepad },
    },
    controls: { ...DEFAULT_CONFIG.controls },
  }
}

describe('selected task action routing', () => {
  it('routes hardware commands only to the selected task and keeps selection sticky', () => {
    const server = new HostServer(harnessFor('codex'))
    server.registerLocalWrapper({
      wrapperId: 'codex',
      kind: 'codex',
      cwd: '/api',
      pid: 1,
      slot: 1,
    })
    server.registerLocalWrapper({
      wrapperId: 'claude',
      kind: 'claude',
      cwd: '/ui',
      pid: 2,
      slot: 2,
    })
    const codex: string[] = []
    const claude: string[] = []
    server.attachWriter('codex', (bytes) => codex.push(bytes))
    server.attachWriter('claude', (bytes) => claude.push(bytes))
    const router = new TaskActionRouter(server, config())
    server.on('control', (event) => router.handleControl(event))

    server.dispatchControl({
      controlId: 'agent.2',
      phase: 'press',
      sourceId: 'keyboard',
      timestamp: 1,
    })
    server.dispatchControl({
      controlId: 'command.fast',
      phase: 'press',
      sourceId: 'keyboard',
      timestamp: 2,
    })

    expect(server.tasks.selected()?.wrapperId).toBe('claude')
    expect(codex).toEqual([])
    expect(claude).toEqual(['/fast\r'])
  })

  it('uses the selected harness and leaves unsupported Codex dial turns as no-ops', () => {
    const server = new HostServer(harnessFor('codex'))
    server.registerLocalWrapper({
      wrapperId: 'codex',
      kind: 'codex',
      cwd: '/api',
      pid: 1,
      slot: 1,
    })
    server.registerLocalWrapper({
      wrapperId: 'claude',
      kind: 'claude',
      cwd: '/ui',
      pid: 2,
      slot: 2,
    })
    const codex: string[] = []
    const claude: string[] = []
    server.attachWriter('codex', (bytes) => codex.push(bytes))
    server.attachWriter('claude', (bytes) => claude.push(bytes))
    const router = new TaskActionRouter(server, config())

    router.dispatch({ type: 'thinking_depth', delta: 1 })
    server.selectSlot(2)
    router.dispatch({ type: 'thinking_depth', delta: 1 })

    expect(codex).toEqual([])
    expect(claude).toEqual(['/effort xhigh\r'])
  })

  it('allows repeats only for focus and thinking-depth actions', () => {
    const server = new HostServer(harnessFor('claude'))
    server.registerLocalWrapper({
      wrapperId: 'claude',
      kind: 'claude',
      cwd: '/ui',
      pid: 2,
      slot: 1,
    })
    const writes: string[] = []
    server.attachWriter('claude', (bytes) => writes.push(bytes))
    const router = new TaskActionRouter(server, config())

    router.handleControl({
      controlId: 'command.send',
      phase: 'repeat',
      sourceId: 'keyboard',
      timestamp: 1,
    })
    router.handleControl({
      controlId: 'dial.cw',
      phase: 'repeat',
      sourceId: 'keyboard',
      timestamp: 2,
    })

    expect(writes).toEqual(['/effort xhigh\r'])
  })
})
