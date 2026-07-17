<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Firmware tests

These checks require only Node.js and a C11 compiler:

```sh
node firmware/tests/validate_vectors.mjs
cc -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  -fsyntax-only firmware/tests/module_syntax_test.c
cc -std=c11 -Wall -Wextra -Werror \
  -DOPENCONTROL_TEST_RGB -DOPENCONTROL_TEST_LED -DOPENCONTROL_TEST_ENCODER \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  -fsyntax-only firmware/tests/module_syntax_test.c
cc -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  firmware/tests/module_behavior_test.c -o /tmp/opencontrol-firmware-test
/tmp/opencontrol-firmware-test
```

`protocol_vectors.json` contains complete 32-byte reports shared with host-side
tests. The C API shim is deliberately small: it catches portable C errors and
conditional-compilation mistakes and exercises task colors, selected pulse,
VIA Agent-key remapping, and heartbeat restoration, but does not replace compiling the module
against the pinned QMK version for a real AVR or ARM keyboard.
