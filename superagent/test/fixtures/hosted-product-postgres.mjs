import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as Profile from '../../dist/profile.js'
import * as PostgresSessionPersistence from '../../dist/session-persistence-postgres.js'
import {
  nativeContext, routerResponse, textResponse, toolResponse,
} from '../../dev/native-mock.mjs'
import { completedToolCount, lastUserText } from '../input-support.mjs'

const postgres = JSON.parse(process.env.DS_SUPERAGENT_POSTGRES)
const home = process.env.DSH_HOME
const workspace = process.env.DS_SUPERAGENT_WORKSPACE
const enroll = process.argv.includes('--enroll')
const replacement = process.argv.includes('--replacement')
if (!postgres || !home || !workspace) throw new Error('The hosted product fixture needs its trusted environment.')
await Promise.all([
  mkdir(join(home, 'core'), { recursive: true }),
  mkdir(workspace, { recursive: true }),
])

let native
let product
let replacementWorkerPhase = 0

async function stop() {
  try { await product?.close() }
  finally { await native?.fiber.dispose() }
}

function waitForShutdown() {
  return new Promise(resolve => {
    const shutdown = () => {
      process.off('message', onMessage)
      process.off('disconnect', shutdown)
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      resolve()
    }
    const onMessage = message => { if (message?.type === 'shutdown') shutdown() }
    process.on('message', onMessage)
    process.once('disconnect', shutdown)
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

async function* respond(options) {
  const text = lastUserText(options)
  const completed = completedToolCount(options)
  if (options.model === 'router') {
    yield* routerResponse(options)
    return
  }
  if (options.model === 'main') {
    if (text.startsWith('[Work update]')) {
      yield* textResponse('The recovered Work result is available in the same Main.')
      return
    }
    if (completed === 0) {
      yield* toolResponse('delegate_work', {
        goal: text,
        constraints: 'Keep the same Work, Ticket and Worker Session across Host replacement.',
        acceptanceCriteria: 'Resume the waiting Worker and return a verified result.',
      })
    } else {
      yield* textResponse('The recovery Work was delegated through the same Main.')
    }
    return
  }
  if (replacement) {
    if (replacementWorkerPhase === 0) {
      replacementWorkerPhase += 1
      yield* toolResponse('write_file', {
        path: 'recovered.txt',
        text: 'The successor Host continued this Worker.\n',
      })
    } else if (replacementWorkerPhase === 1) {
      replacementWorkerPhase += 1
      yield* toolResponse('run_shell', {
        command: process.platform === 'win32'
          ? "if ((Get-Content -Raw recovered.txt).Trim() -ne 'The successor Host continued this Worker.') { exit 1 }"
          : "test \"$(cat recovered.txt)\" = 'The successor Host continued this Worker.'",
      })
    } else if (replacementWorkerPhase === 2) {
      replacementWorkerPhase += 1
      yield* toolResponse('report_ready', {
        result: 'The Worker resumed after Host replacement.',
        evidence: 'The successor Host reopened the same waiting Assignment and submitted the human answer.',
        artifacts: 'recovered.txt',
      })
    } else {
      yield* textResponse('The recovered Worker result was recorded.')
    }
    return
  }
  if (completed === 0) {
    yield* toolResponse('ask_human', {
      question: 'Continue after replacement?',
      options: 'Continue\nStop',
    })
  } else {
    await sleep(60_000, undefined, { signal: options.signal })
    yield* textResponse('The Worker is waiting for the replacement proof.')
  }
}

try {
  native = await nativeContext(home, respond, {
    persistence: PostgresSessionPersistence,
    persistenceConfig: postgres,
  })
  await native.plugin(LocalCredentials, { path: join(home, 'fixture-credentials.yaml'), watch: false })
  await native.plugin(Profile, {
    instanceId: 'hosted-product',
    actorId: 'owner',
    workspaceRoot: workspace,
    main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' },
  })
  product = native.get('superagentProduct')
  if (!product?.clientGateway) throw new Error('The hosted product did not start its client gateway.')
  const binding = await product.dispatch('open')
  let enrollment
  if (enroll) {
    enrollment = await product.clients.enroll({
      commandId: 'hosted-product-client',
      label: 'Replacement test client',
      grants: [{ instanceId: 'hosted-product', capabilities: ['read', 'command'] }],
    })
  }
  const shutdown = waitForShutdown()
  process.send?.({
    type: 'ready',
    pid: process.pid,
    address: product.clientGateway.url,
    mainId: binding.mainId,
    mainSessionId: binding.mainSessionId,
    routerSessionId: binding.routerSessionId,
    ...(enrollment ? { credential: enrollment.token, clientId: enrollment.client.id } : {}),
  })
  await shutdown
} catch (error) {
  if (process.connected) process.send?.({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  try { await stop() }
  finally { if (process.connected) process.disconnect() }
}
