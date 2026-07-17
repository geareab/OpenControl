// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include QMK_KEYBOARD_H

#include <string.h>

#include "dynamic_keymap.h"
#include "opencontrol.h"
#include "raw_hid.h"
#include "via.h"

#if defined(OPENCONTROL_LEGACY_QMK)
/*
 * Manufacturer QMK forks that predate Community Modules do not generate the
 * module hook chain. Keep the compatibility path explicit and opt-in so
 * current QMK builds retain the generated keyboard/user extension points.
 */
__attribute__((weak)) void keyboard_post_init_opencontrol_kb(void) {}

__attribute__((weak)) bool process_record_opencontrol_kb(uint16_t keycode, keyrecord_t *record) {
    (void)keycode;
    (void)record;
    return true;
}

__attribute__((weak)) void housekeeping_task_opencontrol_kb(void) {}

#    if defined(RGB_MATRIX_ENABLE)
__attribute__((weak)) bool rgb_matrix_indicators_opencontrol_kb(void) {
    return true;
}
#    endif
#else
ASSERT_COMMUNITY_MODULES_MIN_API_VERSION(1, 1, 0);
#endif

#if OPENCONTROL_LAYER >= DYNAMIC_KEYMAP_LAYER_COUNT
#    error "OPENCONTROL_LAYER must be lower than DYNAMIC_KEYMAP_LAYER_COUNT"
#endif

#define OPENCONTROL_HELD_CONTROL_COUNT 8
#define OPENCONTROL_SELECTED_NONE 0xFF

typedef struct {
    bool     used;
    keypos_t key;
    uint8_t  control_id;
    uint8_t  layer;
} opencontrol_held_control_t;

static opencontrol_held_control_t opencontrol_held_controls[OPENCONTROL_HELD_CONTROL_COUNT];
static bool                       opencontrol_input_active;
static bool                       opencontrol_feedback_active;
static uint8_t                    opencontrol_device_sequence;
static uint32_t                   opencontrol_last_input_contact;
static uint32_t                   opencontrol_last_feedback_contact;
static uint8_t                    opencontrol_task_states[OPENCONTROL_AGENT_COUNT];
static uint8_t                    opencontrol_selected_agent = OPENCONTROL_SELECTED_NONE;
static uint8_t                    opencontrol_unread_mask;

#if defined(RGB_MATRIX_ENABLE)
static uint8_t  opencontrol_agent_leds[OPENCONTROL_AGENT_COUNT];
static uint32_t opencontrol_last_led_scan;
static bool     opencontrol_led_map_dirty = true;
#endif

static bool opencontrol_keypos_equal(keypos_t left, keypos_t right) {
    return left.row == right.row && left.col == right.col;
}

static int8_t opencontrol_find_held(keypos_t key) {
    for (uint8_t index = 0; index < OPENCONTROL_HELD_CONTROL_COUNT; index++) {
        if (opencontrol_held_controls[index].used && opencontrol_keypos_equal(opencontrol_held_controls[index].key, key)) {
            return (int8_t)index;
        }
    }
    return -1;
}

static int8_t opencontrol_remember_held(keypos_t key, uint8_t control_id, uint8_t layer) {
    for (uint8_t index = 0; index < OPENCONTROL_HELD_CONTROL_COUNT; index++) {
        if (!opencontrol_held_controls[index].used) {
            opencontrol_held_controls[index] = (opencontrol_held_control_t){
                .used       = true,
                .key        = key,
                .control_id = control_id,
                .layer      = layer,
            };
            return (int8_t)index;
        }
    }
    return -1;
}

static uint8_t opencontrol_control_for_keycode(uint16_t keycode) {
    uint8_t basic_keycode = (uint8_t)keycode;
    bool    shifted       = false;

    if (IS_QK_MODS(keycode)) {
        uint8_t encoded_mods = QK_MODS_GET_MODS(keycode);
        if (encoded_mods != (QK_LSFT >> 8) && encoded_mods != (QK_RSFT >> 8)) {
            return OPENCONTROL_CONTROL_NONE;
        }
        shifted       = true;
        basic_keycode = QK_MODS_GET_BASIC_KEYCODE(keycode);
    }

    if (!shifted) {
        if (basic_keycode >= KC_F13 && basic_keycode <= KC_F18) {
            return OPENCONTROL_CONTROL_AGENT_1 + (basic_keycode - KC_F13);
        }
        if (basic_keycode >= KC_F19 && basic_keycode <= KC_F24) {
            return OPENCONTROL_CONTROL_FAST + (basic_keycode - KC_F19);
        }
        return OPENCONTROL_CONTROL_NONE;
    }

    if (basic_keycode >= KC_F13 && basic_keycode <= KC_F16) {
        return OPENCONTROL_CONTROL_NAV_UP + (basic_keycode - KC_F13);
    }
    if (basic_keycode >= KC_F17 && basic_keycode <= KC_F19) {
        return OPENCONTROL_CONTROL_DIAL_CCW + (basic_keycode - KC_F17);
    }
    return OPENCONTROL_CONTROL_NONE;
}

static void opencontrol_init_packet(uint8_t *packet, uint8_t message_type, uint8_t sequence, uint8_t payload_length, uint8_t flags) {
    memset(packet, 0, OPENCONTROL_REPORT_SIZE);
    packet[OPENCONTROL_OFFSET_NAMESPACE] = OPENCONTROL_NAMESPACE;
    packet[OPENCONTROL_OFFSET_MAGIC_0]   = OPENCONTROL_MAGIC_0;
    packet[OPENCONTROL_OFFSET_MAGIC_1]   = OPENCONTROL_MAGIC_1;
    packet[OPENCONTROL_OFFSET_VERSION]   = OPENCONTROL_PROTOCOL_MAJOR;
    packet[OPENCONTROL_OFFSET_TYPE]      = message_type;
    packet[OPENCONTROL_OFFSET_SEQUENCE]  = sequence;
    packet[OPENCONTROL_OFFSET_LENGTH]    = payload_length;
    packet[OPENCONTROL_OFFSET_FLAGS]     = flags;
}

static void opencontrol_send_packet(uint8_t message_type, uint8_t sequence, uint8_t flags, const uint8_t *payload, uint8_t payload_length) {
    uint8_t packet[OPENCONTROL_REPORT_SIZE];
    opencontrol_init_packet(packet, message_type, sequence, payload_length, flags);
    if (payload != NULL && payload_length > 0) {
        memcpy(&packet[OPENCONTROL_OFFSET_PAYLOAD], payload, payload_length);
    }
    raw_hid_send(packet, OPENCONTROL_REPORT_SIZE);
}

static uint16_t opencontrol_capabilities(void) {
    uint16_t capabilities = OPENCONTROL_CAP_PRESS_RELEASE | OPENCONTROL_CAP_USB | OPENCONTROL_CAP_DYNAMIC_MAP;
#if defined(RGB_MATRIX_ENABLE)
    capabilities |= OPENCONTROL_CAP_RGB_MATRIX;
#endif
#if defined(ENCODER_MAP_ENABLE)
    capabilities |= OPENCONTROL_CAP_ENCODER;
#endif
    return capabilities;
}

static void opencontrol_mark_input_seen(void) {
    opencontrol_input_active       = true;
    opencontrol_last_input_contact = timer_read32();
}

static void opencontrol_mark_feedback_seen(void) {
    opencontrol_feedback_active       = true;
    opencontrol_last_feedback_contact = timer_read32();
    opencontrol_mark_input_seen();
}

static void opencontrol_send_hello_ack(uint8_t sequence) {
    uint16_t capabilities = opencontrol_capabilities();
    uint8_t  payload[]    = {
        OPENCONTROL_PROTOCOL_MINOR,
        capabilities & 0xFF,
        capabilities >> 8,
        OPENCONTROL_AGENT_COUNT,
        OPENCONTROL_CONTROL_COUNT,
        OPENCONTROL_REPORT_SIZE,
        OPENCONTROL_LAYER,
        OPENCONTROL_HEARTBEAT_TIMEOUT_MS / 1000,
    };
    opencontrol_send_packet(OPENCONTROL_MESSAGE_HELLO_ACK, sequence, OPENCONTROL_FLAG_RESPONSE, payload, sizeof(payload));
}

static void opencontrol_send_ack(uint8_t sequence, uint8_t acknowledged_type) {
    uint8_t payload[] = {acknowledged_type, sequence};
    opencontrol_send_packet(OPENCONTROL_MESSAGE_ACK, sequence, OPENCONTROL_FLAG_RESPONSE, payload, sizeof(payload));
}

static void opencontrol_send_error(uint8_t sequence, uint8_t error, uint8_t offending_type, uint8_t detail) {
    uint8_t payload[] = {error, offending_type, detail};
    opencontrol_send_packet(OPENCONTROL_MESSAGE_ERROR, sequence, OPENCONTROL_FLAG_RESPONSE, payload, sizeof(payload));
}

static void opencontrol_send_control_event(uint8_t control_id, uint8_t phase, uint8_t layer, keyevent_t event) {
    if (!opencontrol_input_active) {
        return;
    }

    uint32_t timestamp = timer_read32();
#if defined(OPENCONTROL_LEGACY_QMK)
    /*
     * Older QMK keyevent_t values predate the event-type member. This callback
     * only receives matrix key records, whose protocol-v1 type is KEY_EVENT.
     */
    uint8_t event_type = 1;
#else
    uint8_t event_type = event.type;
#endif
    uint8_t  payload[] = {
        control_id,
        phase,
        event.key.row,
        event.key.col,
        event_type,
        layer,
        timestamp & 0xFF,
        (timestamp >> 8) & 0xFF,
        (timestamp >> 16) & 0xFF,
        (timestamp >> 24) & 0xFF,
    };
    opencontrol_send_packet(OPENCONTROL_MESSAGE_CONTROL_EVENT, opencontrol_device_sequence++, OPENCONTROL_FLAG_ASYNC, payload, sizeof(payload));
}

static bool opencontrol_packet_is_ours(const uint8_t *data, uint8_t length) {
    return length >= 3 && data[OPENCONTROL_OFFSET_NAMESPACE] == OPENCONTROL_NAMESPACE && data[OPENCONTROL_OFFSET_MAGIC_0] == OPENCONTROL_MAGIC_0 && data[OPENCONTROL_OFFSET_MAGIC_1] == OPENCONTROL_MAGIC_1;
}

static void opencontrol_observe_via_packet(const uint8_t *data, uint8_t length) {
#if defined(RGB_MATRIX_ENABLE)
    if (length == OPENCONTROL_REPORT_SIZE && (data[0] == id_dynamic_keymap_set_keycode || data[0] == id_dynamic_keymap_set_buffer || data[0] == id_dynamic_keymap_reset)) {
        opencontrol_led_map_dirty = true;
    }
#else
    (void)data;
    (void)length;
#endif
}

bool opencontrol_via_command(uint8_t *data, uint8_t length) {
    if (!opencontrol_packet_is_ours(data, length)) {
        opencontrol_observe_via_packet(data, length);
        return false;
    }

    uint8_t message_type = length > OPENCONTROL_OFFSET_TYPE ? data[OPENCONTROL_OFFSET_TYPE] : 0;
    uint8_t sequence     = length > OPENCONTROL_OFFSET_SEQUENCE ? data[OPENCONTROL_OFFSET_SEQUENCE] : 0;

    if (length != OPENCONTROL_REPORT_SIZE || data[OPENCONTROL_OFFSET_LENGTH] > OPENCONTROL_MAX_PAYLOAD) {
        opencontrol_send_error(sequence, OPENCONTROL_ERROR_MALFORMED_PAYLOAD, message_type, length);
        return true;
    }
    if (data[OPENCONTROL_OFFSET_VERSION] != OPENCONTROL_PROTOCOL_MAJOR) {
        opencontrol_send_error(sequence, OPENCONTROL_ERROR_UNSUPPORTED_VERSION, message_type, data[OPENCONTROL_OFFSET_VERSION]);
        return true;
    }

    uint8_t *payload        = &data[OPENCONTROL_OFFSET_PAYLOAD];
    uint8_t  payload_length = data[OPENCONTROL_OFFSET_LENGTH];

    switch (message_type) {
        case OPENCONTROL_MESSAGE_HELLO:
            opencontrol_mark_input_seen();
            opencontrol_send_hello_ack(sequence);
            return true;

        case OPENCONTROL_MESSAGE_TASK_STATES:
            if (payload_length != OPENCONTROL_AGENT_COUNT + 2 || (payload[0] != OPENCONTROL_SELECTED_NONE && payload[0] >= OPENCONTROL_AGENT_COUNT)) {
                opencontrol_send_error(sequence, OPENCONTROL_ERROR_MALFORMED_PAYLOAD, message_type, payload_length);
                return true;
            }
            for (uint8_t index = 0; index < OPENCONTROL_AGENT_COUNT; index++) {
                if (payload[index + 1] > OPENCONTROL_TASK_ERROR) {
                    opencontrol_send_error(sequence, OPENCONTROL_ERROR_INVALID_STATE, message_type, index);
                    return true;
                }
            }
            opencontrol_selected_agent = payload[0];
            memcpy(opencontrol_task_states, &payload[1], OPENCONTROL_AGENT_COUNT);
            opencontrol_unread_mask = payload[OPENCONTROL_AGENT_COUNT + 1] & ((1 << OPENCONTROL_AGENT_COUNT) - 1);
            opencontrol_mark_feedback_seen();
            opencontrol_send_ack(sequence, message_type);
            return true;

        case OPENCONTROL_MESSAGE_PING:
            opencontrol_mark_input_seen();
            opencontrol_send_ack(sequence, message_type);
            return true;

        case OPENCONTROL_MESSAGE_ACK:
            opencontrol_mark_input_seen();
            return true;

        default:
            opencontrol_send_error(sequence, OPENCONTROL_ERROR_UNKNOWN_MESSAGE, message_type, 0);
            return true;
    }
}

#ifndef OPENCONTROL_VIA_COMMAND_MANUAL
bool via_command_kb(uint8_t *data, uint8_t length) {
    return opencontrol_via_command(data, length);
}
#endif

void keyboard_post_init_opencontrol(void) {
    keyboard_post_init_opencontrol_kb();
    opencontrol_input_active    = false;
    opencontrol_feedback_active = false;
    memset(opencontrol_task_states, OPENCONTROL_TASK_OFF, sizeof(opencontrol_task_states));
#if defined(RGB_MATRIX_ENABLE)
    memset(opencontrol_agent_leds, NO_LED, sizeof(opencontrol_agent_leds));
    opencontrol_led_map_dirty = true;
#endif
}

bool process_record_opencontrol(uint16_t keycode, keyrecord_t *record) {
    if (!process_record_opencontrol_kb(keycode, record)) {
        return false;
    }

    int8_t held_index = opencontrol_find_held(record->event.key);
    if (!record->event.pressed && held_index >= 0) {
        opencontrol_held_control_t held = opencontrol_held_controls[held_index];
        opencontrol_held_controls[held_index].used = false;
        opencontrol_send_control_event(held.control_id, OPENCONTROL_PHASE_RELEASE, held.layer, record->event);
        return false;
    }

    uint8_t control_id = opencontrol_control_for_keycode(keycode);
    if (control_id == OPENCONTROL_CONTROL_NONE || layer_switch_get_layer(record->event.key) != OPENCONTROL_LAYER) {
        return true;
    }

    if (!record->event.pressed) {
        opencontrol_send_control_event(control_id, OPENCONTROL_PHASE_RELEASE, OPENCONTROL_LAYER, record->event);
        return false;
    }

    uint8_t phase = held_index >= 0 ? OPENCONTROL_PHASE_REPEAT : OPENCONTROL_PHASE_PRESS;
    if (held_index < 0) {
        opencontrol_remember_held(record->event.key, control_id, OPENCONTROL_LAYER);
    }
    opencontrol_send_control_event(control_id, phase, OPENCONTROL_LAYER, record->event);
    return false;
}

void housekeeping_task_opencontrol(void) {
    housekeeping_task_opencontrol_kb();
    if (opencontrol_input_active && timer_elapsed32(opencontrol_last_input_contact) > OPENCONTROL_HEARTBEAT_TIMEOUT_MS) {
        opencontrol_input_active = false;
    }
    if (opencontrol_feedback_active && timer_elapsed32(opencontrol_last_feedback_contact) > OPENCONTROL_HEARTBEAT_TIMEOUT_MS) {
        opencontrol_feedback_active = false;
        opencontrol_selected_agent = OPENCONTROL_SELECTED_NONE;
        opencontrol_unread_mask    = 0;
        memset(opencontrol_task_states, OPENCONTROL_TASK_OFF, sizeof(opencontrol_task_states));
    }
}

#if defined(RGB_MATRIX_ENABLE)
static uint8_t opencontrol_scale8(uint8_t value, uint8_t scale) {
    /*
     * Equivalent to QMK/FastLED's fixed scale8 implementation, without
     * depending on where a particular QMK generation exposes that helper.
     */
    return ((uint16_t)value * (1U + (uint16_t)scale)) >> 8;
}

static void opencontrol_refresh_agent_leds(void) {
    memset(opencontrol_agent_leds, NO_LED, sizeof(opencontrol_agent_leds));
    for (uint8_t row = 0; row < MATRIX_ROWS; row++) {
        for (uint8_t col = 0; col < MATRIX_COLS; col++) {
            uint8_t control_id = opencontrol_control_for_keycode(dynamic_keymap_get_keycode(OPENCONTROL_LAYER, row, col));
            if (control_id >= OPENCONTROL_CONTROL_AGENT_1 && control_id <= OPENCONTROL_CONTROL_AGENT_6) {
                uint8_t agent_index = control_id - OPENCONTROL_CONTROL_AGENT_1;
                uint8_t led_index   = g_led_config.matrix_co[row][col];
                if (opencontrol_agent_leds[agent_index] == NO_LED && led_index != NO_LED) {
                    opencontrol_agent_leds[agent_index] = led_index;
                }
            }
        }
    }
    opencontrol_last_led_scan = timer_read32();
    opencontrol_led_map_dirty = false;
}

static void opencontrol_color_for_state(uint8_t state, bool unread, uint8_t *red, uint8_t *green, uint8_t *blue) {
    if (state == OPENCONTROL_TASK_COMPLETE && !unread) {
        state = OPENCONTROL_TASK_IDLE;
    }

    switch (state) {
        case OPENCONTROL_TASK_IDLE:
            *red = *green = *blue = 255;
            break;
        case OPENCONTROL_TASK_EXECUTING:
            *red   = 0;
            *green = 96;
            *blue  = 255;
            break;
        case OPENCONTROL_TASK_WAITING:
            *red   = 255;
            *green = 128;
            *blue  = 0;
            break;
        case OPENCONTROL_TASK_COMPLETE:
            *red   = 0;
            *green = 255;
            *blue  = 48;
            break;
        case OPENCONTROL_TASK_ERROR:
            *red   = 255;
            *green = 0;
            *blue  = 0;
            break;
        case OPENCONTROL_TASK_OFF:
        default:
            *red = *green = *blue = 0;
            break;
    }
}

bool rgb_matrix_indicators_opencontrol(void) {
    if (!rgb_matrix_indicators_opencontrol_kb()) {
        return false;
    }
    if (!opencontrol_feedback_active) {
        return true;
    }
    if (opencontrol_led_map_dirty || timer_elapsed32(opencontrol_last_led_scan) > OPENCONTROL_LED_RESCAN_MS) {
        opencontrol_refresh_agent_leds();
    }

    uint8_t base_brightness = rgb_matrix_get_val();
    for (uint8_t agent = 0; agent < OPENCONTROL_AGENT_COUNT; agent++) {
        uint8_t led_index = opencontrol_agent_leds[agent];
        if (led_index == NO_LED) {
            continue;
        }

        uint8_t red;
        uint8_t green;
        uint8_t blue;
        opencontrol_color_for_state(opencontrol_task_states[agent], (opencontrol_unread_mask & (1 << agent)) != 0, &red, &green, &blue);

        uint8_t brightness = base_brightness;
        if (opencontrol_selected_agent == agent && opencontrol_task_states[agent] != OPENCONTROL_TASK_OFF) {
            uint16_t pulse = timer_read32() % 1600;
            if (pulse > 800) {
                pulse = 1600 - pulse;
            }
            uint8_t pulse_scale = 128 + ((uint32_t)pulse * 127 / 800);
            brightness          = opencontrol_scale8(base_brightness, pulse_scale);
        }

        rgb_matrix_set_color(led_index, opencontrol_scale8(red, brightness), opencontrol_scale8(green, brightness), opencontrol_scale8(blue, brightness));
    }
    return true;
}
#endif
