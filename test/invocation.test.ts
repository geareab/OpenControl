// parseInvocation splits argv into a harness kind + forwarded args. The kind is
// resolved (and validated) later by harnessFor, so parsing stays purely lexical.

import { describe, expect, it } from 'vitest'
import { parseInvocation } from '../src/invocation.js'

describe('parseInvocation', () => {
  it('defaults to claude with no args', () => {
    expect(parseInvocation([])).toEqual({
      command: 'run',
      kind: 'claude',
      agentArgs: [],
      slot: null,
      name: null,
      hookEvent: null,
      help: false,
      version: false,
      doctor: false,
    })
  })

  it('treats a leading flag as claude args, not a harness kind', () => {
    expect(parseInvocation(['--resume', 'x'])).toEqual({
      command: 'run',
      kind: 'claude',
      agentArgs: ['--resume', 'x'],
      slot: null,
      name: null,
      hookEvent: null,
      help: false,
      version: false,
      doctor: false,
    })
  })

  it('takes a leading bare word as the harness kind', () => {
    expect(parseInvocation(['codex', '--foo'])).toEqual({
      command: 'run',
      kind: 'codex',
      agentArgs: ['--foo'],
      slot: null,
      name: null,
      hookEvent: null,
      help: false,
      version: false,
      doctor: false,
    })
  })

  it('passes an unknown bare word through as the kind (cli validates it)', () => {
    expect(parseInvocation(['gemini'])).toEqual({
      command: 'run',
      kind: 'gemini',
      agentArgs: [],
      slot: null,
      name: null,
      hookEvent: null,
      help: false,
      version: false,
      doctor: false,
    })
  })

  it('flags --help', () => {
    expect(parseInvocation(['--help']).help).toBe(true)
    expect(parseInvocation(['-h']).help).toBe(true)
  })

  it('flags the doctor subcommand', () => {
    expect(parseInvocation(['doctor'])).toEqual({
      command: 'doctor',
      kind: 'claude',
      agentArgs: [],
      slot: null,
      name: null,
      hookEvent: null,
      help: false,
      version: false,
      doctor: true,
    })
  })

  it('retains the explicit legacy gamepad doctor option', () => {
    expect(parseInvocation(['doctor', '--gamepad', '--overwrite'])).toMatchObject({
      command: 'doctor',
      agentArgs: ['--gamepad', '--overwrite'],
      doctor: true,
    })
  })

  it('rejects unknown or conflicting doctor options', () => {
    expect(() => parseInvocation(['doctor', '--output', 'report.json'])).toThrow(
      /unknown doctor option/,
    )
    expect(() => parseInvocation(['doctor', '--hardware', '--gamepad'])).toThrow(
      /cannot be used together/,
    )
  })

  it('parses explicit run metadata without consuming agent arguments', () => {
    expect(
      parseInvocation(['run', 'codex', '--slot', '3', '--name', 'api', '--', '--resume', 'x']),
    ).toMatchObject({
      command: 'run',
      kind: 'codex',
      slot: 3,
      name: 'api',
      agentArgs: ['--resume', 'x'],
    })
  })

  it('parses setup, status, and hook subcommands', () => {
    expect(parseInvocation(['setup']).command).toBe('setup')
    expect(parseInvocation(['status']).command).toBe('status')
    expect(parseInvocation(['hook', 'Stop'])).toMatchObject({
      command: 'hook',
      hookEvent: 'Stop',
    })
  })

  it('rejects invalid explicit run options', () => {
    expect(() => parseInvocation(['run', 'codex', '--slot', '7'])).toThrow(/1 to 6/)
    expect(() => parseInvocation(['run', 'codex', '--resume'])).toThrow(/standalone --/)
  })
})

describe('--version', () => {
  it.each([['--version'], ['-V'], ['-v']])('%s reports opencontrol, not the agent', (flag) => {
    const parsed = parseInvocation([flag])
    expect(parsed.version).toBe(true)
    expect(parsed.agentArgs).toEqual([])
  })

  it('passes --version through when a harness is named', () => {
    const parsed = parseInvocation(['claude', '--version'])
    expect(parsed.version).toBe(false)
    expect(parsed.agentArgs).toEqual(['--version'])
  })
})
