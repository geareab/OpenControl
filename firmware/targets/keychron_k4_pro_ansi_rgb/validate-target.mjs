#!/usr/bin/env node
// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const targetDir = path.dirname(fileURLToPath(import.meta.url))
const qmkIndex = process.argv.indexOf('--qmk-tree')
const qmkTree =
  qmkIndex >= 0 && process.argv[qmkIndex + 1] ? path.resolve(process.argv[qmkIndex + 1]) : undefined

if (qmkIndex >= 0 && !process.argv[qmkIndex + 1]) {
  throw new Error('--qmk-tree requires a path')
}

const keymap = fs.readFileSync(path.join(targetDir, 'keymap.c'), 'utf8')
const config = fs.readFileSync(path.join(targetDir, 'config.h'), 'utf8')
const rules = fs.readFileSync(path.join(targetDir, 'rules.mk'), 'utf8')
const adapter = fs.readFileSync(path.join(targetDir, 'keychron-opencontrol.patch'), 'utf8')
const preparation = fs.readFileSync(path.join(targetDir, 'prepare.sh'), 'utf8')
const moduleHeader = fs.readFileSync(
  path.resolve(targetDir, '../../modules/opencontrol/opencontrol.h'),
  'utf8',
)

function balancedBody(source, openingIndex) {
  assert.equal(source[openingIndex], '(', "balancedBody must start at '('")
  let depth = 1
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1
    if (source[index] === ')') depth -= 1
    if (depth === 0) {
      return source.slice(openingIndex + 1, index)
    }
  }
  throw new Error('unterminated parenthesized expression')
}

function splitArguments(body) {
  const values = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '(') depth += 1
    if (body[index] === ')') depth -= 1
    if (body[index] === ',' && depth === 0) {
      values.push(body.slice(start, index).trim().replace(/\s+/g, ''))
      start = index + 1
    }
  }
  values.push(body.slice(start).trim().replace(/\s+/g, ''))
  return values
}

function readLayouts(source) {
  const layouts = []
  const marker = 'LAYOUT_ansi_100('
  let cursor = 0
  while ((cursor = source.indexOf(marker, cursor)) >= 0) {
    const assignment = source.slice(0, cursor).match(/\[([A-Z_]+)\]\s*=\s*$/)
    assert.ok(assignment, `missing layer assignment before layout ${layouts.length}`)
    layouts.push({
      name: assignment[1],
      values: splitArguments(balancedBody(source, cursor + marker.length - 1)),
    })
    cursor += marker.length
  }
  return layouts
}

const layouts = readLayouts(keymap)
assert.deepEqual(
  layouts.map(({ name }) => name),
  ['MAC_BASE', 'MAC_FN', 'WIN_BASE', 'WIN_FN', 'OPENCONTROL'],
  'the target must define the four factory layers plus one OpenControl layer',
)
for (const layout of layouts) {
  assert.equal(layout.values.length, 100, `${layout.name} must contain exactly 100 physical keys`)
  assert.equal(
    layout.values[18],
    'OC_TOGG',
    `${layout.name} must keep the top-right Lock key as the layer toggle`,
  )
}

const controls = new Map([
  [84, 'KC_F13'], // Numpad 1: Agent 1
  [85, 'KC_F14'], // Numpad 2: Agent 2
  [86, 'KC_F15'], // Numpad 3: Agent 3
  [68, 'KC_F16'], // Numpad 4: Agent 4
  [69, 'KC_F17'], // Numpad 5: Agent 5
  [70, 'KC_F18'], // Numpad 6: Agent 6
  [51, 'KC_F19'], // Numpad 7: Fast
  [52, 'KC_F20'], // Numpad 8: Approve
  [53, 'KC_F21'], // Numpad 9: Decline
  [34, 'KC_F22'], // Numpad /: Fork
  [98, 'KC_F23'], // Numpad 0: Mic
  [99, 'KC_F24'], // Numpad .: Send
  [54, 'LSFT(KC_F13)'], // Numpad +: Plan
  [36, 'LSFT(KC_F14)'], // Numpad -: Next task
  [35, 'LSFT(KC_F15)'], // Numpad *: Skills
  [33, 'LSFT(KC_F16)'], // Num Lock: Previous task
  [17, 'LSFT(KC_F17)'], // PgDn: Reasoning down
  [16, 'LSFT(KC_F18)'], // PgUp: Reasoning up
  [87, 'LSFT(KC_F19)'], // Numpad Enter: Model picker
])

const openControlLayer = layouts[4].values
for (let index = 0; index < openControlLayer.length; index += 1) {
  const expected = index === 18 ? 'OC_TOGG' : (controls.get(index) ?? '_______')
  assert.equal(
    openControlLayer[index],
    expected,
    `unexpected OpenControl layer key at physical index ${index}`,
  )
}
assert.equal(controls.size, 19)
assert.equal(new Set(controls.values()).size, 19, 'all OpenControl keycodes must be unique')

assert.match(config, /#define DYNAMIC_KEYMAP_LAYER_COUNT 5\b/)
assert.match(config, /#define OPENCONTROL_LAYER 4\b/)
assert.match(config, /#define OPENCONTROL_LEGACY_QMK\b/)
assert.match(config, /#define OPENCONTROL_VIA_COMMAND_MANUAL\b/)
assert.match(rules, /^VIA_ENABLE = yes$/m)
assert.match(rules, /opencontrol\.c/)
assert.match(moduleHeader, /#define OPENCONTROL_REPORT_SIZE 32\b/)

assert.match(adapter, /opencontrol_via_command\(data, length\)/)
assert.match(adapter, /get_transport\(\) == TRANSPORT_USB/)
assert.match(adapter, /rgb_matrix_indicators_opencontrol\(\)/)
assert.doesNotMatch(adapter, /^-\s*(?:case 0xA[AB]|ckbt51_dfu_rx|factory_test_rx)/m)
assert.match(keymap, /get_transport\(\) != TRANSPORT_USB/)
assert.match(preparation, /upstream_revision="618127a725a1773e85f13455602cf6f72ab4de17"/)
assert.match(
  preparation,
  /qmk_image="ghcr\.io\/qmk\/qmk_cli@sha256:b7d7fa8fb4432b569931de5ad59098cb788f440ed61a62c5126746b71aee0f4a"/,
)
assert.match(
  preparation,
  /factory_sha256="bda30aac7a192f748afba731d0c5ddda0cf42313b48ad6c94eeb93060f5d5493"/,
)
assert.match(preparation, /--network none/)
assert.doesNotMatch(
  preparation,
  /(?:qmk\s+flash|dfu-util|:flash\b|--device(?:=|\s)|--privileged)/i,
  'preparation must not contain a flashing command or expose host devices',
)
assert.ok(
  preparation.indexOf('build_tree "$work_root/baseline" via') <
    preparation.indexOf('build_tree "$work_root/custom-a" opencontrol'),
  'the untouched VIA target must compile before the custom target',
)

if (qmkTree) {
  const keyboardDir = path.join(qmkTree, 'keyboards/keychron/k4_pro')
  const info = JSON.parse(fs.readFileSync(path.join(keyboardDir, 'info.json'), 'utf8'))
  const rgbInfo = JSON.parse(fs.readFileSync(path.join(keyboardDir, 'ansi/rgb/info.json'), 'utf8'))
  const keyboardSource = fs.readFileSync(path.join(keyboardDir, 'k4_pro.c'), 'utf8')
  const indicatorSource = fs.readFileSync(
    path.join(qmkTree, 'keyboards/keychron/bluetooth/indicator.c'),
    'utf8',
  )
  const keyboardConfig = fs.readFileSync(path.join(keyboardDir, 'config.h'), 'utf8')
  const rgbSource = fs.readFileSync(path.join(keyboardDir, 'ansi/rgb/rgb.c'), 'utf8')

  assert.equal(info.processor, 'STM32L432')
  assert.equal(info.bootloader, 'stm32-dfu')
  assert.equal(info.usb.vid, '0x3434')
  assert.equal(rgbInfo.usb.pid, '0x0240')
  assert.equal(rgbInfo.features.rgb_matrix, true)
  assert.equal(info.features.raw, true)
  assert.deepEqual(info.matrix_size, { rows: 6, cols: 18 })

  const physicalLayout = info.layouts.LAYOUT_ansi_100.layout
  const expectedAgentMatrices = [
    [4, 14],
    [4, 15],
    [4, 16],
    [3, 14],
    [3, 15],
    [3, 16],
  ]
  assert.deepEqual(
    [84, 85, 86, 68, 69, 70].map((index) => physicalLayout[index].matrix),
    expectedAgentMatrices,
    'agent controls must occupy Numpad 1-6 matrix positions',
  )

  const ledInitializer = rgbSource.indexOf('led_config_t g_led_config')
  assert.notEqual(ledInitializer, -1)
  const matrixStart = rgbSource.indexOf('{', rgbSource.indexOf('{', ledInitializer) + 1)
  const matrixEnd = (() => {
    let depth = 1
    for (let index = matrixStart + 1; index < rgbSource.length; index += 1) {
      if (rgbSource[index] === '{') depth += 1
      if (rgbSource[index] === '}') depth -= 1
      if (depth === 0) return index
    }
    return -1
  })()
  assert.notEqual(matrixEnd, -1)
  const matrixRows = [...rgbSource.slice(matrixStart, matrixEnd + 1).matchAll(/\{([^{}]+)\}/g)].map(
    ([, row]) =>
      row
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
  )
  assert.equal(matrixRows.length, 6)
  assert.deepEqual(matrixRows[3].slice(14, 17), ['68', '69', '70'])
  assert.deepEqual(matrixRows[4].slice(14, 17), ['84', '85', '86'])

  assert.match(keyboardSource, /opencontrol_via_command\(data, length\)/)
  assert.match(keyboardSource, /ckbt51_dfu_rx\(data, length\)/)
  assert.match(keyboardSource, /factory_test_rx\(data, length\)/)
  assert.match(indicatorSource, /LED_INDICATORS_USER\(\)/)
  assert.match(indicatorSource, /get_transport\(\) == TRANSPORT_BLUETOOTH/)
  assert.match(indicatorSource, /rgb_matrix_indicators_opencontrol\(\)/)

  const eepromLimit = Number(
    keyboardConfig.match(/#define DYNAMIC_KEYMAP_EEPROM_MAX_ADDR (\d+)/)?.[1],
  )
  const dynamicKeymapBytes = 5 * info.matrix_size.rows * info.matrix_size.cols * 2
  assert.equal(eepromLimit, 2047)
  assert.ok(
    dynamicKeymapBytes <= eepromLimit,
    `five-layer dynamic keymap (${dynamicKeymapBytes} bytes) exceeds EEPROM bound`,
  )
}

console.log(
  `K4P-H3 target validated: 5 layers, ${controls.size} unique controls, ` +
    'Numpad 1-6 RGB overlay mapping, 32-byte Raw HID.',
)
