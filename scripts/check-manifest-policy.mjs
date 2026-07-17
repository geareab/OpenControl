import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const failures = []
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const exactScriptApproval = /^(?:@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const supportedNodeRange = '>=22.23.1 <23 || >=24.18.0 <25'
const supportedNpmRange = '>=11.16.0 <12'
const reviewedPackageManager = 'npm@11.16.0'

if (manifest.private !== true) {
  failures.push('package.json must remain private until a scoped npm package is approved')
}
if (manifest.engines?.node !== supportedNodeRange) {
  failures.push(`engines.node must remain ${supportedNodeRange}`)
}
if (manifest.engines?.npm !== supportedNpmRange) {
  failures.push(`engines.npm must remain ${supportedNpmRange}`)
}
if (manifest.packageManager !== reviewedPackageManager) {
  failures.push(`packageManager must remain ${reviewedPackageManager}`)
}

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (typeof version !== 'string' || !exactVersion.test(version)) {
      failures.push(`${section}.${name} must use an exact version; received ${String(version)}`)
    }
  }
}

for (const [dependency, allowed] of Object.entries(manifest.allowScripts ?? {})) {
  if (!exactScriptApproval.test(dependency)) {
    failures.push(`allowScripts.${dependency} must pin an exact reviewed package version`)
  }
  if (allowed !== true && allowed !== false) {
    failures.push(`allowScripts.${dependency} must be an explicit boolean`)
  }
}

const npmrc = fs.readFileSync(new URL('../.npmrc', import.meta.url), 'utf8')
for (const requiredSetting of ['engine-strict=true', 'strict-allow-scripts=true']) {
  if (!npmrc.split(/\r?\n/u).includes(requiredSetting)) {
    failures.push(`.npmrc must include ${requiredSetting}`)
  }
}

for (const script of [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
]) {
  if (script in (manifest.scripts ?? {})) {
    failures.push(`root lifecycle script ${script} is disabled for the GitHub-first launch`)
  }
}

if (manifest.publishConfig !== undefined) {
  failures.push('publishConfig must not be added before the scoped trusted-publishing design')
}

if (manifest.files?.some((entry) => entry === 'firmware' || entry.startsWith('firmware/'))) {
  failures.push('the MIT npm artifact must not include the GPL firmware tree')
}

if (failures.length > 0) {
  console.error(`Manifest policy failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(
    'Manifest is private, runtime-pinned, script-policy-enforced, and free of publish lifecycle hooks.',
  )
}
