import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeGamepadDoctorReport, type DoctorReport } from '../src/doctor.js'
import {
  writeOpenControlDiagnosticReport,
  type OpenControlDoctorReport,
} from '../src/opencontrol-doctor.js'
import { SecureFileError } from '../src/secure-files.js'

let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-doctor-output-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

function diagnostic(marker: string): OpenControlDoctorReport {
  // The writer intentionally treats the already-sanitized report as opaque
  // JSON; a marker keeps this test focused on its filesystem contract.
  return { schemaVersion: 1, marker } as unknown as OpenControlDoctorReport
}

function gamepadReport(product: string): DoctorReport {
  return {
    schemaVersion: 1,
    openmicroVersion: 'test',
    platform: 'test',
    osVersion: 'test',
    controller: {
      vid: '0x1234',
      pid: '0xabcd',
      product,
      transport: 'usb',
      driver: 'generic',
    },
    results: {},
    axes: {},
    output: 'unsupported',
    timestamp: '2026-01-02T03:04:05.000Z',
  }
}

describe('doctor report output security', () => {
  it('refuses an existing diagnostic by default and overwrites only when requested', () => {
    const reportPath = path.join(directory, 'opencontrol-doctor.json')
    writeOpenControlDiagnosticReport(diagnostic('first'), reportPath)

    expect(() => writeOpenControlDiagnosticReport(diagnostic('second'), reportPath)).toThrowError(
      expect.objectContaining<Partial<SecureFileError>>({ code: 'EEXIST' }),
    )
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('"marker": "first"')

    writeOpenControlDiagnosticReport(diagnostic('second'), reportPath, { overwrite: true })
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('"marker": "second"')
    if (process.platform !== 'win32') {
      expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'never follows a diagnostic symlink in overwrite mode',
    () => {
      const reportPath = path.join(directory, 'opencontrol-doctor.json')
      const victim = path.join(directory, 'victim.json')
      fs.writeFileSync(victim, 'unchanged')
      fs.symlinkSync(victim, reportPath)

      expect(() =>
        writeOpenControlDiagnosticReport(diagnostic('replacement'), reportPath, {
          overwrite: true,
        }),
      ).toThrow(SecureFileError)
      expect(fs.readFileSync(victim, 'utf8')).toBe('unchanged')
      expect(fs.lstatSync(reportPath).isSymbolicLink()).toBe(true)
    },
  )

  it('applies the same exclusive/overwrite contract to gamepad fixture reports', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const reportPath = path.join(directory, 'gamepad.json')
    writeGamepadDoctorReport(gamepadReport('first'), { reportPath })

    expect(() => writeGamepadDoctorReport(gamepadReport('second'), { reportPath })).toThrowError(
      expect.objectContaining<Partial<SecureFileError>>({ code: 'EEXIST' }),
    )
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('"product": "first"')

    writeGamepadDoctorReport(gamepadReport('second'), { reportPath, overwrite: true })
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('"product": "second"')
  })

  it('removes terminal control sequences from HID display strings before storing or rendering', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const reportPath = path.join(directory, 'gamepad.json')
    writeGamepadDoctorReport(gamepadReport('\u001b]2;owned\u0007Game\n\u001b[31mPad'), {
      reportPath,
    })

    const output = fs.readFileSync(reportPath, 'utf8')
    expect(output).toContain('"product": "GamePad"')
    expect(output).not.toContain('owned')
    expect(output).not.toContain('31m')
    const rendered = log.mock.calls.flat().join(' ')
    expect(rendered).toContain('GamePad')
    expect(rendered).not.toContain('owned')
    expect(rendered).not.toContain('\u001b')
  })
})
