import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { rectsOverlap } from '../src/client/browser-overlap.js'

test('overlay coverage requires positive rectangle intersection', () => {
  const panel = { left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 }
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 150, bottom: 160, width: 100, height: 100 }), true)
  assert.equal(rectsOverlap(panel, { left: 110, top: 20, right: 150, bottom: 60, width: 40, height: 40 }), false)
  assert.equal(rectsOverlap(panel, { left: 200, top: 200, right: 250, bottom: 250, width: 50, height: 50 }), false)
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 50, bottom: 90, width: 0, height: 30 }), false)
})

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/browser-pane.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// A minimal stateful React: hook cells live across renders and a setState re-renders,
// so the import flow's deferred results run as on the page. Effects run when their
// deps change; the mount's cleanups are kept for the unmount.
const cells = []
const prevDeps = []
const cleanups = []
let hook = 0
let dirty = false
let pendingEffects = []
const changed = (deps, prev) => deps === undefined || prev === undefined || deps.length !== prev.length || deps.some((dep, i) => !Object.is(dep, prev[i]))
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState(initial) {
    const i = hook++
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
    return [cells[i], (next) => {
      const value = typeof next === 'function' ? next(cells[i]) : next
      if (!Object.is(value, cells[i])) { cells[i] = value; dirty = true }
    }]
  },
  useRef(initial) { const i = hook++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
  useEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
  useLayoutEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
  useMemo: make => make(),
  useId: () => 'id',
  Fragment: Symbol('Fragment'),
}
const effects = () => {
  for (const { i, fn, deps } of pendingEffects) {
    if (!changed(deps, prevDeps[i])) continue
    if (typeof cleanups[i] === 'function') cleanups[i]()
    prevDeps[i] = deps
    cleanups[i] = fn()
  }
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
  document: {
    body: { append() {} },
    documentElement: { hasAttribute: () => false, dataset: {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`no platform module ${name}`)
  },
})
const { BrowserView } = module.exports

const render = (props) => {
  let tree
  do {
    dirty = false
    hook = 0
    pendingEffects = []
    tree = BrowserView(props)
    effects()
  } while (dirty)
  return tree
}
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props?.children, match)
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('a cookie pick landing after the tab is left cancels its pending import', async () => {
  let finish
  const cancelled = []
  const imports = {
    sources: async () => [],
    pick: () => new Promise(resolve => { finish = resolve }),
    live: async () => ({}),
    apply: async () => ({ stored: 0 }),
    cancel: async id => { cancelled.push(id) },
  }
  const props = {
    bot: { id: 'a', name: 'Writer' }, tabId: 't1', leaving: false, landed: true, hold: null,
    actions: {
      browserImport: imports, browserShow: async () => {}, browserCommand() {}, browserNewTab() {},
      browserActivate() {}, browserCloseTab: async () => {}, openSideChat() {}, closeSideChat: async () => {}, closePanel() {},
    },
    useBrowserPages: pick => pick({}),
  }
  let tree = render(props)
  find(tree, node => node.props?.['aria-label'] === 'Import cookies').props.onClick()
  tree = render(props)
  find(tree, node => node.type?.name === 'ImportMenu').props.onFile()
  render(props)
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  finish({ id: 'pending-1', preview: { cookies: 1, sites: [], skipped: [], warnings: [], notes: [], source: { label: 'file' } } })
  await settle()
  assert.deepEqual(cancelled, ['pending-1'])
})
