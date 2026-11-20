import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserResources } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'

test('browser modes share the product grant, assignment, takeover and unknown operation checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'superagent-browser-modes-'))
  const storage = await SqliteStorage.open(join(root, 'settings.sqlite'))
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }) })
  const instanceId = 'personal'
  const environment = { kind: 'local', config: { id: 'local', instanceId, root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} } }
  const work = { instanceId, ticketId: 'ticket', workItemId: 'work', assignmentId: 'assignment', generation: 'generation', environmentId: 'local' }
  await storage.transaction(instanceId, async tx => {
    await tx.insert('work-brief', 'brief', { instanceId, environmentId: 'local' })
    await tx.insert('work-item', 'work', { workBriefId: 'brief' })
    await tx.insert('work-item-ticket', 'work', { ticketId: 'ticket' })
    await tx.insert('ticket', 'ticket', { state: 'open' })
    await tx.insert('assignment', 'ticket', { id: 'assignment', generation: 'generation', state: 'running',
      environment: { kind: 'local', id: 'local', root } })
  })
  const calls = []
  const controls = []
  let unknown = false
  const adapter = { linkReferences: true, async hold(profile, held) { controls.push({ profile, held }) },
    async execute(request, signal, authorize) {
      await authorize()
      signal.throwIfAborted()
      calls.push(request)
      if (unknown) throw new Error('Fixture lost the result.')
      return 'Fixture browser page'
    } }
  const browser = new BrowserResources(storage, instanceId, 'alice', [environment], adapter, async () => {})
  const resource = await browser.create({ instanceId, commandId: 'create', environmentId: 'local', label: 'Research' })
  const resourceId = resource.id
  const signal = new AbortController().signal
  const load = options => browser.workerTools(async () => work, options)
  const setting = (mode, expectedRevision) => ({ instanceId, commandId: `set-${mode}`, mode, expectedRevision })
  assert.deepEqual(await browser.plugin({ instanceId }), { mode: 'off', revision: 0, modes: ['off', 'refs', 'script', 'task'] })
  assert.deepEqual((await load()).map(tool => tool.name), ['browser_resources', 'browser_use'])
  const refsSetting = setting('refs', 0)
  const selected = await browser.setPlugin(refsSetting)
  assert.deepEqual(await browser.setPlugin(refsSetting), selected)
  const refs = await load()
  assert.deepEqual(refs.map(tool => tool.name), ['browser_resources', 'browser_open', 'browser_snapshot', 'browser_click'])
  const snapshot = refs.find(tool => tool.name === 'browser_snapshot')
  await assert.rejects(snapshot.execute({ resourceId }, signal), { code: 'BROWSER_DENIED' })
  const grant = await browser.grant({ instanceId, commandId: 'grant', resourceId, workItemId: 'work', expectedRevision: 1, active: true })
  assert.equal(await snapshot.execute({ resourceId }, signal), 'Fixture browser page')
  assert.equal(calls[0].referenceScope, JSON.stringify(['assignment', 'generation', 1]))
  const click = refs.find(tool => tool.name === 'browser_click')
  await assert.rejects(click.execute({ resourceId, ref: '//button' }, signal), { code: 'INVALID_INPUT' })
  assert.equal(await click.execute({ resourceId, ref: 'e1-1111111111111111' }, signal), 'Fixture browser page')
  assert.equal(calls[1].action, 'follow')
  assert.equal(calls[1].url, undefined)
  const takeover = await browser.take({ instanceId, commandId: 'take', resourceId, workItemId: 'work', expectedRevision: grant.revision })
  await assert.rejects(snapshot.execute({ resourceId }, signal), { code: 'BROWSER_HUMAN_CONTROL' })
  await browser.giveBack({ instanceId, commandId: 'return', resourceId, controlId: takeover.id })
  assert.deepEqual(controls.map(item => item.held), [true, false])

  await browser.setPlugin(setting('script', 1))
  await assert.rejects(snapshot.execute({ resourceId }, signal), { code: 'BROWSER_PLUGIN_CHANGED' })
  const facts = []
  const script = (await load({ recordStep: fact => facts.push(fact) })).find(tool => tool.name === 'browser_exec')
  await assert.rejects(script.execute({ resourceId, steps: 'unknown JavaScript source' }, signal), { code: 'INVALID_INPUT' })
  await assert.rejects(script.execute({ resourceId, steps: '[{"action":"snapshot"},{"action":"submit"}]' }, signal), { code: 'INVALID_INPUT' })
  assert.equal(calls.length, 2)
  const result = JSON.parse(await script.execute({ resourceId, steps: '[{"action":"open","url":"https://example.test/guide"},{"action":"snapshot"}]' }, signal))
  assert.deepEqual(result.steps.map(item => item.action), ['open', 'snapshot'])
  assert.equal(result.finalSnapshot, 'Fixture browser page')
  assert.equal(facts.length, 2)
  assert.ok(facts.every(item => item.operationId))
  await browser.setPlugin(setting('task', 2))
  const task = (await load()).find(tool => tool.name === 'browser_task')
  unknown = true
  await assert.rejects(task.execute({ resourceId, goal: 'Read the guide', steps: '[{"action":"snapshot"},{"action":"snapshot"}]' }, signal),
    { code: 'BROWSER_OUTCOME_UNKNOWN' })
  assert.equal(calls.length, 5)
  await assert.rejects(task.execute({ resourceId, goal: 'Read the guide', steps: '[{"action":"snapshot"}]' }, signal),
    { code: 'BROWSER_RECONCILE_REQUIRED' })
  const unsupported = new BrowserResources(storage, instanceId, 'alice', [environment], { execute: adapter.execute }, async () => {})
  assert.deepEqual((await unsupported.plugin({ instanceId })).modes, ['off'])
  await assert.rejects(unsupported.setPlugin({ ...refsSetting, commandId: 'unsupported', expectedRevision: 3 }), { code: 'UNAVAILABLE' })
})
