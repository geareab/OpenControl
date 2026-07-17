import { describe, expect, it } from 'vitest'
import type { HostStatus } from '../src/server.js'
import { formatHostStatus } from '../src/status.js'

describe('formatHostStatus', () => {
  it('shows six slots, selection, unread state, overflow, and devices', () => {
    const now = Date.now()
    const task = {
      wrapperId: 'one',
      name: 'api',
      kind: 'codex',
      cwd: '/work/api',
      pid: 10,
      state: 'complete' as const,
      connectionState: 'reconnecting' as const,
      slot: 1,
      selected: true,
      unread: true,
      sessionId: null,
      registeredAt: now,
      updatedAt: now,
    }
    const overflow = { ...task, wrapperId: 'seven', name: 'extra', slot: null, selected: false }
    const status: HostStatus = {
      app: 'opencontrol',
      version: 1,
      pid: 42,
      port: 32100,
      tasks: {
        slots: [task, null, null, null, null, null],
        unassigned: [overflow],
        selectedSlot: 1,
      },
      devices: [{ adapterId: 'qmk-raw-hid', health: 'degraded' }],
    }

    const output = formatHostStatus(status)
    expect(output).toContain('OpenControl host 42')
    expect(output).toContain('* 1')
    expect(output).toContain('complete/reconnecting •')
    expect(output).toContain('/work/api')
    expect(output).toContain('  6')
    expect(output).toContain('extra · codex')
    expect(output).toContain('qmk-raw-hid (degraded)')
  })

  it('removes terminal control sequences and bounds untrusted display fields', () => {
    const now = Date.now()
    const hostile = {
      wrapperId: 'hostile',
      name: '\u001b[31mred\u001b[0m\nforged',
      kind: 'co\u009bdex',
      cwd: `/safe/\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007/${'x'.repeat(300)}`,
      pid: 10,
      state: 'idle' as const,
      connectionState: 'connected' as const,
      slot: 1,
      selected: true,
      unread: false,
      sessionId: null,
      registeredAt: now,
      updatedAt: now,
    }
    const status: HostStatus = {
      app: 'opencontrol',
      version: 1,
      pid: 42,
      port: 32100,
      tasks: {
        slots: [hostile, null, null, null, null, null],
        unassigned: [],
        selectedSlot: 1,
      },
      devices: [{ product: '\u001b[2Jkeyboard\nforged', health: '\u001b]0;pwned\u0007ok' }],
    }

    const output = formatHostStatus(status)
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(output).not.toContain('[31m')
    expect(output).not.toContain('https://example.invalid')
    expect(output).toContain('redforged')
    expect(output).toContain('keyboardforged (ok)')
    expect(output.split('\n').every((line) => line.length < 220)).toBe(true)
  })
})
