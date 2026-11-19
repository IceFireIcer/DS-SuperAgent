import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, PencilIcon } from './icons.js'
import { t } from './i18n.js'
import { useLinger, useViewport, viewBottom } from './motion.js'

const MENU_EXIT_MS = 120
const Caret = () => h('svg', {
  className: 'bt-model-caret', width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M5.5 8l4.5 4.5L14.5 8' }))

function useAnchoredMenu() {
  const [anchor, setAnchor] = useState(null)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const close = () => { setAnchor(null); setPlace(null) }
  useEffect(() => {
    if (place === null) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
      button.current?.focus()
    }
    const onScroll = (event) => { if (!menu.current?.contains(event.target)) close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [place])
  useLayoutEffect(() => {
    if (anchor === null || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = Math.max(240, rect.width)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = viewBottom() - rect.bottom
    setPlace(below >= 260 || below >= rect.top
      ? { left, width, top: rect.bottom + 4, maxHeight: below - 16, '--bt-origin': 'top right' }
      : { left, width, bottom: viewBottom() - rect.top + 4, maxHeight: rect.top - 16, '--bt-origin': 'bottom right' })
  }, [anchor, tick])
  return { isOpen: place !== null, shownPlace, leaving, button, menu, open: () => setAnchor({}), close }
}

// The last segment of a host path, Windows or POSIX; a root keeps its own spelling.
export const folderName = path => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path)

const Tick = ({ on }) => h('span', { className: 'bt-model-tick', 'aria-hidden': true }, on ? h(CheckIcon) : null)

// Where a SuperAgent role, or every member of a group, works. `value` is the saved folder;
// without one a role works in the SuperAgent workspace and a group member in its own folder. `onPick`
// gets the chosen path, or '' for that default. `team` is the menu for the team workspace
// itself, which has no default.
export function FolderMenu({ value, group = false, team = false, actions, run, onPick, wide = false, disabled = false,
  fallbackLabel, label }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const [info, setInfo] = useState(null)
  const [view, setView] = useState('list')
  const [draft, setDraft] = useState('')
  const [listing, setListing] = useState(null)
  const [problem, setProblem] = useState('')
  const fallback = fallbackLabel ?? (group ? t("Each Worker's own folder") : t('SuperAgent workspace'))
  const menuLabel = label ?? (team ? t('SuperAgent workspace') : t('Working folder'))
  const toggle = () => {
    if (isOpen) { close(); return }
    setView('list')
    setProblem('')
    // Projects added in DSH meanwhile show up, so opening asks again.
    void Promise.resolve(actions.folders()).then(setInfo).catch(() => setInfo(last => last ?? { team: null, picker: null, folders: [] }))
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
    void run(Promise.resolve(actions.folderPick()).then(path => (path ? onPick(path) : undefined)))
  }
  const typed = () => {
    const path = draft.trim()
    if (path !== '') choose(path)
  }
  const known = info?.folders ?? []
  const folders = value && !known.some(folder => folder.path === value) ? [{ path: value, title: folderName(value) }, ...known] : known
  const listView = h('div', { key: 'list', className: 'bt-folder-view' },
    team ? null : h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': !value, title: group ? undefined : info?.team ?? undefined, onClick: () => choose('') },
      h('span', { className: 'bt-menu-label' }, fallback), h(Tick, { on: !value })),
    folders.length > 0 ? h('div', { className: 'bt-model-group', role: 'presentation' }, t('Folders')) : null,
    folders.map(folder => h('button', { key: folder.path, type: 'button', role: 'menuitemradio', 'aria-checked': folder.path === value, title: folder.path, onClick: () => choose(folder.path) },
      h('span', { className: 'bt-folder-copy' }, h('span', { className: 'bt-menu-label' }, folder.title), h('span', { className: 'bt-folder-path' }, folder.path)),
      h(Tick, { on: folder.path === value }))),
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    info?.picker === 'native' ? h('button', { type: 'button', role: 'menuitem', onClick: pickNative }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Choose a folder…'))) : null,
    info?.picker === 'browse' ? h('button', { type: 'button', role: 'menuitem', onClick: () => browse(value) }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Browse folders…'))) : null,
    h('button', { type: 'button', role: 'menuitem', onClick: () => { setDraft(value ?? ''); setView('type') } }, h(PencilIcon), h('span', { className: 'bt-menu-label' }, t('Enter a path…'))))
  const typeView = h('div', { key: 'type', className: 'bt-folder-view' },
    h('button', { type: 'button', className: 'bt-folder-back', onClick: () => setView('list') }, h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, t('Back'))),
    h('input', {
      className: 'bt-folder-input', autoFocus: true, value: draft, spellCheck: false, 'aria-label': t('Folder path'), placeholder: t('Full path of a folder'),
      onChange: event => setDraft(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) typed() },
    }),
    h('button', { type: 'button', className: 'bt-folder-use', disabled: draft.trim() === '', onClick: typed }, t('Use this folder')))
  const parent = listing?.crumbs?.length > 1 ? listing.crumbs.at(-2) : undefined
  const inside = listing?.entries?.filter(entry => !entry.hidden) ?? []
  const browseView = listing ? h('div', { key: `browse:${listing.path}`, className: 'bt-folder-view' },
    h('button', { type: 'button', className: 'bt-folder-back', onClick: () => setView('list') }, h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, t('Back'))),
    h('div', { className: 'bt-folder-path bt-folder-here' }, listing.path),
    parent ? h('button', { type: 'button', role: 'menuitem', title: parent.path, onClick: () => browse(parent.path) }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Up one level'))) : null,
    inside.map(entry => h('button', { key: entry.path, type: 'button', role: 'menuitem', onClick: () => browse(entry.path) },
      h(FolderIcon), h('span', { className: 'bt-menu-label' }, entry.name), h(ChevronRightIcon))),
    inside.length === 0 ? h('div', { className: 'bt-model-none' }, t('No folders inside.')) : null,
    listing.truncated ? h('div', { className: 'bt-folder-path bt-folder-here' }, t('Some folders are not shown.')) : null,
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    h('button', { type: 'button', className: 'bt-folder-use', onClick: () => choose(listing.path) }, t('Use this folder'))) : null
  const shownView = view === 'type' ? typeView : view === 'browse' && browseView ? browseView : listView
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-model-trigger', 'data-wide': wide || undefined,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-label': `${menuLabel}: ${value ?? (team ? '' : fallback)}`,
      title: value, onClick: toggle, disabled,
    },
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, value ? folderName(value) : fallback),
      value ? h('span', { className: 'bt-model-provider' }, value) : null),
    h(Caret)),
    shownPlace ? createPortal(h('div', { ref: menu, className: `bt-menu bt-model-menu bt-folder-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, role: 'menu', 'aria-label': menuLabel, style: shownPlace, 'data-leaving': leaving || undefined },
      shownView,
      problem ? h('div', { className: 'bt-folder-error', role: 'alert' }, problem) : null), document.body) : null)
}

export const FOLDER_CSS = `
.bt-folder-view{display:flex;flex-direction:column;gap:2px;animation:bt-veil-in .14s ease-out}
.bt-model-caret{flex:none;color:var(--bt-ink-3);transition:transform .12s ease}
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
.bt-model-trigger:disabled{opacity:.6;cursor:default}
.bt-folder-error{padding:4px 8px;font-size:12px;line-height:16px;color:var(--bt-danger);overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.bt-folder-view{animation:none}}
`
