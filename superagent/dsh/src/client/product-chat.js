import { createElement as h } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { t } from './i18n.js'

export function ProductChatRow({ kind, text }) {
  return h('div', { className: `bt-product-message bt-product-message-${kind}` },
    h('div', { className: 'bt-bubble' }, h(MarkdownText, {
      text,
      labels: { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') },
      variant: 'compact',
    })))
}
