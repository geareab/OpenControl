<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# OpenControl QMK firmware

This directory contains the optional enhanced firmware integration for
OpenControl. It is device-neutral: any QMK keyboard with VIA and a 32-byte Raw
HID endpoint can use the module. RGB task feedback additionally requires QMK
RGB Matrix and a matrix-to-LED mapping.
Monochrome LED Matrix feedback is not advertised or supported in protocol v1.

Encoder capability is advertised only when QMK Encoder Map is enabled, because
the standard F13–F24 mapping must be available to translate encoder actions.
On split keyboards, Raw HID input and RGB feedback apply to the USB primary
half; v1 does not advertise or synchronize secondary-half RGB feedback.

The module does not flash a keyboard and this repository does not distribute
model-specific firmware binaries. Build it against the exact QMK source and
keyboard revision supplied by the keyboard manufacturer.

- `modules/opencontrol/` — QMK Community Module
- `examples/external_userspace/` — files to merge into an External Userspace
- `PROTOCOL.md` — Raw HID protocol v1
- `tests/` — host-independent golden packet validation

The firmware files are licensed under GPL-2.0-or-later. The host application
is licensed separately.
