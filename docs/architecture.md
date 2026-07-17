# Architecture

OpenControl separates physical input, semantic intent, task ownership, and agent-specific terminal sequences.

```text
                                      ┌─ Codex harness ─ selected PTY
terminal / QMK / gamepad ─ controls ─ router
                                      └─ Claude harness ─ selected PTY
                                               │
agent hooks ─ authenticated host ─ task slots ─┴─ feedback adapters
```

## Process model

Every `opencontrol run` invocation owns exactly one child PTY. The user's terminal input is attached directly to that local PTY. Only bytes recognized as captured stock VIA controls are removed and relayed to the host.

The first wrapper acquires a per-user runtime lease, binds an ephemeral `127.0.0.1` port, and atomically publishes a descriptor containing the port and a random bearer token. The descriptor and lock use owner-only permissions on POSIX platforms. Later wrappers authenticate, reserve their task slot, then spawn their PTY and attach an authenticated event stream.

All HTTP surfaces—health, registration, hooks, controls, status, and streams—require the bearer token. Hook requests also carry the active wrapper ID. Stale descriptors are removed only after their authenticated health probe fails.

## Input boundary

`ControlEvent` contains a stable control ID, `press`/`release`/`repeat` phase, source ID, and timestamp. Terminal and QMK adapters expose the same IDs:

- `agent.1`–`agent.6`
- `command.fast`, `approve`, `decline`, `fork`, `mic`, `send`
- `nav.up`, `right`, `down`, `left`
- `dial.ccw`, `cw`, `press`

The Raw HID adapter matches the standard QMK interface and requires a valid HELLO handshake. VID/PID is retained only as diagnostic metadata and never drives compatibility. The legacy gamepad router remains action-based to preserve existing six-layer configurations.

## Task state

The host owns six hardware slots plus an unassigned overflow list. A task record contains wrapper identity, display name, harness, directory, process ID, lifecycle state, slot, selection, unread state, and hook session identity.

Selection changes only through Agent controls, relative task controls, or selected-process exit. Hooks change lifecycle state but do not steal selection. Completion remains unread until that slot's Agent control is pressed.

## Feedback

The host converts the complete task registry into one six-slot feedback frame. Enhanced QMK firmware installs the frame atomically, generates the selected pulse locally, and overlays only Agent-key LEDs after normal RGB rendering. The gamepad path maps the selected task to the existing DualSense lightbar and occupied slots to player LEDs.

The wire protocol is specified by [`firmware/PROTOCOL.md`](../firmware/PROTOCOL.md). Host tests read the same golden vector file used by firmware tests.

## Trust boundaries

- OpenControl does not capture global keyboard input.
- Ordinary typing never crosses task sessions.
- Runtime tokens are not written to logs or diagnostics.
- Hardware reports omit terminal bytes, prompts, paths, serials, environment variables, and other secrets.
- Enhanced firmware never accepts commands outside its `E0 4F 43` namespace and delegates all other packets to VIA.
- OpenControl never flashes a keyboard.
- Processes running as the same operating-system user are inside the trust
  boundary. The bearer token protects the local interface from accidental or
  cross-user access; it is not a sandbox against a hostile same-user process.
- Device enrollment identifies an expected transport and observable device
  fingerprint. It is not cryptographic authentication. Enrolled hardware,
  firmware, and software capable of emulating that hardware are privileged.

Configuration, runtime descriptors, hooks, logs, and diagnostic reports reject
symbolic links and unsafe file types. POSIX directories and files are kept at
owner-only permissions; Windows data is placed under the current user's
`%LOCALAPPDATA%\OpenControl` profile directory and relies on its ACL. Windows
runtime-path overrides must remain below that trusted directory. POSIX custom
runtime paths reject ancestor directories that permit non-sticky cross-user
renames.

Runtime locks and descriptors carry a process-incarnation identity in addition
to the PID. Linux derives that identity from the boot ID and kernel process
start ticks; other platforms use an authenticated random process identity.
PID-only locks from older versions are still honored during a 30-second startup
window, but an aged lock without a matching authenticated descriptor is
reclaimed rather than trusting a potentially reused PID indefinitely.
Stale descriptor cleanup first moves the exact file to a private randomized
quarantine and verifies its identity before deletion, restoring a concurrently
published replacement instead of unlinking it.
