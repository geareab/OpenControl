// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <stdbool.h>
#include <stdint.h>

/*
 * The last VIA layer is a useful default. Override OPENCONTROL_LAYER in the
 * keymap config.h when the OpenControl layer lives elsewhere.
 */
#ifndef OPENCONTROL_LAYER
#    define OPENCONTROL_LAYER (DYNAMIC_KEYMAP_LAYER_COUNT - 1)
#endif

#ifndef OPENCONTROL_HEARTBEAT_TIMEOUT_MS
#    define OPENCONTROL_HEARTBEAT_TIMEOUT_MS 5000
#endif

#ifndef OPENCONTROL_LED_RESCAN_MS
#    define OPENCONTROL_LED_RESCAN_MS 1000
#endif

#if OPENCONTROL_HEARTBEAT_TIMEOUT_MS < 1000 || OPENCONTROL_HEARTBEAT_TIMEOUT_MS > 255000
#    error "OPENCONTROL_HEARTBEAT_TIMEOUT_MS must fit the protocol's 1-255 second range"
#endif

#define OPENCONTROL_REPORT_SIZE 32
#define OPENCONTROL_HEADER_SIZE 8
#define OPENCONTROL_MAX_PAYLOAD (OPENCONTROL_REPORT_SIZE - OPENCONTROL_HEADER_SIZE)
#define OPENCONTROL_AGENT_COUNT 6
#define OPENCONTROL_CONTROL_COUNT 19

#define OPENCONTROL_NAMESPACE 0xE0
#define OPENCONTROL_MAGIC_0 0x4F /* O */
#define OPENCONTROL_MAGIC_1 0x43 /* C */
#define OPENCONTROL_PROTOCOL_MAJOR 1
#define OPENCONTROL_PROTOCOL_MINOR 0

enum opencontrol_packet_offset {
    OPENCONTROL_OFFSET_NAMESPACE = 0,
    OPENCONTROL_OFFSET_MAGIC_0   = 1,
    OPENCONTROL_OFFSET_MAGIC_1   = 2,
    OPENCONTROL_OFFSET_VERSION   = 3,
    OPENCONTROL_OFFSET_TYPE      = 4,
    OPENCONTROL_OFFSET_SEQUENCE  = 5,
    OPENCONTROL_OFFSET_LENGTH    = 6,
    OPENCONTROL_OFFSET_FLAGS     = 7,
    OPENCONTROL_OFFSET_PAYLOAD   = 8,
};

enum opencontrol_message_type {
    OPENCONTROL_MESSAGE_HELLO         = 0x01,
    OPENCONTROL_MESSAGE_HELLO_ACK     = 0x02,
    OPENCONTROL_MESSAGE_CONTROL_EVENT = 0x03,
    OPENCONTROL_MESSAGE_TASK_STATES   = 0x04,
    OPENCONTROL_MESSAGE_PING          = 0x05,
    OPENCONTROL_MESSAGE_ACK           = 0x06,
    OPENCONTROL_MESSAGE_ERROR         = 0x7F,
};

enum opencontrol_packet_flag {
    OPENCONTROL_FLAG_RESPONSE = 1 << 0,
    OPENCONTROL_FLAG_ASYNC    = 1 << 1,
};

enum opencontrol_capability {
    OPENCONTROL_CAP_PRESS_RELEASE = 1 << 0,
    OPENCONTROL_CAP_RGB_MATRIX    = 1 << 1,
    /* Reserved in v1; early preview builds used this for LED Matrix presence. */
    OPENCONTROL_CAP_LED_MATRIX    = 1 << 2,
    OPENCONTROL_CAP_ENCODER       = 1 << 3,
    OPENCONTROL_CAP_USB           = 1 << 4,
    OPENCONTROL_CAP_DYNAMIC_MAP   = 1 << 5,
};

enum opencontrol_control_id {
    OPENCONTROL_CONTROL_NONE = 0x00,

    OPENCONTROL_CONTROL_AGENT_1 = 0x01,
    OPENCONTROL_CONTROL_AGENT_2 = 0x02,
    OPENCONTROL_CONTROL_AGENT_3 = 0x03,
    OPENCONTROL_CONTROL_AGENT_4 = 0x04,
    OPENCONTROL_CONTROL_AGENT_5 = 0x05,
    OPENCONTROL_CONTROL_AGENT_6 = 0x06,

    OPENCONTROL_CONTROL_FAST    = 0x10,
    OPENCONTROL_CONTROL_APPROVE = 0x11,
    OPENCONTROL_CONTROL_DECLINE = 0x12,
    OPENCONTROL_CONTROL_FORK    = 0x13,
    OPENCONTROL_CONTROL_MIC     = 0x14,
    OPENCONTROL_CONTROL_SEND    = 0x15,

    OPENCONTROL_CONTROL_NAV_UP    = 0x20,
    OPENCONTROL_CONTROL_NAV_RIGHT = 0x21,
    OPENCONTROL_CONTROL_NAV_DOWN  = 0x22,
    OPENCONTROL_CONTROL_NAV_LEFT  = 0x23,

    OPENCONTROL_CONTROL_DIAL_CCW   = 0x30,
    OPENCONTROL_CONTROL_DIAL_CW    = 0x31,
    OPENCONTROL_CONTROL_DIAL_PRESS = 0x32,
};

enum opencontrol_control_phase {
    OPENCONTROL_PHASE_PRESS   = 0x01,
    OPENCONTROL_PHASE_RELEASE = 0x02,
    OPENCONTROL_PHASE_REPEAT  = 0x03,
};

enum opencontrol_task_state {
    OPENCONTROL_TASK_OFF       = 0x00,
    OPENCONTROL_TASK_IDLE      = 0x01,
    OPENCONTROL_TASK_EXECUTING = 0x02,
    OPENCONTROL_TASK_WAITING   = 0x03,
    OPENCONTROL_TASK_COMPLETE  = 0x04,
    OPENCONTROL_TASK_ERROR     = 0x05,
};

enum opencontrol_error_code {
    OPENCONTROL_ERROR_UNSUPPORTED_VERSION = 0x01,
    OPENCONTROL_ERROR_UNKNOWN_MESSAGE     = 0x02,
    OPENCONTROL_ERROR_MALFORMED_PAYLOAD   = 0x03,
    OPENCONTROL_ERROR_INVALID_STATE       = 0x04,
};

/**
 * Handle an OpenControl packet presented through VIA's Raw HID endpoint.
 *
 * Returns true only when the packet belongs to OpenControl and has been fully
 * handled. For all ordinary VIA traffic it returns false, allowing VIA to
 * continue processing the packet.
 */
bool opencontrol_via_command(uint8_t *data, uint8_t length);

/*
 * Legacy manufacturer forks call these entry points from their existing QMK
 * hooks. Current Community Module builds receive equivalent declarations from
 * QMK's generated module hook chain.
 */
#if defined(OPENCONTROL_LEGACY_QMK)
void keyboard_post_init_opencontrol(void);
bool process_record_opencontrol(uint16_t keycode, keyrecord_t *record);
void housekeeping_task_opencontrol(void);
#    if defined(RGB_MATRIX_ENABLE)
bool rgb_matrix_indicators_opencontrol(void);
#    endif
#endif
