import { stripHeader } from './text.js'

/** Turn a Main reply into readable speech without Markdown or relay metadata. */
export const plainSpeech = text => stripHeader(text).replace(/```[\s\S]*?```/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~-]+/g, ' ').replace(/\s+/g, ' ').trim()
