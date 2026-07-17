import { describe, expect, it } from 'vitest'
import {
  TERMINAL_REPEAT_WINDOW_MS,
  TerminalInputAdapter,
} from '../src/input/terminal-input-adapter.js'

describe('TerminalInputAdapter', () => {
  it('exposes terminal capabilities and delivers controls/passthrough in input order', () => {
    const adapter = new TerminalInputAdapter(
      [{ controlId: 'agent.1', sequence: Buffer.from('\x1b[25~') }],
      { sourceId: 'terminal:test' },
    )
    const ordered: string[] = []
    adapter.onControl((event) => ordered.push(`control:${event.controlId}`))
    adapter.start()
    adapter.consume(Buffer.from('a\x1b[25~b'), (bytes) => ordered.push(`bytes:${bytes}`), 10)

    expect(adapter.capabilities).toMatchObject({
      transport: 'terminal',
      pressRelease: false,
      rgbFeedback: false,
    })
    expect(ordered).toEqual(['bytes:a', 'control:agent.1', 'bytes:b'])
  })

  it('classifies a held terminal key burst as repeat until a quiet interval', () => {
    const sequence = Buffer.from('\x1b[25~')
    const adapter = new TerminalInputAdapter([{ controlId: 'command.send', sequence }])
    const phases: string[] = []
    adapter.onControl((event) => phases.push(event.phase))
    adapter.start()

    adapter.consume(sequence, () => {}, 10)
    adapter.consume(sequence, () => {}, 20)
    adapter.consume(sequence, () => {}, 20 + TERMINAL_REPEAT_WINDOW_MS + 1)

    expect(phases).toEqual(['press', 'repeat', 'press'])
  })
})
