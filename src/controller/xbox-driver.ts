// Xbox Series wired-USB report parsing.
// Ported from the v1 extension (src/extension/hid/xbox-driver.ts in git history).

import type { ButtonId, ControllerEvent } from '../types.js'

export const XBOX_VID = 0x045e
export const XBOX_PIDS = [0x0b12, 0x0b13, 0x02fd, 0x02e0]

/** Normalize a signed 16-bit stick value to -1.0..1.0. */
function normalizeAxis(raw: number): number {
  const clamped = Math.max(-32768, Math.min(32767, raw))
  return clamped < 0 ? clamped / 32768 : clamped / 32767
}

/**
 * Parse an Xbox Series USB HID report (64 bytes) into ControllerEvents.
 * Byte 1: system buttons, byte 2: face buttons, byte 3: dpad,
 * bytes 4-7: triggers (16-bit LE, 0-1023), bytes 8-15: sticks (int16 LE).
 * Exact layout varies by firmware; this matches the common wired layout.
 */
export function parseXboxReport(data: Buffer): ControllerEvent[] {
  const events: ControllerEvent[] = []
  if (data.length < 16) return events

  const face = data[2]!
  const faceMap: Array<[number, ButtonId]> = [
    [0x01, 'south'],
    [0x02, 'east'],
    [0x04, 'west'],
    [0x08, 'north'],
  ]
  for (const [bit, id] of faceMap) {
    events.push({ kind: 'button', button: id, pressed: (face & bit) !== 0 })
  }

  const sys = data[1]!
  const sysMap: Array<[number, ButtonId]> = [
    [0x01, 'l1'],
    [0x02, 'r1'],
    [0x04, 'menu'],
    [0x08, 'view'],
    [0x10, 'l3'],
    [0x20, 'r3'],
  ]
  for (const [bit, id] of sysMap) {
    events.push({ kind: 'button', button: id, pressed: (sys & bit) !== 0 })
  }

  // D-pad is a rotary hat value 1-8 clockwise from north (0 = released).
  const dpad = data[3]!
  events.push({
    kind: 'button',
    button: 'dpad_up',
    pressed: dpad === 1 || dpad === 2 || dpad === 8,
  })
  events.push({ kind: 'button', button: 'dpad_right', pressed: dpad >= 2 && dpad <= 4 })
  events.push({ kind: 'button', button: 'dpad_down', pressed: dpad >= 4 && dpad <= 6 })
  events.push({ kind: 'button', button: 'dpad_left', pressed: dpad >= 6 && dpad <= 8 })

  const lt = ((data[5]! << 8) | data[4]!) / 1023
  const rt = ((data[7]! << 8) | data[6]!) / 1023
  events.push({ kind: 'axis', axis: 'l2', value: Math.max(0, Math.min(1, lt)) })
  events.push({ kind: 'axis', axis: 'r2', value: Math.max(0, Math.min(1, rt)) })
  events.push({ kind: 'button', button: 'l2', pressed: lt > 0.5 })
  events.push({ kind: 'button', button: 'r2', pressed: rt > 0.5 })

  events.push({ kind: 'axis', axis: 'left_x', value: normalizeAxis(data.readInt16LE(8)) })
  events.push({ kind: 'axis', axis: 'left_y', value: normalizeAxis(data.readInt16LE(10)) })
  events.push({ kind: 'axis', axis: 'right_x', value: normalizeAxis(data.readInt16LE(12)) })
  events.push({ kind: 'axis', axis: 'right_y', value: normalizeAxis(data.readInt16LE(14)) })

  return events
}
