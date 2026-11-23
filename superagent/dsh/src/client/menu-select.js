import { createElement as h, useId, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { focusMenuItem, useAnchoredMenu } from './anchored-menu.js'
import { CheckIcon, ChevronDownIcon } from './icons.js'

export function MenuSelect({ value, options, label, onChange, disabled = false, dismiss = false, className }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu({
    dismiss: dismiss || disabled, minWidth: 220,
  })
  const id = useId()
  const selected = options.find(option => option.value === value)
  const items = () => [...(menu.current?.querySelectorAll('[role="menuitemradio"]:not(:disabled)') ?? [])]
  useLayoutEffect(() => {
    if (!isOpen || !shownPlace || menu.current?.contains(document.activeElement)) return
    const checked = menu.current?.querySelector('[aria-checked="true"]') ?? items()[0]
    ;(checked ?? menu.current)?.focus()
  }, [isOpen, Boolean(shownPlace)])
  const keyDown = event => {
    if (event.defaultPrevented) return
    if (event.key === 'Tab') {
      close()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    focusMenuItem(event, menu.current)
  }
  const choose = option => {
    close()
    if (option.value !== value) onChange(option.value)
  }
  return h('span', { className: 'bt-choice' },
    h('button', {
      ref: button, type: 'button', className: `bt-model-trigger bt-choice-trigger${className ? ` ${className}` : ''}`,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-controls': isOpen ? id : undefined,
      'aria-label': `${label}: ${selected?.label ?? options[0]?.label ?? ''}`,
      'data-value': value,
      title: selected?.title ?? selected?.detail ?? selected?.label ?? label,
      disabled: disabled || undefined,
      onClick: () => { if (isOpen) close(); else open() },
      onKeyDown: event => {
        if (!isOpen && !disabled && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault()
          open()
        } else if (isOpen) keyDown(event)
      },
    },
    h('span', { className: 'bt-model-copy' }, h('span', { className: 'bt-model-name' }, selected?.label ?? '')),
    h(ChevronDownIcon, { className: 'bt-model-caret' })),
    shownPlace ? createPortal(h('div', {
      ref: menu, id, className: `bt-menu bt-choice-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu', tabIndex: -1, 'aria-label': label, style: shownPlace,
      'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined, inert: leaving, onKeyDown: keyDown,
    }, options.map(option => h('button', {
      key: option.value, type: 'button', role: 'menuitemradio', tabIndex: -1, className: 'bt-choice-item',
      'aria-checked': option.value === value, disabled: option.disabled || undefined,
      title: option.title ?? option.detail ?? option.label, onClick: () => choose(option),
    },
    h('span', { className: 'bt-choice-copy' },
      h('span', { className: 'bt-menu-label bt-choice-label' }, option.label),
      option.detail ? h('span', { className: 'bt-choice-detail' }, option.detail) : null),
    h('span', { className: 'bt-model-tick', 'aria-hidden': true },
      option.value === value ? h(CheckIcon) : null)))), document.body) : null)
}

export const MENU_SELECT_CSS = `
.bt-choice{display:inline-flex;max-width:100%;min-width:0}
.bt-choice-trigger{max-width:100%}
.bt-choice-menu{min-width:0;overflow-y:auto;scrollbar-width:thin}
.bt-choice-menu .bt-choice-item{display:grid;grid-template-columns:minmax(0,1fr) 16px;align-items:center;gap:10px;padding:7px 8px}
.bt-choice-copy{display:flex;flex-direction:column;min-width:0}
.bt-choice-label{font-size:var(--bt-font-body);line-height:18px}
.bt-choice-item[aria-checked=true] .bt-choice-label{font-weight:500}
.bt-choice-detail{min-width:0;font-size:var(--bt-font-small);line-height:16px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-choice-trigger:focus-visible,.bt-choice-menu .bt-choice-item:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
body[data-bt-motion=quiet] :is(.bt-choice-menu,.bt-choice-trigger,.bt-choice-trigger .bt-model-caret){animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){:is(.bt-choice-menu,.bt-choice-trigger,.bt-choice-trigger .bt-model-caret){animation:none!important;transition:none!important}}
`
