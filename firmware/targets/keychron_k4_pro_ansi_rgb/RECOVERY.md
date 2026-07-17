# K4P-H3 recovery reference

The included factory binary is the official Keychron K4 Pro US ANSI RGB
firmware downloaded from Keychron's recovery page. Its checksum is recorded in
`SHA256SUMS` and `manifest.json`.

No recovery or flashing action was performed while preparing this bundle. The
bundle intentionally contains no flashing command or automation.

If a separately reviewed flash phase is approved later:

1. Reconfirm the underside label is `K4P-H3`, the layout is US ANSI, and the
   keyboard has RGB backlighting.
2. Keep this factory binary and the bundle checksums available before changing
   the keyboard.
3. Follow Keychron's official K4 Pro factory-reset and firmware-recovery page,
   including its model-selection and cable requirements:
   <https://keychron.be/pages/how-to-factory-reset-and-flash-firmware-for-your-k4-pro-keyboard>
4. Stop if the updater, USB identity, MCU, layout, or file name does not match
   the manifest.

Keychron warns that installing the wrong firmware can damage the keyboard.
OpenControl enrollment identifies hardware; it does not cryptographically
authenticate the keyboard or its firmware.
