// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const vectorsUrl = new URL('./protocol_vectors.json', import.meta.url)
const headerUrl = new URL('../modules/opencontrol/opencontrol.h', import.meta.url)
const fixture = JSON.parse(readFileSync(vectorsUrl, 'utf8'))
const header = readFileSync(headerUrl, 'utf8')

function constant(name) {
  const match = header.match(
    new RegExp(`(?:#\\s*define\\s+${name}|\\b${name}\\s*=)\\s*(0x[0-9A-Fa-f]+|[0-9]+)`),
  )
  assert.ok(match, `missing numeric constant ${name}`)
  return Number.parseInt(match[1], 0)
}

const expected = {
  namespace: constant('OPENCONTROL_NAMESPACE'),
  magic0: constant('OPENCONTROL_MAGIC_0'),
  magic1: constant('OPENCONTROL_MAGIC_1'),
  version: constant('OPENCONTROL_PROTOCOL_MAJOR'),
  reportSize: constant('OPENCONTROL_REPORT_SIZE'),
}

assert.equal(fixture.protocol, expected.version)
assert.equal(fixture.reportSize, expected.reportSize)
assert.ok(Array.isArray(fixture.vectors) && fixture.vectors.length > 0)

const names = new Set()
for (const vector of fixture.vectors) {
  assert.ok(!names.has(vector.name), `duplicate vector ${vector.name}`)
  names.add(vector.name)
  assert.ok(['host-to-device', 'device-to-host'].includes(vector.direction))
  assert.equal(vector.bytes.length, expected.reportSize, `${vector.name}: report size`)
  assert.ok(
    vector.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    `${vector.name}: byte range`,
  )
  assert.deepEqual(
    vector.bytes.slice(0, 4),
    [expected.namespace, expected.magic0, expected.magic1, expected.version],
    `${vector.name}: header`,
  )

  const payloadLength = vector.bytes[6]
  assert.ok(payloadLength <= expected.reportSize - 8, `${vector.name}: payload length`)
  assert.ok(
    vector.bytes.slice(8 + payloadLength).every((byte) => byte === 0),
    `${vector.name}: padding must be zero`,
  )
}

const hello = fixture.vectors.find((vector) => vector.name === 'hello_host_to_device')
const helloAck = fixture.vectors.find((vector) => vector.name === 'hello_ack_all_capabilities')
const ping = fixture.vectors.find((vector) => vector.name === 'ping')
const pingAck = fixture.vectors.find((vector) => vector.name === 'ping_ack')

assert.equal(hello.bytes[5], helloAck.bytes[5], 'HELLO response sequence')
assert.equal(ping.bytes[5], pingAck.bytes[5], 'PING response sequence')
assert.deepEqual(pingAck.bytes.slice(8, 10), [ping.bytes[4], ping.bytes[5]], 'ACK payload')

console.log(`Validated ${fixture.vectors.length} OpenControl Raw HID protocol vectors.`)
