import { acquireRuntimeLease, type RuntimeLease } from '../../src/runtime.js'

const runtimePath = process.argv[2]
const token = process.argv[3]
let lease: RuntimeLease | null = null

if (!runtimePath || !token || !process.send) process.exit(2)

process.on('message', async (message) => {
  if (message === 'start') {
    lease = await acquireRuntimeLease({ file: runtimePath, token })
    process.send?.({ type: 'result', won: lease !== null })
    if (!lease) process.exit(0)
  } else if (message === 'release') {
    lease?.release()
    process.exit(0)
  }
})

process.send({ type: 'ready' })
