import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { createProductHost } from '../dist/index.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check) {
  const deadline = Date.now() + 20_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('The product view work did not settle.')
    await sleep(25)
  }
}

test('an interactive Worker view waits on its exact work and resumes into a verified report view', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-product-views-'))
  const work = join(root, 'work'), core = join(root, 'core')
  await Promise.all([mkdir(work), mkdir(core)])
  let promptView, reportView
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) { yield* textResponse('The structured result is ready.'); return }
      if (completedToolCount(options) === 0) yield* toolResponse('delegate_work', { goal: 'Create a reviewed note.',
        constraints: 'Ask for the layout before the final file.', acceptanceCriteria: 'Return the verified file and its view.' })
      else yield* textResponse('The note work was delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    const count = completedToolCount(options)
    const answering = lastUserText(options).includes('[Answer to view card] Choose a note layout')
    if (answering && count === 0) yield* toolResponse('write_file', { path: 'final.txt', text: 'Detailed note.' }, 'view-final')
    else if (answering && count === 1) yield* toolResponse('run_shell', { command: `node -e "if(require('fs').readFileSync('final.txt','utf8')!=='Detailed note.')process.exit(1)"` }, 'view-check')
    else if (answering && count === 2) yield* toolResponse('report_ready', { result: 'Created the detailed note.',
      evidence: 'Checked the final note after applying the view answer.', artifacts: 'final.txt', view: reportView }, 'view-report')
    else if (answering) yield* textResponse('The structured note is complete.')
    else if (count === 0) yield* toolResponse('write_file', { path: 'draft.txt', text: 'Draft note.' }, 'view-draft')
    else if (count === 1) yield* toolResponse('show_view', { title: 'Display only',
      view: JSON.stringify({ type: 'metric', label: 'Draft', value: '1' }) }, 'invalid-display-view')
    else if (count === 2) yield* toolResponse('show_view', { title: 'Choose a note layout', view: promptView }, 'view-question')
    else yield* textResponse('The structured note is complete.')
  })
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { instanceId: 'personal', actorId: 'alice', databasePath: join(core, 'state.sqlite'),
    workspaceRoot: work, main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' },
    worker: { provider: 'mock', model: 'worker' } })
  const directory = await host.dispatch('directory-options', { instanceId: 'personal' })
  const environmentRoot = directory.default.root
  promptView = JSON.stringify({ type: 'stack', children: [
    { type: 'text', text: `Workspace ${environmentRoot}; token=private-view-value` },
    { type: 'options', id: 'layout', options: [{ label: 'Compact' }, { label: 'Detailed' }] },
  ] })
  reportView = JSON.stringify({ title: 'Chosen layout', view: { type: 'stack', children: [
    { type: 'metric', label: 'Layout', value: 'Detailed' },
    { type: 'text', text: `The final note uses the selected layout in ${environmentRoot}; password=hidden-value.` },
  ] } })
  await host.dispatch('send', { instanceId: 'personal', commandId: 'send-view-work', text: 'Create the reviewed note.' })
  let card
  await until(async () => {
    card = (await host.dispatch('history', { instanceId: 'personal' })).works[0]
    return card?.status === 'waiting' && card.control?.attention?.view
  })
  assert.equal(card.control.attention.view.title, 'Choose a note layout')
  assert.equal(card.control.attention.view.view.type, 'stack')
  assert.match(card.control.attention.view.view.children[0].text, /<workdir>.*token=\[redacted\]/u)
  await assert.rejects(host.dispatch('work-answer-view', { instanceId: 'personal', commandId: 'wrong-generation',
    workItemId: card.brief.workItemId, ticketId: card.receipt.ticketId, expectedGeneration: 'old-generation',
    attentionId: card.control.attention.id, attentionVersion: card.control.attention.version,
    action: 'layout', values: { selected: ['Detailed'] } }), { code: 'ATTENTION_STALE' })
  await assert.rejects(host.dispatch('work-answer-view', { instanceId: 'personal', commandId: 'bad-view-answer',
    workItemId: card.brief.workItemId, ticketId: card.receipt.ticketId,
    expectedGeneration: card.control.assignment.generation, attentionId: card.control.attention.id,
    attentionVersion: card.control.attention.version, action: 'layout', values: { selected: [] } }), { code: 'INVALID_INPUT' })
  const command = { instanceId: 'personal', commandId: 'answer-view', workItemId: card.brief.workItemId,
    ticketId: card.receipt.ticketId, expectedGeneration: card.control.assignment.generation,
    attentionId: card.control.attention.id, attentionVersion: card.control.attention.version,
    action: 'layout', values: { selected: ['Detailed'] } }
  const answered = await host.dispatch('work-answer-view', command)
  assert.equal(answered.attention.status, 'answered')
  assert.equal(answered.attention.answerView.values.selected[0], 'Detailed')
  assert.equal((await host.dispatch('work-answer-view', command)).input.id, answered.input.id)
  await until(async () => {
    card = (await host.dispatch('history', { instanceId: 'personal' })).works[0]
    return card?.outcome?.status === 'success'
  })
  assert.equal(card.outcome.view.title, 'Chosen layout')
  assert.equal(card.outcome.view.view.children[0].type, 'metric')
  assert.match(card.outcome.view.view.children[1].text, /<workdir>.*password=\[redacted\]/u)
  assert.equal(card.outcome.artifacts[0].path, 'final.txt')
  assert.equal(await readFile(join(work, 'final.txt'), 'utf8'), 'Detailed note.')
  await assert.rejects(host.dispatch('work-answer-view', { ...command, commandId: 'stale-view-answer' }),
    { code: 'ATTENTION_STALE' })
})
