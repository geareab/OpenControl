# Firmware source

The custom binary is GPL-2.0-or-later. The bundle's `source/` directory
contains:

- the OpenControl module source;
- the complete custom keymap and build configuration;
- the small adapter patch applied to Keychron's existing VIA and RGB hooks;
- copies of the two patched Keychron source files;
- Keychron/QMK's GPLv2 license; and
- the exact QMK and submodule revisions used for the build.

The unmodified base is Keychron's `qmk_firmware` repository,
`bluetooth_playground` commit
`618127a725a1773e85f13455602cf6f72ab4de17`. Applying
`keychron-opencontrol.patch`, adding the supplied keymap, and adding the
supplied OpenControl module reconstructs the source used for the custom
binary.

The build uses `SKIP_VERSION=yes` so QMK's generated build timestamp is fixed.
The real source and toolchain revisions remain recorded in `manifest.json`.
