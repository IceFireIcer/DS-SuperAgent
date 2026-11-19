// Derived from DS Bot 0.3.8 (Apache-2.0), ds-bot/src/client/themes.js.
import { ACCENT_INKS, INKS, isHex, luminance } from './inks.js'
import { SHAPES, markupCache, maskCache } from './characters.js'
import { createSource } from './sources.js'

// -------------------------------------------------------------------------
// Themes. A theme names eight colors per mode; every `--bt-*` variable and the shell
// tokens derive from them, so a registered theme recolors the whole team UI.

const THEME_KEYS = ['bg', 'sidebar', 'bubble', 'card', 'text', 'user', 'userText', 'accent']
const THEMES = {
  deepseek: {
    label: 'DeepSeek',
    light: { bg: '#fcfcfc', sidebar: '#f7f7f7', bubble: '#eeeeee', card: '#ffffff', text: '#141414', user: '#070707', userText: '#fcfcfc', accent: '#4d6bfe' },
    dark: { bg: '#141414', sidebar: '#1b1b1b', bubble: '#262626', card: '#1f1f1f', text: '#f2f2f2', user: '#f2f2f2', userText: '#141414', accent: '#5b7bff' },
  },
  mono: {
    label: 'Mono',
    light: { bg: '#ffffff', sidebar: '#f9f9f9', bubble: '#f0f0f0', card: '#ffffff', text: '#0d0d0d', user: '#0d0d0d', userText: '#ffffff', accent: '#0d0d0d' },
    dark: { bg: '#0f0f0f', sidebar: '#171717', bubble: '#242424', card: '#1c1c1c', text: '#f4f4f4', user: '#f4f4f4', userText: '#0f0f0f', accent: '#f4f4f4' },
  },
  paper: {
    label: 'Paper',
    light: { bg: '#faf9f5', sidebar: '#f3f0e8', bubble: '#ebe7dc', card: '#ffffff', text: '#1f1e1b', user: '#2b2a26', userText: '#faf9f5', accent: '#d97757' },
    dark: { bg: '#1f1e1b', sidebar: '#262521', bubble: '#34322d', card: '#2a2925', text: '#f3f0e8', user: '#f3f0e8', userText: '#1f1e1b', accent: '#e08a6d' },
  },
  moonlight: {
    label: 'Moonlight',
    light: { bg: '#f7f9fc', sidebar: '#eef2f8', bubble: '#e5ebf5', card: '#ffffff', text: '#121826', user: '#1e3a8a', userText: '#ffffff', accent: '#1e86ff' },
    dark: { bg: '#0b1020', sidebar: '#10172a', bubble: '#1a2340', card: '#141c33', text: '#e8edf7', user: '#3b6fd8', userText: '#ffffff', accent: '#4f9dff' },
  },
}
// Text on the accent: near-black or white, whichever has the higher WCAG contrast.
// (L + .05)² > 1.05 × (L(#141414) + .05) is "dark ink reads better".
const DARK_INK = '#141414'
const accentInk = accent => ((luminance(accent) + 0.05) ** 2 > 1.05 * (luminance(DARK_INK) + 0.05) ? DARK_INK : '#ffffff')
const rgba = (hex, alpha) => `rgba(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(',')},${alpha})`
function themeVars(mode, dark, accent = mode.accent) {
  return {
    '--bt-ink': mode.text, '--bt-ink-2': rgba(mode.text, 0.6), '--bt-ink-3': rgba(mode.text, 0.36),
    '--bt-bubble': mode.bubble, '--bt-sidebar': mode.sidebar, '--bt-main': mode.bg, '--bt-card': mode.card,
    '--bt-line': rgba(mode.text, 0.08), '--bt-line-2': rgba(mode.text, 0.15), '--bt-line-weak': rgba(mode.text, 0.1),
    '--bt-hover': dark ? 'rgba(160,160,160,.12)' : 'rgba(119,119,119,.09)',
    '--bt-active': dark ? 'rgba(160,160,160,.2)' : 'rgba(119,119,119,.17)',
    '--bt-accent': accent, '--bt-accent-ink': accentInk(accent),
    '--bt-user': mode.user, '--bt-user-ink': mode.userText,
    '--bt-tag-bg': rgba(mode.text, dark ? 0.09 : 0.06), '--bt-tag-ink': rgba(mode.text, 0.58),
    '--bt-warn': dark ? '#f0b84a' : '#8a5a00',
    '--bt-glass-bg': `color-mix(in srgb,var(--bt-main) ${dark ? 74 : 78}%,transparent)`,
    '--bt-glass-border': dark ? 'rgba(255,255,255,.13)' : 'rgba(255,255,255,.72)',
    '--bt-glass-rim': dark ? 'rgba(255,255,255,.11)' : 'rgba(20,20,20,.09)',
    '--bt-glass-shadow': dark
      ? '0 12px 32px -6px rgba(0,0,0,.42),0 2px 8px -1px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.12)'
      : '0 8px 28px -6px rgba(0,0,0,.08),0 2px 6px -1px rgba(0,0,0,.04),inset 0 1px 0 rgba(255,255,255,.82)',
    '--bt-dialog-shadow': dark ? '0 24px 70px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.3)' : '0 24px 70px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.06)',
    '--bt-card-shadow': dark ? '0 1px 2px rgba(0,0,0,.35)' : '0 1px 2px rgba(0,0,0,.03)',
    '--bt-nav-thumb-bg': 'color-mix(in srgb,var(--bt-card) 82%,var(--bt-active))',
    '--bt-nav-thumb-shadow': dark ? '0 1px 3px rgba(0,0,0,.28)' : '0 1px 3px rgba(0,0,0,.08)',
    '--bt-accent-soft': `color-mix(in srgb,var(--bt-accent) ${dark ? 18 : 14}%,transparent)`,
    '--bt-danger-soft': `color-mix(in srgb,var(--bt-danger) ${dark ? 18 : 14}%,transparent)`,
    '--bt-danger-glow': `color-mix(in srgb,var(--bt-danger) ${dark ? 28 : 24}%,transparent)`,
    '--bt-q-edge': rgba(mode.text, dark ? 0.16 : 0.1),
    '--bt-q-rule': rgba(mode.text, dark ? 0.12 : 0.08),
    '--bt-q-rule-2': rgba(mode.text, dark ? 0.08 : 0.05),
    ...Object.fromEntries(Object.entries(INKS).map(([id, colors]) => [`--bt-ink-${id}`, colors[Number(dark)]])),
  }
}
const declarations = vars => Object.entries(vars).map(([name, value]) => `${name}:${value}`).join(';')
// A preset accent is saved as its light value; in dark mode it takes the preset's dark
// value, as Bot names do, so Charcoal does not vanish on a dark background. A custom
// accent is the same in both modes. A preset is matched the way Settings marks it.
const darkAccent = (accent) => {
  const ink = ACCENT_INKS.find(id => INKS[id][0] === accent)
  return ink === undefined ? accent : INKS[ink][1]
}
const DARK_ROOT = ':root:has(> body[data-ds-dark-theme])'
export const themeCss = (theme, accent, { fallback = false } = {}) => {
  const selected = isHex(accent) ? accent : undefined
  const selector = root => fallback ? `:where(${root})` : root
  return `${selector(':root')}{${declarations(themeVars(theme.light, false, selected))}}
${selector(DARK_ROOT)}{${declarations(themeVars(theme.dark, true, darkAccent(selected)))}}
${theme.css ?? ''}`
}

export const FOUNDATION_TOKENS_CSS = `
:root{
  --bt-danger:#e02135;
  --bt-green:#00c972;
  --bt-star:#ff9800;
  --bt-knob:#ffffff;
  --bt-static-light:#ffffff;
  --bt-recording:#ff3e51;
  --bt-recording-ring:color-mix(in srgb,var(--bt-recording) 35%,transparent);
  --bt-hairline:rgba(228,228,228,.04);
  --bt-shadow-ink:#000;
  --bt-scrim:rgba(0,0,0,.32);
  --bt-font-fallback:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --bt-font:var(--dsw-font-family,var(--bt-font-fallback));
  --bt-font-hidden:0;
  --bt-font-badge:8.5px;
  --bt-font-caption:11px;
  --bt-font-small:12px;
  --bt-font-body:13px;
  --bt-font-control:14px;
  --bt-font-heading:15px;
  --bt-font-large:16px;
  --bt-font-title:17px;
  --bt-font-display:18px;
  --bt-line-caption:16px;
  --bt-line-body:18px;
  --bt-line-heading:20px;
  --bt-line-control:22px;
  --bt-radius-none:0;
  --bt-radius-hairline:1px;
  --bt-radius-tag:4px;
  --bt-radius-menu-item:6px;
  --bt-radius-input:8px;
  --bt-radius-row:10px;
  --bt-radius-card:12px;
  --bt-radius-popover:16px;
  --bt-radius-bubble:18px;
  --bt-radius-dialog:20px;
  --bt-radius-composer:22px;
  --bt-radius-pill:999px;
  --bt-radius-round:50%;
  --bt-msg-w:.8;
  --bt-flat-w:1;
}
${DARK_ROOT}{--bt-scrim:rgba(0,0,0,.5)}
${themeCss(THEMES.deepseek, undefined, { fallback: true })}`
export const shellTokens = ({ light, dark }) => ({
  '--dsw-alias-bg-base': { light: light.bg, dark: dark.bg },
  '--dsw-specific-sidebar-fill': { light: light.sidebar, dark: dark.sidebar },
  '--dsw-specific-input-major': { light: light.bg, dark: dark.sidebar },
  '--dsw-alias-label-primary': { light: light.text, dark: dark.text },
  '--dsw-alias-label-secondary': { light: rgba(light.text, 0.74), dark: rgba(dark.text, 0.74) },
  '--dsw-alias-label-tertiary': { light: rgba(light.text, 0.6), dark: rgba(dark.text, 0.6) },
})

const customThemes = {}
export const registry = createSource(0)
const isPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
export function registerShape(id, shape) {
  if (typeof id !== 'string' || !/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Shape ids are lowercase words')
  if (typeof shape?.body !== 'function' || typeof shape.body('#000') !== 'string') throw new Error('A shape needs body(paint) returning SVG markup')
  const at = shape.eyes?.at
  if (!Array.isArray(at) || at.length !== 2 || !at.every(isPoint)) throw new Error('A shape needs eyes.at: two [x, y] points')
  const size = Number.isFinite(shape.size) && shape.size > 0 ? shape.size : 100
  const pick = (key, fallback) => (Number.isFinite(shape.eyes[key]) ? shape.eyes[key] : fallback)
  const eyes = at.map(([x, y]) => [x, y, pick('w', size * 0.1), pick('h', size * 0.23), pick('tilt', -27)])
  const previous = SHAPES[id]
  SHAPES[id] = {
    label: String(shape.label ?? id),
    size,
    body: shape.body,
    eyes,
    ...(typeof shape.wrap === 'string' ? { wrap: shape.wrap } : {}),
  }
  const refresh = () => {
    markupCache.clear()
    maskCache.delete(id)
    registry.set(value => value + 1)
  }
  refresh()
  return () => {
    if (previous) SHAPES[id] = previous
    else delete SHAPES[id]
    refresh()
  }
}
export function registerTheme(id, theme) {
  if (typeof id !== 'string' || !/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Theme ids are lowercase words')
  for (const mode of ['light', 'dark']) {
    for (const key of THEME_KEYS) if (!isHex(theme?.[mode]?.[key])) throw new Error(`Theme ${mode}.${key} must be a #rrggbb color`)
  }
  const previous = customThemes[id]
  customThemes[id] = { label: String(theme.label ?? id), light: theme.light, dark: theme.dark, css: typeof theme.css === 'string' ? theme.css : '' }
  registry.set(value => value + 1)
  return () => {
    if (previous) customThemes[id] = previous
    else delete customThemes[id]
    registry.set(value => value + 1)
  }
}
export const allThemes = () => ({ ...THEMES, ...customThemes })
