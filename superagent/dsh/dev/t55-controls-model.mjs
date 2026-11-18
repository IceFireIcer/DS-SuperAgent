export const t55Request = 'T55: verify the alpha and beta notes.'
export const t55SlowReply = 'T55: prepare a slow reply.'
export const t55Question = 'Use the approved alpha text?'

const alpha = 'T55 alpha note'
const beta = 'T55 beta note'
const plan = [alpha, beta].map(goal => ({ goal, constraints: 'Use only the local fixture workspace.',
  acceptanceCriteria: 'Verify the note and report its local artifact.' }))

export function t55ControlsReply(body, user, id) {
  const tools = body.tools ?? []
  const has = name => tools.some(tool => tool.name === name)
  const blocks = body.messages.flatMap(message => typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }] : message.content ?? [])
  let completed = 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.type === 'text' && block.text === user) break
    if (block.type === 'tool_result') completed++
  }
  const invoke = (name, input) => ({ type: 'tool_use', id, name, input })
  if (has('delegate_work') && user === t55Request && completed === 0) return invoke('delegate_work', { items: plan })

  const router = tools.filter(tool => /^(establish_work_plan|deliver_result|record_work_update|assign_worker)/u.test(tool.name))
  if (router.length) {
    const tool = router[completed]
    if (!tool) return undefined
    const number = tool.description?.match(/Handle notification (\d+) only\./u)?.[1]
    const text = number ? user.split(`Notification ${number}:\n`)[1]?.split(/\nNotification \d+:\n/u)[0] : user
    if (tool.name === 'establish_work_plan') return invoke(tool.name, { items: plan })
    if (tool.name.startsWith('deliver_result') && text?.startsWith('Ready report:')) {
      return invoke(tool.name, { reportId: JSON.parse(text.slice('Ready report:'.length)).id })
    }
    return invoke(tool.name, {})
  }

  if (!has('report_ready')) return undefined
  const goal = blocks.findLast(block => block.type === 'text' && (block.text.includes(`Goal:\n${alpha}`) || block.text.includes(`Goal:\n${beta}`)))?.text
  if (!goal) return undefined
  const isAlpha = goal.includes(`Goal:\n${alpha}`)
  if (isAlpha && user.includes(`Goal:\n${alpha}`) && completed === 0) return invoke('ask_human', { question: t55Question, options: 'Yes\nNo' })
  if (!isAlpha && user.includes(`Goal:\n${beta}`) && completed === 0) {
    return invoke('start_shell', { command: 'node -e "setTimeout(() => {}, 60000)"' })
  }
  if (!isAlpha && !user.startsWith('Continue after resume.')) return undefined
  const file = isAlpha ? 'alpha.txt' : 'beta.txt'
  const commands = [
    ['write_file', { path: file, text: 'T55 verified text\n' }],
    ['run_shell', { command: `node -e "if (!require('node:fs').readFileSync('${file}', 'utf8').startsWith('T55 verified text')) process.exit(1)"` }],
    ['report_ready', { result: `Verified ${file}.`, evidence: 'The local verification command exited successfully.', artifacts: file }],
  ]
  const next = commands[completed]
  return next ? invoke(...next) : undefined
}
