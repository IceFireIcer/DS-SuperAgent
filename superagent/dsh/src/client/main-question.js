// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/questions.js.
import { createElement as h, useId } from 'react'
import { CheckIcon } from './icons.js'
import { t } from './i18n.js'

export function MainQuestion({ attention, goal, draft = '', onDraft, onSubmit, busy = false, error }) {
  const titleId = useId()
  const options = attention.options ?? []
  const allowText = attention.freeText !== false
  const answer = draft.trim()
  const canSubmit = !busy && answer !== '' && (allowText || options.includes(answer))

  return h('div', { className: 'bt-q-dock' },
    h('form', {
      className: 'bt-q', 'aria-labelledby': titleId,
      onSubmit(event) {
        event.preventDefault()
        if (canSubmit) onSubmit(answer)
      },
    },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' }, goal ? h('p', { className: 'bt-main-work-detail' }, goal) : null,
        h('p', { className: 'bt-q-title', id: titleId }, attention.question))),
    options.length ? h('div', { className: 'bt-q-list', role: 'group', 'aria-labelledby': titleId }, options.map(option => {
      const selected = answer === option
      return h('button', {
        key: option, type: 'button', className: 'bt-q-opt', disabled: busy, 'aria-pressed': selected,
        onClick: () => onDraft(option),
      },
      h('span', { className: 'bt-q-body' }, h('span', { className: 'bt-q-label' }, option)),
      selected ? h('span', { className: 'bt-q-check', 'aria-hidden': true }, h(CheckIcon)) : null)
    })) : null,
    allowText ? h('div', { className: 'bt-q-custom' },
      h('label', { className: 'bt-q-field' }, h('textarea', {
        className: 'bt-q-input', value: draft, readOnly: busy, rows: 1, maxLength: 65536,
        'aria-label': t('Answer this work question'), placeholder: t('Type an answer…'),
        onChange: event => onDraft(event.currentTarget.value),
        onKeyDown(event) {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (canSubmit) event.currentTarget.form?.requestSubmit()
        },
      }))) : null,
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'submit', className: 'bt-q-submit', disabled: !canSubmit }, t(busy ? 'Sending answer…' : 'Send answer')))))
}
