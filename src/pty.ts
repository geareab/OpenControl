// Spawns the selected agent under a pty and passes its TUI through untouched: user
// keyboard → pty, pty output → stdout, window resizes forwarded. Controller
// keystrokes are just extra writes into the same pty.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as pty from 'node-pty'
import { logger } from './logger.js'

function permissionError(helper: string, reason: string): Error {
  return new Error(
    `Cannot safely enable node-pty helper ${helper}: ${reason}. ` +
      'Reinstall OpenControl as the current user or correct the node-pty installation permissions.',
  )
}

interface TrustedDirectory {
  path: string
  stats: fs.Stats
  label: string
  allowRootOwnedSticky: boolean
  trustedRootUid: number
}

interface TrustedHelper {
  path: string
  stats: fs.Stats
  currentUid: number
  currentGroups: ReadonlySet<number>
  trustedRootUid: number
}

// Some node-pty archives have shipped spawn-helper without its user execute
// bit. Resolve the installed package instead of trusting PATH, verify every
// pathname component that can replace it, and change only an already-open,
// current-user-owned file. The returned check must run immediately before
// node-pty resolves and executes the helper by pathname.
export function fixSpawnHelperPermissions(prebuildsDir?: string): () => void {
  const noOp = (): void => {}
  if (process.platform === 'win32') return noOp

  let requestedDir: string
  try {
    requestedDir =
      prebuildsDir ??
      path.join(
        path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),
        'prebuilds',
      )
  } catch (error) {
    throw permissionError('node-pty/prebuilds/spawn-helper', String(error))
  }

  let ancestorDirectories: TrustedDirectory[]
  let packageDirectory: TrustedDirectory
  let prebuildsDirectory: TrustedDirectory
  try {
    fs.lstatSync(requestedDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return noOp // source build
    throw permissionError(requestedDir, String(error))
  }

  try {
    const packagePath = path.dirname(path.resolve(requestedDir))
    const trustedRootUid = fs.lstatSync(path.parse(packagePath).root).uid
    ancestorDirectories = inspectTrustedAncestorChain(packagePath, trustedRootUid)
    packageDirectory = inspectTrustedDirectory(
      packagePath,
      'node-pty package directory',
      false,
      trustedRootUid,
    )
    prebuildsDirectory = inspectTrustedDirectory(
      requestedDir,
      'node-pty prebuilds directory',
      false,
      trustedRootUid,
    )
    if (path.dirname(prebuildsDirectory.path) !== packageDirectory.path) {
      throw permissionError(
        requestedDir,
        'the resolved prebuilds directory escapes the node-pty package directory',
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot safely enable')) throw error
    throw permissionError(requestedDir, String(error))
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(prebuildsDirectory.path, { withFileTypes: true })
    revalidateTrustedDirectories([...ancestorDirectories, packageDirectory, prebuildsDirectory])
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot safely enable')) throw error
    throw permissionError(prebuildsDirectory.path, String(error))
  }

  const platformDirectories: TrustedDirectory[] = []
  const trustedHelpers: TrustedHelper[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const platformPath = path.join(prebuildsDirectory.path, entry.name)
    let platformDirectory: TrustedDirectory
    try {
      platformDirectory = inspectTrustedDirectory(
        platformPath,
        `node-pty platform directory ${entry.name}`,
        false,
        packageDirectory.trustedRootUid,
      )
      if (path.dirname(platformDirectory.path) !== prebuildsDirectory.path) {
        throw permissionError(
          platformPath,
          'the resolved platform directory escapes the node-pty prebuilds directory',
        )
      }
      platformDirectories.push(platformDirectory)
      revalidateTrustedDirectories([...ancestorDirectories, packageDirectory, prebuildsDirectory])
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot safely enable')) throw error
      throw permissionError(platformPath, String(error))
    }

    const helper = path.join(platformDirectory.path, 'spawn-helper')
    let pathStat: fs.Stats
    try {
      pathStat = fs.lstatSync(helper)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw permissionError(helper, String(error))
    }

    let descriptor: number | undefined
    try {
      if (pathStat.isSymbolicLink()) {
        throw permissionError(helper, 'the helper is a symbolic link')
      }
      if (!pathStat.isFile()) throw permissionError(helper, 'it is not a regular file')
      if (fs.realpathSync(helper) !== path.resolve(helper)) {
        throw permissionError(helper, 'the helper path traverses a symbolic link')
      }

      descriptor = fs.openSync(helper, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile()) throw permissionError(helper, 'it is not a regular file')
      assertSameIdentity(pathStat, stat, helper)
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid
      const currentGroups =
        typeof process.getgroups === 'function' ? new Set(process.getgroups()) : new Set<number>()
      const trustedRootUid = packageDirectory.trustedRootUid
      const canExecute =
        (stat.uid === currentUid && (stat.mode & 0o100) !== 0) ||
        (stat.uid !== currentUid && currentGroups.has(stat.gid) && (stat.mode & 0o010) !== 0) ||
        (stat.uid !== currentUid && !currentGroups.has(stat.gid) && (stat.mode & 0o001) !== 0)
      if (stat.uid !== currentUid) {
        if (stat.uid !== trustedRootUid) {
          throw permissionError(helper, 'it is not owned by the current user or root')
        }
        if (!canExecute || (stat.mode & 0o022) !== 0) {
          throw permissionError(helper, 'the root-owned helper is not safely executable')
        }
      } else {
        const safeMode = (stat.mode | 0o100) & ~0o022
        if (!canExecute || safeMode !== stat.mode) fs.fchmodSync(descriptor, safeMode)
      }

      const adjusted = fs.fstatSync(descriptor)
      assertSameIdentity(stat, adjusted, helper)
      assertSafeHelper(adjusted, currentUid, currentGroups, trustedRootUid, helper)
      revalidateHelperPath(helper, adjusted, currentUid, currentGroups, trustedRootUid)
      revalidateTrustedDirectories([
        ...ancestorDirectories,
        packageDirectory,
        prebuildsDirectory,
        platformDirectory,
      ])
      trustedHelpers.push({
        path: helper,
        stats: adjusted,
        currentUid,
        currentGroups,
        trustedRootUid,
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot safely enable')) throw error
      throw permissionError(helper, String(error))
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }

  const allDirectories = [
    ...ancestorDirectories,
    packageDirectory,
    prebuildsDirectory,
    ...platformDirectories,
  ]
  const revalidate = (): void => {
    try {
      revalidateTrustedDirectories(allDirectories)
      for (const helper of trustedHelpers) {
        revalidateHelperPath(
          helper.path,
          helper.stats,
          helper.currentUid,
          helper.currentGroups,
          helper.trustedRootUid,
        )
      }
      revalidateTrustedDirectories(allDirectories)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot safely enable')) throw error
      throw permissionError(requestedDir, String(error))
    }
  }
  revalidate()
  return revalidate
}

function inspectTrustedAncestorChain(
  packagePath: string,
  trustedRootUid: number,
): TrustedDirectory[] {
  const resolvedPackage = path.resolve(packagePath)
  const root = path.parse(resolvedPackage).root
  const parent = path.dirname(resolvedPackage)
  if (parent === resolvedPackage) return []

  const directories: string[] = [root]
  let current = root
  const relative = path.relative(root, parent)
  if (relative) {
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component)
      directories.push(current)
    }
  }
  return directories.map((directory) =>
    inspectTrustedDirectory(
      directory,
      `node-pty ancestor directory ${directory}`,
      true,
      trustedRootUid,
    ),
  )
}

function inspectTrustedDirectory(
  directory: string,
  label: string,
  allowRootOwnedSticky = false,
  trustedRootUid = 0,
): TrustedDirectory {
  const resolved = path.resolve(directory)
  const pathStat = fs.lstatSync(resolved)
  if (pathStat.isSymbolicLink()) {
    throw permissionError(resolved, `${label} is a symbolic link`)
  }
  if (!pathStat.isDirectory()) {
    throw permissionError(resolved, `${label} is not a regular directory`)
  }
  const real = fs.realpathSync(resolved)
  if (real !== resolved) {
    throw permissionError(resolved, `${label} traverses a symbolic link`)
  }

  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    )
    const opened = fs.fstatSync(descriptor)
    if (!opened.isDirectory()) {
      throw permissionError(resolved, `${label} is not a regular directory`)
    }
    assertSameIdentity(pathStat, opened, resolved)
    const secured = secureTrustedDirectoryMode(
      descriptor,
      opened,
      resolved,
      label,
      allowRootOwnedSticky,
      trustedRootUid,
    )
    return {
      path: resolved,
      stats: secured,
      label,
      allowRootOwnedSticky,
      trustedRootUid,
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function revalidateTrustedDirectory(observed: TrustedDirectory): void {
  const current = inspectTrustedDirectory(
    observed.path,
    observed.label,
    observed.allowRootOwnedSticky,
    observed.trustedRootUid,
  )
  assertSameIdentity(observed.stats, current.stats, observed.path)
}

function revalidateTrustedDirectories(observed: readonly TrustedDirectory[]): void {
  for (const directory of observed) revalidateTrustedDirectory(directory)
}

function secureTrustedDirectoryMode(
  descriptor: number,
  stats: fs.Stats,
  directory: string,
  label: string,
  allowRootOwnedSticky: boolean,
  trustedRootUid: number,
): fs.Stats {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid
  if (stats.uid !== currentUid && stats.uid !== trustedRootUid) {
    throw permissionError(directory, `${label} is not owned by the current user or root`)
  }
  if ((stats.mode & 0o022) === 0) return stats

  const rootOwnedSticky =
    allowRootOwnedSticky && stats.uid === trustedRootUid && (stats.mode & 0o1000) !== 0
  if (rootOwnedSticky) return stats
  if (stats.uid !== currentUid) {
    throw permissionError(directory, `${label} is writable by group or other users`)
  }

  fs.fchmodSync(descriptor, stats.mode & ~0o022)
  const secured = fs.fstatSync(descriptor)
  assertSameIdentity(stats, secured, directory)
  if ((secured.mode & 0o022) !== 0) {
    throw permissionError(directory, `${label} remains writable by group or other users`)
  }
  return secured
}

function revalidateHelperPath(
  helper: string,
  observed: fs.Stats,
  currentUid: number,
  currentGroups: ReadonlySet<number>,
  trustedRootUid: number,
): void {
  const pathStat = fs.lstatSync(helper)
  if (pathStat.isSymbolicLink()) {
    throw permissionError(helper, 'the helper became a symbolic link during validation')
  }
  if (!pathStat.isFile()) throw permissionError(helper, 'it is not a regular file')
  assertSameIdentity(observed, pathStat, helper)
  if (fs.realpathSync(helper) !== path.resolve(helper)) {
    throw permissionError(helper, 'the helper path traverses a symbolic link')
  }

  let verificationDescriptor: number | undefined
  try {
    verificationDescriptor = fs.openSync(
      helper,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    )
    const verified = fs.fstatSync(verificationDescriptor)
    assertSameIdentity(observed, verified, helper)
    assertSafeHelper(verified, currentUid, currentGroups, trustedRootUid, helper)
  } finally {
    if (verificationDescriptor !== undefined) fs.closeSync(verificationDescriptor)
  }
}

function assertSafeHelper(
  stats: fs.Stats,
  currentUid: number,
  currentGroups: ReadonlySet<number>,
  trustedRootUid: number,
  helper: string,
): void {
  if (!stats.isFile()) throw permissionError(helper, 'it is not a regular file')
  if (stats.uid !== currentUid && stats.uid !== trustedRootUid) {
    throw permissionError(helper, 'it is not owned by the current user or root')
  }
  if ((stats.mode & 0o022) !== 0) {
    throw permissionError(helper, 'it remains writable by group or other users')
  }
  const executable =
    (stats.uid === currentUid && (stats.mode & 0o100) !== 0) ||
    (stats.uid !== currentUid && currentGroups.has(stats.gid) && (stats.mode & 0o010) !== 0) ||
    (stats.uid !== currentUid && !currentGroups.has(stats.gid) && (stats.mode & 0o001) !== 0)
  if (!executable) throw permissionError(helper, 'it is not executable by the current user')
}

function assertSameIdentity(before: fs.Stats, after: fs.Stats, target: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw permissionError(target, 'the path changed while it was being validated')
  }
}

type PtySpawner = typeof pty.spawn

export interface AgentPtyOptions {
  /** Intercept terminal bytes before they reach the local agent. */
  onInput?: (data: Buffer, writeLocal: (bytes: string | Buffer) => void) => void
}

export function spawnAgentProcess(
  spawnPty: PtySpawner,
  command: string,
  args: string[],
  wrapperId: string | undefined,
  beforeSpawn?: () => void,
): pty.IPty {
  const options = {
    name: process.env.TERM ?? 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: process.cwd(),
    env: (wrapperId
      ? {
          ...process.env,
          OPENCONTROL_WRAPPER_ID: wrapperId,
          OPENCONTROL_INSTANCE_ID: wrapperId,
          // One-release compatibility for hooks installed by OpenMicro.
          OPENMICRO_INSTANCE_ID: wrapperId,
        }
      : process.env) as Record<string, string>,
  }
  beforeSpawn?.()
  return spawnPty(command, args, options)
}

export class AgentPty {
  private proc: pty.IPty
  private readonly stdinHandler: (data: Buffer) => void

  constructor(
    command: string,
    args: string[],
    wrapperId: string | undefined,
    onExit: (code: number) => void,
    options: AgentPtyOptions = {},
  ) {
    const revalidateSpawnHelper = fixSpawnHelperPermissions()
    this.proc = spawnAgentProcess(pty.spawn, command, args, wrapperId, revalidateSpawnHelper)

    this.proc.onData((data) => process.stdout.write(data))
    this.proc.onExit(({ exitCode }) => onExit(exitCode))

    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    this.stdinHandler = (data: Buffer): void => {
      if (options.onInput) options.onInput(data, (local) => this.proc.write(local))
      else this.proc.write(data)
    }
    process.stdin.on('data', this.stdinHandler)

    process.stdout.on('resize', () => {
      try {
        this.proc.resize(process.stdout.columns, process.stdout.rows)
      } catch (err) {
        logger.warn('pty resize failed', err)
      }
    })
  }

  write(data: string | Buffer): void {
    this.proc.write(data)
  }

  dispose(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.off('data', this.stdinHandler)
    process.stdin.pause()
    try {
      this.proc.kill()
    } catch {
      // already dead
    }
  }
}
