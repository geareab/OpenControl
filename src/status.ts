import type { HostStatus } from './server.js'
import { sanitizeTerminalText } from './terminal-sanitize.js'

export function formatHostStatus(status: HostStatus): string {
  const lines = [
    `OpenControl host ${status.pid} · port ${status.port}`,
    '',
    'Slot  Task                  Agent   State        Directory',
  ]
  for (let index = 0; index < status.tasks.slots.length; index += 1) {
    const task = status.tasks.slots[index]
    const slot = index + 1
    if (!task) {
      lines.push(`  ${slot}   —                     —       off          —`)
      continue
    }
    const marker = task.selected ? '*' : ' '
    const unread = task.unread ? ' •' : ''
    const taskState =
      task.connectionState === 'reconnecting' ? `${task.state}/reconnecting` : task.state
    const name = sanitizeTerminalText(String(task.name), 20)
    const kind = sanitizeTerminalText(String(task.kind), 7)
    const state = sanitizeTerminalText(`${taskState}${unread}`, 24)
    const cwd = sanitizeTerminalText(String(task.cwd), 120)
    lines.push(
      `${marker} ${slot}   ${name.padEnd(20)}  ${kind.padEnd(7)} ${state.padEnd(12)} ${cwd}`,
    )
  }
  if (status.tasks.unassigned.length > 0) {
    lines.push('', 'Unassigned (all six hardware slots are occupied):')
    for (const task of status.tasks.unassigned) {
      lines.push(
        `  ${sanitizeTerminalText(String(task.name), 40)} · ${sanitizeTerminalText(String(task.kind), 20)} · ${sanitizeTerminalText(String(task.state), 24)} · ${sanitizeTerminalText(String(task.cwd), 120)}`,
      )
    }
  }
  lines.push(
    '',
    `Devices: ${status.devices.length > 0 ? status.devices.map(describeDevice).join(', ') : 'none'}`,
  )
  return lines.join('\n')
}

function describeDevice(device: unknown): string {
  if (typeof device === 'string') return sanitizeTerminalText(device, 80)
  if (!device || typeof device !== 'object') return 'unknown'
  const value = device as {
    adapterId?: unknown
    product?: unknown
    deviceId?: unknown
    health?: unknown
  }
  const name =
    typeof value.product === 'string'
      ? value.product
      : typeof value.adapterId === 'string'
        ? value.adapterId
        : typeof value.deviceId === 'string'
          ? value.deviceId
          : null
  if (name) {
    const safeName = sanitizeTerminalText(name, 80)
    return typeof value.health === 'string'
      ? `${safeName} (${sanitizeTerminalText(value.health, 24)})`
      : safeName
  }
  return 'unknown'
}
