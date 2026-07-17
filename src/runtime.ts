import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  appDataDirectory,
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  inspectOwnedRegularFile,
  readOwnedRegularFile,
  SecureFileError,
} from './secure-files.js'

export const RUNTIME_DESCRIPTOR_VERSION = 1

export interface RuntimeDescriptor {
  version: typeof RUNTIME_DESCRIPTOR_VERSION
  app: 'opencontrol'
  pid: number
  port: number
  token: string
  startedAt: string
  /** Distinguishes this process incarnation from a later reuse of the same PID. */
  processStartId?: string
}

interface RuntimeLock {
  pid: number
  token: string
  processStartId?: string
}

interface ObservedLock {
  generation: string
  owner: RuntimeLock | null
  fresh: boolean
  ageMs: number
}

const INCOMPLETE_LOCK_GRACE_MS = 5_000
const OWNER_STARTUP_GRACE_MS = 30_000
const MAX_RECLAIM_GUARD_GENERATIONS = 64
const PROCESS_START_ID = osProcessStartId(process.pid) ?? randomBytes(32).toString('base64url')
const PROCESS_START_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export interface RuntimeLease {
  readonly path: string
  readonly token: string
  publish(port: number): RuntimeDescriptor
  release(): void
}

export type RuntimeProbeState = 'live' | 'temporarily-unreachable' | 'stale'

export function runtimeDescriptorPath(): string {
  return process.env.OPENCONTROL_RUNTIME_FILE ?? path.join(appDataDirectory(), 'runtime.json')
}

export function createRuntimeToken(): string {
  return randomBytes(32).toString('base64url')
}

export function runtimeProcessStartId(): string {
  return PROCESS_START_ID
}

export function runtimeUrl(descriptor: Pick<RuntimeDescriptor, 'port'>): string {
  return `http://127.0.0.1:${descriptor.port}`
}

export function authorizationHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export function readRuntimeDescriptor(file = runtimeDescriptorPath()): RuntimeDescriptor | null {
  try {
    return readRuntimeDescriptorFile(file)?.descriptor ?? null
  } catch {
    return null
  }
}

export function removeRuntimeDescriptor(
  file = runtimeDescriptorPath(),
  expected?: Pick<RuntimeDescriptor, 'pid' | 'port' | 'token'> &
    Partial<Pick<RuntimeDescriptor, 'processStartId' | 'startedAt'>>,
): boolean {
  let observed: ReturnType<typeof readOwnedRegularFile>
  try {
    observed = readOwnedRegularFile(file)
    if (!observed || !hasPrivateRuntimeMode(observed.stats)) return false
    if (expected) {
      const current = parseRuntimeDescriptor(observed.contents)
      if (!current || !sameExpectedDescriptor(current, expected)) return false
    }
  } catch {
    return false
  }

  const quarantine = descriptorQuarantinePath(file)
  try {
    fs.renameSync(file, quarantine)
  } catch {
    return false
  }

  try {
    const moved = readOwnedRegularFile(quarantine)
    if (
      !moved ||
      !hasPrivateRuntimeMode(moved.stats) ||
      !sameFileIdentity(observed.stats, moved.stats) ||
      !observed.contents.equals(moved.contents)
    ) {
      restoreQuarantinedDescriptor(quarantine, file)
      return false
    }
    fs.unlinkSync(quarantine)
    return true
  } catch {
    restoreQuarantinedDescriptor(quarantine, file)
    return false
  }
}

export async function probeRuntime(
  descriptor: RuntimeDescriptor,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeProbeState> {
  let response: Response
  try {
    response = await fetchImpl(`${runtimeUrl(descriptor)}/health`, {
      headers: authorizationHeaders(descriptor.token),
      signal: AbortSignal.timeout(750),
    })
  } catch (error) {
    return isConnectionRefused(error) || processOwnerState(descriptor) === 'dead'
      ? 'stale'
      : 'temporarily-unreachable'
  }
  if (!response.ok) {
    if (
      (response.status === 429 || response.status >= 500) &&
      processOwnerState(descriptor) !== 'dead'
    ) {
      return 'temporarily-unreachable'
    }
    return 'stale'
  }
  try {
    const body = (await response.json()) as {
      app?: string
      pid?: number
      processStartId?: string
    }
    return body.app === 'opencontrol' &&
      body.pid === descriptor.pid &&
      (descriptor.processStartId === undefined || body.processStartId === descriptor.processStartId)
      ? 'live'
      : 'stale'
  } catch {
    // Headers may arrive before a slow or interrupted body. A single failed
    // body read is not evidence that an otherwise-live owner is stale.
    return processOwnerState(descriptor) === 'dead' ? 'stale' : 'temporarily-unreachable'
  }
}

/** Read and validate the descriptor against the authenticated health endpoint. */
export async function discoverRuntime(
  file = runtimeDescriptorPath(),
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeDescriptor | null> {
  const descriptor = readRuntimeDescriptor(file)
  if (!descriptor) return null
  const probe = await probeRuntime(descriptor, fetchImpl)
  if (probe === 'live') return descriptor
  if (probe === 'stale') removeRuntimeDescriptor(file, descriptor)
  return null
}

/**
 * Acquire the per-user singleton lease. The lock is held for the host lifetime;
 * a dead owner's lock and descriptor are reclaimed on the next start.
 */
export async function acquireRuntimeLease(
  options: {
    file?: string
    token?: string
    fetchImpl?: typeof fetch
  } = {},
): Promise<RuntimeLease | null> {
  const file = options.file ?? runtimeDescriptorPath()
  const lockFile = `${file}.lock`
  const token = options.token ?? createRuntimeToken()
  const owner: RuntimeLock = {
    pid: process.pid,
    token,
    processStartId: PROCESS_START_ID,
  }
  const defaultFile = path.join(appDataDirectory(), 'runtime.json')
  if (path.resolve(file) === path.resolve(defaultFile)) {
    ensurePrivateDirectory(path.dirname(file))
  } else if (process.platform === 'win32') {
    ensureTrustedWindowsRuntimeDirectory(path.dirname(file), appDataDirectory())
  } else {
    ensureCustomRuntimeDirectory(path.dirname(file))
  }
  assertSafeRuntimeDestination(file)

  let ownsLock = false
  for (let attempt = 0; attempt < 2 && !ownsLock; attempt += 1) {
    const result = createOwnedLock(lockFile, owner)
    if (result === 'created') {
      ownsLock = true
    } else {
      const observed = observeLock(lockFile)
      if (!observed) continue
      if (observed.owner && (await lockOwnerIsActive(observed, file, options.fetchImpl ?? fetch))) {
        return null
      }
      if (!observed.owner && observed.fresh) return null
      const reclaimGuard = acquireReclaimGuard(lockFile, observed.generation, owner)
      if (!reclaimGuard) return null
      try {
        const current = observeLock(lockFile)
        if (!current || current.generation !== observed.generation) continue
        if (current.owner && (await lockOwnerIsActive(current, file, options.fetchImpl ?? fetch))) {
          return null
        }
        if (!current.owner && current.fresh) return null
        try {
          fs.unlinkSync(lockFile)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
        }
      } finally {
        safeUnlinkOwnedLock(reclaimGuard, token)
      }
    }
  }
  if (!ownsLock) return null

  const previous = readRuntimeDescriptor(file)
  if (previous) {
    const probe = await probeRuntime(previous, options.fetchImpl ?? fetch)
    if (probe !== 'stale') {
      safeUnlinkOwnedLock(lockFile, token)
      return null
    }
    removeRuntimeDescriptor(file, previous)
  } else if (inspectOwnedRegularFile(file)) {
    // A private but malformed descriptor cannot identify a live owner. The
    // exclusive lock above makes reclaiming it safe.
    removeRuntimeDescriptor(file)
  }

  let published: RuntimeDescriptor | null = null
  let released = false
  return {
    path: file,
    token,
    publish(port: number): RuntimeDescriptor {
      if (released) throw new Error('Runtime lease has already been released')
      if (published) return published
      published = {
        version: RUNTIME_DESCRIPTOR_VERSION,
        app: 'opencontrol',
        pid: process.pid,
        port,
        token,
        startedAt: new Date().toISOString(),
        processStartId: PROCESS_START_ID,
      }
      writeDescriptor(file, published)
      return published
    },
    release(): void {
      if (released) return
      released = true
      if (published) removeRuntimeDescriptor(file, published)
      safeUnlinkOwnedLock(lockFile, token)
    },
  }
}

function writeDescriptor(file: string, descriptor: RuntimeDescriptor): void {
  atomicWritePrivateFile(file, `${JSON.stringify(descriptor, null, 2)}\n`)
}

function readLock(file: string): RuntimeLock | null {
  try {
    const owned = readOwnedRegularFile(file)
    if (!owned || (process.platform !== 'win32' && (owned.stats.mode & 0o077) !== 0)) return null
    return parseLock(owned.contents)
  } catch {
    return null
  }
}

function parseLock(raw: Uint8Array): RuntimeLock | null {
  try {
    const value = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<RuntimeLock>
    if (
      !Number.isInteger(value.pid) ||
      value.pid! <= 0 ||
      typeof value.token !== 'string' ||
      (value.processStartId !== undefined && !isProcessStartId(value.processStartId))
    ) {
      return null
    }
    return value as RuntimeLock
  } catch {
    return null
  }
}

function observeLock(file: string): ObservedLock | null {
  try {
    const owned = readOwnedRegularFile(file)
    if (!owned || (process.platform !== 'win32' && (owned.stats.mode & 0o077) !== 0)) return null
    const stat = owned.stats
    const raw = owned.contents
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
    const generation = createHash('sha256')
      .update(raw)
      .update(`\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 24)
    return {
      generation,
      owner: parseLock(raw),
      fresh: ageMs < INCOMPLETE_LOCK_GRACE_MS,
      ageMs,
    }
  } catch {
    return null
  }
}

function acquireReclaimGuard(
  lockFile: string,
  generation: string,
  owner: RuntimeLock,
): string | null {
  for (let attempt = 0; attempt < MAX_RECLAIM_GUARD_GENERATIONS; attempt += 1) {
    const guard = `${lockFile}.reclaim.${generation}.${attempt}`
    if (createOwnedLock(guard, owner) === 'created') return guard
    const existing = observeLock(guard)
    if (!existing) return null
    if (existing.owner) {
      const state = processOwnerState(existing.owner)
      if (
        state === 'verified' ||
        (state === 'alive-unverified' && existing.ageMs < OWNER_STARTUP_GRACE_MS)
      ) {
        return null
      }
    }
    if (!existing.owner && existing.fresh) return null
    // A previous reclaimer died. Never unlink its guard: advance to a new
    // atomically-created generation so concurrent takeovers still serialize.
  }
  return null
}

/** Publish complete owner data with an atomic no-replace hard link. */
function createOwnedLock(file: string, lock: RuntimeLock): 'created' | 'exists' {
  const temporary = `${file}.${lock.pid}.${randomBytes(12).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(lock), 'utf8')
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    try {
      fs.linkSync(temporary, file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return 'exists'
      if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error
      try {
        // Some Windows/network filesystems cannot create hard links. The
        // exclusive copy fallback may be briefly visible while copying; fresh
        // invalid locks are treated as busy, never reclaimed.
        fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL)
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw copyError
      }
    }
    return 'created'
  } finally {
    if (fd !== null) fs.closeSync(fd)
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The temporary link was already removed or never created.
    }
  }
}

/**
 * Custom descriptor locations are accepted only beneath an already-private
 * directory owned by this user. Existing directories are inspected but never
 * chmodded, so a caller cannot make a shared parent such as /tmp private.
 */
function ensureCustomRuntimeDirectory(directory: string): void {
  const missing: string[] = []
  let cursor = path.resolve(directory)

  for (;;) {
    try {
      assertPrivateDirectory(cursor, fs.lstatSync(cursor))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(cursor)
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        throw new SecureFileError(
          'ESECUREDIR',
          `custom runtime path has no private existing parent: ${directory}`,
        )
      }
      cursor = parent
    }
  }

  assertSafePosixAncestorChain(cursor)

  for (const component of missing.reverse()) {
    let created = false
    try {
      fs.mkdirSync(component, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (created && process.platform !== 'win32') fs.chmodSync(component, 0o700)
    assertPrivateDirectory(component, fs.lstatSync(component))
  }
}

/**
 * Windows has no meaningful uid/mode data in Node's fs. Custom locations are
 * therefore limited to the profile-ACL-protected application directory, and
 * each descendant is checked so a junction cannot escape that root.
 */
function ensureTrustedWindowsRuntimeDirectory(directory: string, trustedDirectory: string): void {
  const trusted = path.resolve(trustedDirectory)
  const target = path.resolve(directory)
  const relative = path.relative(trusted, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SecureFileError(
      'ESECUREDIR',
      `custom Windows runtime paths must stay under ${trusted}`,
    )
  }

  ensurePrivateDirectory(trusted)
  let cursor = trusted
  if (relative === '') return
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let created = false
    try {
      fs.mkdirSync(cursor, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stats = fs.lstatSync(cursor)
    if (created && stats.isSymbolicLink()) {
      throw new SecureFileError('ESECUREDIR', `refusing symbolic-link directory ${cursor}`)
    }
    assertPrivateDirectory(cursor, stats)
  }
}

function assertPrivateDirectory(directory: string, stats: fs.Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SecureFileError('ESECUREDIR', `refusing unsafe custom runtime parent: ${directory}`)
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0) {
      throw new SecureFileError(
        'ESECUREDIR',
        `custom runtime parent must be private and owned by the current user: ${directory}`,
      )
    }
  }
}

function assertSafePosixAncestorChain(directory: string): void {
  assertPosixPathComponents(path.resolve(directory))
  const canonical = fs.realpathSync.native(directory)
  if (canonical !== path.resolve(directory)) assertPosixPathComponents(canonical, true)
}

function assertPosixPathComponents(directory: string, canonical = false): void {
  const root = path.parse(directory).root
  let cursor = root
  let parentStats = fs.lstatSync(root)
  const trustedRootUid = parentStats.uid
  assertStablePosixDirectory(root, parentStats, trustedRootUid)

  const relative = path.relative(root, directory)
  if (relative === '') return
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    const stats = fs.lstatSync(cursor)
    if (stats.isSymbolicLink()) {
      if (
        canonical ||
        typeof process.getuid !== 'function' ||
        stats.uid !== trustedRootUid ||
        isRenameExposed(parentStats)
      ) {
        throw new SecureFileError(
          'ESECUREDIR',
          `refusing symbolic-link custom runtime ancestor: ${cursor}`,
        )
      }
      parentStats = fs.statSync(cursor)
      assertStablePosixDirectory(cursor, parentStats, trustedRootUid)
      continue
    }
    assertStablePosixDirectory(cursor, stats, trustedRootUid)
    parentStats = stats
  }
}

function assertStablePosixDirectory(
  directory: string,
  stats: fs.Stats,
  trustedRootUid: number,
): void {
  if (!stats.isDirectory()) {
    throw new SecureFileError(
      'ESECUREDIR',
      `refusing non-directory custom runtime ancestor: ${directory}`,
    )
  }
  if (
    typeof process.getuid !== 'function' ||
    (stats.uid !== trustedRootUid && stats.uid !== process.getuid())
  ) {
    throw new SecureFileError(
      'ESECUREDIR',
      `custom runtime ancestor is not owned by root or the current user: ${directory}`,
    )
  }
  if (isRenameExposed(stats)) {
    throw new SecureFileError(
      'ESECUREDIR',
      `custom runtime ancestor permits cross-user renames: ${directory}`,
    )
  }
}

function isRenameExposed(stats: fs.Stats): boolean {
  const groupOrOtherWritable = (stats.mode & 0o022) !== 0
  const sticky = (stats.mode & 0o1000) !== 0
  return groupOrOtherWritable && !sticky
}

function assertSafeRuntimeDestination(file: string): void {
  const stats = inspectOwnedRegularFile(file)
  if (stats && process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new SecureFileError('ESECUREFILE', `runtime descriptor is not private: ${file}`)
  }
}

function readRuntimeDescriptorFile(
  file: string,
): { descriptor: RuntimeDescriptor; contents: Buffer; stats: fs.Stats } | null {
  const owned = readOwnedRegularFile(file)
  if (!owned || !hasPrivateRuntimeMode(owned.stats)) return null
  const descriptor = parseRuntimeDescriptor(owned.contents)
  return descriptor ? { descriptor, ...owned } : null
}

function parseRuntimeDescriptor(contents: Uint8Array): RuntimeDescriptor | null {
  try {
    const value = JSON.parse(Buffer.from(contents).toString('utf8')) as Partial<RuntimeDescriptor>
    if (
      value.version !== RUNTIME_DESCRIPTOR_VERSION ||
      value.app !== 'opencontrol' ||
      !Number.isInteger(value.pid) ||
      value.pid! <= 0 ||
      !Number.isInteger(value.port) ||
      value.port! <= 0 ||
      value.port! > 65535 ||
      typeof value.token !== 'string' ||
      value.token.length < 32 ||
      typeof value.startedAt !== 'string' ||
      (value.processStartId !== undefined && !isProcessStartId(value.processStartId))
    ) {
      return null
    }
    return value as RuntimeDescriptor
  } catch {
    return null
  }
}

function sameExpectedDescriptor(
  current: RuntimeDescriptor,
  expected: Pick<RuntimeDescriptor, 'pid' | 'port' | 'token'> &
    Partial<Pick<RuntimeDescriptor, 'processStartId' | 'startedAt'>>,
): boolean {
  return (
    current.pid === expected.pid &&
    current.port === expected.port &&
    current.token === expected.token &&
    (expected.processStartId === undefined || current.processStartId === expected.processStartId) &&
    (expected.startedAt === undefined || current.startedAt === expected.startedAt)
  )
}

function hasPrivateRuntimeMode(stats: fs.Stats): boolean {
  return process.platform === 'win32' || (stats.mode & 0o077) === 0
}

function descriptorQuarantinePath(file: string): string {
  const directory = path.dirname(file)
  const base = path.basename(file)
  return path.join(
    directory,
    `.${base}.remove.${process.pid}.${randomBytes(24).toString('hex')}.quarantine`,
  )
}

function restoreQuarantinedDescriptor(quarantine: string, file: string): void {
  try {
    fs.linkSync(quarantine, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      try {
        const quarantined = inspectOwnedRegularFile(quarantine)
        const current = inspectOwnedRegularFile(file)
        if (quarantined && current && sameFileIdentity(quarantined, current)) {
          fs.unlinkSync(quarantine)
        }
      } catch {
        // Preserve the quarantined descriptor if either path is uncertain.
      }
      return
    }
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')
    ) {
      return
    }
    try {
      fs.copyFileSync(quarantine, file, fs.constants.COPYFILE_EXCL)
    } catch {
      return
    }
  }

  try {
    fs.unlinkSync(quarantine)
  } catch {
    // Both links/copies preserve the descriptor; a private orphan is harmless.
  }
}

function sameFileIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino
}

async function lockOwnerIsActive(
  observed: ObservedLock,
  descriptorFile: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const owner = observed.owner
  if (!owner) return false
  const ownerState = processOwnerState(owner)
  if (ownerState === 'dead') return false
  if (ownerState === 'verified') return true

  const descriptor = readRuntimeDescriptor(descriptorFile)
  if (descriptor && lockMatchesDescriptor(owner, descriptor)) {
    return (await probeRuntime(descriptor, fetchImpl)) !== 'stale'
  }

  // An owner that crashed before publishing has no authenticated endpoint.
  // Bound that ambiguous startup state instead of trusting a reused PID
  // forever. This also gives legacy PID-only hosts a startup compatibility
  // window without allowing their orphaned locks to become permanent.
  return observed.ageMs < OWNER_STARTUP_GRACE_MS
}

function lockMatchesDescriptor(lock: RuntimeLock, descriptor: RuntimeDescriptor): boolean {
  return (
    lock.pid === descriptor.pid &&
    lock.token === descriptor.token &&
    (lock.processStartId === undefined ||
      descriptor.processStartId === undefined ||
      lock.processStartId === descriptor.processStartId)
  )
}

type ProcessOwnerState = 'verified' | 'alive-unverified' | 'dead'

function processOwnerState(owner: Pick<RuntimeLock, 'pid' | 'processStartId'>): ProcessOwnerState {
  if (owner.processStartId !== undefined) {
    const observedStartId = osProcessStartId(owner.pid)
    if (observedStartId !== null) {
      return observedStartId === owner.processStartId ? 'verified' : 'dead'
    }
    if (owner.pid === process.pid) {
      return owner.processStartId === PROCESS_START_ID ? 'verified' : 'dead'
    }
  }
  return processIsAlive(owner.pid) ? 'alive-unverified' : 'dead'
}

function osProcessStartId(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (!bootId || commandEnd < 0) return null
    const fieldsAfterCommand = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u)
    const startTicks = fieldsAfterCommand[19]
    if (!startTicks || !/^\d+$/u.test(startTicks)) return null
    return createHash('sha256')
      .update(`linux-process-start\0${bootId}\0${startTicks}`)
      .digest('base64url')
  } catch {
    return null
  }
}

function isProcessStartId(value: unknown): value is string {
  return typeof value === 'string' && PROCESS_START_ID_PATTERN.test(value)
}

function isConnectionRefused(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function safeUnlinkOwnedLock(file: string, token: string): void {
  const lock = readLock(file)
  if (
    !lock ||
    lock.token !== token ||
    lock.pid !== process.pid ||
    (lock.processStartId !== undefined && lock.processStartId !== PROCESS_START_ID)
  ) {
    return
  }
  try {
    fs.unlinkSync(file)
  } catch {
    // A later owner may already have reclaimed it.
  }
}
