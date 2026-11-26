import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { reducedMotion, SPRING_SHAPE, spring, useLinger, useViewport, viewBottom } from './motion.js'

const MENU_EXIT_MS = 120

export function useAnchoredMenu({ compact = false, dismiss = false, minWidth = 240, align = 'end' } = {}) {
  const [isOpen, setOpen] = useState(false)
  const [place, setPlace] = useState(null)
  const [kept, leaving] = useLinger(isOpen && place, MENU_EXIT_MS)
  const shownPlace = reducedMotion() || document.body?.dataset.btMotion === 'quiet' ? isOpen && place : kept
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const open = () => { setPlace(null); setOpen(true) }
  const close = () => { setOpen(false); button.current?.focus() }
  const anchor = () => {
    if (!button.current) return
    const rect = button.current.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewLeft = viewport?.offsetLeft ?? 0
    const viewWidth = viewport?.width ?? window.innerWidth
    const width = Math.min(Math.max(minWidth, rect.width), viewWidth - 16)
    const preferredLeft = align === 'start' ? rect.left : rect.right - width
    const left = Math.max(viewLeft + 8, Math.min(preferredLeft, viewLeft + viewWidth - width - 8))
    const below = viewBottom() - rect.bottom - 4
    const above = rect.top - (viewport?.offsetTop ?? 0) - 4
    const horizontalOrigin = align === 'start' ? 'left' : 'right'
    setPlace(below >= 260 || below >= above
      ? { left, width, top: rect.bottom + 4, maxHeight: Math.max(0, below - 8), '--bt-origin': `top ${horizontalOrigin}` }
      : { left, width, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(0, above - 8), '--bt-origin': `bottom ${horizontalOrigin}` })
  }
  useLayoutEffect(() => { if (isOpen) anchor() }, [isOpen, compact, tick])
  useEffect(() => { if (dismiss) setOpen(false) }, [dismiss])
  useEffect(() => {
    if (!isOpen) return undefined
    const outside = event => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      const active = document.activeElement
      if (active === document.body || menu.current?.contains(active)) close()
      else setOpen(false)
    }
    const scroll = event => { if (!menu.current?.contains(event.target)) anchor() }
    window.addEventListener('click', outside)
    window.addEventListener('resize', anchor)
    window.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('click', outside)
      window.removeEventListener('resize', anchor)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [isOpen])
  return { isOpen, shownPlace, leaving, button, menu, open, close }
}

export function focusMenuItem(event, menu, selector = 'button[role^="menuitem"]:not(:disabled)') {
  if (event.defaultPrevented || event.target.tagName === 'INPUT') return false
  const items = [...(menu?.querySelectorAll(selector) ?? [])]
  const current = items.indexOf(event.target)
  const last = items.length - 1
  if (event.key.length === 1 && /\S/u.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const key = event.key.toLocaleLowerCase()
    const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)]
    const match = ordered.find(item => item.textContent.trim().toLocaleLowerCase().startsWith(key))
    if (!match) return false
    event.preventDefault()
    match.focus()
    return true
  }
  const targets = { Home: 0, End: last, ArrowDown: current < last ? current + 1 : 0,
    ArrowUp: current > 0 ? current - 1 : last }
  if (!Object.hasOwn(targets, event.key)) return false
  event.preventDefault()
  items[targets[event.key]]?.focus()
  return true
}

export const MENU_TRIGGER_CSS = `
.bt-model-trigger{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;min-height:32px;padding:4px 8px 4px 10px;border:0;border-radius:var(--bt-radius-input);background:var(--bt-hover);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-model-trigger:hover,.bt-model-trigger[aria-expanded=true]{background:var(--bt-active)}
.bt-model-trigger[data-wide]{width:100%;justify-content:space-between}
.bt-model-copy{display:flex;flex-direction:column;min-width:0}
.bt-model-name{font-size:var(--bt-font-body);line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-provider{font-size:var(--bt-font-small);line-height:14px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-caret{flex:none;color:var(--bt-ink-3);transition:${spring(SPRING_SHAPE, 'transform')}}
[aria-expanded=true]>.bt-model-caret{transform:rotate(180deg)}
.bt-model-tick{flex:none;width:16px;height:16px;display:inline-flex;color:var(--bt-ink-2)}
`
