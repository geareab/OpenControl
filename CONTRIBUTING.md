# Contributing to OpenControl

OpenControl has an MIT host application and an optional GPL-2.0-or-later QMK module. Keep those source trees and license headers separate when contributing.

Security vulnerabilities must be reported privately through the repository's
GitHub Security Advisory form, not through a public issue or pull request. See
[SECURITY.md](SECURITY.md) for scope, response targets, and safe harbor.

## Start locally

```sh
git clone <your-fork-url> OpenControl
cd OpenControl
node scripts/bootstrap-reviewed-npm.mjs
npm ci --ignore-scripts
npm audit signatures
npm run security:rebuild
npm run verify
npm run test:firmware
npm run build
```

Use a patched Node.js `22.x` (`22.23.1` or newer) or `24.x` (`24.18.0` or
newer), plus npm `11.16.0` or newer within npm 11. The bootstrap replaces only
an unsupported active npm and verifies the downloaded tarball against the
repository-pinned SHA-512 digest. Host CI targets macOS, Windows, and Linux.
Enhanced keyboard support is USB-first and must not be described as
hardware-verified unless it was tested on the exact keyboard revision.

The bootstrap never needs `sudo`; it falls back to the current user's
`~/.local` prefix when the system npm prefix is read-only. It deliberately does
not replace an unsupported Node.js runtime.

## Report a keyboard

Run:

```sh
opencontrol doctor
```

Attach `opencontrol-doctor.json` to an issue. The report is intentionally sanitized: it does not include terminal sequences, prompts, tokens, serial numbers, device paths, project directories, or environment variables. State whether you tested stock VIA or enhanced firmware, connection type, QMK revision, RGB Matrix support, and what was physically verified.

Do not submit or request unverified firmware binaries. Recovery and exact-revision details belong in every hardware report involving a custom build.

## Host changes

- Keep physical input behind semantic `ControlEvent` IDs. Agent slots are stable and cannot become user-remappable commands.
- Preserve local typing: unrecognized terminal bytes must go only to that terminal's PTY.
- Register task slots before spawning an agent process.
- Authenticate every local host endpoint; never reintroduce a fixed unauthenticated port or shell `curl` hooks.
- Return `null` for unsupported harness actions. Do not guess CLI sequences.
- Add tests for malformed input, partial byte sequences, lifecycle cleanup, and cross-session routing.

A new agent harness implements `Harness` in `src/harness/`, cites the CLI behavior it relies on, and tests every supported and intentionally unsupported action.

## QMK module changes

Firmware changes live under `firmware/` and use GPL-2.0-or-later headers. Follow QMK Community Module and External Userspace conventions; do not add model-specific VID/PID matching.

Any wire-format change must update all of these together:

- `firmware/PROTOCOL.md`
- `firmware/tests/protocol_vectors.json`
- firmware behavior/header tests
- host codec and adapter tests

The host protocol tests consume the firmware vector file directly so drift fails CI. Before submitting, run the portable checks documented in `firmware/tests/README.md`. If QMK toolchains are available, also compile representative AVR and ARM targets against the supported pinned release and current QMK master.

## Gamepad fixtures

Legacy gamepad support remains part of OpenControl. Use the controller fixture workflow documented in [CONTROLLERS.md](CONTROLLERS.md). New drivers should keep report parsing pure and include captured regression fixtures. Never include Bluetooth addresses or unrelated HID paths in fixtures.

## Pull requests

- Keep changes focused and preserve unrelated user configuration and hardware behavior.
- Run `npm run verify`, `npm run test:firmware`, and `npm run build`.
- State which checks were automated and which hardware behavior was physically tested.
- Call out protocol, configuration-schema, hook, security, or license changes explicitly.
- New runtime dependencies need a clear justification.
- Dependency and GitHub Actions updates must retain exact version or full-commit
  pins and pass the dependency, signature, license, package-content, and SBOM
  checks.

By contributing host code, you agree it is MIT licensed. By contributing under `firmware/`, you agree it is GPL-2.0-or-later.
