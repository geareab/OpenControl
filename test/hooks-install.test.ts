import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installClaudeHooks, installCodexHooks } from '../src/hooks-install.js'

let directory: string
let settingsPath: string
const execFileAsync = promisify(execFile)

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-hooks-'))
  settingsPath = path.join(directory, 'settings.json')
})

afterEach(() => {
  delete process.env.CODEX_HOME
  fs.rmSync(directory, { recursive: true, force: true })
})

function read(): {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
  [key: string]: unknown
} {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
}

function expectedCommand(event: string): string {
  const cli = path.resolve(fileURLToPath(new URL('../src/cli.js', import.meta.url)))
  const quote = (value: string): string =>
    process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\"'\"'")}'`
  return `${quote(path.resolve(process.execPath))} ${quote(cli)} hook ${event}`
}

describe('installClaudeHooks', () => {
  it('uses the cross-platform relay command for lifecycle and failure events', () => {
    expect(installClaudeHooks(settingsPath)).toBe('changed')
    const settings = read()
    for (const event of [
      'UserPromptSubmit',
      'Stop',
      'Notification',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'StopFailure',
      'SessionEnd',
    ]) {
      expect(settings.hooks[event], event).toHaveLength(1)
      expect(settings.hooks[event]![0]!.hooks[0]!.command).toBe(expectedCommand(event))
    }
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe('AskUserQuestion')
  })

  it('contains no fixed port, curl, shell redirection, or vibesense /hook/ marker', () => {
    installClaudeHooks(settingsPath)
    const command = read().hooks.Stop![0]!.hooks[0]!.command
    expect(command).toBe(expectedCommand('Stop'))
    expect(command).not.toMatch(/curl|48762|[;&|>]|\/hook\//)
    expect(path.isAbsolute(process.execPath)).toBe(true)
    expect(command).toContain(path.resolve(process.execPath))
    expect(command).toContain(
      path.resolve(fileURLToPath(new URL('../src/cli.js', import.meta.url))),
    )
  })

  it('is byte-idempotent', () => {
    installClaudeHooks(settingsPath)
    const first = fs.readFileSync(settingsPath, 'utf8')
    expect(installClaudeHooks(settingsPath)).toBe('unchanged')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(first)
  })

  it('preserves foreign settings and hooks', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: '/my/other/stop-hook' }] },
            { hooks: [{ type: 'command', command: 'curl http://127.0.0.1:48753/hook/Stop' }] },
          ],
        },
      }),
    )
    installClaudeHooks(settingsPath)
    const commands = read().hooks.Stop!.flatMap((group) => group.hooks.map((hook) => hook.command))
    expect(commands).toContain('/my/other/stop-hook')
    expect(commands).toContain('curl http://127.0.0.1:48753/hook/Stop')
    expect(commands).toContain(expectedCommand('Stop'))
  })

  it('replaces both stale curl and stale relay entries', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'curl http://127.0.0.1:48762/om-hook/old' }] },
            { hooks: [{ type: 'command', command: 'opencontrol hook Stop --old' }] },
          ],
        },
      }),
    )
    installClaudeHooks(settingsPath)
    expect(read().hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: expectedCommand('Stop') }] },
    ])
  })

  it('leaves invalid JSON untouched', () => {
    fs.writeFileSync(settingsPath, '{not json')
    expect(installClaudeHooks(settingsPath)).toBe('failed')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{not json')
  })

  it('never throws or overwrites a non-object settings root', () => {
    fs.writeFileSync(settingsPath, 'null')
    expect(installClaudeHooks(settingsPath)).toBe('failed')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('null')
  })

  it.skipIf(process.platform === 'win32')(
    'creates private directories and files even with a permissive umask',
    () => {
      settingsPath = path.join(directory, 'new-claude-home', 'settings.json')
      const previousUmask = process.umask(0o002)
      try {
        expect(installClaudeHooks(settingsPath)).toBe('changed')
      } finally {
        process.umask(previousUmask)
      }
      expect(fs.statSync(path.dirname(settingsPath)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'preserves stricter owner permissions and removes group/other access',
    () => {
      fs.writeFileSync(settingsPath, '{"model":"test"}')
      fs.chmodSync(settingsPath, 0o440)
      expect(installClaudeHooks(settingsPath)).toBe('changed')
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o400)

      fs.chmodSync(settingsPath, 0o644)
      expect(installClaudeHooks(settingsPath)).toBe('unchanged')
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600)
    },
  )

  it.skipIf(process.platform === 'win32')('rejects a symlink without changing its target', () => {
    const victim = path.join(directory, 'victim.json')
    fs.writeFileSync(victim, 'do not replace')
    fs.symlinkSync(victim, settingsPath)
    expect(installClaudeHooks(settingsPath)).toBe('failed')
    expect(fs.readFileSync(victim, 'utf8')).toBe('do not replace')
    expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true)
  })

  it('rejects a non-regular hook destination', () => {
    fs.mkdirSync(settingsPath)
    expect(installClaudeHooks(settingsPath)).toBe('failed')
    expect(fs.statSync(settingsPath).isDirectory()).toBe(true)
  })

  it('allows concurrent installers without fixed temporary-file collisions', async () => {
    const moduleUrl = pathToFileURL(path.resolve('src/hooks-install.ts')).href
    const script = `import { installClaudeHooks } from ${JSON.stringify(moduleUrl)}; if (installClaudeHooks(${JSON.stringify(settingsPath)}) === 'failed') process.exitCode = 1`
    await Promise.all([
      execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script]),
      execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script]),
    ])
    expect(read().hooks.Stop![0]!.hooks[0]!.command).toBe(expectedCommand('Stop'))
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('installCodexHooks', () => {
  it('creates the four supported hooks with the portable relay command', () => {
    expect(installCodexHooks(settingsPath)).toBe('changed')
    const settings = read()
    expect(Object.keys(settings.hooks).sort()).toEqual(
      ['PermissionRequest', 'PostToolUse', 'Stop', 'UserPromptSubmit'].sort(),
    )
    for (const [event, groups] of Object.entries(settings.hooks)) {
      expect(groups).toHaveLength(1)
      expect(groups[0]!.matcher, event).toBeUndefined()
      expect(groups[0]!.hooks[0]!.command).toBe(expectedCommand(event))
    }
  })

  it('is byte-idempotent', () => {
    installCodexHooks(settingsPath)
    const first = fs.readFileSync(settingsPath, 'utf8')
    expect(installCodexHooks(settingsPath)).toBe('unchanged')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(first)
  })

  it('uses CODEX_HOME and preserves foreign data and hooks', () => {
    process.env.CODEX_HOME = directory
    settingsPath = path.join(directory, 'hooks.json')
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        custom: true,
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '/other/stop-hook' }] }] },
      }),
    )
    installCodexHooks()
    expect(read().custom).toBe(true)
    expect(read().hooks.Stop).toHaveLength(2)
  })

  it('replaces legacy OpenMicro hooks and preserves vibesense/webhooks', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'curl http://127.0.0.1:48762/om-hook/Stop -H "X-Openmicro-Instance-Id: old"',
                },
              ],
            },
            { hooks: [{ type: 'command', command: 'curl http://127.0.0.1:48753/hook/Stop' }] },
            { hooks: [{ type: 'command', command: 'curl https://example.com/hook/Stop' }] },
          ],
        },
      }),
    )
    installCodexHooks(settingsPath)
    const commands = read().hooks.Stop!.flatMap((group) => group.hooks.map((hook) => hook.command))
    expect(commands).toContain('curl http://127.0.0.1:48753/hook/Stop')
    expect(commands).toContain('curl https://example.com/hook/Stop')
    expect(commands.filter((command) => command === expectedCommand('Stop'))).toHaveLength(1)
  })

  it('leaves invalid JSON untouched', () => {
    fs.writeFileSync(settingsPath, '{broken')
    expect(installCodexHooks(settingsPath)).toBe('failed')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{broken')
  })

  it('never throws or overwrites a non-object hooks root', () => {
    fs.writeFileSync(settingsPath, 'null')
    expect(installCodexHooks(settingsPath)).toBe('failed')
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('null')
  })
})
