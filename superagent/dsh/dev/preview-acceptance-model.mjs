export const previewMainOnly = 'PREVIEW main without a project'
export const previewParallel = 'PREVIEW parallel delivery'
export const previewPath = 'PREVIEW path grants'
export const previewAlphaQuestion = 'Approve the preview A result?'
export const previewPathQuestion = 'Allow write access to the external preview note?'
export const previewPathRetryQuestion = 'The write is still blocked. Allow it now?'
export const previewPathDenial = 'Not now'
export const previewPathApproval = 'Allow this path access'

export const previewAlphaGoal = 'PREVIEW wait for A approval.'
export const previewBetaGoal = 'PREVIEW finish B independently.'
export const previewPathGoal = 'PREVIEW read the granted external note.'

const toolNames = body => new Set((body.tools ?? []).map(tool => tool.name))
const blocksOf = body => body.messages.flatMap(message => typeof message.content === 'string'
  ? [{ type: 'text', text: message.content }]
  : message.content ?? [])

function completedTools(body, user) {
  const blocks = blocksOf(body)
  let completed = 0
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.type === 'text' && block.text === user) break
    if (block.type === 'tool_result') completed++
  }
  return completed
}

function invoke(name, input, id) {
  return { type: 'tool_use', id, name, input }
}

function firstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('The Router prompt has no JSON object.')
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1))
  }
  throw new Error('The Router prompt has an unfinished JSON object.')
}

let alphaStarted = false
let betaStarted = false
let releaseBothStarted
let releaseAlphaAsked
const bothStarted = new Promise(done => { releaseBothStarted = done })
const alphaAsked = new Promise(done => { releaseAlphaAsked = done })

function startWorker(role) {
  if (role === 'alpha') alphaStarted = true
  if (role === 'beta') betaStarted = true
  if (alphaStarted && betaStarted) releaseBothStarted()
}

async function waitFor(promise, label) {
  let timer
  const timeout = new Promise(done => {
    timer = setTimeout(() => {
      console.error(`preview acceptance mock: timed out waiting for ${label}`)
      done()
    }, 30_000)
    timer.unref()
  })
  await Promise.race([promise, timeout])
  clearTimeout(timer)
}

function routerReply(body, user, id) {
  const tools = body.tools.filter(tool => /^(establish_work_plan|deliver_result|record_work_update|assign_worker)$/u.test(tool.name))
  const completed = completedTools(body, user)
  const tool = tools[completed]
  if (!tool) return { type: 'text', text: 'The preview work plan is established.' }
  const number = tool.description?.match(/Handle notification (\d+) only\./u)?.[1]
  const text = number ? user.split(`Notification ${number}:\n`)[1]?.split(/\nNotification \d+:\n/u)[0] : user
  if (tool.name === 'establish_work_plan') {
    const brief = firstJsonObject(text)
    return invoke(tool.name, { items: brief.requestedItems ?? [brief] }, id)
  }
  if (tool.name.startsWith('deliver_result') && text?.startsWith('Ready report:')) {
    return invoke(tool.name, { reportId: firstJsonObject(text.slice('Ready report:'.length)).id }, id)
  }
  return invoke(tool.name, {}, id)
}

async function workerReply(body, user, id, names) {
  const completed = completedTools(body, user)
  const allText = blocksOf(body).filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (allText.includes(`Goal:\n${previewAlphaGoal}`) && names.has('report_ready')) {
    if (user.includes(previewAlphaQuestion) || user.includes('Approve A')) {
      const commands = [
        ['write_file', { path: 'preview-alpha.txt', text: 'A approved and verified\n' }],
        ['read_file', { path: 'preview-alpha.txt' }],
        ['report_ready', { result: 'Preview A completed after its own answer.',
          evidence: 'Wrote and read preview-alpha.txt after the approval.', artifacts: 'preview-alpha.txt' }],
      ]
      const command = commands[completed]
      return command ? invoke(...command, id) : undefined
    }
    startWorker('alpha')
    await waitFor(bothStarted, 'both Workers to start')
    releaseAlphaAsked()
    return invoke('ask_human', { question: previewAlphaQuestion, options: 'Approve A\nDeny A' }, id)
  }
  if (allText.includes(`Goal:\n${previewBetaGoal}`) && names.has('report_ready')) {
    startWorker('beta')
    await waitFor(bothStarted, 'both Workers to start')
    if (completed === 0) return invoke('write_file', { path: 'preview-beta.txt', text: 'B completed independently\n' }, id)
    if (completed === 1) return invoke('read_file', { path: 'preview-beta.txt' }, id)
    if (completed === 2) {
      await waitFor(alphaAsked, 'preview A to ask its question')
      return invoke('report_ready', { result: 'Preview B delivered while A waited.',
        evidence: 'Wrote and read preview-beta.txt with no answer for A.', artifacts: 'preview-beta.txt' }, id)
    }
    return undefined
  }
  if (allText.includes(`Goal:\n${previewPathGoal}`) && names.has('report_ready')) {
    const external = process.env.PREVIEW_EXTERNAL_FILE
    if (!external) return undefined
    if (user.includes(previewPathDenial)) {
      const denied = [
        ['write_file', { path: external, text: 'preview refused write\n' }],
        ['write_file', { path: 'preview-after-refusal.txt', text: 'unrelated preview work continued\n' }],
        ['read_file', { path: 'preview-after-refusal.txt' }],
        ['ask_human', { question: previewPathRetryQuestion, options: 'Keep blocked',
          pathGrants: JSON.stringify([{ path: external, operations: ['write'] }]) }],
      ]
      const command = denied[completed]
      return command ? invoke(...command, id) : undefined
    }
    if (user.includes(previewPathApproval)) {
      const approved = [
        ['write_file', { path: external, text: 'preview external note\napproved write\n' }],
        ['read_file', { path: external }],
        ['report_ready', { result: 'Preview external write completed after the exact approval.',
          evidence: 'Wrote and read the authorized external note; unrelated local work had already continued.',
          artifacts: external }],
      ]
      const command = approved[completed]
      return command ? invoke(...command, id) : undefined
    }
    if (completed === 0) return invoke('read_file', { path: external }, id)
    if (completed === 1) {
      return invoke('ask_human', { question: previewPathQuestion, options: previewPathDenial,
        pathGrants: JSON.stringify([{ path: external, operations: ['write'] }]) }, id)
    }
    return undefined
  }
  return undefined
}

export async function previewAcceptanceReply(body, user, id) {
  const names = toolNames(body)
  if (names.has('delegate_work')) {
    if (user.includes(previewMainOnly)) return { type: 'text', text: 'Main replied without a project.' }
    if (user.includes(previewParallel)) {
      return invoke('delegate_work', { items: [
        { goal: previewAlphaGoal, constraints: 'Ask one question and wait for its answer before writing.',
          acceptanceCriteria: 'Write and read back preview-alpha.txt after the exact answer.' },
        { goal: previewBetaGoal, constraints: 'Write only preview-beta.txt and complete without waiting for A.',
          acceptanceCriteria: 'Read preview-beta.txt back and report it while A waits.' },
      ] }, id)
    }
    if (user.includes(previewPath)) {
      const external = process.env.PREVIEW_EXTERNAL_FILE
      if (!external) return { type: 'text', text: 'The preview external path is not configured.' }
      return invoke('delegate_work', {
        goal: previewPathGoal,
        constraints: 'Read the granted external note, ask before writing, and continue unrelated local work after a denial.',
        acceptanceCriteria: 'Only the exact approval adds write access; preview-after-refusal.txt proves unrelated work continued.',
        pathGrants: [{ path: external, operations: ['read'] }],
      }, id)
    }
    return { type: 'text', text: 'Preview Main recorded the update.' }
  }
  if (names.has('establish_work_plan')) return routerReply(body, user, id)
  if (names.has('report_ready')) return workerReply(body, user, id, names)
  return undefined
}
