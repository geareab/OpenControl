import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/layers.js'
import type { OpenMicroConfig } from '../src/layers.js'

let dir: string
let configPath: string
let realHome: string | undefined
let realUserProfile: string | undefined
let realLocalAppData: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-config-'))
  configPath = path.join(dir, 'config.json')
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  realLocalAppData = process.env.LOCALAPPDATA
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  if (realHome !== undefined) process.env.HOME = realHome
  else delete process.env.HOME
  if (realUserProfile !== undefined) process.env.USERPROFILE = realUserProfile
  else delete process.env.USERPROFILE
  if (realLocalAppData !== undefined) process.env.LOCALAPPDATA = realLocalAppData
  else delete process.env.LOCALAPPDATA
})

describe('loadConfig / saveConfig', () => {
  it('creates DEFAULT_CONFIG when the file does not exist', () => {
    expect(fs.existsSync(configPath)).toBe(false)
    const config = loadConfig(configPath)
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(fs.existsSync(configPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(DEFAULT_CONFIG)
  })

  it('uses the platform-specific private application-data directory', () => {
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    process.env.LOCALAPPDATA = path.join(dir, 'local-app-data')
    const config = loadConfig()
    expect(config).toEqual(DEFAULT_CONFIG)
    const expected =
      process.platform === 'win32'
        ? path.join(dir, 'local-app-data', 'OpenControl', 'config.json')
        : path.join(dir, '.opencontrol', 'config.json')
    expect(fs.existsSync(expected)).toBe(true)
  })

  it('imports a legacy OpenMicro config once without modifying it', () => {
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    process.env.LOCALAPPDATA = path.join(dir, 'local-app-data')
    const legacyPath = path.join(dir, '.openmicro', 'config.json')
    const legacy = {
      layers: DEFAULT_CONFIG.layers,
      workflows: { migrated: 'keep this workflow' },
    }
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, JSON.stringify(legacy))

    const config = loadConfig()
    expect(config.schemaVersion).toBe(2)
    expect(config.hardwareEnrollmentRequired).toBe(true)
    expect(config.inputs.qmk.enabled).toBe(false)
    expect(config.inputs.gamepad.enabled).toBe(false)
    expect(config.workflows).toEqual(legacy.workflows)
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(JSON.stringify(legacy))
    const expected =
      process.platform === 'win32'
        ? path.join(dir, 'local-app-data', 'OpenControl', 'config.json')
        : path.join(dir, '.opencontrol', 'config.json')
    expect(fs.existsSync(expected)).toBe(true)
  })

  it('round-trips a saved config exactly', () => {
    const custom: OpenMicroConfig = {
      ...DEFAULT_CONFIG,
      layers: [
        { name: 'My Layer', color: { r: 1, g: 2, b: 3 }, bindings: { south: { type: 'accept' } } },
        ...DEFAULT_CONFIG.layers.slice(1),
      ] as OpenMicroConfig['layers'],
      workflows: { custom: 'do the thing' },
    }
    saveConfig(custom, configPath)
    expect(loadConfig(configPath)).toEqual(custom)
  })

  it('migrates schema v1 mappings but disables hardware pending re-enrollment', () => {
    const versionOne = {
      ...DEFAULT_CONFIG,
      schemaVersion: 1,
      inputs: {
        terminal: { enabled: true, bindings: { 'command.send': 'G1syNH4=' }, escapeTimeoutMs: 25 },
        qmk: { enabled: true, serialNumber: 'old-serial' },
        gamepad: { enabled: true },
      },
      controls: { custom: { type: 'prompt', text: 'keep me' } },
      workflows: { migrated: 'keep workflow' },
    }
    delete (versionOne as Partial<typeof DEFAULT_CONFIG>).hardwareEnrollmentRequired
    fs.writeFileSync(configPath, JSON.stringify(versionOne))

    const migrated = loadConfig(configPath)
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      hardwareEnrollmentRequired: true,
      inputs: {
        terminal: versionOne.inputs.terminal,
        qmk: { enabled: false },
        gamepad: { enabled: false },
      },
      controls: versionOne.controls,
      workflows: versionOne.workflows,
    })
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(migrated)
  })

  it('rejects schema v2 configs that enable unenrolled hardware', () => {
    const invalid = structuredClone(DEFAULT_CONFIG)
    invalid.inputs.qmk.enabled = true
    fs.writeFileSync(configPath, JSON.stringify(invalid))
    expect(() => loadConfig(configPath)).toThrow(/requires an enrolled device/)
  })

  it('rejects enrolled device labels containing terminal control sequences', () => {
    const invalid = structuredClone(DEFAULT_CONFIG)
    invalid.inputs.qmk.device = {
      fingerprint: 'a'.repeat(64),
      vendorId: 0x1209,
      productId: 0x0001,
      transport: 'usb',
      label: '\u001b]8;;https://example.invalid\u0007spoofed\u001b]8;;\u0007',
      generic: false,
    }
    fs.writeFileSync(configPath, JSON.stringify(invalid))
    expect(() => loadConfig(configPath)).toThrow(/device label must not contain terminal control/)
  })

  it('writes atomically via a tmp file that is renamed into place', () => {
    saveConfig(DEFAULT_CONFIG, configPath)
    const entries = fs.readdirSync(dir)
    expect(entries).toEqual(['config.json'])
  })

  it('creates private config directories and files even under a permissive umask', () => {
    if (process.platform === 'win32') return
    const nestedPath = path.join(dir, 'private', 'config.json')
    const previous = process.umask(0o002)
    try {
      saveConfig(DEFAULT_CONFIG, nestedPath)
    } finally {
      process.umask(previous)
    }
    expect(fs.statSync(path.dirname(nestedPath)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(nestedPath).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses config symlinks without changing their targets',
    () => {
      const target = path.join(dir, 'target.json')
      fs.writeFileSync(target, 'do not replace')
      fs.symlinkSync(target, configPath)

      expect(() => saveConfig(DEFAULT_CONFIG, configPath)).toThrow(/symbolic-link/)
      expect(() => loadConfig(configPath)).toThrow(/symbolic-link/)
      expect(fs.readFileSync(target, 'utf8')).toBe('do not replace')
    },
  )

  it('throws a clear error on invalid JSON and never touches the file', () => {
    fs.writeFileSync(configPath, '{ not json')
    expect(() => loadConfig(configPath)).toThrow(/not valid JSON/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ not json')
  })

  it('throws a clear error on schema-invalid config and never touches the file', () => {
    const bad = JSON.stringify({ layers: [], workflows: {} })
    fs.writeFileSync(configPath, bad)
    expect(() => loadConfig(configPath)).toThrow(/invalid config/)
    expect(fs.readFileSync(configPath, 'utf8')).toBe(bad)
  })

  it('rejects an unknown binding key', () => {
    const bad = JSON.stringify({
      layers: [
        {
          name: 'L1',
          color: { r: 0, g: 0, b: 0 },
          bindings: { not_a_control: { type: 'accept' } },
        },
        ...DEFAULT_CONFIG.layers.slice(1),
      ],
      workflows: {},
    })
    fs.writeFileSync(configPath, bad)
    expect(() => loadConfig(configPath)).toThrow(/invalid config/)
  })
})
