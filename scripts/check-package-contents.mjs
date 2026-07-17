import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const cache = path.join(os.tmpdir(), 'opencontrol-npm-pack-cache')
const raw = execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache],
  { encoding: 'utf8' },
)
const result = JSON.parse(raw)[0]
const paths = (result?.files ?? []).map((file) => file.path)
const forbidden = [
  /^firmware(?:\/|$)/,
  /^dist\/firmware(?:\/|$)/,
  /^src(?:\/|$)/,
  /^test(?:\/|$)/,
  /^\.github(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(?:pem|key|p12|jks)$/i,
]
const violations = paths.filter((entry) => forbidden.some((pattern) => pattern.test(entry)))

if (violations.length > 0) {
  console.error(
    `Forbidden npm package contents:\n${violations.map((item) => `- ${item}`).join('\n')}`,
  )
  process.exitCode = 1
} else {
  console.log(
    `Validated ${paths.length} npm package entries; no private or GPL source paths included.`,
  )
}
