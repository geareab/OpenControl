import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REVIEWED_NPM_VERSION = '11.16.0'
const REVIEWED_NPM_INTEGRITY =
  'sha512-A74XL8OxmcegZDMWPkWb5bEQppg8HdYwW3rBD2sPoS4UQHVajfaxBkqyzLeJ3wR0kZ+5xoTjItxXaF7eIXUsyw=='

if (!isSupportedNode(process.versions.node)) {
  throw new Error(
    `Node.js ${process.versions.node} is unsupported. Install Node.js 22.23.1+ ` +
      'within the 22.x line or Node.js 24.18.0+ within the 24.x line, then rerun this command. ' +
      'The npm bootstrap does not modify the system Node.js installation.',
  )
}

const npmCommand = activeNpmCommand()
const currentVersion = runNpm(npmCommand, ['--version'], process.cwd()).stdout.trim()
if (isSupportedNpm(currentVersion)) {
  console.log(`Using reviewed npm policy implementation ${currentVersion}.`)
  process.exit(0)
}

const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrol-npm-bootstrap-'))
try {
  const packed = runNpm(
    npmCommand,
    [
      'pack',
      `npm@${REVIEWED_NPM_VERSION}`,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      stagingDirectory,
    ],
    stagingDirectory,
  )
  const metadata = JSON.parse(packed.stdout)
  if (!Array.isArray(metadata) || metadata.length !== 1) {
    throw new Error('npm pack returned an unexpected result')
  }
  const filename = metadata[0]?.filename
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    throw new Error('npm pack returned an unsafe archive path')
  }

  const archive = path.join(stagingDirectory, filename)
  const stats = fs.lstatSync(archive)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('the reviewed npm archive is not a regular file')
  }
  const actualIntegrity = `sha512-${createHash('sha512')
    .update(fs.readFileSync(archive))
    .digest('base64')}`
  if (actualIntegrity !== REVIEWED_NPM_INTEGRITY) {
    throw new Error(
      `npm ${REVIEWED_NPM_VERSION} integrity mismatch; refusing to install the bootstrap tool`,
    )
  }

  const installArguments = [
    'install',
    '--global',
    archive,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--engine-strict=false',
  ]
  let installedNpmCommand = npmCommand
  try {
    runNpm(npmCommand, installArguments, stagingDirectory)
  } catch (error) {
    if (!isPermissionError(error)) throw error
    const userPrefix = userNpmPrefix()
    fs.mkdirSync(userPrefix, { recursive: true, mode: 0o700 })
    runNpm(npmCommand, [...installArguments, '--prefix', userPrefix], stagingDirectory)
    installedNpmCommand = npmCommandForPrefix(userPrefix)
    exposeUserNpmPath(userPrefix)
  }
  const installedVersion = runNpm(
    installedNpmCommand,
    ['--version'],
    stagingDirectory,
  ).stdout.trim()
  if (!isSupportedNpm(installedVersion)) {
    throw new Error(
      `npm bootstrap completed but the active version is still unsupported: ${installedVersion}`,
    )
  }
  console.log(`Installed checksum-verified npm ${installedVersion}.`)
} finally {
  fs.rmSync(stagingDirectory, { recursive: true, force: true })
}

function runNpm(command, arguments_, cwd) {
  const result = spawnSync(command.executable, [...command.prefix, ...arguments_], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_engine_strict: 'false',
      npm_config_ignore_scripts: 'true',
    },
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `npm ${arguments_.join(' ')} failed:\n${
        result.error?.message || result.stderr || result.stdout || 'no output'
      }`,
    )
  }
  return result
}

function isSupportedNpm(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return false
  const [, major, minor] = match.map(Number)
  return major === 11 && minor >= 16
}

function isSupportedNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return (
    (major === 22 && (minor > 23 || (minor === 23 && patch >= 1))) ||
    (major === 24 && (minor > 18 || (minor === 18 && patch >= 0)))
  )
}

function isPermissionError(error) {
  return /\bEACCES\b|permission denied/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

function userNpmPrefix() {
  if (process.env.OPENCONTROL_NPM_PREFIX) {
    return path.resolve(process.env.OPENCONTROL_NPM_PREFIX)
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'OpenControl', 'npm')
  }
  return path.join(os.homedir(), '.local')
}

function npmCommandForPrefix(prefix) {
  if (process.platform !== 'win32') {
    return { executable: path.join(prefix, 'bin', 'npm'), prefix: [] }
  }
  return npmCliCommand(path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
}

function activeNpmCommand() {
  if (process.platform !== 'win32') return { executable: 'npm', prefix: [] }

  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  if (process.env.npm_execpath) candidates.push(path.resolve(process.env.npm_execpath))

  for (const candidate of candidates) {
    try {
      return npmCliCommand(candidate)
    } catch {
      // Try the next canonical npm CLI location.
    }
  }
  throw new Error(
    `Could not locate a safe npm CLI beside ${process.execPath}. ` +
      'Reinstall a supported Node.js distribution and rerun this command.',
  )
}

function npmCliCommand(cliPath) {
  const stats = fs.lstatSync(cliPath)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`refusing unsafe npm CLI path ${cliPath}`)
  }
  const resolved = fs.realpathSync(cliPath)
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(path.dirname(resolved), '..', 'package.json'), 'utf8'),
  )
  if (manifest.name !== 'npm' || typeof manifest.version !== 'string') {
    throw new Error(`could not identify the npm CLI at ${cliPath}`)
  }
  return { executable: process.execPath, prefix: [resolved] }
}

function exposeUserNpmPath(prefix) {
  const binDirectory = process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
  if (process.env.GITHUB_PATH) {
    fs.appendFileSync(process.env.GITHUB_PATH, `${binDirectory}${os.EOL}`)
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter)
  if (!pathEntries.includes(binDirectory)) {
    const command =
      process.platform === 'win32'
        ? `set PATH=${binDirectory};%PATH%`
        : `export PATH="${binDirectory}:$PATH"`
    console.warn(
      `npm was installed without administrator access under ${prefix}. ` +
        `Run this before the remaining install commands:\n${command}`,
    )
  }
}
