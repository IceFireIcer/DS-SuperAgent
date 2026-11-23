// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/{folder-menu,model-menu}.js.
import { createElement as h, Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, PencilIcon } from './icons.js'
import { t } from './i18n.js'
import { reducedMotion, SPRING_SHAPE, spring, useLinger, useViewport, viewBottom } from './motion.js'

const MENU_EXIT_MS = 120
const Caret = () => h('svg', {
  className: 'bt-model-caret', width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M5.5 8l4.5 4.5L14.5 8' }))

function useAnchoredMenu(compact, dismiss) {
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
    const width = Math.min(Math.max(240, rect.width), viewWidth - 16)
    const left = Math.max(viewLeft + 8, Math.min(rect.right - width, viewLeft + viewWidth - width - 8))
    const below = viewBottom() - rect.bottom - 4
    const above = rect.top - (viewport?.offsetTop ?? 0) - 4
    setPlace(below >= 260 || below >= above
      ? { left, width, top: rect.bottom + 4, maxHeight: Math.max(0, below - 8), '--bt-origin': 'top right' }
      : { left, width, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(0, above - 8), '--bt-origin': 'bottom right' })
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

// The last segment of a host path, Windows or POSIX; a root keeps its own spelling.
export const folderName = path => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path)

const Tick = ({ on }) => h('span', { className: 'bt-model-tick', 'aria-hidden': true }, on ? h(CheckIcon) : null)

// Where a SuperAgent role, or every member of a group, works. `value` is the saved folder;
// without one a role works in the SuperAgent workspace and a group member in its own folder. `onPick`
// gets the chosen path, or '' for that default. `team` is the menu for the team workspace
// itself, which has no default.
export function FolderMenu({ value, defaultPath, group = false, team = false, actions, run, onPick, onNativePick,
  wide = false, compact = false, disabled = false, dismiss = false, fallbackLabel, label }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu(compact, dismiss || disabled)
  const id = useId()
  const [info, setInfo] = useState(null)
  const [view, setView] = useState('list')
  const [draft, setDraft] = useState('')
  const [listing, setListing] = useState(null)
  const [problem, setProblem] = useState('')
  const [loading, setLoading] = useState(false)
  const currentPath = value ?? defaultPath
  const fallback = fallbackLabel ?? (group ? t("Each Worker's own folder") : t('SuperAgent workspace'))
  const menuLabel = label ?? (team ? t('SuperAgent workspace') : t('Working folder'))
  const menuItems = () => [...(menu.current?.querySelectorAll('button[role^="menuitem"]:not(:disabled)') ?? [])]
  const showProblem = reason => setProblem(reason?.message ?? String(reason))
  useLayoutEffect(() => {
    if (!isOpen || !shownPlace || menu.current?.contains(document.activeElement)) return
    const selected = menu.current?.querySelector('[aria-checked=true]') ?? menuItems()[0]
    ;(selected ?? menu.current)?.focus()
  }, [isOpen, Boolean(shownPlace), view, listing, info])
  const onKeyDown = event => {
    if (event.defaultPrevented) return
    if (event.key === 'Tab' && isOpen) {
      if (view === 'type' && menu.current?.contains(event.target)) {
        const stops = [...menu.current.querySelectorAll('button:not(:disabled), input')]
        if (event.target !== (event.shiftKey ? stops[0] : stops.at(-1))) return
      }
      close()
      return
    }
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.target.tagName === 'INPUT') return
    const items = menuItems()
    const current = items.indexOf(event.target)
    const last = items.length - 1
    const targets = { Home: 0, End: last, ArrowDown: current < last ? current + 1 : 0,
      ArrowUp: current > 0 ? current - 1 : last }
    if (!Object.hasOwn(targets, event.key)) return
    event.preventDefault()
    items[targets[event.key]]?.focus()
  }
  const toggle = () => {
    if (disabled || dismiss) return
    if (isOpen) { close(); return }
    setView('list')
    setProblem('')
    setLoading(true)
    void Promise.resolve(actions.folders()).then(setInfo).catch(showProblem).finally(() => setLoading(false))
    open()
  }
  const choose = (path) => {
    close()
    if (path !== (value ?? '')) void onPick(path)
  }
  const browse = (path) => {
    setProblem('')
    void Promise.resolve(actions.folderList(path)).then((next) => { setListing(next); setView('browse') })
      .catch(failure => setProblem(failure?.message ?? String(failure)))
  }
  const pickNative = () => {
    close()
    if (onNativePick) void onNativePick()
    else void run(Promise.resolve(actions.folderPick()).then(path => (path ? onPick(path) : undefined)))
  }
  const typed = () => {
    const path = draft.trim()
    if (path !== '') choose(path)
  }
  const known = (info?.folders ?? []).filter(folder => team || folder.path !== defaultPath || folder.path === value)
  const folders = value && !known.some(folder => folder.path === value) ? [{ path: value, title: folderName(value) }, ...known] : known
  const listView = h('div', { key: 'list', className: 'bt-folder-view' },
    team ? null : h('button', { type: 'button', role: 'menuitemradio', tabIndex: -1, 'aria-checked': !value,
      title: group ? undefined : defaultPath ?? info?.team ?? undefined, onClick: () => choose('') },
      h('span', { className: 'bt-folder-copy' }, h('span', { className: 'bt-menu-label' }, fallback),
        defaultPath ? h('span', { className: 'bt-folder-path' }, defaultPath) : null), h(Tick, { on: !value })),
    folders.length > 0 ? h('div', { className: 'bt-model-group', role: 'presentation' }, t('Folders')) : null,
    folders.map(folder => h('button', { key: folder.path, type: 'button', role: 'menuitemradio', tabIndex: -1, 'aria-checked': folder.path === value, title: folder.path, onClick: () => choose(folder.path) },
      h('span', { className: 'bt-folder-copy' }, h('span', { className: 'bt-menu-label' }, folder.title), h('span', { className: 'bt-folder-path' }, folder.path)),
      h(Tick, { on: folder.path === value }))),
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    loading ? h('div', { className: 'bt-model-none', role: 'status' }, t('Loading…')) : null,
    info?.picker === 'native' ? h('button', { type: 'button', role: 'menuitem', tabIndex: -1, onClick: pickNative }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Choose a folder…'))) : null,
    info?.picker === 'browse' ? h('button', { type: 'button', role: 'menuitem', tabIndex: -1, onClick: () => browse(currentPath) }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Browse folders…'))) : null,
    h('button', { type: 'button', role: 'menuitem', tabIndex: -1, onClick: () => { setDraft(currentPath ?? ''); setView('type') } }, h(PencilIcon), h('span', { className: 'bt-menu-label' }, t('Enter a path…'))))
  const typeView = h('div', { key: 'type', className: 'bt-folder-view' },
    h('button', { type: 'button', role: 'menuitem', className: 'bt-folder-back', onClick: () => setView('list') }, h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, t('Back'))),
    h('input', {
      className: 'bt-folder-input', autoFocus: true, value: draft, spellCheck: false, 'aria-label': t('Folder path'), placeholder: t('Full path of a folder'),
      onChange: event => setDraft(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) typed() },
    }),
    h('button', { type: 'button', role: 'menuitem', className: 'bt-folder-use', disabled: draft.trim() === '', onClick: typed }, t('Use this folder')))
  const parent = listing?.crumbs?.length > 1 ? listing.crumbs.at(-2) : undefined
  const inside = listing?.entries?.filter(entry => !entry.hidden) ?? []
  const browseView = listing ? h('div', { key: `browse:${listing.path}`, className: 'bt-folder-view' },
    h('button', { type: 'button', role: 'menuitem', className: 'bt-folder-back', onClick: () => setView('list') }, h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, t('Back'))),
    h('div', { className: 'bt-folder-path bt-folder-here' }, listing.path),
    parent ? h('button', { type: 'button', role: 'menuitem', title: parent.path, onClick: () => browse(parent.path) }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Up one level'))) : null,
    inside.map(entry => h('button', { key: entry.path, type: 'button', role: 'menuitem', onClick: () => browse(entry.path) },
      h(FolderIcon), h('span', { className: 'bt-menu-label' }, entry.name), h(ChevronRightIcon))),
    inside.length === 0 ? h('div', { className: 'bt-model-none' }, t('No folders inside.')) : null,
    listing.truncated ? h('div', { className: 'bt-folder-path bt-folder-here' }, t('Some folders are not shown.')) : null,
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    h('button', { type: 'button', role: 'menuitem', className: 'bt-folder-use', onClick: () => choose(listing.path) }, t('Use this folder'))) : null
  const shownView = view === 'type' ? typeView : view === 'browse' && browseView ? browseView : listView
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: compact ? 'bt-round bt-folder-trigger' : 'bt-model-trigger bt-folder-trigger', 'data-wide': wide || undefined,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-controls': isOpen ? id : undefined,
      'aria-label': `${menuLabel}: ${currentPath ?? fallback}`, 'aria-disabled': disabled || undefined,
      title: currentPath ?? menuLabel, onClick: toggle,
      onKeyDown: event => {
        if (!isOpen && !disabled && !dismiss && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); toggle()
        } else if (isOpen) onKeyDown(event)
      },
    },
    compact ? h(FolderIcon) : h(Fragment, null, h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, currentPath ? folderName(currentPath) : fallback),
      currentPath ? h('span', { className: 'bt-model-provider' }, currentPath) : null), h(Caret))),
    shownPlace ? createPortal(h('div', { ref: menu, id, className: `bt-menu bt-folder-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`,
      role: 'menu', tabIndex: -1, 'aria-label': menuLabel, style: shownPlace, 'data-leaving': leaving || undefined,
      'aria-hidden': leaving || undefined, inert: leaving, onKeyDown },
      shownView,
      problem ? h('div', { className: 'bt-folder-error', role: 'alert' }, problem) : null), document.body) : null)
}

export const FOLDER_CSS = `
.bt-model-trigger{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;min-height:32px;padding:4px 8px 4px 10px;border:0;border-radius:var(--bt-radius-input);background:var(--bt-hover);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-model-trigger:hover,.bt-model-trigger[aria-expanded=true]{background:var(--bt-active)}
.bt-model-trigger[data-wide]{width:100%;justify-content:space-between}
.bt-model-copy{display:flex;flex-direction:column;min-width:0}
.bt-model-name{font-size:var(--bt-font-body);line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-provider{font-size:var(--bt-font-small);line-height:14px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-menu.bt-folder-menu{min-width:0;overflow:auto;scrollbar-width:thin}
.bt-folder-trigger:focus-visible,.bt-menu.bt-folder-menu :is(button,input):focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-folder-view{display:flex;flex-direction:column;gap:2px;animation:bt-veil-in .14s ease-out}
.bt-model-caret{flex:none;color:var(--bt-ink-3);transition:${spring(SPRING_SHAPE, 'transform')}}
[aria-expanded=true]>.bt-model-caret{transform:rotate(180deg)}
.bt-model-group{flex:none;padding:8px 8px 2px;font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3)}
.bt-model-group:first-child{padding-top:2px}
.bt-model-tick{flex:none;width:16px;height:16px;display:inline-flex;color:var(--bt-ink-2)}
.bt-model-none{padding:8px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-folder-copy{flex:1;display:flex;flex-direction:column;min-width:0}
.bt-folder-copy .bt-menu-label{flex:none}
.bt-folder-path{min-width:0;font-size:11px;line-height:14px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-folder-here{padding:0 8px 4px;white-space:normal;overflow-wrap:anywhere}
.bt-menu .bt-folder-back{color:var(--bt-ink-2);font-weight:500}
.bt-folder-input{height:30px;margin:2px 4px;padding:0 8px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;outline:none;box-sizing:border-box}
.bt-folder-input:focus{border-color:var(--bt-accent)}
.bt-menu .bt-folder-use{justify-content:center;font-weight:500;color:var(--bt-accent)}
.bt-menu .bt-folder-use:disabled{color:var(--bt-ink-3);cursor:default;background:none}
.bt-folder-trigger[aria-disabled=true]{opacity:.6;cursor:default}
.bt-folder-error{padding:4px 8px;font-size:12px;line-height:16px;color:var(--bt-danger);overflow-wrap:anywhere}
body[data-bt-motion=quiet] :is(.bt-folder-menu,.bt-folder-view,.bt-folder-trigger,.bt-folder-trigger .bt-model-caret){animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){:is(.bt-folder-menu,.bt-folder-view,.bt-folder-trigger,.bt-folder-trigger .bt-model-caret){animation:none!important;transition:none!important}}
`
