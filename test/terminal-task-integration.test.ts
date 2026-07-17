import { describe, expect, it } from 'vitest'
import { harnessFor } from '../src/harness/index.js'
import { terminalSequenceToBase64 } from '../src/input/index.js'
import { DEFAULT_CONFIG, type OpenControlConfig } from '../src/layers.js'
import { HostServer } from '../src/server.js'
import { TaskActionRouter } from '../src/task-action-router.js'
import { createTerminalInputRelay } from '../src/terminal-input-relay.js'

function config(): OpenControlConfig {
  const sequence = Buffer.from('\x1b[33~')
  return {
    ...DEFAULT_CONFIG,
    inputs: {
      terminal: {
        enabled: true,
        bindings: { 'command.fast': terminalSequenceToBase64(sequence) },
        escapeTimeoutMs: 25,
      },
      qmk: { enabled: false },
      gamepad: { enabled: false },
    },
    controls: { ...DEFAULT_CONFIG.controls },
  }
}

describe('stock terminal to selected task integration', () => {
  it('keeps ordinary typing local while hardware actions reach only the selected PTY', () => {
    const userConfig = config()
    const server = new HostServer(harnessFor('codex'))
    server.registerLocalWrapper({
      wrapperId: 'terminal-a',
      kind: 'codex',
      cwd: '/a',
      pid: 1,
      slot: 1,
    })
    server.registerLocalWrapper({
      wrapperId: 'terminal-b',
      kind: 'claude',
      cwd: '/b',
      pid: 2,
      slot: 2,
    })
    const ptyA: string[] = []
    const ptyB: string[] = []
    server.attachWriter('terminal-a', (bytes) => ptyA.push(bytes))
    server.attachWriter('terminal-b', (bytes) => ptyB.push(bytes))
    server.selectSlot(2)
    const actions = new TaskActionRouter(server, userConfig)
    server.on('control', (event) => actions.handleControl(event))
    const relay = createTerminalInputRelay(userConfig, 'terminal-a', (event) =>
      server.dispatchControl(event),
    )!

    relay('ordinary local prompt', (bytes) => ptyA.push(bytes.toString()))
    relay('\x1b[', (bytes) => ptyA.push(bytes.toString()))
    relay('33~', (bytes) => ptyA.push(bytes.toString()))

    expect(ptyA).toEqual(['ordinary local prompt'])
    expect(ptyB).toEqual(['/fast\r'])
  })

  it('preserves non-UTF-8 passthrough bytes', () => {
    const relay = createTerminalInputRelay(config(), 'terminal', () => {
      throw new Error('unexpected control')
    })!
    const output: Buffer[] = []
    relay(Buffer.from([0xff, 0xfe, 0x00]), (bytes) => output.push(Buffer.from(bytes)))
    expect(Buffer.concat(output)).toEqual(Buffer.from([0xff, 0xfe, 0x00]))
  })
})
