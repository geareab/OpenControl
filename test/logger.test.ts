import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileLogger } from '../src/logger.js'

let directory: string
let logFile: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-logger-'))
  logFile = path.join(directory, 'logs', 'opencontrol.log')
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('file logger security', () => {
  it('writes privately and redacts credentials and action payloads', () => {
    const logger = createFileLogger({
      logFile,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })
    logger.warn('request failed Bearer top-secret', {
      authorization: 'Bearer detail-secret',
      accessToken: 'token-secret',
      actionPayload: {
        type: 'prompt',
        text: 'do not log this prompt',
      },
      safe: 'visible',
    })
    logger.warn('unsupported action', {
      type: 'workflow',
      presetId: 'private-workflow-name',
    })
    logger.warn('unsupported raw action', {
      type: 'keys',
      bytes: 'private-terminal-bytes',
    })

    const output = fs.readFileSync(logFile, 'utf8')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('"safe":"visible"')
    expect(output).not.toMatch(
      /top-secret|detail-secret|token-secret|do not log this prompt|private-workflow-name|private-terminal-bytes/,
    )
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(logFile)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600)
    }
  })

  it('suppresses repeated identical errors and records a bounded summary', () => {
    const logger = createFileLogger({
      logFile,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })
    const error = new Error('same failure')
    logger.error('worker failed', error)
    logger.error('worker failed', error)
    logger.error('worker failed', error)
    logger.info('worker recovered')

    const output = fs.readFileSync(logFile, 'utf8')
    expect(output.match(/\[error\] worker failed/g)).toHaveLength(1)
    expect(output).toContain('previous log message repeated 2 times')
    expect(output).toContain('[info] worker recovered')
  })

  it('redacts complete credential headers, URL userinfo, and escaped JSON values', () => {
    const logger = createFileLogger({
      logFile,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })
    logger.error(
      [
        'Authorization: Basic basic-secret',
        'Proxy-Authorization: Digest username="bob", response="digest-secret"',
        'Cookie: session=cookie-secret; csrf=csrf-secret',
        'Set-Cookie: sid=set-cookie-secret; Path=/; HttpOnly',
        'URL https://alice:url-secret@example.com/path',
      ].join('\n'),
    )
    logger.warn(
      String.raw`escaped {\"Authorization\":\"Basic escaped-basic-secret\",\"Cookie\":\"sid=escaped-cookie-secret\",\"safe\":\"escaped-visible\"} https:\/\/user:escaped-url-secret@example.com`,
    )
    logger.info(
      'json {"Authorization":"Digest username=\\"bob\\", response=\\"json-digest-secret\\"","safe":"json-visible"}',
    )
    logger.error('"Authorization: Basic quoted-basic-secret"')
    logger.error(
      String.raw`\"Proxy-Authorization: Digest username=bob, response=quoted-digest-secret\"`,
    )

    const output = fs.readFileSync(logFile, 'utf8')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('escaped-visible')
    expect(output).toContain('json-visible')
    expect(output).not.toMatch(
      /basic-secret|digest-secret|cookie-secret|csrf-secret|set-cookie-secret|url-secret|escaped-basic-secret|escaped-cookie-secret|escaped-url-secret|json-digest-secret|quoted-basic-secret|quoted-digest-secret|username="bob"|alice:/,
    )
  })

  it('rotates at the configured boundary and retains exactly one backup', () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.writeFileSync(logFile, '')
    if (process.platform !== 'win32') fs.chmodSync(logFile, 0o644)
    const logger = createFileLogger({
      logFile,
      maxBytes: 220,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    })
    logger.info(`first-${'a'.repeat(120)}`)
    logger.info(`second-${'b'.repeat(120)}`)
    logger.info(`third-${'c'.repeat(120)}`)

    expect(fs.existsSync(`${logFile}.1`)).toBe(true)
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toContain('second-')
    expect(fs.readFileSync(logFile, 'utf8')).toContain('third-')
    expect(fs.readdirSync(path.dirname(logFile)).sort()).toEqual([
      'opencontrol.log',
      'opencontrol.log.1',
    ])
    if (process.platform !== 'win32') {
      expect(fs.statSync(`${logFile}.1`).mode & 0o777).toBe(0o600)
    }
  })

  it.skipIf(process.platform === 'win32')('does not follow a log symlink', () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const victim = path.join(directory, 'victim')
    fs.writeFileSync(victim, 'leave me alone')
    fs.symlinkSync(victim, logFile)

    createFileLogger({ logFile }).error('must be dropped')

    expect(fs.readFileSync(victim, 'utf8')).toBe('leave me alone')
    expect(fs.lstatSync(logFile).isSymbolicLink()).toBe(true)
  })
})
