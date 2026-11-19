import { createElement as h, useEffect, useRef, useState } from 'react'
import { fnv1a, lookOf, shapeId, shapeOf, MASK_ID, nextMarkSerial, characterMarkup } from './characters.js'
import { mascotInteraction } from './motion.js'

export { lookOf } from './characters.js'

// -------------------------------------------------------------------------
// Bot mark: the Bot's character (or its uploaded photo), looked up by lookOf.

// Uploaded images only bob or hop because they have no character parts to move.
const STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done']

// Eyes follow the pointer on large marks.
function useGaze(ref, enabled) {
  useEffect(() => {
    if (!enabled) return undefined
    let frame = 0
    let point = null
    const place = () => {
      frame = 0
      const node = ref.current
      if (!node || !point || !mascotInteraction()) return
      const box = node.getBoundingClientRect()
      const clamp = value => Math.max(-1, Math.min(1, value))
      node.style.setProperty('--bt-gx', clamp((point.x - box.left - box.width / 2) / 160).toFixed(2))
      node.style.setProperty('--bt-gy', clamp((point.y - box.top - box.height / 2) / 160).toFixed(2))
    }
    const onMove = (event) => {
      if (!mascotInteraction()) return
      point = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(place)
    }
    const onLeave = () => { point = null; ref.current?.style.setProperty('--bt-gx', '0'); ref.current?.style.setProperty('--bt-gy', '0') }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [enabled])
}

// A mark moves for its state. `live` marks (sidebar, header, details) also answer the
// pointer, and at the lively motion level blink and fidget at rest (each Bot its own
// fidget and moment); transcript marks stay still so a long chat does not run dozens
// of animations.
const FIDGETS = ['hop', 'sway', 'stretch', 'look']
export function BotMark({ bot, look: given, size = 36, state = 'idle', live = false, gaze = false, pokeable = false, label }) {
  const look = given ?? lookOf(bot)
  const ref = useRef(null)
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-mark-${nextMarkSerial()}`
  const [poked, setPoked] = useState(false)
  useEffect(() => {
    if (!poked) return undefined
    const node = ref.current
    const reset = (event) => { if (event.animationName.startsWith('bt-poke')) setPoked(false) }
    node?.addEventListener('animationcancel', reset)
    return () => node?.removeEventListener('animationcancel', reset)
  }, [poked])
  // A photo that does not load shows the character instead; a new photo is tried again.
  const [broken, setBroken] = useState('')
  const image = look.image && look.image !== broken ? look.image : undefined
  useGaze(ref, gaze)
  const common = {
    ref,
    className: poked ? 'bt-mark bt-mark-poke' : 'bt-mark',
    'data-shape': image ? 'image' : shapeId(look.shape),
    'data-state': STATES.includes(state) ? state : 'idle',
    'data-live': live ? '' : undefined,
    'data-fidget': live ? FIDGETS[fnv1a(`${bot?.id ?? ''}:fidget`) % FIDGETS.length] : undefined,
    'data-gaze': gaze ? '' : undefined,
    'data-poke': pokeable ? '' : undefined,
    style: { width: size, height: size, ...(live ? { '--bt-delay': `${-(fnv1a(String(bot?.id ?? '')) % 5000) / 1000}s`, '--bt-fidget-delay': `${-(fnv1a(`${bot?.id ?? ''}:when`) % 9000) / 1000}s` } : {}) },
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    onClick: pokeable ? () => { if (mascotInteraction()) setPoked(true) } : undefined,
    onAnimationEnd: poked ? (event) => { if (event.animationName.startsWith('bt-poke')) setPoked(false) } : undefined,
  }
  if (image) return h('span', common, h('img', { className: 'bt-mark-img', src: image, alt: '', draggable: false, onError: () => setBroken(image) }))
  const box = shapeOf(look.shape).size
  return h('span', common, h('svg', { viewBox: `0 0 ${box} ${box}`, dangerouslySetInnerHTML: { __html: characterMarkup(look.shape, look.color).replaceAll(MASK_ID, maskId.current) } }))
}
