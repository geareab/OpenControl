// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#define DYNAMIC_KEYMAP_LAYER_COUNT 4
#include "opencontrol.h"

_Static_assert(OPENCONTROL_REPORT_SIZE == 32, "QMK Raw HID reports must be 32 bytes");
_Static_assert(OPENCONTROL_HEADER_SIZE + OPENCONTROL_MAX_PAYLOAD == OPENCONTROL_REPORT_SIZE, "payload calculation");
_Static_assert(OPENCONTROL_NAMESPACE == 0xE0, "wire namespace");
_Static_assert(OPENCONTROL_PROTOCOL_MAJOR == 1, "wire major version");
_Static_assert(OPENCONTROL_AGENT_COUNT == 6, "agent count");
_Static_assert(OPENCONTROL_CONTROL_COUNT == 19, "control count");
_Static_assert(OPENCONTROL_CONTROL_AGENT_6 - OPENCONTROL_CONTROL_AGENT_1 == 5, "contiguous agents");
_Static_assert(OPENCONTROL_CONTROL_SEND - OPENCONTROL_CONTROL_FAST == 5, "contiguous commands");
_Static_assert(OPENCONTROL_CONTROL_NAV_LEFT - OPENCONTROL_CONTROL_NAV_UP == 3, "contiguous navigation");
_Static_assert(OPENCONTROL_CONTROL_DIAL_PRESS - OPENCONTROL_CONTROL_DIAL_CCW == 2, "contiguous dial");

int main(void) {
    return 0;
}
