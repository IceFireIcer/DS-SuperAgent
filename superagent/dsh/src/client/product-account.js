import { createElement as h, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClockIcon, ConnectorIcon, GaugeIcon, GearIcon, SlidersIcon } from './icons.js'
import { t } from './i18n.js'
import { reducedMotion, useLinger, useViewport, viewBottom } from './motion.js'

const destinations = [
  ['Usage', GaugeIcon, 'usage'],
  ['Models and API keys', SlidersIcon, 'models'],
  ['Connectors', ConnectorIcon, 'connectors'],
  ['Automation tasks', ClockIcon, 'scheduled-tasks'],
  ['Settings', GearIcon, 'general'],
]

export function SuperagentAccountFooter({ wide, modalOpen, signIn, openSettings }) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState(null)
  const [kept, leaving] = useLinger(open && placement, 120)
  const shown = reducedMotion() || document.body.dataset.btMotion === 'quiet' ? open && placement : kept
  const trigger = useRef(null)
  const menu = useRef(null)
  const menuId = useId()
  const viewport = useViewport()
  const close = () => { setOpen(false); trigger.current?.focus() }
  const anchor = () => {
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(224, window.innerWidth - 16)
    const menuBottom = rect.top - 5
    setPlacement({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width,
      bottom: viewBottom() - menuBottom, maxHeight: Math.max(0, menuBottom - (window.visualViewport?.offsetTop ?? 0) - 8) })
  }
  useLayoutEffect(() => { if (open) anchor() }, [open, viewport, wide])
  useEffect(() => { if (modalOpen) setOpen(false) }, [modalOpen])
  useEffect(() => {
    if (!open) return undefined
    const onOutside = event => {
      if (menu.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      setOpen(false)
      const active = document.activeElement
      if (active === document.body || menu.current?.contains(active)) trigger.current?.focus()
    }
    window.addEventListener('click', onOutside)
    window.addEventListener('resize', anchor)
    return () => {
      window.removeEventListener('click', onOutside)
      window.removeEventListener('resize', anchor)
    }
  }, [open])
  useEffect(() => {
    if (open && placement) menu.current?.querySelector('[role=menuitem]')?.focus()
  }, [open, Boolean(placement)])

  const onKeyDown = event => {
    if (event.defaultPrevented) return
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const items = [...event.currentTarget.querySelectorAll('[role=menuitem]')]
    const last = items.length - 1
    const current = items.indexOf(event.target)
    const targets = { Home: 0, End: last, ArrowDown: current >= last ? 0 : current + 1,
      ArrowUp: current <= 0 ? last : current - 1 }
    if (!Object.hasOwn(targets, event.key)) return
    event.preventDefault()
    items[targets[event.key]]?.focus()
  }
  const activate = action => { close(); action() }
  const item = (label, Icon, action) => h('button', { key: label, type: 'button', role: 'menuitem', tabIndex: -1,
    onClick: () => activate(action) }, h(Icon), h('span', { className: 'bt-menu-label' }, t(label)))
  const iconButton = (label, Icon, extra) => h('button', { type: 'button', className: 'bt-account',
    'aria-label': t(label), title: t(label), ...extra }, h('span', { className: 'bt-you', 'aria-hidden': true }, h(Icon)))

  return h('div', { className: `bt-leftcol-foot${wide ? '' : ' bt-leftcol-foot-rail'}` },
    iconButton('Account', GearIcon, { ref: trigger, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': menuId,
      onClick: () => open ? close() : setOpen(true) }),
    iconButton('Connectors', ConnectorIcon, { onClick: () => openSettings('connectors') }),
    shown ? createPortal(h('div', { ref: menu, id: menuId, className: 'bt-menu bt-menu-up bt-account-menu', role: 'menu',
      'aria-label': t('Account'), inert: leaving, 'aria-hidden': leaving || undefined,
      'data-leaving': leaving ? '' : undefined, style: shown, onKeyDown },
    destinations.map(([label, Icon, page]) => item(label, Icon, () => openSettings(page))),
    signIn ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
    signIn ? item('Sign in to DeepSeek', SlidersIcon, signIn) : null), document.body) : null)
}
