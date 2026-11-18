import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

const defaultTimeoutMs = 120_000
const defaultMaxTokens = 2_048

/** Normalize a provider origin or versioned base into its OpenAI chat-completions endpoint. */
export function chatCompletionsEndpoint(value) {
  let url
  try { url = new URL(value) }
  catch { throw new Error('The real-model endpoint must be a valid HTTP or HTTPS URL.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The real-model endpoint must be HTTP or HTTPS.')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('A remote real-model endpoint must use HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('The real-model endpoint cannot carry credentials, a query or a fragment.')
  if (url.pathname.endsWith('/chat/completions')) return url.toString()
  if (url.pathname.endsWith('/v1')) url.pathname = `${url.pathname}/chat/completions`
  else url.pathname = `${url.pathname.replace(/\/$/u, '')}/v1/chat/completions`
  return url.toString()
}

export function createModelBudget({ maxRequests = 30, maxTokens = 60_000, timeoutMs = defaultTimeoutMs } = {}) {
  for (const [label, value] of [['maxRequests', maxRequests], ['maxTokens', maxTokens], ['timeoutMs', timeoutMs]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`)
  }
  return { maxRequests, maxTokens, timeoutMs, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    startedAt: Date.now(), calls: [], exceeded: false }
}

/**
 * A public DSH LlmAdapter for an OpenAI-compatible chat-completions route.
 * It is intentionally non-streaming: one request is one budgeted call, and the
 * whole provider response is translated into the public chunk vocabulary.
 */
export class OpenAiCompatibleAdapter extends LlmAdapter {
  constructor({ endpoint, apiKey, model, reasoningEffort, defaultModelTokens = defaultMaxTokens,
    budget = createModelBudget(), fetchImpl = fetch, now = Date.now }) {
    super()
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('The real-model API key is required.')
    if (typeof model !== 'string' || !model.trim()) throw new Error('The real-model id is required.')
    if (!Number.isSafeInteger(defaultModelTokens) || defaultModelTokens < 1) throw new Error('The real-model output budget must be a positive safe integer.')
    if (reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
      throw new Error('The real-model reasoning effort is invalid.')
    }
    this.endpoint = chatCompletionsEndpoint(endpoint)
    this.apiKey = apiKey.trim()
    this.model = model.trim()
    this.reasoningEffort = reasoningEffort
    this.defaultModelTokens = defaultModelTokens
    this.budget = budget
    this.fetchImpl = fetchImpl
    this.now = now
  }

  async *stream(options) {
    const tokensExhausted = this.budget.exceeded || this.budget.totalTokens >= this.budget.maxTokens
    if (tokensExhausted || this.budget.requests >= this.budget.maxRequests) {
      this.budget.exceeded = true
      throw new LlmError(tokensExhausted ? 'The real-model token budget is exhausted.' : 'The real-model request budget is exhausted.', 'MODEL_BUDGET')
    }
    const requestIndex = ++this.budget.requests
    const startedAt = this.now()
    const callRecord = { index: requestIndex, provider: options.provider, model: options.model ?? this.model,
      purpose: options.purpose, toolCalls: [], finish: 'pending' }
    this.budget.calls.push(callRecord)
    const failedCall = code => Object.assign(callRecord, { durationMs: this.now() - startedAt, finish: 'error', error: code })
    let response
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(this.budget.timeoutMs)])
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model || this.model,
          messages: providerMessages(options),
          ...(options.tools?.length ? { tools: providerTools(options.tools) } : {}),
          ...(this.reasoningEffort === undefined ? {} : { reasoning_effort: this.reasoningEffort }),
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? this.defaultModelTokens,
          stream: false,
        }),
      })
    } catch (error) {
      failedCall(signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_TRANSPORT')
      throw new LlmError('The real-model request failed.', signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      const status = response.status
      failedCall(status === 401 || status === 403 ? 'AUTH' : 'MODEL_HTTP')
      throw new LlmError(`The real-model endpoint returned HTTP ${status}.`, status === 401 || status === 403 ? 'AUTH' : 'MODEL_HTTP', { status })
    }
    let body
    try { body = await response.json() }
    catch (error) {
      failedCall('MODEL_INVALID_RESPONSE')
      throw new LlmError('The real-model endpoint returned invalid JSON.', 'MODEL_INVALID_RESPONSE', { cause: error })
    }
    const choice = body?.choices?.[0]
    if (!choice || typeof choice !== 'object') {
      failedCall('MODEL_INVALID_RESPONSE')
      throw new LlmError('The real-model response has no choice.', 'MODEL_INVALID_RESPONSE')
    }
    const message = choice.message
    if (!message || typeof message !== 'object') {
      failedCall('MODEL_INVALID_RESPONSE')
      throw new LlmError('The real-model response has no message.', 'MODEL_INVALID_RESPONSE')
    }
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    const text = typeof message.content === 'string' ? message.content : ''
    const textBlockCount = Number(Boolean(reasoning)) + Number(Boolean(text))
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => {
      if (!call || typeof call !== 'object' || typeof call.function?.name !== 'string') {
        failedCall('MODEL_INVALID_RESPONSE')
        throw new LlmError('The real-model response has a malformed tool call.', 'MODEL_INVALID_RESPONSE')
      }
      const id = typeof call.id === 'string' && call.id ? call.id : `call-${textBlockCount + index}-${index}`
      const args = typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {})
      return { id, name: call.function.name, arguments: args }
    })
    const usage = modelUsage(body.usage)
    const finish = finishReason(choice.finish_reason, toolCalls.length)
    this.budget.inputTokens += usage.inputTokens
    this.budget.outputTokens += usage.outputTokens
    this.budget.totalTokens += usage.totalTokens ?? usage.inputTokens + usage.outputTokens
    if (this.budget.totalTokens >= this.budget.maxTokens) this.budget.exceeded = true
    // A Session can stop consuming chunks before the model's finish event.
    Object.assign(callRecord, { durationMs: this.now() - startedAt, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens, toolCalls: toolCalls.map(call => call.name), finish: finish.kind })

    let index = 0
    if (reasoning) {
      yield* block(index++, 'reasoning', [{ type: 'reasoning-delta', text: reasoning }], { type: 'reasoning', text: reasoning })
    }
    if (text) yield* block(index++, 'text', [{ type: 'text-delta', text }], { type: 'text', text })
    for (const { id, name, arguments: args } of toolCalls) {
      yield* block(index++, 'tool-call', [{ type: 'tool-call-delta', id, name, argumentsDelta: args }],
        { type: 'tool-call', id, name, arguments: args })
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish }
  }
}

export function createRealModelRuntime({ provider = 'pokexiao', endpoint, apiKey, model, reasoningEffort, budget, fetchImpl, now }) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('The real-model provider route is required.')
  return { provider: provider.trim(), model, adapter: new OpenAiCompatibleAdapter({ endpoint, apiKey, model, reasoningEffort, budget, fetchImpl, now }) }
}

export function providerMessages(options) {
  const messages = []
  if (typeof options.system === 'string' && options.system.trim()) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages ?? []) {
    const text = contentText(message.content)
    if (message.role === 'system') {
      if (text) messages.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'developer') {
      if (text) messages.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId ?? message.source?.callId, content: text })
      continue
    }
    if (message.role === 'assistant') {
      const calls = (message.content ?? []).filter(block => block.type === 'tool-call').map(block => ({
        id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
      }))
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    messages.push({ role: 'user', content: text })
  }
  return messages
}

export function providerTools(tools) {
  return tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'image') return `[image: ${block.attachment?.name ?? 'attached image'}]`
    if (block?.type === 'file') return `[file: ${block.attachment?.name ?? 'attached file'}]`
    if (block?.type === 'reasoning') return ''
    return ''
  }).join('')
}

function modelUsage(value) {
  const prompt = Number(value?.prompt_tokens)
  const completion = Number(value?.completion_tokens)
  const total = Number(value?.total_tokens)
  const cached = Number(value?.prompt_tokens_details?.cached_tokens ?? value?.prompt_cache_hit_tokens ?? 0)
  const inputTokens = Number.isSafeInteger(prompt) && prompt >= 0 ? Math.max(0, prompt - (Number.isSafeInteger(cached) ? cached : 0)) : 0
  const outputTokens = Number.isSafeInteger(completion) && completion >= 0 ? completion : 0
  return { inputTokens, outputTokens, ...(Number.isSafeInteger(total) && total >= 0 ? { totalTokens: total } : {}),
    ...(Number.isSafeInteger(cached) && cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(Number.isSafeInteger(value?.completion_tokens_details?.reasoning_tokens) && value.completion_tokens_details.reasoning_tokens > 0
      ? { reasoningTokens: value.completion_tokens_details.reasoning_tokens } : {}) }
}

function finishReason(value, toolCalls) {
  if (value === 'tool_calls' || value === 'function_call') return { kind: 'tool-calls' }
  if (value === 'length') return { kind: 'max-tokens' }
  if (value === 'content_filter' || value === 'error') return { kind: 'error', failure: { message: 'The provider stopped on a content filter.', code: 'MODEL_CONTENT_FILTER' } }
  if (toolCalls) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

function* block(index, blockType, deltas, completed) {
  yield { type: 'block-start', index, blockType }
  for (const delta of deltas) yield { type: delta.type, index, ...(delta.type === 'text-delta' ? { text: delta.text } : delta) }
  yield { type: 'block-end', index, block: completed }
}
