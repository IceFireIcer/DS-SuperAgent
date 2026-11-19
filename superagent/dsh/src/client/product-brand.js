import { createElement as h } from 'react'
import { MAIN_LOOK } from './characters.js'
import { BotMark } from './mark.js'

export function ProductBrandMark({ size = 24 }) {
  return h('span', { className: 'bt-brand-whale' }, h(BotMark, { look: MAIN_LOOK, size }))
}
