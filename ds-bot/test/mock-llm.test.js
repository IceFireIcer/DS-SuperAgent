import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const mockPath = fileURLToPath(new URL('../dev/mock-llm.mjs', import.meta.url))

async function start(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsb-product-mock-'))
  const log = join(directory, 'mock.jsonl')
  const child = spawn(process.execPath, [mockPath], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: log }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => { child.kill(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }) })
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      const found = /http:\/\/127\.0\.0\.1:(\d+)\/v1/u.exec(output)
      if (found) resolve({ url: `http://127.0.0.1:${found[1]}/v1`, log })
    })
    child.once('exit', code => reject(new Error(`mock model exited ${String(code)}`)))
  })
}

test('the product mock returns the packaged-app reply and no old team behaviour', async t => {
  const { url, log } = await start(t)
  const response = await fetch(`${url}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'packaged app check' }] }] }),
  })
  assert.equal(response.status, 200)
  const events = (await response.text()).split('\n\n')
    .map(chunk => /^data: (.*)$/mu.exec(chunk)?.[1]).filter(Boolean).map(JSON.parse)
  assert.equal(events.filter(event => event.type === 'content_block_delta')
    .map(event => event.delta.text).join(''), '收到：packaged app check')
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).reply, '收到：packaged app check')
})
