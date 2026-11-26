// Minimal Anthropic Messages mock for packaged-app and isolated product smoke checks.
// It needs no key and implements no team tools or old runtime behaviour.
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { previewAcceptanceReply } from './preview-acceptance-model.mjs'
import { t55ControlsReply, t55SlowReply } from './t55-controls-model.mjs'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.MOCK_PORT ?? 8765)
const logPath = process.env.MOCK_LOG ?? fileURLToPath(new URL('../../.dsh-test/mock.jsonl', import.meta.url))
const controls = process.env.MOCK_T55_CONTROLS === '1'
const classicRoundTrip = process.env.MOCK_CLASSIC_ROUND_TRIP === '1'
const previewAcceptance = process.env.MOCK_PREVIEW_ACCEPTANCE === '1'
mkdirSync(dirname(logPath), { recursive: true })

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = textOf(message.content).trim()
    if (text !== '') return text
  }
  return 'mock request'
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  if (request.method === 'GET' && path === '/v1/models') {
    sendJson(response, 200, { data: [{ id: 'mock', object: 'model' }] })
    return
  }
  if (request.method !== 'POST' || path !== '/v1/messages') {
    sendJson(response, 404, { error: { type: 'not_found_error', message: 'The mock supports /v1/messages.' } })
    return
  }
  let raw = ''
  for await (const chunk of request) {
    raw += chunk.toString()
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) {
      sendJson(response, 413, { error: { type: 'request_too_large', message: 'Request is too large.' } })
      return
    }
  }
  let body
  try { body = JSON.parse(raw) } catch {
    sendJson(response, 400, { error: { type: 'invalid_request_error', message: 'Send JSON.' } })
    return
  }
  const user = latestUserText(body)
  const reply = user.startsWith('收到：') ? user : `收到：${user}`
  const id = `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const block = (controls ? t55ControlsReply(body, user, id)
    : previewAcceptance ? await previewAcceptanceReply(body, user, id) : undefined) ?? { type: 'text', text: reply }
  const stop_reason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
  const classicWork = classicRoundTrip && block.type === 'tool_use' && block.name === 'write_file' && block.input.path === 'alpha.txt'
  if (controls && (user === t55SlowReply || classicWork)) {
    await new Promise(done => {
      const timer = setTimeout(done, classicWork ? 9000 : 10_000)
      response.once('close', () => { clearTimeout(timer); done() })
    })
    if (response.destroyed) return
  }
  appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), model: body.model ?? 'mock', user, reply })}\n`)
  if (body.stream !== true) {
    sendJson(response, 200, {
      id, type: 'message', role: 'assistant', model: body.model ?? 'mock',
      content: [block],
      stop_reason, usage: { input_tokens: 1, output_tokens: 1 },
    })
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  event({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model ?? 'mock',
    content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
  if (block.type === 'tool_use') {
    event({ type: 'content_block_start', index: 0, content_block: { ...block, input: {} } })
    event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
  } else {
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } })
  }
  event({ type: 'content_block_stop', index: 0 })
  event({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } })
  event({ type: 'message_stop' })
  response.end()
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  console.log(`mock model: http://127.0.0.1:${String(address.port)}/v1`)
})

const stop = () => server.close(() => process.exit(0))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
