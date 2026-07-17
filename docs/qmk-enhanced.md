# Enhanced QMK/VIA keyboards

The enhanced integration adds focus-independent controls and per-Agent-key RGB
feedback to a wired QMK/VIA keyboard. It is optional; stock VIA mode does not
require firmware changes.

## Requirements

- A source tree that exactly matches the keyboard and hardware revision
- Current QMK Community Module support
- VIA/dynamic keymaps and a 32-byte Raw HID endpoint
- USB for enhanced mode; Bluetooth and 2.4 GHz Raw HID are not supported in v1
- RGB Matrix for status colors (monochrome LED Matrix feedback is not
  advertised or supported in v1)

The module discovers no vendor or product IDs and contains no Keychron-specific
code. Compatibility is determined by the Raw HID handshake and capability
bits.

## Install and configure

1. Set up a [QMK External Userspace](https://docs.qmk.fm/newbs_external_userspace)
   and retain the manufacturer's keyboard source, bootloader settings, and VIA
   definition.
2. Copy `firmware/modules/opencontrol` into
   `<QMK_USERSPACE>/modules/opencontrol`.
3. Add `"modules": ["opencontrol"]` to the keymap's `keymap.json`.
4. Set `OPENCONTROL_LAYER` in the keymap's `config.h`. It defaults to the last
   dynamic VIA layer.
5. In VIA, assign the dedicated layer:

   | Keys                                    | Assignment    |
   | --------------------------------------- | ------------- |
   | Agent 1–6                               | F13–F18       |
   | Fast, Approve, Decline, Fork, Mic, Send | F19–F24       |
   | Up, Right, Down, Left                   | Shift+F13–F16 |
   | Dial CCW, CW, Press                     | Shift+F17–F19 |

6. Compile for the exact keyboard and keymap. Inspect the resulting firmware
   size and follow the manufacturer's recovery instructions before flashing.
7. Connect over USB and run `opencontrol setup`. Confirm the specific keyboard
   shown before Raw HID input is enabled. If indistinguishable serial-less
   devices are connected, disconnect all but one and retry.
8. Run `opencontrol doctor`. A successful `HELLO_ACK` reports protocol 1, six
   Agent slots, the configured layer, and capabilities.
9. Before reporting hardware support, run `opencontrol doctor --hardware` and
   follow the guided feedback, input, hotplug, and animation-restoration checks.

The module consumes the reserved mappings only when QMK resolves the event
from `OPENCONTROL_LAYER`. F13–F24 remain normal keys elsewhere. Encoder map
entries can use shifted F17/F18 for dial rotation and Shift+F19 for dial press.

## VIA coexistence

[VIA](https://www.caniusevia.com/docs/configuring_qmk/) enables QMK's
[Raw HID](https://docs.qmk.fm/features/rawhid) endpoint, owns
`raw_hid_receive()`, and calls the weak `via_command_kb()` hook before
processing its own commands. OpenControl implements that hook by default,
consumes only reports beginning `E0 4F 43`, and returns `false` for normal VIA
reports.

If a keyboard already defines `via_command_kb()`, add
`#define OPENCONTROL_VIA_COMMAND_MANUAL` to its keymap `config.h`. Then call
`opencontrol_via_command(data, length)` first from the existing hook and return
immediately when it returns `true`; otherwise continue the existing handler.
The complete delegation shape is in the External Userspace example. Defining
both complete hooks causes a linker error and is intentionally not hidden.

Some operating systems allow only one application to open the Raw HID
interface. Close VIA while OpenControl is running if `opencontrol doctor`
reports endpoint contention. Protocol coexistence prevents packet collisions;
it cannot override an operating-system exclusive-open policy.

## RGB behavior

The host sends all six task states in one atomic packet. The module overlays
only the LEDs corresponding to F13–F18 on the configured dynamic layer and
leaves all other LEDs to the user's current QMK animation. It rescans after VIA
keymap writes and periodically while connected, so remapping an Agent key moves
its indicator without recompiling.

If no valid heartbeat arrives for five seconds, the overlay is removed. The
underlying animation was never replaced, so it becomes visible on the next RGB
frame. Status colors respect the user's RGB Matrix brightness.

## Recovery and limitations

- Enrollment matches a post-handshake fingerprint, VID/PID, and transport. It
  identifies the expected device but does not cryptographically authenticate
  it; enrolled hardware and firmware remain privileged.
- OpenControl never flashes firmware automatically and does not publish
  unverified model-specific binaries.
- Flashing firmware for the wrong revision can make a keyboard temporarily or
  permanently inaccessible. Verify the bootloader entry method and keep a
  known-good image before starting.
- If the device no longer enumerates, use the manufacturer's physical reset or
  bootloader procedure and restore the known-good image.
- A board-specific `via_command_kb()` requires the explicit delegation above.
- The first RGB Matrix position for a duplicated Agent key is used.
- v1 provides RGB Matrix colors only; monochrome LED Matrix feedback is not
  advertised or supported.
- On split keyboards, enhanced input is supported through the USB-connected
  primary half. v1 does not claim task-key RGB synchronization on the secondary
  half.

The wire format and numeric IDs are documented in
`firmware/PROTOCOL.md`; golden reports live in `firmware/tests/`.
