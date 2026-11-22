// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/{index,sidebar,header,overlays}.js.
import { createElement as h, Fragment, useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { MAIN_LOOK } from './characters.js'
import { ProductBrandMark } from './product-brand.js'
import { GaugeIcon, GlobeIcon, SearchIcon } from './icons.js'
import { t } from './i18n.js'
import { createSource } from './sources.js'
import { ShellPalette } from './shell-palette.js'
import { ShellNotificationWatcher, ShellToast } from './shell-notifications.js'
import { SuperagentAccountFooter } from './product-account.js'
import { installCompiledStyles } from './styles.js'

const BRAND = 'DS SuperAgent'
const ShellBrandName = () => h('span', { className: 'bt-product-brand-name' }, BRAND)
const MainMark = ({ state = 'idle', size }) => h(BotMark, { look: MAIN_LOOK, size, state, live: true })

const GoArrow = () => h('svg', { width: 14, height: 14, viewBox: '-12 -12 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M-7 0H7M2 -5L7 0L2 5' }))

export function ProductShellHeader({ activity = false, markState, onMain, onActivity, children }) {
  const action = activity ? onMain : onActivity
  const label = activity ? t('Back to chat') : t('Main')
  const contents = h(Fragment, null,
    h(MainMark, { size: 24, state: markState }),
    h('span', { className: 'bt-pill-name' }, label),
    action ? h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow)) : null)
  return h('div', { className: 'bt-head bt-product-head' },
    action ? h('button', { type: 'button', className: 'bt-pill',
      'aria-label': activity ? label : t('View activity'), onClick: action }, contents)
      : h('span', { className: 'bt-pill' }, contents),
    children)
}

function ShellSidebar({ wide = true, useShell, actions, openPalette, WorkDirectory }) {
  const { activity, markState, preview, pending, unread, connectLabel, settingsAvailable, modalOpen, signIn, classicAvailable } = useShell()
  const mainLabel = [t('Main'), pending ? t('Waiting for your answer') : unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  const row = (label, icon, onClick, selected) => h('button', {
    type: 'button', className: 'bt-row', 'aria-current': selected ? 'page' : undefined,
    'aria-label': label, title: wide ? undefined : label, onClick,
  }, icon, wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, label))) : null)

  return h('nav', { className: `bt-side bt-product-side${wide ? '' : ' bt-rail'}`, 'aria-label': t('Work navigation') },
    h('div', { className: wide ? 'bt-side-top' : 'bt-rail-top' },
      WorkDirectory ? h(WorkDirectory, { wide }) : null,
      h('button', { type: 'button', className: 'bt-round', title: t('Search'), 'aria-label': t('Search'),
        'aria-keyshortcuts': 'Control+k Meta+k', onClick: openPalette }, h(SearchIcon))),
    h('div', { className: 'bt-list' },
      wide ? h('div', { className: 'bt-tile-wrap' }, h('button', {
        type: 'button', className: 'bt-tile', 'aria-current': activity ? undefined : 'page',
        'aria-label': mainLabel, title: preview || t('Main'), onClick: actions.openMain,
      }, h(MainMark, { size: 60, state: markState }), h('span', { className: 'bt-tile-name' }, t('Main')),
      (pending || unread) && activity ? h('span', { className: 'bt-dot', 'aria-hidden': true }) : null))
        : row(mainLabel, h(MainMark, { size: 36, state: markState }), actions.openMain, !activity),
      actions.openActivity ? row(t('Activity'), h(GaugeIcon), actions.openActivity, activity) : null,
      actions.openConnection && connectLabel ? row(connectLabel, h(GlobeIcon), actions.openConnection) : null),
    actions.openSettings && settingsAvailable !== false
      ? h(SuperagentAccountFooter, { wide, modalOpen, signIn, openSettings: actions.openSettings,
        openClassic: classicAvailable ? actions.openClassic : undefined }) : null)
}

export function installProductShell(ctx, { useShell, actions, Overlay, overlayChildren, WorkDirectory, collect, settingsInSidebar = true, nativeHeader = false }) {
  const palette = createSource(false)
  const toast = createSource(null)
  const openPalette = () => palette.set(true)
  const reportError = error => toast.set({ text: error instanceof Error ? error.message : String(error) })
  const showNotice = text => toast.set({ text, tone: 'notice' })
  const shellActions = settingsInSidebar ? actions : { ...actions, openSettings: undefined }

  const Sidebar = props => h(ShellSidebar, { ...props, useShell, actions: shellActions, openPalette, WorkDirectory })
  const Header = props => {
    const state = useShell()
    return h(ProductShellHeader, { activity: state.activity, markState: state.markState,
      onMain: actions.openMain, onActivity: actions.openActivity, ...props })
  }
  const Overlays = ({ renderSlot }) => {
    const { connectLabel, modalOpen, settingsAvailable } = useShell()
    const searchOpen = useSyncExternalStore(palette.subscribe, palette.getSnapshot)
    const currentToast = useSyncExternalStore(toast.subscribe, toast.getSnapshot)
    useEffect(() => {
      if (modalOpen) palette.set(false)
      const onKeyDown = event => {
        if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || event.altKey
          || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
        if (modalOpen || document.querySelector('[aria-modal="true"]') || event.target?.closest?.('.xterm')) return
        event.preventDefault()
        event.stopPropagation()
        openPalette()
      }
      document.addEventListener('keydown', onKeyDown, true)
      return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [modalOpen])
    return h(Fragment, null,
      h(ShellNotificationWatcher, { useShell, onOpenMain: actions.openMain, showNotice }),
      Overlay ? createPortal(h(Overlay, { renderSlot }), document.body) : null,
      searchOpen && !modalOpen ? createPortal(h(ShellPalette, { actions, connectLabel, settingsAvailable,
        onClose: () => palette.set(false), reportError }), document.body) : null,
      currentToast ? createPortal(h(ShellToast, { toast: currentToast, onOpenMain: actions.openMain, onDismiss: () => {
        toast.set(value => value === currentToast ? null : value)
      } }), document.body) : null)
  }

  const register = (name, component, options = { priority: -200 }) => {
    const install = () => ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component))
    return collect ? collect(install) : install()
  }
  const installStyles = () => installCompiledStyles(PRODUCT_SHELL_CSS, 'product-shell')
  if (collect) collect(installStyles)
  else ctx.effect(installStyles, 'superagent: product shell styles')
  register('sidebar.workspaces', Sidebar)
  register('sidebar.brand.mark', ProductBrandMark)
  register('sidebar.brand.name', ShellBrandName)
  if (nativeHeader) register('conversation.session.header', ({ hideChrome }) => hideChrome ? null : h(Header))
  register('shell.overlay', Overlays, { id: 'superagent-shell', order: 50, ...(overlayChildren ? { children: overlayChildren } : {}) })
  return { Header, openPalette, reportError, closeOverlays() { palette.set(false); toast.set(null) } }
}

const PRODUCT_SHELL_CSS = `
.bt-product-brand-name{font-weight:600;font-size:14px}
.bt-product-side{height:100%;box-sizing:border-box;padding-inline:var(--dsh-sidebar-inline-padding,8px);padding-bottom:8px}
.bt-product-side>.bt-side-top{justify-content:flex-end}
.bt-sidebar-directory{position:relative;min-width:0}
.bt-sidebar-directory+.bt-round{flex:none}
.bt-sidebar-directory>.bt-main-error{position:absolute;top:100%;left:0;z-index:59;width:max-content;max-width:min(240px,calc(100vw - 24px));margin:4px 0 0;padding:6px 8px;border-radius:var(--bt-radius-input);background:var(--bt-card);box-shadow:var(--bt-glass-shadow)}
.bt-product-side:not(.bt-rail)>.bt-list{margin:0;scrollbar-gutter:auto}
.bt-product-side .bt-tile{position:relative}
.bt-product-side.bt-rail{width:auto;padding-inline:0}
.bt-product-side.bt-rail .bt-row{width:100%}
.bt-product-side .bt-leftcol-foot-rail{align-items:center}
.bt-product-side .bt-row>svg{flex:none}
.bt-product-head>.bt-pill:is(span){cursor:default;pointer-events:none}
.bt-product-head{gap:8px}
.bt-product-head>button,.bt-product-head>a{pointer-events:auto}
.bt-product-side button:focus-visible,.bt-product-head button:focus-visible,.bt-product-palette button:focus-visible,.bt-toast button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-account-menu{min-width:0;overflow-y:auto}
.bt-account-menu button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-product-palette-layer{max-width:none;max-height:none;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;color:inherit}
.bt-product-palette-layer::backdrop{background:transparent}
.bt-product-palette{max-height:calc(100% - 24px)}
.bt-toast{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom,0px));z-index:1000;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));padding:8px 8px 8px 14px;border-radius:12px;background:var(--bt-card);color:var(--bt-ink);border:1px solid var(--bt-line-2);box-shadow:var(--bt-glass-shadow);font:13px/18px var(--bt-font);transform:translateX(-50%);animation:bt-toast-in .2s ease-out}
.bt-toast[data-leaving]{opacity:0;transition:opacity .18s ease-in}
.bt-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}
.bt-toast-text::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--bt-danger);margin:0 8px 1px 0}
.bt-toast[data-tone=notice] .bt-toast-text::before{background:var(--bt-accent)}
.bt-toast-link{flex:none;border:0;background:none;color:var(--bt-ink);font:inherit;cursor:pointer;padding:4px 6px;border-radius:6px}
.bt-toast-link:hover{background:var(--bt-hover)}
.bt-toast-close{flex:none}
@keyframes bt-toast-in{from{opacity:0}}
body[data-bt-motion=quiet] :is(.bt-product-palette-layer,.bt-product-palette-layer *, .bt-product-head *, .bt-account-menu, .bt-toast){animation:none!important;transition:none!important}
@media(prefers-reduced-motion:reduce){:is(.bt-product-palette-layer,.bt-product-palette-layer *, .bt-account-menu, .bt-toast){animation:none!important;transition:none!important}}
`
