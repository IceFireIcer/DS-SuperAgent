import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readProductArtifact, readProductAttachment, uploadFingerprint, uploadPayload, uploadWithRetry } from '../src/client/product-attachments.js'

test('product file input retains exact bytes and media type for admission', async () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 255])
  const file = new File([bytes], 'note.bin', { type: 'application/octet-stream' })
  const payload = await uploadPayload(file)
  assert.equal(payload.kind, 'file')
  assert.equal(payload.name, 'note.bin')
  assert.deepEqual(Buffer.from(payload.data, 'base64'), Buffer.from(bytes))
  assert.equal(await uploadFingerprint(payload, 'work-one'), await uploadFingerprint(payload, 'work-one'))
  assert.notEqual(await uploadFingerprint(payload, 'work-one'), await uploadFingerprint(payload, 'work-two'))
  await assert.rejects(uploadPayload(new File([], 'empty.txt')), /nonempty file/u)
})

test('product download joins bounded text and binary pages without losing bytes', async () => {
  const calls = []
  const pages = [
    { offset: 0, nextOffset: 3, totalBytes: 5, encoding: 'utf8', text: 'abc' },
    { offset: 3, nextOffset: 5, totalBytes: 5, encoding: 'base64', text: Buffer.from([0, 255]).toString('base64') },
  ]
  const result = await readProductAttachment(async (endpoint, request) => {
    calls.push({ endpoint, request })
    return pages[calls.length - 1]
  }, 'personal', 'asset-1')
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from([97, 98, 99, 0, 255]))
  assert.deepEqual(calls.map(call => call.request.offset), [0, 3])
  const artifact = await readProductArtifact(async (endpoint, request) => {
    assert.equal(endpoint, 'artifact-read')
    assert.deepEqual({ workItemId: request.workItemId, path: request.path }, { workItemId: 'work-1', path: 'out.txt' })
    return { offset: 0, nextOffset: 3, totalBytes: 3, encoding: 'utf8', text: 'out' }
  }, 'personal', 'work-1', 'out.txt')
  assert.equal(await artifact.text(), 'out')
})

test('a near-limit UTF-8 file remains readable when page boundaries shorten every page', async () => {
  const totalBytes = 8 * 1024 * 1024 - 2
  let calls = 0
  const result = await readProductAttachment(async (_endpoint, { offset }) => {
    calls += 1
    const nextOffset = Math.min(totalBytes, offset + 8190)
    return { offset, nextOffset, totalBytes, encoding: 'utf8', text: '中'.repeat((nextOffset - offset) / 3) }
  }, 'personal', 'near-limit')
  assert.ok(calls > 1024)
  assert.equal(result.size, totalBytes)
})

test('a lost upload response retries the original command identity', async () => {
  const entries = new Map()
  const store = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key) }
  const payload = await uploadPayload(new File(['retry me'], 'retry.txt'))
  const commands = []
  const call = async (_endpoint, request) => {
    commands.push(request.commandId)
    if (commands.length === 1) throw new Error('The response was lost.')
    return { id: 'accepted-upload' }
  }
  await assert.rejects(uploadWithRetry(call, store, 'personal', 'work-one', payload), /response was lost/u)
  assert.equal((await uploadWithRetry(call, store, 'personal', 'work-one', payload)).id, 'accepted-upload')
  assert.equal(commands[0], commands[1])
  assert.equal(entries.size, 0)
  await uploadWithRetry(call, store, 'personal', 'work-one', payload)
  assert.notEqual(commands[1], commands[2], 'a new upload after confirmation may have a new identity')
})
