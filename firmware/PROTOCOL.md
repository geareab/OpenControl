<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# OpenControl Raw HID protocol v1

OpenControl multiplexes its messages through VIA's existing Raw HID endpoint.
QMK Raw HID reports are exactly 32 bytes. Integers longer than one byte use
little-endian byte order.

## Packet header

| Byte | Field           | Value                              |
| ---: | --------------- | ---------------------------------- |
|    0 | Namespace       | `0xE0`                             |
|  1–2 | Magic           | ASCII `OC` (`0x4F 0x43`)           |
|    3 | Protocol major  | `0x01`                             |
|    4 | Message type    | See below                          |
|    5 | Sequence        | Sender-controlled, wraps at 255    |
|    6 | Payload length  | 0–24                               |
|    7 | Flags           | bit 0 response, bit 1 asynchronous |
| 8–31 | Payload/padding | Payload followed by zero padding   |

Packets without the namespace and magic are returned to VIA untouched. A
packet with OpenControl's namespace and magic is always consumed and receives
an error response when malformed or unsupported.

## Messages

|   Type | Name            | Direction     | Payload                                                                                                |
| -----: | --------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `0x01` | `HELLO`         | Host → device | Optional host minor version                                                                            |
| `0x02` | `HELLO_ACK`     | Device → host | Minor, capabilities LE16, agent count, control count, report size, configured layer, heartbeat seconds |
| `0x03` | `CONTROL_EVENT` | Device → host | Control, phase, row, column, QMK event type, layer, timestamp LE32                                     |
| `0x04` | `TASK_STATES`   | Host → device | Selected agent, six states, unread bit mask                                                            |
| `0x05` | `PING`          | Host → device | Opaque optional data                                                                                   |
| `0x06` | `ACK`           | Either        | Acknowledged message type and sequence                                                                 |
| `0x7F` | `ERROR`         | Device → host | Error code, offending type, detail                                                                     |

The selected agent is zero-based (`0`–`5`) or `0xFF` for none. A
`TASK_STATES` message is acknowledged only after the complete state vector has
been validated and installed.

The host derives a cadence below the timeout advertised by `HELLO_ACK`.
`TASK_STATES` is resent on every heartbeat once feedback exists; otherwise the
host sends `PING`. Missing acknowledgements are retried twice with the original
type and sequence before the host reconnects.

Input and feedback liveness are independent. `HELLO`, `PING`, and
`TASK_STATES` keep semantic input active, while only a fully validated
`TASK_STATES` frame activates or refreshes the RGB overlay. After feedback
times out, `HELLO` or `PING` cannot paint a zero-state overlay over the user's
normal QMK animation.

## Capabilities

| Bit | Meaning                     |
| --: | --------------------------- |
|   0 | Press and release events    |
|   1 | RGB Matrix present          |
|   2 | Reserved                    |
|   3 | Encoder Map support enabled |
|   4 | USB Raw HID transport       |
|   5 | VIA dynamic keymap          |

Early preview firmware used bit 2 to report LED Matrix presence. Protocol-v1
hosts ignore it because the public feedback capability means the six-color RGB
overlay; monochrome feedback is not implemented in v1.

## Control IDs and default VIA keycodes

| Keycode on `OPENCONTROL_LAYER` | Control IDs                                            |
| ------------------------------ | ------------------------------------------------------ |
| F13–F18                        | `0x01`–`0x06`, Agent 1–6                               |
| F19–F24                        | `0x10`–`0x15`, Fast, Approve, Decline, Fork, Mic, Send |
| Shift+F13–Shift+F16            | `0x20`–`0x23`, Up, Right, Down, Left                   |
| Shift+F17–Shift+F19            | `0x30`–`0x32`, Dial CCW, CW, Press                     |

The module suppresses these keycodes only when QMK resolves their source to
`OPENCONTROL_LAYER`. The same keycodes on normal layers remain regular keys.
Both press and release are emitted; an unexpected duplicate press is emitted
as phase `0x03` (repeat).

## Task states

|  Value | State               | RGB   |
| -----: | ------------------- | ----- |
| `0x00` | Off/unassigned      | Off   |
| `0x01` | Idle                | White |
| `0x02` | Executing           | Blue  |
| `0x03` | Waiting for input   | Amber |
| `0x04` | Complete and unread | Green |
| `0x05` | Error               | Red   |

If a complete slot is not marked in the unread bit mask, it renders as idle.
The selected assigned slot pulses locally. F13–F18 are rescanned from the VIA
dynamic keymap, so moving an Agent key also moves its RGB overlay. When an
Agent key appears more than once, the first matrix position with an LED wins.
