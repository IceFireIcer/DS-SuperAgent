import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createProductHost, LocalEnvironment } from '../dist/index.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

const project = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(project, 'superagent', 'dsh', 'office.js')
const original = join(project, 'superagent', 'dsh', 'test', 'fixtures', 'office', 'sample.docx')

test('an authorized Word upload becomes a checked, downloadable work artifact', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-product-word-'))
  const work = join(root, 'work'), core = join(root, 'core'), skillsPath = join(root, 'skills')
  await Promise.all([mkdir(work), mkdir(core), mkdir(join(skillsPath, 'office'), { recursive: true }),
    mkdir(join(skillsPath, 'office-docx'), { recursive: true })])
  for (const name of ['office', 'office-docx']) await writeFile(join(skillsPath, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Word document assistance.\n---\nUse the bound Office tool.`)
  const source = await readFile(original)
  let uploaded
  const native = await nativeContext(join(root, 'sessions'), function* (options) {
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) { yield* textResponse('The checked Word file is ready.'); return }
      if (completedToolCount(options) === 0) yield* toolResponse('delegate_work', { items: [{
        goal: 'Edit the attached Word document.', constraints: 'Keep its structure and create a new file.',
        acceptanceCriteria: 'Check the new Word file and make it downloadable.', attachmentIds: [uploaded.id],
      }] }, 'delegate-word')
      else yield* textResponse('The Word work was delegated.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    const count = completedToolCount(options)
    const matched = /Attached resources for this work[^\n]*\n(\[[^\n]+\])/u.exec(lastUserText(options))
    if (count === 0) yield* toolResponse('list_skills', {}, 'word-skills')
    else if (count === 1) {
      assert.ok(matched)
      assert.match(JSON.stringify(options.messages.filter(message => message.role === 'tool').at(-1)?.content), /office-docx/u)
      const reference = JSON.parse(matched[1])[0]
      yield* toolResponse('stage_attachment', { attachmentId: reference.attachmentId, id: reference.id,
        bytes: String(reference.bytes), sha256: reference.sha256, path: 'input.docx' }, 'stage-word')
    } else if (count === 2) yield* toolResponse('run_office', { operation: 'docx-read', input: 'input.docx' }, 'read-word')
    else if (count === 3) yield* toolResponse('run_office', { operation: 'docx-edit', input: 'input.docx',
      output: 'edited.docx', ops: JSON.stringify([{ replace: { find: 'north region', with: 'south area' } }]) }, 'edit-word')
    else if (count === 4) yield* toolResponse('run_office', { operation: 'check', input: 'edited.docx' }, 'check-word')
    else if (count === 5) yield* toolResponse('report_ready', { result: 'Created edited.docx.',
      evidence: 'The Word package is valid.', artifacts: 'edited.docx',
      view: JSON.stringify({ title: 'Invalid interactive report', view: { type: 'options', id: 'choice',
        options: [{ label: 'Continue' }] } }) }, 'invalid-report-view')
    else if (count === 6) yield* toolResponse('report_ready', { result: 'Created edited.docx.',
      evidence: 'Read the source and checked the edited Word package.', artifacts: 'edited.docx',
      view: JSON.stringify({ title: 'Edited Word document', view: { type: 'stack', children: [
        { type: 'metric', label: 'Changed region', value: '1' },
        { type: 'text', text: 'The edited Word package passed its structure check.' },
      ] } }) }, 'report-word')
    else yield* textResponse('The verified Word file is available.')
  })
  await native.plugin(LocalAttachmentStore, { dshHome: join(root, 'harness-home') })
  let host
  t.after(async () => { await host?.close(); await native.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  host = await createProductHost(native, { databasePath: join(core, 'state.sqlite'), workspaceRoot: work,
    instanceId: 'personal', actorId: 'alice', main: { provider: 'mock', model: 'main' },
    router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
    office: { node: process.execPath, cli, skillsPath } })
  const instanceId = 'personal'
  const directory = await host.dispatch('directory-options', { instanceId })
  uploaded = await host.dispatch('attachment-upload', { instanceId, commandId: 'upload-word',
    environmentId: directory.default.environmentId, kind: 'file', name: 'original.docx', data: source.toString('base64') })
  assert.equal((await host.dispatch('attachment-upload', { instanceId, commandId: 'upload-word',
    environmentId: directory.default.environmentId, kind: 'file', name: 'original.docx', data: source.toString('base64') })).id, uploaded.id)
  await host.dispatch('send', { instanceId, commandId: 'send-word', text: 'Edit this Word document.', attachments: [uploaded.id] })
  let card
  for (let attempt = 0; attempt < 100; attempt++) {
    card = (await host.dispatch('history', { instanceId })).works.find(item => item.outcome?.status === 'success')
    if (card) break
    await sleep(50)
  }
  assert.ok(card, 'the Worker must produce a checked artifact')
  assert.equal(card.outcome.artifacts.length, 1)
  assert.equal(card.outcome.artifacts[0].path, 'edited.docx')
  assert.equal(card.outcome.artifacts[0].reference.environmentId, directory.default.environmentId)
  assert.equal(card.outcome.view.title, 'Edited Word document')
  assert.equal(card.outcome.view.view.children[0].value, 1)
  assert.equal(card.outcome.summary, 'Created edited.docx.')
  let offset = 0
  const pages = []
  do {
    const page = await host.dispatch('artifact-read', { instanceId, workItemId: card.brief.workItemId,
      path: 'edited.docx', offset, maxBytes: 8192 })
    assert.equal(page.offset, offset)
    pages.push(page.encoding === 'base64' ? Buffer.from(page.text, 'base64') : Buffer.from(page.text, 'utf8'))
    offset = page.nextOffset
    if (!page.truncated) break
  } while (pages.length < 100)
  const output = Buffer.concat(pages)
  assert.equal(createHash('sha256').update(output).digest('hex'), card.outcome.artifacts[0].sha256)
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'docx', 'read', join(work, 'edited.docx'), '--json'], { encoding: 'utf8' }))
  assert.match(result.data.blocks[1].text, /south area/u)
  assert.equal((await readFile(join(work, 'input.docx'))).compare(source), 0)
  await assert.rejects(host.dispatch('artifact-read', { instanceId, workItemId: card.brief.workItemId,
    path: 'input.docx' }), { code: 'NOT_FOUND' })
  await assert.rejects(host.dispatch('artifact-read', { instanceId, workItemId: 'unknown', path: 'edited.docx' }),
    { code: 'NOT_FOUND' })
})

test('a Word operation stays within its original Environment and refuses uncertain files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r5-word-boundary-'))
  const work = join(root, 'work'), skillsPath = join(root, 'skills')
  await Promise.all([mkdir(work), mkdir(skillsPath)])
  const environment = await LocalEnvironment.open({ id: 'word-work', instanceId: 'personal', root: work,
    allowedActorIds: ['alice'], permissions: ['read', 'write', 'command'], skillsPath,
    assetsPath: join(root, 'assets'), commands: { office: { argv: [process.execPath, cli], timeoutMs: 10000 } } })
  t.after(async () => { await environment.close(); await rm(root, { recursive: true, force: true }) })
  const bound = await environment.prepare({ instanceId: 'personal', actorId: 'alice' })
  const foreign = { kind: 'attachment', environmentId: 'other-work', environmentKind: 'local', environmentFingerprint: 'foreign',
    id: `file:sha256:${'a'.repeat(64)}`, name: 'other.docx', bytes: 1, sha256: 'a'.repeat(64) }
  await assert.rejects(bound.stageAttachment(foreign, 'staged.docx'), { code: 'REFERENCE_STALE' })
  await assert.rejects(bound.runOffice({ operation: 'check', input: '../original.docx' }), { code: 'PATH_DENIED' })
  await writeFile(join(work, 'invalid.docx'), 'This is not an Office package.')
  await assert.rejects(bound.runOffice({ operation: 'check', input: 'invalid.docx' }), { code: 'OFFICE_CHECK_FAILED' })
  assert.equal((await readFile(join(work, 'invalid.docx'), 'utf8')), 'This is not an Office package.')
})
