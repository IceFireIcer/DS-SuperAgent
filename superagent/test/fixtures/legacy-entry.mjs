import { spawn } from 'node:child_process'

const configuration = JSON.parse(process.argv[2])
const child = spawn(process.execPath, [configuration.receiver, JSON.stringify(configuration)], { stdio: 'inherit' })
let stopping = false
const forward = signal => {
  if (stopping) return
  stopping = true
  if (!child.killed) child.kill(signal)
}
process.on('SIGTERM', () => forward('SIGTERM'))
process.on('SIGINT', () => forward('SIGINT'))
child.on('exit', code => process.exit(code ?? 1))
child.on('error', () => process.exit(1))
