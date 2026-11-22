import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { mountProduct } from './helpers/mount-product.js'

const first = { id: 'fixture-directory-a', root: '/fixture/directory-a', title: 'directory-a' }
const second = { id: 'fixture-directory-b', root: '/fixture/directory-b', title: 'directory-b' }
const failure = message => Promise.reject(new Error(message))

test('Main and both sidebar widths share the directory for the next accepted input', async context => {
  let pickerResult = second.root
  let sendRejected = true
  const directoryRequests = []
  const sendRequests = []
  const directoryOptions = () => ({ default: { environmentId: first.id, root: first.root }, directories: [first, second], picker: 'native' })
  const { act, click, document, fill, findButton, key, setWide, window } = await mountProduct(context, {
    responses: {
      'directory-options': directoryOptions,
      'execution-options': () => ({ policy: { defaultTarget: 'local-only' }, environments: [first, second]
        .map(entry => ({ ...entry, kind: 'local', eligible: true })) }),
      'directory-register': input => {
        directoryRequests.push(input.path)
        return input.path === second.root ? second : failure('This folder was not authorized.')
      },
      'directory-pick': () => pickerResult,
      'attachment-upload': () => ({ id: 'attachment-id', name: 'note.txt', environmentId: second.id, bytes: 4 }),
      'attachment-revoke': () => ({ revoked: true }),
      send: input => {
        sendRequests.push(input)
        if (sendRejected) return failure('Could not send this message.')
        return { messageId: 'accepted-work', status: 'completed' }
      },
    },
  })
  const nav = document.querySelector('nav[aria-label="Work navigation"]')
  const sidebar = () => nav.querySelector('button[aria-haspopup="menu"][aria-label^="Work directory:"]')
  const composer = () => document.querySelector('.bt-main-composer button[aria-haspopup="menu"]')
  const menu = () => document.querySelector('[role="menu"][aria-label="Work directory"]:not([inert])')
  const draft = document.querySelector('textarea')
  const send = () => document.querySelector('.bt-main-composer button[type="submit"]')
  const shows = root => {
    assert.equal(sidebar().getAttribute('aria-label'), `Work directory: ${root}`)
    assert.equal(composer().getAttribute('aria-label'), `Work directory: ${root}`)
  }

  shows(first.root)
  await click(sidebar())
  assert.equal(document.activeElement.getAttribute('aria-checked'), 'true')
  await key(document.activeElement, 'ArrowDown')
  assert.equal(document.activeElement.title, second.root)
  await click(document.activeElement)
  shows(second.root)
  assert.equal(document.activeElement, sidebar())

  await setWide(false)
  shows(second.root)
  await click(sidebar())
  await key(document.activeElement, 'ArrowUp')
  assert.equal(document.activeElement.title, first.root)
  await key(document.activeElement, 'Escape')
  assert.equal(menu(), null)
  assert.equal(document.activeElement, sidebar())
  await setWide(true)
  shows(second.root)

  pickerResult = null
  await click(sidebar())
  await click(findButton('Choose a folder…', menu()))
  shows(second.root)
  assert.deepEqual(directoryRequests, [second.root])
  pickerResult = '/fixture/denied'
  await click(sidebar())
  await click(findButton('Choose a folder…', menu()))
  assert.match(nav.querySelector('[role="alert"]').textContent, /not authorized/u)
  shows(second.root)

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
  await click(sidebar())
  await key(document.activeElement, 'ArrowUp')
  await click(document.activeElement)
  assert.match(nav.querySelector('[role="alert"]').textContent, /Remove attached files/u)
  shows(second.root)
  await click(findButton('Remove note.txt'))

  await click(composer())
  await act(async () => document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  assert.equal(menu(), null)
  assert.equal(document.activeElement, composer())
  await fill(draft, 'Write the next note.')
  await click(send())
  assert.match(document.querySelector('.bt-main-composer [role="alert"]').textContent, /Could not send/u)
  shows(second.root)
  assert.equal(draft.value, 'Write the next note.')
  sendRejected = false
  await click(send())
  shows(first.root)
  assert.equal(draft.value, '')
  assert.equal(sendRequests.length, 2)
  assert.deepEqual(sendRequests.map(({ environmentId, target }) => ({ environmentId, target })), [
    { environmentId: second.id, target: 'local-only' }, { environmentId: second.id, target: 'local-only' },
  ])
  assert.equal(sendRequests[0].commandId, sendRequests[1].commandId)
})

test('Main can send its first local input without assigning an instance default', async context => {
  let registered = false
  const { click, document, fill, findButton, requests } = await mountProduct(context, {
    responses: {
      'directory-options': () => ({ default: null, directories: registered ? [first] : [], picker: 'native' }),
      'execution-options': () => ({ policy: { defaultTarget: 'local-only' }, environments: registered ? [{ ...first, kind: 'local' }] : [] }),
      'directory-pick': () => first.root,
      'directory-register': () => { registered = true; return first },
      send: () => ({ messageId: 'first-input', status: 'completed' }),
    },
  })
  const sidebar = () => document.querySelector('nav button[aria-label^="Work directory:"]')
  assert.equal(sidebar().getAttribute('aria-label'), 'Work directory: No directory selected')
  await click(sidebar())
  await click(findButton('Choose a folder…'))
  await fill(document.querySelector('textarea'), 'Start work here.')
  await click(document.querySelector('.bt-main-composer button[type="submit"]'))
  assert.equal(requests.find(({ endpoint }) => endpoint === 'send').payload.environmentId, first.id)
  assert.equal(requests.some(({ endpoint }) => endpoint === 'directory-default-save'), false)
  assert.equal(sidebar().getAttribute('aria-label'), 'Work directory: No directory selected')
  assert.equal(document.querySelector('.bt-main-composer button[aria-haspopup="menu"]').getAttribute('aria-label'), 'Work directory: No directory selected')
})
