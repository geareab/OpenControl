import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixSpawnHelperPermissions, spawnAgentProcess } from '../src/pty.js'

const EXEC_BITS = 0o111

let tmp: string

afterEach(() => {
  vi.restoreAllMocks()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

function makePrebuilds(entries: Record<string, string[]>): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-pty-'))
  const packageDirectory = path.join(tmp, 'node-pty')
  const prebuildsDirectory = path.join(packageDirectory, 'prebuilds')
  fs.mkdirSync(prebuildsDirectory, { recursive: true, mode: 0o700 })
  fs.chmodSync(packageDirectory, 0o700)
  fs.chmodSync(prebuildsDirectory, 0o700)
  for (const [dir, files] of Object.entries(entries)) {
    fs.mkdirSync(path.join(prebuildsDirectory, dir), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.join(prebuildsDirectory, dir), 0o700)
    for (const file of files) {
      fs.writeFileSync(path.join(prebuildsDirectory, dir, file), '')
      fs.chmodSync(path.join(prebuildsDirectory, dir, file), 0o644)
    }
  }
  return prebuildsDirectory
}

describe.skipIf(process.platform === 'win32')('fixSpawnHelperPermissions', () => {
  it('makes spawn-helper executable in every prebuild dir', () => {
    const dir = makePrebuilds({
      'darwin-arm64': ['spawn-helper'],
      'darwin-x64': ['spawn-helper'],
    })
    fixSpawnHelperPermissions(dir)
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const mode = fs.statSync(path.join(dir, arch, 'spawn-helper')).mode
      expect(mode & EXEC_BITS).not.toBe(0)
    }
  })

  it('adds only the user execute bit and preserves stricter group/other permissions', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    fs.chmodSync(helper, 0o640)

    fixSpawnHelperPermissions(dir)

    expect(fs.statSync(helper).mode & 0o777).toBe(0o740)
  })

  it('removes group/other write access from an owned executable helper', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    fs.chmodSync(helper, 0o775)

    fixSpawnHelperPermissions(dir)

    expect(fs.statSync(helper).mode & 0o777).toBe(0o755)
  })

  it('never follows a spawn-helper symlink', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['target'] })
    const target = path.join(dir, 'darwin-arm64', 'target')
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    fs.symlinkSync(target, helper)

    expect(() => fixSpawnHelperPermissions(dir)).toThrow(/Cannot safely enable node-pty helper/)
    expect(fs.statSync(target).mode & EXEC_BITS).toBe(0)
  })

  it('rejects a symlinked prebuild directory', () => {
    const dir = makePrebuilds({ target: ['spawn-helper'] })
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'darwin-arm64'), 'dir')

    expect(() => fixSpawnHelperPermissions(dir)).toThrow(/platform directory .* is a symbolic link/)
    expect(fs.statSync(path.join(dir, 'target', 'spawn-helper')).mode & EXEC_BITS).toBe(0)
  })

  it('removes group/other write access from owned package, prebuilds, and platform directories', () => {
    for (const target of ['package', 'prebuilds', 'platform'] as const) {
      const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
      const unsafe =
        target === 'package'
          ? path.dirname(dir)
          : target === 'prebuilds'
            ? dir
            : path.join(dir, 'darwin-arm64')
      fs.chmodSync(unsafe, 0o770)

      fixSpawnHelperPermissions(dir)

      expect(fs.statSync(unsafe).mode & 0o777, target).toBe(0o750)
      expect(fs.statSync(path.join(dir, 'darwin-arm64', 'spawn-helper')).mode & EXEC_BITS).not.toBe(
        0,
      )
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    tmp = ''
  })

  it('hardens a writable owned ancestor and rechecks it before spawn', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const ancestor = path.dirname(path.dirname(dir))
    fs.chmodSync(ancestor, 0o770)

    const revalidate = fixSpawnHelperPermissions(dir)
    expect(fs.statSync(ancestor).mode & 0o777).toBe(0o750)

    fs.chmodSync(ancestor, 0o770)
    revalidate()
    expect(fs.statSync(ancestor).mode & 0o777).toBe(0o750)
  })

  it('rejects a symlinked prebuilds root', () => {
    const real = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const linked = path.join(path.dirname(real), 'linked-prebuilds')
    fs.symlinkSync(real, linked, 'dir')

    expect(() => fixSpawnHelperPermissions(linked)).toThrow(/symbolic link/)
    expect(fs.statSync(path.join(real, 'darwin-arm64', 'spawn-helper')).mode & EXEC_BITS).toBe(0)
  })

  it('detects a helper path swap after adjusting its permissions', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    const originalFchmod = fs.fchmodSync.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'fchmodSync').mockImplementation((descriptor, mode) => {
      originalFchmod(descriptor, mode)
      if (swapped) return
      swapped = true
      fs.renameSync(helper, `${helper}.checked`)
      fs.writeFileSync(helper, 'replacement', { mode: 0o700 })
    })

    expect(() => fixSpawnHelperPermissions(dir)).toThrow(
      /path changed while it was being validated/,
    )
  })

  it('fails closed if the helper disappears after its permissions are adjusted', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    const originalFchmod = fs.fchmodSync.bind(fs)
    vi.spyOn(fs, 'fchmodSync').mockImplementation((descriptor, mode) => {
      originalFchmod(descriptor, mode)
      fs.renameSync(helper, `${helper}.removed`)
    })

    expect(() => fixSpawnHelperPermissions(dir)).toThrow(/Cannot safely enable node-pty helper/)
  })

  it('returns a final revalidator for the check immediately before spawn', () => {
    const dir = makePrebuilds({ 'darwin-arm64': ['spawn-helper'] })
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    const revalidate = fixSpawnHelperPermissions(dir)
    fs.renameSync(helper, `${helper}.checked`)
    fs.writeFileSync(helper, 'replacement', { mode: 0o700 })

    expect(() => revalidate()).toThrow(/path changed while it was being validated/)
  })

  it('rejects a non-regular spawn-helper', () => {
    const dir = makePrebuilds({ 'darwin-arm64': [] })
    const helper = path.join(dir, 'darwin-arm64', 'spawn-helper')
    fs.mkdirSync(helper)

    expect(() => fixSpawnHelperPermissions(dir)).toThrow(/not a regular file/)
  })

  it('skips prebuild dirs without a spawn-helper and still fixes the rest', () => {
    const dir = makePrebuilds({
      'linux-x64': ['pty.node'],
      'darwin-arm64': ['spawn-helper'],
    })
    fixSpawnHelperPermissions(dir)
    const mode = fs.statSync(path.join(dir, 'darwin-arm64', 'spawn-helper')).mode
    expect(mode & EXEC_BITS).not.toBe(0)
  })

  it('is a no-op when the prebuilds dir is missing', () => {
    expect(() => fixSpawnHelperPermissions('/nonexistent/prebuilds')).not.toThrow()
  })
})

describe('spawnAgentProcess', () => {
  it('spawns the selected harness and adds the wrapper id to the inherited environment', () => {
    let call: { command: string; args: string[]; env: Record<string, string> } | undefined
    let revalidated = false
    const spawn = ((command: string, args: string[], options: { env: Record<string, string> }) => {
      expect(revalidated).toBe(true)
      call = { command, args, env: options.env }
      return {}
    }) as Parameters<typeof spawnAgentProcess>[0]

    spawnAgentProcess(spawn, 'codex', ['--model', 'gpt-5.4'], 'wrapper-123', () => {
      revalidated = true
    })

    expect(call).toMatchObject({
      command: 'codex',
      args: ['--model', 'gpt-5.4'],
      env: {
        OPENCONTROL_INSTANCE_ID: 'wrapper-123',
        OPENMICRO_INSTANCE_ID: 'wrapper-123',
      },
    })
    expect(call!.env.PATH).toBe(process.env.PATH)
  })

  it('leaves the inherited environment unchanged when no wrapper id is requested', () => {
    const previous = process.env.OPENMICRO_INSTANCE_ID
    process.env.OPENMICRO_INSTANCE_ID = 'existing-value'
    let env: Record<string, string> | undefined
    const spawn = ((
      _command: string,
      _args: string[],
      options: { env: Record<string, string> },
    ) => {
      env = options.env
      return {}
    }) as Parameters<typeof spawnAgentProcess>[0]

    try {
      spawnAgentProcess(spawn, 'claude', [], undefined)
      expect(env!.OPENMICRO_INSTANCE_ID).toBe('existing-value')
    } finally {
      if (previous === undefined) delete process.env.OPENMICRO_INSTANCE_ID
      else process.env.OPENMICRO_INSTANCE_ID = previous
    }
  })
})
