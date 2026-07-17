// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MATRIX_ROWS 4
#define MATRIX_COLS 4
#define DYNAMIC_KEYMAP_LAYER_COUNT 4

#define KC_F13 0x68
#define KC_F14 0x69
#define KC_F15 0x6A
#define KC_F16 0x6B
#define KC_F17 0x6C
#define KC_F18 0x6D
#define KC_F19 0x6E
#define KC_F20 0x6F
#define KC_F21 0x70
#define KC_F22 0x71
#define KC_F23 0x72
#define KC_F24 0x73

#define QK_MODS 0x0100
#define QK_MODS_MAX 0x1FFF
#define QK_LSFT 0x0200
#define QK_RSFT 0x1200
#define IS_QK_MODS(keycode) ((keycode) >= QK_MODS && (keycode) <= QK_MODS_MAX)
#define QK_MODS_GET_MODS(keycode) (((keycode) >> 8) & 0x1F)
#define QK_MODS_GET_BASIC_KEYCODE(keycode) ((keycode) & 0xFF)

#define NO_LED 255
#define ASSERT_COMMUNITY_MODULES_MIN_API_VERSION(major, minor, patch)

#if defined(OPENCONTROL_TEST_RGB)
#    define RGB_MATRIX_ENABLE
#endif

#if defined(OPENCONTROL_TEST_LED)
#    define LED_MATRIX_ENABLE
#endif

#if defined(OPENCONTROL_TEST_ENCODER)
#    define ENCODER_ENABLE
#    define ENCODER_MAP_ENABLE
#endif

typedef struct {
    uint8_t col;
    uint8_t row;
} keypos_t;

typedef enum {
    TICK_EVENT        = 0,
    KEY_EVENT         = 1,
    ENCODER_CW_EVENT  = 2,
    ENCODER_CCW_EVENT = 3,
} keyevent_type_t;

#if defined(OPENCONTROL_LEGACY_QMK)
typedef struct {
    keypos_t key;
    bool     pressed;
    uint16_t time;
} keyevent_t;
#else
typedef struct {
    keypos_t        key;
    uint16_t        time;
    keyevent_type_t type;
    bool            pressed;
} keyevent_t;
#endif

typedef struct {
    keyevent_t event;
} keyrecord_t;

typedef struct {
    uint8_t matrix_co[MATRIX_ROWS][MATRIX_COLS];
} led_config_t;

extern led_config_t g_led_config;

uint8_t  layer_switch_get_layer(keypos_t key);
uint32_t timer_read32(void);
uint32_t timer_elapsed32(uint32_t last);
uint8_t  scale8(uint8_t value, uint8_t scale);

void rgb_matrix_set_color(int index, uint8_t red, uint8_t green, uint8_t blue);
uint8_t rgb_matrix_get_val(void);

void keyboard_post_init_opencontrol_kb(void);
bool process_record_opencontrol_kb(uint16_t keycode, keyrecord_t *record);
void housekeeping_task_opencontrol_kb(void);
bool rgb_matrix_indicators_opencontrol_kb(void);
