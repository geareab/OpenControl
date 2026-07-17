// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

/*
 * This target is deliberately opt-in. Keychron's pinned QMK fork predates
 * Community Modules, so the keymap and the small upstream adapter call the
 * OpenControl hooks directly.
 */
#define DYNAMIC_KEYMAP_LAYER_COUNT 5
#define OPENCONTROL_LAYER 4
#define OPENCONTROL_LEGACY_QMK
#define OPENCONTROL_VIA_COMMAND_MANUAL
