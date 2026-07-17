# OpenControl

OpenControl turns a QMK/VIA keyboard or gamepad into a six-task control surface for Codex CLI and Claude Code. It keeps each agent in its own terminal PTY, routes hardware actions only to the selected task, and shows live task state on enhanced QMK RGB keyboards.

OpenControl is a capability-based evolution of [OpenMicro](https://github.com/stephenleo/OpenMicro). Existing OpenMicro gamepad configurations and the `openmicro` executable remain supported during the v0.2 compatibility release.

## Architecture

```text
Stock VIA layer ── terminal sequences ─┐
Enhanced QMK ───── Raw HID v1 ─────────┼─ semantic controls ─ task/action router ─ selected agent PTY
Gamepad ────────── legacy HID layers ──┘                                      │
                                                                               │
Codex / Claude hooks ─ authenticated local host ─ task state ─ RGB/gamepad ────┘
```

The first wrapper starts an ephemeral loopback host. Later wrappers authenticate through a user-only runtime descriptor and reserve a task slot before their CLI process starts. There is no global keyboard listener, fixed unauthenticated port, or macOS Input Monitoring requirement.

See the [architecture and trust-boundary details](docs/architecture.md).

## Install from this repository

OpenControl is currently distributed from this GitHub source repository only.
The unscoped `opencontrol` package name on npm belongs to another project; do
not install it expecting this code.

Requirements: a current patched Node.js `22.x` (`22.23.1` or newer) or `24.x`
(`24.18.0` or newer), npm `11.16.0` or newer within npm 11, and Codex CLI
and/or Claude Code on `PATH`. Node 22's bundled npm is too old to enforce this
repository's dependency lifecycle-script allowlist.

```sh
node scripts/bootstrap-reviewed-npm.mjs
npm ci --ignore-scripts
npm audit signatures
npm run security:rebuild
npm run build
npm link
opencontrol setup
```

The bootstrap installs a checksum-pinned npm `11.16.0` only when the active npm
is outside the supported npm 11 range. Dependencies are first installed without
lifecycle scripts, their registry signatures are checked, and only the four
exact packages listed in `allowScripts` are then rebuilt.

The bootstrap does not require `sudo`: if the system-wide npm directory is
read-only, it installs npm under the current user's `~/.local` directory. It
does not install Node.js itself, so upgrade an older Node.js runtime first.

Run agents in separate terminal tabs or windows:

```sh
opencontrol run codex --slot 1 --name api -- --model gpt-5
opencontrol run claude --slot 2 --name frontend -- --permission-mode default
```

Agent arguments must follow `--` in the explicit `run` form. The compatibility forms `opencontrol codex ...`, `opencontrol claude ...`, and `openmicro ...` are also available for this minor release.

Useful commands:

```sh
opencontrol setup
opencontrol status
opencontrol doctor
opencontrol doctor --hardware
opencontrol doctor --gamepad
opencontrol --help
```

`status` shows all six slots, selection, state, agent, directory, overflow tasks, and connected devices. The default `doctor` command is noninteractive and checks terminal bindings, the enhanced QMK handshake and capabilities, selected-task routing, authenticated hook delivery, gamepad discovery, hook installation, and endpoint contention. `doctor --hardware` adds guided checks for Raw HID feedback acknowledgement, press/release input, hotplug recovery, all six task states, selected-key pulse, and heartbeat-timeout restoration. Its `opencontrol-doctor.json` output records which checks were performed, skipped, passed, or failed while omitting prompts, tokens, serial numbers, device paths, working directories, environment variables, and other secrets. Reports never overwrite an existing path unless `--overwrite` is supplied, and symbolic links are always refused. `doctor --gamepad` retains OpenMicro's interactive raw controller-fixture workflow.

## Security model

The host listens only on loopback and authenticates every route with a random
bearer token stored in private per-user files. OpenControl does not attempt to
sandbox hostile processes running as the same operating-system user; those
processes are inside its trust boundary.

Hardware enrollment identifies an expected device but is not cryptographic
device authentication. Enrolled hardware, its firmware, and software able to
emulate it are privileged inputs. Report suspected vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

## Stock QMK/VIA mode

Stock mode works without custom firmware. In VIA, make a dedicated layer and assign portable standard keycodes:

| Controls                                 | VIA keycodes  |
| ---------------------------------------- | ------------- |
| Agent 1–6                                | F13–F18       |
| Fast, Approve, Decline, Fork, Mic, Send  | F19–F24       |
| Up, Right, Down, Left                    | Shift+F13–F16 |
| Dial counter-clockwise, clockwise, press | Shift+F17–F19 |

Run `opencontrol setup` with that terminal focused. It captures the actual byte sequence emitted by every key, including chunked escape sequences, and stores it as base64 in the private OpenControl config (`~/.opencontrol/config.json` on POSIX or `%LOCALAPPDATA%\OpenControl\config.json` on Windows). The runtime uses longest-prefix decoding with an Escape timeout. Recognized controls go to the task host; all other input goes directly to the agent in the visible terminal.

Because stock mode reads only the wrapped terminal, it works over USB, Bluetooth, or 2.4 GHz whenever the operating system delivers those keycodes to that terminal. It cannot control an agent while another application has keyboard focus.

See the [stock VIA setup and terminal troubleshooting guide](docs/stock-via.md).

## Enhanced QMK mode

Enhanced mode adds USB Raw HID controls and task-key RGB feedback. Initial
compatibility discovery requires QMK's standard Raw HID usage page `0xFF60`,
usage `0x61`, followed by a successful OpenControl protocol handshake; VID/PID
alone never establishes compatibility. Setup then asks you to confirm one
specific device and records its fingerprint, VID/PID, and transport for future
connections. Ambiguous serial-less devices are refused.

The optional GPL-2.0-or-later Community Module is in [`firmware/modules/opencontrol`](firmware/modules/opencontrol). See:

- [Enhanced QMK integration, VIA coexistence, and recovery](docs/qmk-enhanced.md)
- [Raw HID protocol v1](firmware/PROTOCOL.md)
- [External Userspace example](firmware/examples/external_userspace/README.md)
- [Experimental Keychron K4 Pro K4P-H3 source target](firmware/targets/keychron_k4_pro_ansi_rgb/README.md)

OpenControl does not flash keyboards and does not ship model-specific binaries.
The K4P-H3 source target passed the documented acceptance checks on one exact
US ANSI RGB unit on Linux; it remains experimental and is not a compatibility
claim for other units or revisions. Build only against the exact keyboard
revision and keep a known-good recovery image.

## Tasks and feedback

Explicit occupied slots fail before the agent PTY starts. With no `--slot`, the first free slot is assigned. A seventh or later process still runs normally but has no hardware Agent key.

Selection is sticky. Agent keys select a slot; Right and Left select the next or previous occupied slot. When the selected process exits, fallback priority is waiting, executing, then the lowest occupied slot. Pressing a completed Agent key clears its unread state.

| State                                     | Enhanced Agent-key color |
| ----------------------------------------- | ------------------------ |
| Unassigned                                | Off                      |
| Idle                                      | White                    |
| Executing                                 | Blue                     |
| Waiting for approval/input                | Amber                    |
| Completed, unread                         | Green                    |
| Agent, process, hook, or protocol failure | Red                      |

The selected assigned key pulses locally in firmware. Only Agent-key LEDs are overlaid; the rest of the user's RGB Matrix animation is preserved. If heartbeats stop for five seconds, the overlay disappears and the normal animation is visible again.

## Default actions

| Control        | Codex CLI                   | Claude Code                   |
| -------------- | --------------------------- | ----------------------------- |
| Fast           | `/fast`                     | `/fast`                       |
| Approve / Send | Enter                       | Enter                         |
| Decline        | Escape                      | Escape                        |
| Fork           | `/fork`                     | `/branch`                     |
| Mic            | Unsupported                 | Unsupported                   |
| Up             | `/plan`                     | `/plan`                       |
| Right / Left   | Select next / previous task | Select next / previous task   |
| Down           | `/skills`                   | `/skills`                     |
| Dial turn      | Unsupported                 | Step through `/effort` levels |
| Dial press     | `/model`                    | `/model`                      |

Unsupported actions write one concise diagnostic to the private OpenControl log
and send no guessed terminal input. Logs redact credentials and action payloads,
suppress repeated errors, and rotate at 1 MiB with one backup. Semantic command,
navigation, and dial bindings can be changed to workflow prompts, literal
prompts, or advanced raw key sequences in the versioned config. Agent controls
are always reserved for task selection.

## Configuration and migration

OpenControl creates a private config with `schemaVersion: 2`. QMK and gamepad
input are disabled until `opencontrol setup` interactively confirms a device;
generic HID gamepads require a second explicit opt-in. The main sections are:

- `inputs.terminal`: captured stock VIA sequences and prefix timeout
- `inputs.qmk`: enabled state and enrolled enhanced-keyboard identity
- `inputs.gamepad`: enabled state and enrolled controller identity
- `controls`: semantic keyboard actions
- `layers`: six existing gamepad layers
- `workflows`: named prompt templates

An enrolled-device record contains a SHA-256 fingerprint, VID/PID, transport,
bounded display label, and generic-device flag. It never stores a raw HID path.
Enrollment is identification, not cryptographic authentication.

On first run, a valid `~/.openmicro/config.json` is imported atomically. Existing
schema-v1 bindings, layers, and workflows are migrated, but QMK and gamepad
input are disabled and must be re-enrolled. The old file is never modified.
Configuration errors stop startup without overwriting the user's file.

For example, a command control can run a reusable prompt workflow and a navigation control can emit an advanced terminal sequence:

```json
{
  "controls": {
    "command.fast": { "type": "workflow", "presetId": "ship-check" },
    "nav.up": { "type": "keys", "bytes": "\u001b[A" }
  },
  "workflows": {
    "ship-check": "Review the current changes, run the relevant tests, and report release blockers."
  }
}
```

Merge these fields into the generated versioned file rather than replacing its required `inputs` and six `layers` entries.

## Compatibility

Compatibility is based on capabilities, not a model whitelist.

| Mode               | Required capabilities                                          | Transport                  | Feedback                       |
| ------------------ | -------------------------------------------------------------- | -------------------------- | ------------------------------ |
| Stock VIA          | OS delivers captured F13–F24 sequences to the focused terminal | USB, Bluetooth, or 2.4 GHz | None                           |
| Enhanced QMK input | VIA + 32-byte Raw HID + protocol v1 module                     | USB in v1                  | Optional                       |
| Enhanced QMK RGB   | Enhanced input + RGB Matrix + LED mapping                      | USB in v1                  | Six task colors and pulse      |
| Gamepad            | Supported HID report parser                                    | Device-dependent           | DualSense lightbar/player LEDs |

Community-tested gamepads and legacy fixture contribution instructions remain in [CONTROLLERS.md](CONTROLLERS.md).

For split keyboards, enhanced input is supported through the USB-connected primary half. Synchronizing the six-key RGB overlay to LEDs on the secondary half is not supported in v1 and must not be inferred from a successful handshake.

Host CI runs on macOS, Windows, and Linux. Physical Windows and Linux keyboard
support remains beta until it is manually validated; support for any exact
keyboard revision must not be claimed until the hardware acceptance checks pass.

## Development

```sh
npm run verify
npm run test:firmware
npm run build
npm run verify:release
```

Host tests cover terminal-prefix decoding, task allocation and fallback, authenticated hooks and spoof rejection, SSE routing, harness mappings, config migration, and Raw HID golden vectors. Firmware tests cover packet fixtures, conditional compilation, routing, heartbeat timeout, and RGB behavior. Physical hardware acceptance is still required before claiming support for a specific keyboard revision.

The host is MIT licensed. The optional QMK module and examples are GPL-2.0-or-later. See [NOTICE](NOTICE) for OpenMicro attribution.
