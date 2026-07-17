// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

/* Change this to the dedicated layer configured in VIA. */
#define OPENCONTROL_LAYER 3

/* Optional overrides. */
// #define OPENCONTROL_HEARTBEAT_TIMEOUT_MS 5000
// #define OPENCONTROL_LED_RESCAN_MS 1000

/*
 * Uncomment this only when the keyboard already defines via_command_kb(), then
 * merge via_command_delegate.c.example into that existing implementation.
 */
// #define OPENCONTROL_VIA_COMMAND_MANUAL
