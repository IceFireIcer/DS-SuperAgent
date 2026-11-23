import { createElement as h, useCallback, useSyncExternalStore } from 'react'
import { t } from './i18n.js'
import { ACCENT_INKS, INKS, inkFill, isHex } from './inks.js'
import { MOTION_LEVELS, Segmented } from './motion.js'
import { createSource } from './sources.js'
import { installStyles } from './styles.js'
import { allThemes, registry, shellTokens, themeCss } from './themes.js'

const STORAGE_KEY = 'ds-superagent:appearance'
const CONTENT_SIZE = { min: 12, max: 18 }
const MODE_LABELS = { light: 'Light mode', dark: 'Dark mode', system: 'Follow system' }
const MOTION_LABELS = { quiet: 'Quiet', normal: 'Normal', lively: 'Lively' }
const DEFAULTS = { theme: 'deepseek', accent: null, motion: 'normal' }
const appearance = createSource(DEFAULTS)
let mountedTheme

export function getAppearance() {
  return { ...appearance.getSnapshot(), ...(mountedTheme ? { fontSize: mountedTheme.getTheme().fontSizes.text } : {}) }
}

export function normalizeAppearance(prefs) {
  const { theme, accent, motion } = prefs ?? {}
  return {
    theme: Object.hasOwn(allThemes(), theme) ? theme : DEFAULTS.theme,
    accent: isHex(accent) ? accent : null,
    motion: MOTION_LEVELS.includes(motion) ? motion : DEFAULTS.motion,
  }
}

function readAppearance(value) {
  try { return normalizeAppearance(JSON.parse(value())) } catch { return DEFAULTS }
}

export function setAppearance(patch) {
  if (Object.hasOwn(patch, 'fontSize')) mountedTheme?.setFontSize('text', patch.fontSize)
  const next = normalizeAppearance({ ...appearance.getSnapshot(), ...patch })
  appearance.set(next)
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* privileged or unavailable storage */ }
}

export function installAppearance(hostTheme) {
  mountedTheme = hostTheme
  appearance.set(readAppearance(() => window.localStorage.getItem(STORAGE_KEY)))
  const style = installStyles('', 'appearance')
  const body = document.body
  const previousMotion = body.getAttribute('data-bt-motion')
  let activeTheme
  let releaseTokens
  const render = () => {
    const { theme, accent, motion } = appearance.getSnapshot()
    const themes = allThemes()
    const palette = themes[theme] ?? themes.deepseek
    const next = themeCss(palette, accent)
    if (style.textContent !== next) style.textContent = next
    body.dataset.btMotion = motion
    if (palette !== activeTheme) {
      const releasePrevious = releaseTokens
      releaseTokens = hostTheme?.overrideTokens('ds-superagent', shellTokens(palette))
      releasePrevious?.()
      activeTheme = palette
    }
  }
  const syncStorage = (event) => {
    if (event.key === STORAGE_KEY || event.key === null) appearance.set(readAppearance(() => window.localStorage.getItem(STORAGE_KEY)))
  }
  render()
  const stop = appearance.subscribe(render)
  const stopRegistry = registry.subscribe(render)
  window.addEventListener('storage', syncStorage)
  return () => {
    stop()
    stopRegistry()
    window.removeEventListener('storage', syncStorage)
    style.remove()
    if (previousMotion === null) body.removeAttribute('data-bt-motion')
    else body.setAttribute('data-bt-motion', previousMotion)
    releaseTokens?.()
    if (mountedTheme === hostTheme) mountedTheme = undefined
  }
}

function AppearanceRow({ label, children }) {
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' }, h('span', { className: 'bt-set-label' }, label)), children)
}

function useHostTheme(ctx) {
  const service = ctx.get('theme')
  const subscribe = useCallback(listener => ctx.on('theme/change', listener), [ctx])
  const getSnapshot = useCallback(() => service.getTheme(), [service])
  return [service, useSyncExternalStore(subscribe, getSnapshot)]
}

function ChoiceRow({ label, value, labels, onChange }) {
  return h(AppearanceRow, { label }, h(Segmented, { label, value },
    Object.entries(labels).map(([id, text]) => h('button', {
      key: id, type: 'button', 'data-choice': id, 'aria-pressed': value === id, onClick: () => onChange(id),
    }, t(text)))))
}

function FontSizeRow({ service, size }) {
  const { min, max } = CONTENT_SIZE
  const value = Math.max(min, Math.min(max, size))
  const label = t('Content font size')
  return h(AppearanceRow, { label }, h('div', { className: 'bt-range', style: { '--bt-fill': `${((value - min) / (max - min)) * 100}%` } },
    h('input', { type: 'range', min, max, step: 1, value, 'aria-label': label, 'aria-valuetext': `${size}px`,
      onChange: event => service.setFontSize('text', Number(event.target.value)) }),
    h('output', null, `${size}px`)))
}

export function AppearanceSettings({ ctx }) {
  const [hostTheme, hostSnapshot] = useHostTheme(ctx)
  const prefs = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot)
  useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const themes = allThemes()
  const theme = Object.hasOwn(themes, prefs.theme) ? prefs.theme : DEFAULTS.theme
  const custom = prefs.accent !== null && !ACCENT_INKS.some(ink => INKS[ink][0] === prefs.accent)
  const accentButton = (color, label, ink) => h('button', {
    key: label, type: 'button', className: ink ? 'bt-swatch' : 'bt-swatch bt-swatch-default',
    title: label, 'aria-label': label, 'aria-pressed': prefs.accent === color,
    style: ink ? { background: inkFill(ink) } : undefined,
    onClick: () => setAppearance({ accent: color }),
  })
  return h('section', { className: 'bt-set-section bt-appearance' },
    h('h3', null, t('Display appearance')),
    h('div', { className: 'bt-set-card' },
      h(ChoiceRow, { label: t('Color mode'), value: hostSnapshot.preference, labels: MODE_LABELS, onChange: id => hostTheme.setTheme(id) }),
      h(AppearanceRow, { label: t('Theme') }, h('select', {
        className: 'bt-select', value: theme, 'aria-label': t('Theme'),
        onChange: event => setAppearance({ theme: event.target.value }),
      }, Object.entries(themes).map(([id, palette]) => h('option', { key: id, value: id }, t(palette.label))))),
      h(AppearanceRow, { label: t('Accent') }, h('div', { className: 'bt-swatches', role: 'group', 'aria-label': t('Accent') },
        accentButton(null, t('Theme accent')),
        ACCENT_INKS.map(ink => accentButton(INKS[ink][0], t(ink === 'deepseek' ? 'DeepSeek' : ink[0].toUpperCase() + ink.slice(1)), ink)),
        h('label', { className: 'bt-swatch bt-swatch-custom', title: t('Custom accent'), 'data-on': custom },
          h('input', { type: 'color', value: prefs.accent ?? themes[theme].light.accent, 'aria-label': t('Custom accent'),
            onChange: event => setAppearance({ accent: event.target.value }) })))),
      h(ChoiceRow, { label: t('Animation'), value: prefs.motion, labels: MOTION_LABELS, onChange: motion => setAppearance({ motion }) }),
      h(FontSizeRow, { service: hostTheme, size: hostSnapshot.fontSizes.text })))
}
