import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { mountProduct } from './helpers/mount-product.js'

const workspace = { id: 'fixture-workspace', root: '/fixture', kind: 'local', eligible: true }
const environment = { policy: { defaultTarget: 'local-only' }, environments: [workspace] }

test('Classic mode returns to the original Main and preserves a new draft even when it repeats the submitted text', async context => {
  const receipt = Promise.withResolvers()
  const works = [{ brief: { id: 'brief', workItemId: 'item', goal: 'Keep working on the note' },
    receipt: { status: 'accepted', ticketId: 'in-flight-ticket' }, status: 'running' }]
  const messages = []
  const { act, click, document, fill, findButton, key, navigations, requests, slots, window } = await mountProduct(context, {
    native: true,
    responses: {
      send: () => receipt.promise,
      'classic-open': () => ({ sessionId: 'classic-fixture', workspaceId: 'classic-workspace-fixture' }),
      'classic-close': () => ({ closed: true }),
      history: () => ({ mainSessionId: 'main-fixture', messages, works, health: { state: 'ready' } }),
      'directory-options': () => ({ default: { environmentId: workspace.id, root: workspace.root }, directories: [workspace] }),
      'execution-options': () => environment,
    },
  })
  const text = 'Keep the original Main working'
  await fill(document.querySelector('#main-message'), text)
  await click(findButton('Send'))
  await fill(document.querySelector('#main-message'), '')
  await fill(document.querySelector('#main-message'), text)
  await click(findButton('Account'))
  const classic = findButton('Classic Agent mode')
  assert.ok(classic)
  await click(classic)
  assert.ok(document.querySelector('[aria-label="Native session classic-fixture"]'))
  assert.equal(document.querySelector('#main-message'), null)
  assert.equal(document.querySelector('[role="menu"]'), null)
  assert.equal(slots.entries('conversation.composer').length, 0)
  assert.equal(slots.entries('sidebar.workspaces').length, 0)
  assert.equal(document.activeElement, findButton('Back to DS SuperAgent'))
  assert.equal(navigations.at(-1), 'classic-fixture')

  messages.push({ id: 'native-main-input', role: 'user', sequence: 1, text, status: 'completed' },
    { id: 'reply:native-main-input', role: 'main', sequence: 2, text: 'The original Main is here.', status: 'completed' })
  await act(async () => receipt.resolve({ messageId: 'native-main-input', status: 'completed' }))
  await click(findButton('Back to DS SuperAgent'))
  assert.deepEqual(navigations, ['main-fixture', 'classic-fixture', 'main-fixture'])
  assert.equal(document.querySelector('#main-message').value, text)
  assert.equal(document.activeElement.id, 'main-message')
  await key(document.activeElement, 'Escape')
  assert.equal(findButton('Back to DS SuperAgent'), undefined)
  assert.match(document.body.textContent, /Keep working on the note/u)
  assert.match(document.body.textContent, /Running work/u)
  assert.match(document.body.textContent, /Receipt: Accepted by Router/u)
  assert.deepEqual(requests.filter(request => ['send', 'classic-open', 'classic-close', 'stop-main', 'work-stop'].includes(request.endpoint))
    .map(request => request.endpoint), ['send', 'classic-open', 'classic-close'])
  assert.equal(window.localStorage.getItem('ds-bot:surface'), null)
})

test('Classic mode preserves the unsent attachment for the original Main and Environment', async context => {
  const { act, click, document, fill, findButton, navigations, requests, window } = await mountProduct(context, {
    native: true,
    responses: {
      'classic-open': () => ({ sessionId: 'classic-fixture', workspaceId: 'classic-workspace-fixture' }),
      'classic-close': () => ({ closed: true }),
      'directory-options': () => ({ default: { environmentId: workspace.id, root: workspace.root }, directories: [workspace] }),
      'execution-options': () => environment,
      'attachment-upload': () => ({ id: 'attachment-fixture', name: 'note.txt', environmentId: workspace.id, bytes: 4 }),
      send: () => ({ messageId: 'with-attachment', status: 'completed' }),
    },
  })
  const filePicker = document.querySelector('.bt-main-composer input[type="file"]')
  const file = new window.File(['note'], 'note.txt', { type: 'text/plain' })
  file.arrayBuffer = async () => new TextEncoder().encode('note').buffer
  await act(async () => {
    Object.defineProperty(filePicker, 'files', { value: [file] })
    filePicker.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  const uploadDeadline = Date.now() + 2_000
  while (!findButton('Remove note.txt') && Date.now() < uploadDeadline) await act(async () => wait(20))
  assert.ok(findButton('Remove note.txt'), document.querySelector('.bt-main-composer [role="alert"]')?.textContent)
  await fill(document.querySelector('#main-message'), 'Review the attached note')
  await click(findButton('Account'))
  await click(findButton('Classic Agent mode'))
  await click(findButton('Back to DS SuperAgent'))

  assert.deepEqual(navigations, ['main-fixture', 'classic-fixture', 'main-fixture'])
  assert.equal(document.querySelector('#main-message').value, 'Review the attached note')
  assert.ok(findButton('Remove note.txt'))
  const attachmentActions = () => requests.filter(request => ['attachment-upload', 'attachment-revoke', 'send'].includes(request.endpoint))
  assert.deepEqual(attachmentActions().map(request => request.endpoint), ['attachment-upload'])
  await click(findButton('Send'))
  assert.deepEqual(attachmentActions().map(request => request.endpoint), ['attachment-upload', 'send'])
  const { text, attachments, environmentId } = attachmentActions()[1].payload
  assert.deepEqual({ text, attachments, environmentId }, {
    text: 'Review the attached note', attachments: ['attachment-fixture'], environmentId: workspace.id,
  })
})

test('Classic mode stays on Main when no native Session is granted', async context => {
  const { click, document, findButton, navigations, requests } = await mountProduct(context, { native: true, responses: {
    'classic-open': () => { throw new Error('This Host has no authorized independent Session.') },
  } })
  const account = findButton('Account')
  await click(account)
  await click(findButton('Classic Agent mode'))
  assert.equal(document.activeElement, account)
  assert.match(document.querySelector('[role="alert"]').textContent, /no authorized independent Session/u)
  assert.equal(findButton('Back to DS SuperAgent'), undefined)
  assert.deepEqual(navigations, ['main-fixture'])
  assert.equal(requests.filter(request => request.endpoint === 'classic-open').length, 1)
})

test('a paired client has no Classic Agent mode menu entry', async context => {
  const { document, findButton, requests } = await mountProduct(context, { native: true, connection: {
    connected: true, capabilities: ['read', 'command'], client: { id: 'viewer', label: 'Viewer' }, address: 'https://fixture',
  } })
  assert.ok(document.querySelector('#main-message'))
  assert.equal(findButton('Classic Agent mode'), undefined)
  assert.equal(requests.some(request => request.endpoint === 'classic-open'), false)
})

test('a failed native navigation releases its grant and restores Main', async context => {
  const { click, document, findButton, navigations, requests } = await mountProduct(context, {
    native: true,
    classicNavigationError: new Error('The authorized native Session is no longer available.'),
    responses: {
      'classic-open': () => ({ sessionId: 'classic-fixture', workspaceId: 'classic-workspace-fixture' }),
      'classic-close': () => ({ closed: true }),
    },
  })
  await click(findButton('Account'))
  await click(findButton('Classic Agent mode'))
  assert.equal(document.activeElement.id, 'main-message')
  assert.equal(findButton('Back to DS SuperAgent'), undefined)
  assert.match(document.querySelector('[role="alert"]').textContent, /no longer available/u)
  assert.deepEqual(navigations, ['main-fixture', 'main-fixture'])
  assert.deepEqual(requests.filter(request => request.endpoint.startsWith('classic-'))
    .map(request => request.endpoint), ['classic-open', 'classic-close'])
})
