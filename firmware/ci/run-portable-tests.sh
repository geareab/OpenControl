#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cc_bin="${CC:-cc}"
test_binary="$(mktemp "${TMPDIR:-/tmp}/opencontrol-firmware-test.XXXXXX")"
trap 'rm -f "$test_binary"' EXIT

cd "$repo_root"

node firmware/tests/validate_vectors.mjs

"$cc_bin" -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  firmware/tests/protocol_header_test.c -o /dev/null

"$cc_bin" -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  -fsyntax-only firmware/tests/module_syntax_test.c

"$cc_bin" -std=c11 -Wall -Wextra -Werror \
  -DOPENCONTROL_TEST_RGB -DOPENCONTROL_TEST_LED -DOPENCONTROL_TEST_ENCODER \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  -fsyntax-only firmware/tests/module_syntax_test.c

"$cc_bin" -std=c11 -Wall -Wextra -Werror \
  -DOPENCONTROL_LEGACY_QMK -DOPENCONTROL_VIA_COMMAND_MANUAL \
  -DOPENCONTROL_TEST_RGB \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  -fsyntax-only firmware/tests/module_syntax_test.c

"$cc_bin" -std=c11 -Wall -Wextra -Werror \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  firmware/tests/module_behavior_test.c -o "$test_binary"

"$test_binary"

# LED Matrix presence alone must not advertise functional status feedback: v1
# defines six RGB colors and intentionally has no monochrome renderer.
"$cc_bin" -std=c11 -Wall -Wextra -Werror \
  -DOPENCONTROL_TEST_LED \
  -Ifirmware/tests -Ifirmware/tests/stubs -Ifirmware/modules/opencontrol \
  firmware/tests/module_behavior_test.c -o "$test_binary"

"$test_binary" >/dev/null
