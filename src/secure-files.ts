import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PRIVATE_DIRECTORY_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

const NO_FOLLOW = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW
const DIRECTORY_ONLY = process.platform === 'win32' ? 0 : fs.constants.O_DIRECTORY
const MAX_TEMPORARY_ATTEMPTS = 32

export class SecureFileError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SecureFileError'
    this.code = code
  }
}

export interface OwnedFileRead {
  contents: Buffer
  stats: fs.Stats
}

export interface AtomicWriteOptions {
  /**
   * Replace an existing file only after it has been verified as a regular file
   * owned by the current user. The default is an exclusive, no-clobber write.
   */
  overwrite?: boolean
  /** Final POSIX permission bits. Defaults to owner read/write only. */
  mode?: number
}

/** Per-user OpenControl storage, using the Windows profile ACL when applicable. */
export function appDataDirectory(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'OpenControl')
  }
  return path.join(os.homedir(), '.opencontrol')
}

/**
 * Create or harden a private application directory. A symlink, non-directory,
 * or directory owned by another POSIX user is always rejected.
 */
export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(directory)
  } catch (error) {
    throw secureError('ESECUREDIR', `could not inspect private directory ${directory}`, error)
  }
  if (stats.isSymbolicLink()) {
    throw new SecureFileError('ESECUREDIR', `refusing symbolic-link directory ${directory}`)
  }
  if (!stats.isDirectory()) {
    throw new SecureFileError('ESECUREDIR', `refusing non-directory path ${directory}`)
  }
  assertCurrentOwner(stats, directory)
  if (process.platform !== 'win32') {
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW)
      const opened = fs.fstatSync(descriptor)
      if (!opened.isDirectory()) {
        throw new SecureFileError('ESECUREDIR', `refusing non-directory path ${directory}`)
      }
      assertCurrentOwner(opened, directory)
      assertSameFile(stats, opened, directory)
      fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE)
      if ((fs.fstatSync(descriptor).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw new SecureFileError('ESECUREDIR', `could not make directory private: ${directory}`)
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
  }
}

/**
 * Inspect an existing destination without following its final path component.
 * Missing files return null; unsafe existing filesystem objects throw.
 */
export function inspectOwnedRegularFile(file: string): fs.Stats | null {
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw secureError('ESECUREFILE', `could not inspect file ${file}`, error)
  }
  assertRegularOwnedFile(stats, file)
  return stats
}

/**
 * Read a regular, current-user-owned file through a no-follow descriptor.
 * The descriptor identity is compared with lstat to close path-swap races.
 */
export function readOwnedRegularFile(file: string): OwnedFileRead | null {
  const before = inspectOwnedRegularFile(file)
  if (!before) return null

  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW)
    const after = fs.fstatSync(descriptor)
    assertRegularOwnedFile(after, file)
    assertSameFile(before, after, file)
    return { contents: fs.readFileSync(descriptor), stats: after }
  } catch (error) {
    if (error instanceof SecureFileError) throw error
    throw secureError('ESECUREFILE', `could not securely read file ${file}`, error)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

/**
 * Atomically write a private file using a randomized, exclusive temporary in
 * the destination directory. New destinations are published without replace;
 * overwrite mode only replaces the exact regular owned file that was checked.
 */
export function atomicWritePrivateFile(
  file: string,
  contents: string | NodeJS.ArrayBufferView,
  options: AtomicWriteOptions = {},
): void {
  const mode = normalizedFileMode(options.mode ?? PRIVATE_FILE_MODE)
  const observed = inspectOwnedRegularFile(file)
  if (observed && !options.overwrite) {
    throw new SecureFileError('EEXIST', `refusing to overwrite existing file ${file}`)
  }

  const temporary = openRandomTemporary(file)
  let descriptor: number | null = temporary.descriptor
  let published = false
  try {
    fs.writeFileSync(descriptor, contents)
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, mode)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null

    if (observed) {
      const current = inspectOwnedRegularFile(file)
      if (!current) {
        publishWithoutReplace(temporary.path, file)
      } else {
        assertSameFile(observed, current, file)
        fs.renameSync(temporary.path, file)
      }
    } else {
      publishWithoutReplace(temporary.path, file)
    }
    published = true

    fsyncParentDirectory(file)
  } catch (error) {
    if (error instanceof SecureFileError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new SecureFileError('EEXIST', `refusing to overwrite existing file ${file}`, {
        cause: error,
      })
    }
    throw secureError('ESECUREWRITE', `could not securely write file ${file}`, error)
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // The original error is more useful.
      }
    }
    if (!published || temporary.path !== file) {
      try {
        fs.unlinkSync(temporary.path)
      } catch {
        // The temporary was linked/renamed or was never fully created.
      }
    }
  }
}

/**
 * Open a private regular file for one append operation. Callers must close the
 * returned descriptor. Existing insecure modes are tightened before return.
 */
export function openPrivateAppendFile(file: string): number {
  ensurePrivateDirectory(path.dirname(file))
  const before = inspectOwnedRegularFile(file)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    )
    const after = fs.fstatSync(descriptor)
    assertRegularOwnedFile(after, file)
    if (before) assertSameFile(before, after, file)
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, PRIVATE_FILE_MODE)
    return descriptor
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor)
    if (error instanceof SecureFileError) throw error
    throw secureError('ESECUREFILE', `could not securely open log file ${file}`, error)
  }
}

/**
 * Derive a safe replacement mode from an existing settings file. Owner
 * read-only files remain read-only; all group, other, and executable bits are
 * stripped. New files use 0600.
 */
export function privateReplacementMode(stats: fs.Stats | null): number {
  if (!stats || process.platform === 'win32') return PRIVATE_FILE_MODE
  const ownerAccess = stats.mode & PRIVATE_FILE_MODE
  return ownerAccess === 0 ? PRIVATE_FILE_MODE : ownerAccess
}

function normalizedFileMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new TypeError(`invalid private file mode: ${mode}`)
  }
  const privateMode = mode & PRIVATE_FILE_MODE
  if (privateMode === 0 || mode !== privateMode) {
    throw new TypeError(`private file mode must contain only owner read/write bits: ${mode}`)
  }
  return privateMode
}

function openRandomTemporary(file: string): { path: string; descriptor: number } {
  const directory = path.dirname(file)
  const base = path.basename(file)
  for (let attempt = 0; attempt < MAX_TEMPORARY_ATTEMPTS; attempt += 1) {
    const candidate = path.join(
      directory,
      `.${base}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    )
    try {
      const descriptor = fs.openSync(
        candidate,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE,
      )
      return { path: candidate, descriptor }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new SecureFileError('ESECUREWRITE', `could not allocate an exclusive temporary for ${file}`)
}

function publishWithoutReplace(temporary: string, target: string): void {
  try {
    fs.linkSync(temporary, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw error
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')
    ) {
      throw error
    }
    fs.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL)
  }
}

function fsyncParentDirectory(file: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY)
    fs.fsyncSync(descriptor)
  } catch {
    // Some filesystems do not permit syncing directory descriptors. The file
    // itself has already been synced and atomically published.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function assertRegularOwnedFile(stats: fs.Stats, file: string): void {
  if (stats.isSymbolicLink()) {
    throw new SecureFileError('ESECUREFILE', `refusing symbolic-link file ${file}`)
  }
  if (!stats.isFile()) {
    throw new SecureFileError('ESECUREFILE', `refusing non-regular file ${file}`)
  }
  assertCurrentOwner(stats, file)
}

function assertCurrentOwner(stats: fs.Stats, file: string): void {
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stats.uid !== process.getuid()
  ) {
    throw new SecureFileError('ESECUREOWNER', `refusing path not owned by current user: ${file}`)
  }
}

function assertSameFile(before: fs.Stats, after: fs.Stats, file: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new SecureFileError('ESECURERACE', `file changed while it was being accessed: ${file}`)
  }
}

function secureError(code: string, message: string, cause: unknown): SecureFileError {
  return new SecureFileError(code, message, { cause })
}
