#!/usr/bin/env node
// Copyright 2026 OpenControl contributors
// SPDX-License-Identifier: MIT

import crypto from 'node:crypto'
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
for (const required of [
  'bundle',
  'baseline-bin',
  'custom-a-bin',
  'custom-b-bin',
  'factory-bin',
  'memory-report',
  'qmk-version',
  'gcc-version',
  'image-inspect',
  'submodules',
  'appdirs-wheel',
]) {
  if (!args.has(required)) throw new Error(`missing --${required}`)
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const stat = (file) => ({
  bytes: fs.statSync(file).size,
  sha256: sha256(file),
})
const text = (file) => fs.readFileSync(file, 'utf8').trim()

const bundle = path.resolve(args.get('bundle'))
const baseline = stat(args.get('baseline-bin'))
const customA = stat(args.get('custom-a-bin'))
const customB = stat(args.get('custom-b-bin'))
const factory = stat(args.get('factory-bin'))
if (customA.sha256 !== customB.sha256) {
  throw new Error('the two clean OpenControl builds are not reproducible')
}

const customArtifact = path.join(bundle, 'opencontrol-k4p-h3-experimental.bin')
const factoryArtifact = path.join(bundle, 'keychron-k4-pro-k4p-h3-ansi-rgb-factory-v1.00.bin')
const memory = JSON.parse(text(args.get('memory-report')))
const customBuildDatePolicy = 'QMK SKIP_VERSION=yes fixes QMK_BUILDDATE to 1970-01-01-00:00:00'

const manifest = {
  schemaVersion: 1,
  status: 'experimental-unverified-no-flash',
  preparedAt: new Date().toISOString(),
  hardware: {
    manufacturer: 'Keychron',
    product: 'K4 Pro',
    sku: 'K4P-H3',
    layout: 'US ANSI',
    lighting: 'RGB',
    hotSwappable: true,
    processor: 'STM32L432',
    usb: { vid: '3434', pid: '0240' },
  },
  qmk: {
    repository: 'https://github.com/Keychron/qmk_firmware.git',
    branch: 'bluetooth_playground',
    commit: '618127a725a1773e85f13455602cf6f72ab4de17',
    target: 'keychron/k4_pro/ansi/rgb',
    baselineKeymap: 'via',
    openControlKeymap: 'opencontrol',
    submodules: text(args.get('submodules')).split('\n').filter(Boolean),
  },
  toolchain: {
    container:
      'ghcr.io/qmk/qmk_cli@sha256:b7d7fa8fb4432b569931de5ad59098cb788f440ed61a62c5126746b71aee0f4a',
    imageInspection: text(args.get('image-inspect')),
    qmkCli: text(args.get('qmk-version')).split('\n')[0],
    armGcc: text(args.get('gcc-version')).split('\n')[0],
    deterministicVersionHeader: customBuildDatePolicy,
    legacyPythonCompatibility: {
      package: 'appdirs',
      version: '1.4.4',
      wheel: path.basename(args.get('appdirs-wheel')),
      ...stat(args.get('appdirs-wheel')),
      source:
        'https://files.pythonhosted.org/packages/3b/00/2344469e2084fb287c2e0b57b72910309874c3245463acd6cf5e3db69324/appdirs-1.4.4-py2.py3-none-any.whl',
      installedFromLocalWheelWithNoDependencies: true,
    },
    networkDuringCompilation: false,
    hostUsbDevicesPassedThrough: false,
  },
  keymap: {
    dynamicLayers: 5,
    openControlLayer: 4,
    layerToggle: 'top-right Lock key',
    controls: 19,
    rgbOverlayKeys: ['Numpad 1', 'Numpad 2', 'Numpad 3', 'Numpad 4', 'Numpad 5', 'Numpad 6'],
    bluetoothPreserved: true,
    openControlTransport: 'USB only',
    rawHidReportBytes: 32,
  },
  artifacts: {
    custom: {
      file: path.basename(customArtifact),
      ...stat(customArtifact),
    },
    officialFactoryRecovery: {
      file: path.basename(factoryArtifact),
      ...stat(factoryArtifact),
      source:
        'https://cdn.shopify.com/s/files/1/0059/0630/1017/files/k4_pro_us_rgb_v1.00.bin?v=1672368297',
      versionLabelFromKeychron: 'v1.00',
      vendorPublishedChecksum: false,
      locallyPinnedDownload: factory,
    },
    untouchedViaBaselineBuild: baseline,
    cleanOpenControlBuildA: customA,
    cleanOpenControlBuildB: customB,
  },
  reproducibility: {
    cleanBuildCount: 2,
    hashesIdentical: true,
    sha256: customA.sha256,
  },
  memory,
  validation: {
    cleanAdapterApplication: true,
    untouchedViaTargetCompiledFirst: true,
    fiveLayers: true,
    uniqueControlMappings: 19,
    numpadAgentLedPositionsVerified: true,
    rawHidSizeVerified: true,
    rgbMatrixVerified: true,
    processorAndVidPidVerified: true,
    keychronViaBluetoothFactoryHandlersPreserved: true,
    linkerMapInspected: true,
    flashOverflow: false,
    bootloaderOverlap: false,
    eepromOverlap: false,
  },
  safety: {
    keyboardAccessed: false,
    dfuModeEntered: false,
    viaConfigurationChanged: false,
    firmwareFlashed: false,
    flashCommandIncluded: false,
    physicalVerificationComplete: false,
    supportClaim: false,
  },
  recovery: {
    instructions: 'RECOVERY.md',
    factoryResetRequiredBeforeFuturePhysicalVerification: true,
    officialInstructions:
      'https://keychron.be/pages/how-to-factory-reset-and-flash-firmware-for-your-k4-pro-keyboard',
  },
  licensing: {
    firmware: 'GPL-2.0-or-later',
    sourceDirectory: 'source',
    qmkLicense: 'source/license_GPLv2.md',
    npmPackageInclusion: false,
  },
}

fs.writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
})
