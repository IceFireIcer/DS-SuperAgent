// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/{surface,sidebar}.js.
import { createElement as h, useEffect, useRef } from 'react'
import { MAIN_LOOK } from './characters.js'
import { SwitchIcon } from './icons.js'
import { t } from './i18n.js'
import { BotMark } from './mark.js'

const groups = ['shell', 'conversation']

export function surfaceGroups(install, reportError) {
  const mounted = new Map()
  const dispose = steps => {
    for (const step of steps.reverse()) {
      try { step?.() } catch (error) { reportError(error) }
    }
  }
  const withdraw = () => {
    for (const name of groups.toReversed()) {
      const steps = mounted.get(name)
      mounted.delete(name)
      if (steps) dispose(steps)
    }
  }
  return {
    reconcile(product) {
      if (!product) { withdraw(); return }
      try {
        for (const name of groups) {
          if (mounted.has(name)) continue
          const steps = []
          mounted.set(name, steps)
          for (const step of install[name]) steps.push(step())
        }
      } catch (error) {
        withdraw()
        reportError(error)
      }
    },
    dispose: withdraw,
  }
}

export function ClassicReturn({ wide, onReturn, busy }) {
  const trigger = useRef(null)
  useEffect(() => { trigger.current?.focus() }, [])
  const label = t('Back to DS SuperAgent')
  return h('button', { ref: trigger, type: 'button', className: 'bt-return', 'aria-label': label, title: label,
    'aria-busy': busy || undefined, onClick: onReturn }, h(BotMark, { look: MAIN_LOOK, size: 20 }),
  wide ? h('span', { className: 'bt-return-name' }, label) : null,
  wide ? h('span', { className: 'bt-return-swap', 'aria-hidden': true }, h(SwitchIcon)) : null)
}

export const RETURN_CSS = `
.bt-return{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;max-width:100%;padding:0 12px;border:0;border-radius:999px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font:inherit;cursor:pointer;transition:background-color .12s ease}
.bt-return:hover{background:color-mix(in srgb,currentColor 15%,transparent)}
.bt-return:focus-visible{outline:2px solid var(--dsw-color-accent,currentColor);outline-offset:2px}
.bt-return .bt-mark{display:inline-flex;flex:none;line-height:0;--bt-ink-deepseek:var(--dsw-color-accent,currentColor)}
.bt-return .bt-mark svg{width:100%;height:100%;overflow:visible}
.bt-return-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-return-swap{display:inline-flex;flex:none;opacity:.55}
@media(prefers-reduced-motion:reduce){.bt-return{transition:none}}
`
