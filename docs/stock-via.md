# Stock VIA setup

Stock mode needs no firmware build and no vendor-specific VIA definition. It works with any keyboard whose configured keycodes reach the focused OpenControl terminal.

## Configure a layer

Keep a way to enter and leave the layer, then assign:

| Physical role                           | VIA assignment                             |
| --------------------------------------- | ------------------------------------------ |
| Agent 1–6                               | F13, F14, F15, F16, F17, F18               |
| Fast, Approve, Decline, Fork, Mic, Send | F19, F20, F21, F22, F23, F24               |
| Up, Right, Down, Left                   | Shift+F13, Shift+F14, Shift+F15, Shift+F16 |
| Dial CCW, CW, press                     | Shift+F17, Shift+F18, Shift+F19            |

These are ordinary HID keycodes. There are no custom OpenControl keycodes and no model-specific JSON files.

## Capture the terminal representation

Run:

```sh
opencontrol setup
```

If no enhanced firmware handshake is found, setup prints the mapping and asks for every control once. Keep the same terminal emulator and keyboard mode you intend to use. Enter skips a control and Ctrl+C cancels setup. Duplicate byte sequences are rejected because they would be ambiguous.

Captured bytes are stored as base64 under `inputs.terminal.bindings` in the
private OpenControl config (`~/.opencontrol/config.json` on POSIX or
`%LOCALAPPDATA%\OpenControl\config.json` on Windows). This is binary-safe and
avoids JSON escape ambiguity.

## Runtime behavior

The decoder retains a possible sequence only for `escapeTimeoutMs` (25 ms by
default), uses the longest configured match, and supports sequences split
across input chunks. Because ordinary terminal input has no key-release event,
another copy of the same control within two seconds is classified as a repeat.
Only relative focus and thinking-depth actions accept repeats; approvals,
sends, prompts, workflows, forks, and model actions require a fresh press after
the quiet interval. Any byte not belonging to a configured control is passed
to the local PTY in original order.

Stock mode is deliberately terminal-local. A key controls OpenControl only while an OpenControl terminal has focus; it does not request macOS Input Monitoring or install a global keyboard hook.

## Troubleshooting

- If an F-key reaches the agent as text, rerun setup in that exact terminal and confirm the correct VIA layer.
- If Escape feels delayed, lower `escapeTimeoutMs` cautiously. It must remain long enough for the terminal's multi-byte F-key sequence.
- If two controls collide, change one VIA assignment or terminal mapping and capture again.
- Multiplexers such as tmux may translate function-key sequences. Capture from inside the same multiplexer environment used to run agents.
- Bluetooth and 2.4 GHz work only when the operating system exposes the assigned standard keys. Enhanced Raw HID feedback remains USB-only in v1.
