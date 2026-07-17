import { describe, expect, it } from 'vitest'
import {
  deserializeTerminalBindings,
  serializeTerminalBindings,
  terminalSequenceFromBase64,
  terminalSequenceToBase64,
  TerminalSequenceDecoder,
} from '../src/input/terminal-sequence-decoder.js'
import type { TerminalDecoderEmission } from '../src/input/terminal-sequence-decoder.js'

function controls(emissions: readonly TerminalDecoderEmission[]): string[] {
  return emissions
    .filter((emission) => emission.kind === 'control')
    .map((emission) => `${emission.event.controlId}:${emission.event.phase}`)
}

function passthrough(emissions: readonly TerminalDecoderEmission[]): Buffer {
  return Buffer.concat(
    emissions
      .filter((emission) => emission.kind === 'passthrough')
      .map((emission) => emission.data),
  )
}

describe('TerminalSequenceDecoder', () => {
  it('consumes only configured sequences and preserves interleaved byte order', () => {
    const decoder = new TerminalSequenceDecoder(
      [{ controlId: 'command.send', sequence: Buffer.from([0x00, 0xff]) }],
      { sourceId: 'tty:1' },
    )
    const result = decoder.push(Buffer.from([0x61, 0x00, 0xff, 0x62]), 123)

    expect(result).toEqual([
      { kind: 'passthrough', data: Buffer.from('a') },
      {
        kind: 'control',
        event: {
          controlId: 'command.send',
          phase: 'press',
          sourceId: 'tty:1',
          timestamp: 123,
        },
      },
      { kind: 'passthrough', data: Buffer.from('b') },
    ])
  })

  it('recognizes a sequence split across arbitrary chunks', () => {
    const decoder = new TerminalSequenceDecoder([
      { controlId: 'nav.up', sequence: Buffer.from('\u001b[1;2P', 'binary') },
    ])

    expect(decoder.push(Buffer.from('\u001b[', 'binary'), 10)).toEqual([])
    expect(decoder.pendingBytes).toEqual(Buffer.from('\u001b[', 'binary'))
    expect(controls(decoder.push(Buffer.from('1;2P'), 20))).toEqual(['nav.up:press'])
    expect(decoder.pendingBytes).toHaveLength(0)
  })

  it('flushes an ambiguous Escape prefix only when its deadline expires', () => {
    const decoder = new TerminalSequenceDecoder(
      [{ controlId: 'nav.up', sequence: Buffer.from('\u001b[A', 'binary') }],
      { ambiguityTimeoutMs: 40 },
    )

    expect(decoder.push(Buffer.of(0x1b), 100)).toEqual([])
    expect(decoder.flushDeadline).toBe(140)
    expect(decoder.flushExpired(139)).toEqual([])
    expect(passthrough(decoder.flushExpired(140))).toEqual(Buffer.of(0x1b))
    expect(decoder.flushDeadline).toBeNull()
  })

  it('recognizes an Escape sequence completed before timeout', () => {
    const decoder = new TerminalSequenceDecoder(
      [{ controlId: 'nav.up', sequence: Buffer.from('\u001b[A', 'binary') }],
      { ambiguityTimeoutMs: 40 },
    )

    expect(decoder.push(Buffer.of(0x1b), 100)).toEqual([])
    expect(controls(decoder.push(Buffer.from('[A'), 120))).toEqual(['nav.up:press'])
    expect(decoder.flushExpired(200)).toEqual([])
  })

  it('flushes expired pending bytes before processing a later chunk', () => {
    const decoder = new TerminalSequenceDecoder(
      [{ controlId: 'nav.up', sequence: Buffer.from('\u001b[A', 'binary') }],
      { ambiguityTimeoutMs: 10 },
    )
    decoder.push(Buffer.of(0x1b), 10)

    expect(passthrough(decoder.push(Buffer.from('x'), 21))).toEqual(
      Buffer.concat([Buffer.of(0x1b), Buffer.from('x')]),
    )
  })

  it('chooses the longest configured match and recovers a shorter exact prefix', () => {
    const decoder = new TerminalSequenceDecoder([
      { controlId: 'command.approve', sequence: Buffer.from('a') },
      { controlId: 'command.decline', sequence: Buffer.from('ab') },
    ])

    expect(controls(decoder.push(Buffer.from('ab'), 1))).toEqual(['command.decline:press'])
    const mismatch = decoder.push(Buffer.from('ac'), 2)
    expect(controls(mismatch)).toEqual(['command.approve:press'])
    expect(passthrough(mismatch)).toEqual(Buffer.from('c'))
  })

  it('emits every repeated full sequence', () => {
    const decoder = new TerminalSequenceDecoder([
      { controlId: 'dial.cw', sequence: Buffer.from('\u001b[24~', 'binary'), phase: 'repeat' },
    ])
    const sequence = Buffer.from('\u001b[24~', 'binary')

    expect(controls(decoder.push(Buffer.concat([sequence, sequence, sequence]), 5))).toEqual([
      'dial.cw:repeat',
      'dial.cw:repeat',
      'dial.cw:repeat',
    ])
  })

  it('passes an incomplete sequence through unchanged on forced flush', () => {
    const decoder = new TerminalSequenceDecoder([
      { controlId: 'agent.1', sequence: Buffer.from([0xff, 0x00, 0x01]) },
    ])
    expect(decoder.push(Buffer.from([0xff, 0x00]), 1)).toEqual([])
    expect(passthrough(decoder.flush(2))).toEqual(Buffer.from([0xff, 0x00]))
  })

  it('passes all bytes through when there are no bindings', () => {
    const decoder = new TerminalSequenceDecoder([])
    const input = Buffer.from([0x00, 0xff, 0x1b, 0x41])
    expect(passthrough(decoder.push(input, 1))).toEqual(input)
  })

  it('rejects empty and duplicate sequences', () => {
    expect(
      () => new TerminalSequenceDecoder([{ controlId: 'agent.1', sequence: Buffer.alloc(0) }]),
    ).toThrow(/cannot be empty/)
    expect(
      () =>
        new TerminalSequenceDecoder([
          { controlId: 'agent.1', sequence: Buffer.from('x') },
          { controlId: 'agent.2', sequence: Buffer.from('x') },
        ]),
    ).toThrow(/Duplicate/)
  })
})

describe('terminal binding config helpers', () => {
  it('round-trips arbitrary binary sequences through canonical base64', () => {
    const sequence = Buffer.from([0x00, 0xff, 0x80, 0x1b, 0x00])
    const encoded = terminalSequenceToBase64(sequence)
    expect(terminalSequenceFromBase64(encoded)).toEqual(sequence)

    const serialized = serializeTerminalBindings([
      { controlId: 'agent.6', sequence, phase: 'release' },
    ])
    expect(deserializeTerminalBindings(serialized)).toEqual([
      { controlId: 'agent.6', sequence, phase: 'release' },
    ])
  })

  it('rejects permissive or corrupted base64 forms', () => {
    for (const invalid of ['A', 'AA=A', '!!!!', 'YQ', 'YQ===', ' YQ==']) {
      expect(() => terminalSequenceFromBase64(invalid)).toThrow(/canonical base64/)
    }
  })
})
