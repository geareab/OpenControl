#!/usr/bin/env node
// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function argumentsByName(argv) {
  const values = new Map()
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${name ?? '<end>'}`)
    }
    values.set(name.slice(2), value)
  }
  return values
}

const args = argumentsByName(process.argv)
for (const required of ['bin', 'readelf', 'objdump', 'map', 'output', 'label']) {
  if (!args.has(required)) throw new Error(`missing --${required}`)
}

const flashBase = 0x08000000
const flashEnd = 0x08020000 // 128 KiB STM32L432 variant used by K4P-H3
const eepromStart = 0x0801c000 // final 16 KiB page reserved by Keychron FEE
const systemBootloaderStart = 0x1fff0000
const systemBootloaderEnd = 0x20000000

const binary = fs.readFileSync(args.get('bin'))
const readelf = fs.readFileSync(args.get('readelf'), 'utf8')
const objdump = fs.readFileSync(args.get('objdump'), 'utf8')
const linkerMap = fs.readFileSync(args.get('map'), 'utf8')

assert.ok(binary.length > 8, 'firmware binary is unexpectedly short')
assert.ok(
  binary.length <= eepromStart - flashBase,
  `binary length ${binary.length} reaches Keychron's emulated-EEPROM page`,
)

const loadSegments = []
for (const line of readelf.split('\n')) {
  const match = line.match(
    /^\s*LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)/i,
  )
  if (!match) continue
  loadSegments.push({
    offset: Number.parseInt(match[1], 16),
    virtualAddress: Number.parseInt(match[2], 16),
    physicalAddress: Number.parseInt(match[3], 16),
    fileSize: Number.parseInt(match[4], 16),
    memorySize: Number.parseInt(match[5], 16),
  })
}
assert.ok(loadSegments.length > 0, 'readelf reported no loadable segments')

const intersects = (start, end, regionStart, regionEnd) => start < regionEnd && end > regionStart

const flashSegments = []
for (const segment of loadSegments) {
  const start = segment.physicalAddress
  const end = start + segment.fileSize
  if (intersects(start, end, systemBootloaderStart, systemBootloaderEnd)) {
    throw new Error('firmware load segment overlaps the STM32 system bootloader')
  }
  if (intersects(start, end, eepromStart, flashEnd)) {
    throw new Error("firmware load segment overlaps Keychron's emulated EEPROM")
  }
  if (intersects(start, end, flashBase, flashEnd)) {
    assert.ok(start >= flashBase && end <= eepromStart)
    flashSegments.push({ ...segment, end })
  }
}
assert.ok(flashSegments.length > 0, 'ELF has no loadable MCU flash segment')

const programStart = Math.min(...flashSegments.map((segment) => segment.physicalAddress))
const programEnd = Math.max(...flashSegments.map((segment) => segment.end))
assert.equal(programStart, flashBase, 'firmware must start at STM32 flash base')
assert.ok(programEnd <= eepromStart)
assert.ok(programEnd - flashBase <= binary.length)

assert.match(linkerMap, /Memory Configuration/)
assert.match(linkerMap, /\bflash0\b/)
assert.doesNotMatch(linkerMap, /(?:region [`'].*overflowed|will not fit)/i)
assert.match(objdump, /file format elf32-littlearm/i)
assert.match(objdump, /\.text\b/)

const report = {
  label: args.get('label'),
  binaryBytes: binary.length,
  flash: {
    base: `0x${flashBase.toString(16)}`,
    programEndExclusive: `0x${programEnd.toString(16)}`,
    programBytesByLoadSegments: programEnd - flashBase,
    safeProgramLimitExclusive: `0x${eepromStart.toString(16)}`,
    safeProgramLimitBytes: eepromStart - flashBase,
    freeBytesBeforeEeprom: eepromStart - programEnd,
    physicalFlashEndExclusive: `0x${flashEnd.toString(16)}`,
  },
  eeprom: {
    start: `0x${eepromStart.toString(16)}`,
    endExclusive: `0x${flashEnd.toString(16)}`,
    bytes: flashEnd - eepromStart,
    overlap: false,
  },
  systemBootloader: {
    start: `0x${systemBootloaderStart.toString(16)}`,
    endExclusive: `0x${systemBootloaderEnd.toString(16)}`,
    overlap: false,
  },
  loadSegments,
}

fs.mkdirSync(path.dirname(args.get('output')), { recursive: true, mode: 0o700 })
fs.writeFileSync(args.get('output'), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
})
console.log(
  `${report.label}: ${binary.length} bytes; ${report.flash.freeBytesBeforeEeprom} ` +
    'bytes remain before emulated EEPROM.',
)
