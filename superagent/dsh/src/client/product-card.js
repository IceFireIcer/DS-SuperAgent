import { createElement as h, Fragment, useRef } from 'react'
import {
  CHARACTERS, CHARACTER_COLORS, PICKER_COLUMNS, PICKER_SHAPES, SHAPES, bodyOf, holes, maskBox, shapeOf,
} from './characters.js'
import { paintCss } from './inks.js'
import { BotMark } from './mark.js'
import { t } from './i18n.js'
import { FieldRow } from './product-settings-components.js'

export { SectionCard as Card } from './product-settings-components.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

export function Row({ label, hint, stack = false, children }) {
  return h(FieldRow, { label, hint, layout: stack ? 'stack' : undefined, control: children })
}

export function SwitchRow({ label, hint, on, disabled, onChange }) {
  return h(FieldRow, { label, hint, control: h('button', { type: 'button', role: 'switch', className: 'bt-switch', 'aria-checked': on,
      'aria-label': label, disabled, onClick: () => onChange(!on) },
    h('span', { className: 'bt-switch-knob', 'aria-hidden': true })) })
}

function ShapeRing({ shape, size }) {
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-product-ring-${crypto.randomUUID()}`
  const def = shapeOf(shape)
  const unit = def.size / size
  const markup = `<defs><mask id="${maskId.current}" ${maskBox(def.size)}>${holes(def, `<g stroke="#000" stroke-width="${6 * unit}" stroke-linejoin="round">${bodyOf(def, '#000', true)}</g>`)}</mask></defs><g mask="url(#${maskId.current})" stroke="currentColor" stroke-width="${8 * unit}" stroke-linejoin="round">${bodyOf(def, 'currentColor', true)}</g>`
  return h('svg', { className: 'bt-ring', viewBox: `0 0 ${def.size} ${def.size}`, 'aria-hidden': true,
    dangerouslySetInnerHTML: { __html: markup } })
}

export function CharacterGrid({ look, hasPhoto = false, onShape, onColor }) {
  const shapes = [...PICKER_SHAPES, ...Object.keys(SHAPES).filter(id => !Object.hasOwn(CHARACTERS, id))]
  if (!shapes.includes(look.shape)) shapes.push(look.shape)
  const rows = []
  for (let index = 0; index < shapes.length; index += PICKER_COLUMNS) rows.push(shapes.slice(index, index + PICKER_COLUMNS))
  return h(Fragment, null,
    h('div', { className: 'bt-shapes', role: 'group', 'aria-label': t('Character shape') },
      rows.map((row, index) => h('div', { key: index, className: 'bt-shape-row' }, row.map(id => h('button', {
        key: id, type: 'button', className: 'bt-shape', 'aria-label': t(shapeOf(id).label), title: t(shapeOf(id).label),
        'aria-pressed': !hasPhoto && look.shape === id, onClick: () => onShape(id),
      }, h(ShapeRing, { shape: id, size: 36 }), h(BotMark, { look: { shape: id, color: look.color }, size: 36 })))))),
    h('div', { className: 'bt-colors', role: 'group', 'aria-label': t('Character color') },
      CHARACTER_COLORS.map(color => h('button', {
        key: color, type: 'button', className: 'bt-color', 'aria-label': t(capitalize(color)),
        title: t(capitalize(color)), 'aria-pressed': look.color === color, onClick: () => onColor(color),
      }, h('span', { style: { background: paintCss(color) } })))))
}
