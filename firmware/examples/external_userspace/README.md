<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# External Userspace integration example

This example follows QMK's
[Community Modules](https://docs.qmk.fm/features/community_modules) and
[External Userspace](https://docs.qmk.fm/newbs_external_userspace) layouts.

Copy `firmware/modules/opencontrol` to `<QMK_USERSPACE>/modules/opencontrol`.
Then merge the files below into your real path:

```text
<QMK_USERSPACE>/keyboards/<keyboard>/keymaps/<keymap>/
```

The `your_keyboard` directory is documentation, not a build target. Keep the
keyboard manufacturer's existing `keymap.c` and VIA definition. Merge the
`modules` array from `keymap.json` and the settings from `config.h`.

In VIA, map the selected layer to F13–F24 and shifted F13–F19 as described in
`firmware/PROTOCOL.md`. A layer key such as `MO(3)` must remain reachable from
another layer.

Compile with the normal External Userspace command for your exact keyboard:

```sh
qmk config user.overlay_dir=/absolute/path/to/qmk_userspace
qmk compile -kb <keyboard> -km <keymap>
```

Do not flash until the keyboard, revision, bootloader, and recovery procedure
have all been verified.
