import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REVIEWED_INSTALL_SCRIPTS = new Map([
  ['esbuild', '0.28.1'],
  ['fsevents', '2.3.3'],
  ['node-hid', '3.3.0'],
  ['node-pty', '1.1.0'],
])

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = readJson(path.join(root, 'package.json'))
const lock = readJson(path.join(root, 'package-lock.json'))
const approvals = manifest.allowScripts
if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) {
  throw new Error('package.json allowScripts must contain the reviewed install-script packages')
}

const expectedApprovalKeys = [...REVIEWED_INSTALL_SCRIPTS].map(
  ([name, version]) => `${name}@${version}`,
)
if (
  JSON.stringify(Object.keys(approvals).sort()) !== JSON.stringify(expectedApprovalKeys.sort()) ||
  Object.values(approvals).some((allowed) => allowed !== true)
) {
  throw new Error('package.json allowScripts differs from the reviewed exact package set')
}

const installed = []
for (const [name, version] of REVIEWED_INSTALL_SCRIPTS) {
  const lockEntry = lock.packages?.[`node_modules/${name}`]
  if (lockEntry?.version !== version || lockEntry.hasInstallScript !== true) {
    throw new Error(
      `${name}@${version} is not an exact install-script package in package-lock.json`,
    )
  }

  const packageDirectory = path.join(root, 'node_modules', name)
  let directoryStats
  try {
    directoryStats = fs.lstatSync(packageDirectory)
  } catch (error) {
    if (
      name === 'fsevents' &&
      process.platform !== 'darwin' &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      continue
    }
    throw error
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`refusing unsafe installed package directory ${packageDirectory}`)
  }
  if (fs.realpathSync(packageDirectory) !== packageDirectory) {
    throw new Error(`installed package path traverses a symbolic link: ${packageDirectory}`)
  }

  const installedManifestPath = path.join(packageDirectory, 'package.json')
  const installedManifestStats = fs.lstatSync(installedManifestPath)
  if (!installedManifestStats.isFile() || installedManifestStats.isSymbolicLink()) {
    throw new Error(`refusing unsafe installed manifest ${installedManifestPath}`)
  }
  const installedManifest = readJson(installedManifestPath)
  if (installedManifest.name !== name || installedManifest.version !== version) {
    throw new Error(`installed ${name} does not match reviewed version ${version}`)
  }
  installed.push(name)
}

const npmExecPath = process.env.npm_execpath
const command = npmExecPath
  ? { executable: process.execPath, prefix: [npmExecPath] }
  : { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] }
const activeNpmVersion = npmExecPath ? npmVersionForCli(npmExecPath) : commandNpmVersion(command)
if (!isSupportedNpm(activeNpmVersion)) {
  throw new Error(
    `reviewed dependency rebuild requires npm >=11.16.0 and <12; received ${activeNpmVersion}`,
  )
}

const rebuild = spawnSync(
  command.executable,
  [...command.prefix, 'rebuild', ...installed, '--foreground-scripts'],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
if (rebuild.error || rebuild.status !== 0) {
  throw new Error(
    `reviewed dependency rebuild failed: ${rebuild.error?.message ?? `status ${String(rebuild.status)}`}`,
  )
}
console.log(`Rebuilt reviewed lifecycle packages: ${installed.join(', ')}`)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function isSupportedNpm(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return false
  return Number(match[1]) === 11 && Number(match[2]) >= 16
}

function npmVersionForCli(cli) {
  const resolvedCli = fs.realpathSync(cli)
  const cliStats = fs.lstatSync(resolvedCli)
  if (!cliStats.isFile() || cliStats.isSymbolicLink()) {
    throw new Error(`refusing unsafe npm CLI path ${cli}`)
  }
  const npmManifest = readJson(path.resolve(path.dirname(resolvedCli), '..', 'package.json'))
  if (npmManifest.name !== 'npm' || typeof npmManifest.version !== 'string') {
    throw new Error(`could not identify the active npm CLI at ${cli}`)
  }
  return npmManifest.version
}

function commandNpmVersion(npm) {
  const result = spawnSync(npm.executable, [...npm.prefix, '--version'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not determine active npm version: ${
        result.error?.message || result.stderr || result.stdout
      }`,
    )
  }
  return result.stdout.trim()
}
