# Controller compatibility

OpenControl preserves OpenMicro input from DualSense, DualShock 4, and wired Xbox gamepads, with a best-effort fallback for generic HID layouts. DualSense also supports lightbar and player-LED feedback; other controllers are input-only.

## Community-tested controllers

Every controller below has a committed legacy OpenMicro controller report. CI replays captured inputs through the matching parser on every change.

<!-- controllers:start -->

| Controller                    | VID:PID   | Connection | Driver    | Buttons passed | Output        | Status  |
| ----------------------------- | --------- | ---------- | --------- | -------------- | ------------- | ------- |
| DualSense Wireless Controller | 054c:0ce6 | usb        | dualsense | 17/17          | lightbar+LEDs | ✅ full |
| Xbox Wireless Controller      | 045e:0b12 | usb        | xbox      | 4/4            | none          | ✅ full |

<!-- controllers:end -->

## Test your controller

The OpenControl doctor generates a sanitized system report without raw controller captures:

```sh
opencontrol doctor
```

For a new legacy gamepad parser, run `opencontrol doctor --gamepad` and add the generated `<vid>-<pid>-<transport>.json` to `test/fixtures/controllers/`. Run `npm run gen:controllers` to refresh this page.

Keyboard compatibility is capability-based and documented in the main README rather than listed by model.
