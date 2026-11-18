import { createElement as h } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { WidgetCard, ViewUi } from 'deep-view/react'
import { t } from './i18n.js'

const viewT = (key, params) => (key === 'Send' ? t('Send to Main') : t(key, params))
const VIEW_UI = { t: viewT, Markdown: MarkdownText }
const Card = props => h(ViewUi.Provider, { value: VIEW_UI }, h(WidgetCard, props))

export function ProductWorkView({ title, view, answer, onSubmit, busy = false }) {
  return h('div', { className: 'bt-main-work-view' },
    h(Card, { title, view, ...(onSubmit ? { onSubmit, busy } : { settled: true, answer }) }))
}
