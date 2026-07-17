# Experimental Keychron K4 Pro K4P-H3 target

This reproducible target is only for the Keychron K4 Pro `K4P-H3`: US ANSI,
hot-swappable RGB, STM32L432, USB `3434:0240`. It is prepared from Keychron's
`bluetooth_playground` source at commit
`618127a725a1773e85f13455602cf6f72ab4de17`.

It remains experimental. A build from the pinned source passed handshake,
control, RGB overlay, heartbeat restoration, and hot-plug acceptance checks on
one exact K4P-H3 unit on Linux on 2026-07-17. That result is not a general
compatibility claim. Building this target does not touch a keyboard. Do not use
the artifact for another K4 Pro layout, lighting variant, or hardware revision.

The top-right Lock key toggles a dedicated fifth layer. All other keys are
transparent on that layer except:

| Key                    | OpenControl action        |
| ---------------------- | ------------------------- |
| Numpad 1–6             | Agents 1–6                |
| Numpad 7 / 8 / 9       | Fast / Approve / Decline  |
| Numpad `/` / `0` / `.` | Fork / Mic / Send         |
| Numpad `+` / `-` / `*` | Plan / Next task / Skills |
| Num Lock               | Previous task             |
| PgDn / PgUp            | Reasoning down / up       |
| Numpad Enter           | Model picker              |

Only Numpad 1–6 receive task-state color overlays. OpenControl Raw HID and
feedback are gated to USB mode; Bluetooth and Keychron's VIA, factory, and
Bluetooth-DFU handlers remain in place.

Run `npm run prepare:firmware:k4p-h3` to build an untouched Keychron VIA
baseline and two clean OpenControl builds in the pinned container. The command
creates an ignored local bundle under `dist/firmware/k4p-h3/`. It contains no
flashing command and passes no USB device into the build container.
