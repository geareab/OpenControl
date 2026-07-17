import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readOwnedRegularFile,
  SecureFileError,
} from '../src/secure-files.js'

let directory: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-secure-files-'))
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('secure file primitives', () => {
  it.skipIf(process.platform === 'win32')(
    'creates 0700 directories and 0600 files under umask 0002',
    () => {
      const privateDirectory = path.join(directory, 'private')
      const file = path.join(privateDirectory, 'report.json')
      const previousUmask = process.umask(0o002)
      try {
        ensurePrivateDirectory(privateDirectory)
        atomicWritePrivateFile(file, '{"ok":true}\n')
      } finally {
        process.umask(previousUmask)
      }

      expect(fs.statSync(privateDirectory).mode & 0o777).toBe(0o700)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(readOwnedRegularFile(file)?.contents.toString('utf8')).toBe('{"ok":true}\n')
    },
  )

  it('refuses existing output unless overwrite is explicit', () => {
    const file = path.join(directory, 'report.json')
    atomicWritePrivateFile(file, 'first')
    expect(() => atomicWritePrivateFile(file, 'second')).toThrowError(
      expect.objectContaining<Partial<SecureFileError>>({ code: 'EEXIST' }),
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('first')

    atomicWritePrivateFile(file, 'second', { overwrite: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('second')
  })

  it.skipIf(process.platform === 'win32')(
    'never follows an output symlink, including in overwrite mode',
    () => {
      const victim = path.join(directory, 'victim')
      const file = path.join(directory, 'report.json')
      fs.writeFileSync(victim, 'private data')
      fs.symlinkSync(victim, file)

      expect(() => atomicWritePrivateFile(file, 'replacement')).toThrow(SecureFileError)
      expect(() => atomicWritePrivateFile(file, 'replacement', { overwrite: true })).toThrow(
        SecureFileError,
      )
      expect(fs.readFileSync(victim, 'utf8')).toBe('private data')
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true)
    },
  )

  it('rejects non-regular destinations and cleans randomized temporaries', () => {
    const file = path.join(directory, 'report.json')
    fs.mkdirSync(file)
    expect(() => atomicWritePrivateFile(file, 'replacement', { overwrite: true })).toThrow(
      SecureFileError,
    )
    expect(fs.readdirSync(directory)).toEqual(['report.json'])
  })
})
