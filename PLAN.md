# OpenControl v1 implementation scope

OpenControl extends OpenMicro's PTY, hook, multi-session, and gamepad core with capability-based QMK/VIA input and six task slots.

Implemented foundations:

- `opencontrol run`, `setup`, `doctor`, `status`, and authenticated `hook` relay commands
- six reserved task slots, unassigned overflow sessions, sticky selection, unread completion, and fallback selection
- ephemeral loopback host with a random bearer token and user-only runtime descriptor
- portable stock VIA mapping with binary-safe captured terminal sequences and longest-prefix decoding
- device-neutral controls and a VID/PID-neutral QMK Raw HID adapter
- versioned 32-byte protocol with shared firmware/host golden vectors
- GPL-2.0-or-later QMK Community Module with VIA delegation, dynamic Agent-key RGB lookup, selected pulse, and heartbeat restoration
- existing OpenMicro gamepad layers/config import and temporary executable compatibility
- sanitized diagnostics, platform host CI, portable firmware tests, and hardware documentation

The detailed runtime design is in [docs/architecture.md](docs/architecture.md). Stock and enhanced keyboard setup are in [docs/stock-via.md](docs/stock-via.md) and [docs/qmk-enhanced.md](docs/qmk-enhanced.md).

Deferred from v1:

- voice input and global keyboard capture
- desktop-window foregrounding or ChatGPT desktop integration
- automatic process launch from an empty Agent slot
- persistent project launchers and new-terminal creation
- deterministic Codex dial rotation until Codex exposes a stable effort command
- wireless Raw HID/RGB guarantees
- model-specific firmware binaries or automatic flashing

Windows and Linux hardware support remains beta until manually validated. Never claim compatibility for a specific keyboard revision solely from CI or protocol tests.
