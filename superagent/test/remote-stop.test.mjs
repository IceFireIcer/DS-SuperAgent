import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as core from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { nativeContext, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { breakableProxy } from './fixtures/breakable-proxy.mjs'

const grant = {
  instanceId: 'private',
  environmentId: 'remote-project',
  allowedActorIds: ['user'],
  permissions: ['read', 'write', 'search', 'command'],
}

const commands = {
  long: { argv: [process.execPath, '-e', "console.log('stop-range');setInterval(()=>{},1000)"], timeoutMs: 5000, backgroundTimeoutMs: 120000 },
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

test('an offline remote stop stays pending instead of claiming the device range is cancelled', { timeout: 90000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-remote-stop-'))
  const root = join(directory, 'device-work')
  await mkdir(root)
  let device, proxy, environment, native, storage, sessions, engine
  context.after(async () => {
    engine?.shutdown()
    await engine?.effects.stop()
    await sessions?.close()
    await native?.fiber.dispose()
    await storage?.close()
    await environment?.close()
    await device?.close()
    await proxy?.close()
    await rm(directory, { recursive: true, force: true })
  })
  device = await core.RemoteDevice.open({ deviceId: 'second-device', root, jobsPath: join(directory, 'device-jobs'),
    commands, grants: [grant], statePath: join(directory, 'device-state.json') })
  const endpoint = await device.start()
  proxy = await breakableProxy(endpoint)
  environment = await core.RemoteEnvironment.pair({ id: 'remote-project', instanceId: 'private', allowedActorIds: ['user'],
    permissions: ['read', 'write', 'search', 'command'], endpoint: proxy.endpoint, pairingCode: device.pairingCode,
    expectedDeviceId: 'second-device', expectedDeviceKey: device.deviceKeyFingerprint })
  native = await nativeContext(join(directory, 'sessions'), options => {
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const results = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool')
    if (options.model === 'worker') {
      if (results.length === 0) return toolResponse('start_command', { name: 'long' }, 'remote-stop-0')
      return textResponse('Started the long device command.')
    }
    return results.length ? textResponse('Recorded.') : toolResponse('assign_worker', {})
  })
  storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  sessions = new core.NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  engine = new core.Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {}, sessions,
    [environment], {}, { waitMs: 60000 })
  const receipt = await engine.submit({ commandId: 'remote-stop', eventId: 'remote-stop', text: 'Start a long device command.', environmentId: 'remote-project' })
  let conversation
  for (let index = 0; index < 200; index++) {
    await engine.effects.drain()
    conversation = await engine.conversation(receipt.ticketId)
    if (conversation.jobs?.some(job => job.state === 'running') && conversation.reason === 'worker-idle') break
    await sleep(25)
  }
  assert.ok(conversation.jobs.some(job => job.state === 'running'), JSON.stringify(conversation))
  proxy.state.blocked = true
  await sleep(1000)
  await engine.stopTicket({ commandId: 'stop-remote', ticketId: receipt.ticketId, reason: 'user requested stop' })
  conversation = await engine.conversation(receipt.ticketId)
  assert.equal(conversation.stop.state, 'stopping')
  assert.equal(conversation.stop.pendingDeviceConfirmation, true)
  assert.equal(conversation.jobs[0].state, 'unknown')
  await assert.rejects(engine.resumeTicket({ commandId: 'resume-too-early', ticketId: receipt.ticketId }), { code: 'STOPPING' })

  let inspectedWrongDevice = false
  const replacement = {
    kind: 'remote',
    config: { ...environment.config, root: join(directory, 'replacement-work') },
    deviceId: 'replacement-device',
    deviceIncarnation: 'replacement-incarnation',
    online: true,
    authorize() {},
    prepare: async () => {
      inspectedWrongDevice = true
      throw new Error('The replacement device must not inspect the original range.')
    },
    close: async () => {},
  }
  const replacementEngine = new core.Engine(storage, 'private',
    { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {}, sessions,
    [replacement], {}, { waitMs: 60000 })
  try {
    const stillPending = await replacementEngine.reconcileStop({ commandId: 'reconcile-on-wrong-device',
      ticketId: receipt.ticketId })
    assert.equal(inspectedWrongDevice, false)
    assert.equal(stillPending.stop.pendingDeviceConfirmation, true)
  } finally {
    await replacementEngine.shutdown()
    await replacementEngine.effects.stop()
  }
})
