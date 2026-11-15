// Isolated mock-model product Host for the Watchdog's real child-process contract.
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createProductHost } from '../dist/index.js'
import { nativeContext, textResponse } from './native-mock.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const databasePath = args.get('--database')
const watchdogStatusPath = args.get('--status')
const instanceId = args.get('--instance')
if (!databasePath || !watchdogStatusPath || !instanceId) throw new Error('Provide --database, --status and --instance.')
await mkdir(dirname(databasePath), { recursive: true })
const native = await nativeContext(join(dirname(databasePath), 'sessions'), function* () { yield* textResponse('Mock reply.') })
const host = await createProductHost(native, { databasePath, watchdogStatusPath, instanceId, actorId: 'fixture-user',
  main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
let closing
const stop = () => closing ??= (async () => { await host.close(); await native.fiber.dispose(); process.disconnect?.() })()
process.on('message', message => { if (message?.type === 'shutdown') void stop() })
