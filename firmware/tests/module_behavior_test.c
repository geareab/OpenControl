// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include <assert.h>
#include <stdio.h>
#include <string.h>

#if !defined(OPENCONTROL_TEST_LED)
#    define OPENCONTROL_TEST_RGB
#endif
#define QMK_KEYBOARD_H "stubs/qmk_stub.h"
#include "../modules/opencontrol/opencontrol.c"

static uint8_t  current_layer;
static uint32_t now_ms;
static uint8_t  sent_packet[OPENCONTROL_REPORT_SIZE];
static uint32_t sent_count;
static uint16_t dynamic_keymap[DYNAMIC_KEYMAP_LAYER_COUNT][MATRIX_ROWS][MATRIX_COLS];
static uint8_t  led_red[16];
static uint8_t  led_green[16];
static uint8_t  led_blue[16];
static bool     led_written[16];
static uint32_t led_write_count;

led_config_t g_led_config;

uint8_t layer_switch_get_layer(keypos_t key) {
    (void)key;
    return current_layer;
}

uint32_t timer_read32(void) {
    return now_ms;
}

uint32_t timer_elapsed32(uint32_t last) {
    return now_ms - last;
}

uint8_t scale8(uint8_t value, uint8_t scale) {
    return ((uint16_t)value * (scale + 1)) >> 8;
}

void raw_hid_send(uint8_t *data, uint8_t length) {
    assert(length == OPENCONTROL_REPORT_SIZE);
    memcpy(sent_packet, data, length);
    sent_count++;
}

uint16_t dynamic_keymap_get_keycode(uint8_t layer, uint8_t row, uint8_t column) {
    return dynamic_keymap[layer][row][column];
}

void rgb_matrix_set_color(int index, uint8_t red, uint8_t green, uint8_t blue) {
    assert(index >= 0 && index < 16);
    led_red[index]     = red;
    led_green[index]   = green;
    led_blue[index]    = blue;
    led_written[index] = true;
    led_write_count++;
}

uint8_t rgb_matrix_get_val(void) {
    return 255;
}

void keyboard_post_init_opencontrol_kb(void) {}

bool process_record_opencontrol_kb(uint16_t keycode, keyrecord_t *record) {
    (void)keycode;
    (void)record;
    return true;
}

void housekeeping_task_opencontrol_kb(void) {}

bool rgb_matrix_indicators_opencontrol_kb(void) {
    return true;
}

static void make_packet(uint8_t *packet, uint8_t type, uint8_t sequence, const uint8_t *payload, uint8_t payload_length) {
    memset(packet, 0, OPENCONTROL_REPORT_SIZE);
    packet[0] = OPENCONTROL_NAMESPACE;
    packet[1] = OPENCONTROL_MAGIC_0;
    packet[2] = OPENCONTROL_MAGIC_1;
    packet[3] = OPENCONTROL_PROTOCOL_MAJOR;
    packet[4] = type;
    packet[5] = sequence;
    packet[6] = payload_length;
    if (payload_length > 0) {
        memcpy(&packet[8], payload, payload_length);
    }
}

#if defined(OPENCONTROL_TEST_RGB)
static void reset_led_writes(void) {
    memset(led_red, 0, sizeof(led_red));
    memset(led_green, 0, sizeof(led_green));
    memset(led_blue, 0, sizeof(led_blue));
    memset(led_written, false, sizeof(led_written));
    led_write_count = 0;
}
#endif

int main(void) {
    memset(&g_led_config, NO_LED, sizeof(g_led_config));
    g_led_config.matrix_co[0][0] = 0;
    g_led_config.matrix_co[0][1] = 1;
    g_led_config.matrix_co[0][2] = 2;
    g_led_config.matrix_co[0][3] = 3;
    g_led_config.matrix_co[1][0] = 4;
    g_led_config.matrix_co[1][1] = 5;
    dynamic_keymap[OPENCONTROL_LAYER][0][0] = KC_F13;
    dynamic_keymap[OPENCONTROL_LAYER][0][1] = KC_F14;
    dynamic_keymap[OPENCONTROL_LAYER][0][2] = KC_F15;
    dynamic_keymap[OPENCONTROL_LAYER][0][3] = KC_F16;
    dynamic_keymap[OPENCONTROL_LAYER][1][0] = KC_F17;
    dynamic_keymap[OPENCONTROL_LAYER][1][1] = KC_F18;
    keyboard_post_init_opencontrol();

    uint8_t ordinary_via[OPENCONTROL_REPORT_SIZE] = {0x01};
    assert(!opencontrol_via_command(ordinary_via, sizeof(ordinary_via)));
    assert(sent_count == 0);

    uint8_t packet[OPENCONTROL_REPORT_SIZE];
    uint8_t hello_payload[] = {0};
    make_packet(packet, OPENCONTROL_MESSAGE_HELLO, 42, hello_payload, sizeof(hello_payload));
    assert(opencontrol_via_command(packet, sizeof(packet)));
    assert(sent_count == 1);
    assert(sent_packet[4] == OPENCONTROL_MESSAGE_HELLO_ACK);
    assert(sent_packet[5] == 42);
    uint16_t capabilities = sent_packet[9] | ((uint16_t)sent_packet[10] << 8);
    assert((capabilities & OPENCONTROL_CAP_ENCODER) == 0);
    assert((capabilities & OPENCONTROL_CAP_LED_MATRIX) == 0);
#if defined(OPENCONTROL_TEST_RGB)
    assert((capabilities & OPENCONTROL_CAP_RGB_MATRIX) != 0);

    keyrecord_t record = {
        .event = {
            .key     = {.row = 0, .col = 0},
            .type    = KEY_EVENT,
            .pressed = true,
        },
    };

    current_layer = 0;
    assert(process_record_opencontrol(KC_F13, &record));
    assert(sent_count == 1);

    current_layer = OPENCONTROL_LAYER;
    assert(!process_record_opencontrol(KC_F13, &record));
    assert(sent_packet[4] == OPENCONTROL_MESSAGE_CONTROL_EVENT);
    assert(sent_packet[8] == OPENCONTROL_CONTROL_AGENT_1);
    assert(sent_packet[9] == OPENCONTROL_PHASE_PRESS);

    current_layer        = 0;
    record.event.pressed = false;
    assert(!process_record_opencontrol(KC_F13, &record));
    assert(sent_packet[9] == OPENCONTROL_PHASE_RELEASE);

    uint8_t task_payload[] = {
        OPENCONTROL_SELECTED_NONE,
        OPENCONTROL_TASK_IDLE,
        OPENCONTROL_TASK_EXECUTING,
        OPENCONTROL_TASK_WAITING,
        OPENCONTROL_TASK_COMPLETE,
        OPENCONTROL_TASK_ERROR,
        OPENCONTROL_TASK_OFF,
        1 << 3,
    };
    make_packet(packet, OPENCONTROL_MESSAGE_TASK_STATES, 9, task_payload, sizeof(task_payload));
    assert(opencontrol_via_command(packet, sizeof(packet)));
    assert(sent_packet[4] == OPENCONTROL_MESSAGE_ACK);
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(led_write_count == OPENCONTROL_AGENT_COUNT);
    /* Off, white, blue, amber, green, and red state colors. */
    assert(led_red[0] == 255 && led_green[0] == 255 && led_blue[0] == 255);
    assert(led_red[1] == 0 && led_green[1] > 0 && led_blue[1] > led_green[1]);
    assert(led_red[2] > 0 && led_green[2] > 0 && led_blue[2] == 0);
    assert(led_red[3] == 0 && led_green[3] > led_blue[3] && led_blue[3] > 0);
    assert(led_red[4] > 0 && led_green[4] == 0 && led_blue[4] == 0);
    assert(led_red[5] == 0 && led_green[5] == 0 && led_blue[5] == 0);

    task_payload[0] = 0;
    make_packet(packet, OPENCONTROL_MESSAGE_TASK_STATES, 10, task_payload, sizeof(task_payload));
    assert(opencontrol_via_command(packet, sizeof(packet)));
    now_ms = 0;
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    uint8_t pulse_low = led_red[0];
    now_ms            = 800;
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    uint8_t pulse_high = led_red[0];
    assert(pulse_low < pulse_high);

    /* Completed without unread feedback becomes idle white. */
    task_payload[0] = OPENCONTROL_SELECTED_NONE;
    task_payload[7] = 0;
    make_packet(packet, OPENCONTROL_MESSAGE_TASK_STATES, 11, task_payload, sizeof(task_payload));
    assert(opencontrol_via_command(packet, sizeof(packet)));
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(led_red[3] == 255 && led_green[3] == 255 && led_blue[3] == 255);

    /* A VIA remap moves the status overlay to the new Agent-key LED. */
    g_led_config.matrix_co[1][2] = 6;
    dynamic_keymap[OPENCONTROL_LAYER][0][0] = 0;
    dynamic_keymap[OPENCONTROL_LAYER][1][2] = KC_F13;
    ordinary_via[0] = id_dynamic_keymap_set_keycode;
    assert(!opencontrol_via_command(ordinary_via, sizeof(ordinary_via)));
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(!led_written[0]);
    assert(led_written[6]);

    now_ms = 800 + OPENCONTROL_HEARTBEAT_TIMEOUT_MS + 1;
    housekeeping_task_opencontrol();
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(led_write_count == 0);

    /* PING restores input liveness, but cannot activate a stale/zero RGB overlay. */
    make_packet(packet, OPENCONTROL_MESSAGE_PING, 12, NULL, 0);
    assert(opencontrol_via_command(packet, sizeof(packet)));
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(led_write_count == 0);

    uint8_t resumed_hello_payload[] = {OPENCONTROL_PROTOCOL_MINOR};
    make_packet(packet, OPENCONTROL_MESSAGE_HELLO, 13, resumed_hello_payload, sizeof(resumed_hello_payload));
    assert(opencontrol_via_command(packet, sizeof(packet)));
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(led_write_count == 0);

    current_layer        = OPENCONTROL_LAYER;
    record.event.pressed = true;
    assert(!process_record_opencontrol(KC_F13, &record));
    assert(sent_packet[4] == OPENCONTROL_MESSAGE_CONTROL_EVENT);

    /* A new atomic TASK_STATES frame resumes the overlay after timeout. */
    make_packet(packet, OPENCONTROL_MESSAGE_TASK_STATES, 14, task_payload, sizeof(task_payload));
    assert(opencontrol_via_command(packet, sizeof(packet)));
    reset_led_writes();
    assert(rgb_matrix_indicators_opencontrol());
    assert(led_write_count == OPENCONTROL_AGENT_COUNT);
    assert(led_written[6]);
#else
    assert((capabilities & OPENCONTROL_CAP_RGB_MATRIX) == 0);
#endif

    puts("Validated OpenControl QMK routing, controls, heartbeat, RGB overlay, and VIA remapping.");
    return 0;
}
