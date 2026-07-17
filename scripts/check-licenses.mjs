import fs from 'node:fs'

const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const allowed = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'Python-2.0',
  '(MIT OR X11)',
])
const reviewedCopyleft = new Map([['dualsense-ts', 'LGPL-3.0']])
const failures = []

for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
  if (!location) continue
  const name = location.split('node_modules/').at(-1)
  const license = metadata.license
  if (!name || typeof license !== 'string') {
    failures.push(`${location}: missing package name or license`)
    continue
  }
  if (allowed.has(license)) continue
  if (reviewedCopyleft.get(name) === license) continue
  failures.push(`${name}@${metadata.version ?? 'unknown'}: unapproved license ${license}`)
}

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (manifest.files?.some((entry) => entry === 'firmware' || entry.startsWith('firmware/'))) {
  failures.push('The MIT npm artifact must not include the GPL firmware tree')
}

if (failures.length > 0) {
  console.error(`License policy failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Validated licenses for ${Object.keys(lock.packages).length - 1} locked packages.`)
}
