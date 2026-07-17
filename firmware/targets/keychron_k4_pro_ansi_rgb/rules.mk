# Copyright 2026 OpenControl contributors
# SPDX-License-Identifier: GPL-2.0-or-later

VIA_ENABLE = yes

# prepare.sh copies the GPL module beside this keymap so the path is stable
# inside the pinned Keychron source tree.
OPENCONTROL_DIR = keyboards/keychron/k4_pro/ansi/rgb/keymaps/opencontrol/opencontrol
SRC += $(OPENCONTROL_DIR)/opencontrol.c
VPATH += $(OPENCONTROL_DIR)
