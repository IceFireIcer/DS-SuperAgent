// The task plugin uses the same ARIA ref tools as `refs`. It used to run its own
// model/tool loop inside browser_task; every turn must stay on the Bot's normal
// DSH agent loop, so there is no browser_task tool any more.
import { systemPrompt as refsPrompt, toolDefs as refTools } from './refs.js'

export const id = 'task'
export const label = 'ARIA refs'
export const systemPrompt = refsPrompt
export const toolDefs = refTools
export const tools = toolDefs
