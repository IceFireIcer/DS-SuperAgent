// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/voice.js.
import { createElement as h, useEffect, useRef } from 'react'
import { CloseIcon, MicIcon } from './icons.js'
import { BotMark } from './mark.js'
import { plainSpeech } from './product-speech.js'
import { SPRING_POP } from './motion.js'
import { createSource } from './sources.js'
import { openCapture, speechCatalog, transcribeWave, turnDetector } from './speech.js'
import { t } from './i18n.js'

const closed = { phase: 'off', caption: '', note: '', level: 0 }
const captureNotes = { blocked: 'Microphone access is blocked', unavailable: 'Voice chat is not available in this browser',
  'too-long': 'The recording is too long.' }
const endedInputs = { failed: 'Main could not finish this reply. Your message is saved.',
  interrupted: 'The reply was interrupted.', stopped: 'The reply was stopped.' }

export function createMainVoice({ speechRemote, readMain }) {
  const state = createSource(closed)
  let send
  let turn

  const set = patch => state.set(current => ({ ...current, ...patch }))
  const live = current => turn === current && !document.hidden
  const release = current => {
    const dispose = current.dispose
    current.dispose = undefined
    dispose?.()
  }
  const discard = () => {
    const previous = turn
    turn = undefined
    if (!previous) return
    previous.controller.abort()
    release(previous)
  }
  const close = () => {
    discard()
    send = undefined
    state.set(closed)
  }
  const pause = (note = '') => {
    if (state.getSnapshot().phase === 'off') return
    discard()
    set({ phase: 'paused', note, level: 0 })
  }

  function sync() {
    if (state.getSnapshot().phase === 'off') return
    const { messages, question, active } = readMain()
    if (!active) { close(); return }
    if (document.hidden || question) {
      if (state.getSnapshot().phase !== 'paused') pause()
      return
    }
    const current = turn
    if (!current?.messageId || state.getSnapshot().phase !== 'thinking') return
    const reply = messages.find(message => message.role === 'main' && message.status === 'completed'
      && message.id === `reply:${current.messageId}`)
    if (!reply) {
      const input = messages.find(message => message.role === 'user' && message.id === current.messageId)
      if (Object.hasOwn(endedInputs, input?.status)) pause(t(endedInputs[input.status]))
      return
    }
    const caption = plainSpeech(reply.text)
    if (!caption) { listen(); return }
    const synthesis = window.speechSynthesis
    if (!synthesis || !window.SpeechSynthesisUtterance) { pause(t('Reading aloud is unavailable.')); return }
    set({ phase: 'speaking', caption })
    try {
      const utterance = new window.SpeechSynthesisUtterance(caption)
      utterance.lang = /[\u3400-\u9fff]/u.test(caption) ? 'zh-CN' : 'en-US'
      utterance.onend = () => {
        if (!live(current)) return
        current.dispose = undefined
        listen()
      }
      utterance.onerror = () => { if (live(current)) pause(t('Could not read the reply aloud.')) }
      synthesis.cancel()
      current.dispose = () => synthesis.cancel()
      synthesis.speak(utterance)
    } catch { pause(t('Could not read the reply aloud.')) }
  }

  async function submit(current, words) {
    const text = words.trim()
    if (!text || !live(current) || current.submitted) return
    current.submitted = true
    set({ phase: 'thinking', caption: text, level: 0 })
    release(current)
    if (readMain().busy) { pause(t('Main is replying…')); return }
    try {
      const receipt = await send(text)
      if (!live(current)) return
      if (!receipt?.messageId) { pause(t('Could not submit voice input.')); return }
      if (Object.hasOwn(endedInputs, receipt.status)) { pause(t(endedInputs[receipt.status])); return }
      current.messageId = receipt.messageId
      sync()
    } catch (error) { if (live(current)) pause(error?.message || t('Could not submit voice input.')) }
  }

  function recognize(current) {
    const Api = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Api) { pause(t(captureNotes.unavailable)); return }
    try {
      const recognition = new Api()
      current.dispose = () => { try { recognition.abort() } catch {} }
      recognition.lang = navigator.language || 'en-US'
      recognition.interimResults = true
      recognition.continuous = false
      recognition.onresult = event => {
        if (!live(current) || state.getSnapshot().phase !== 'listening') return
        const results = Array.from(event.results).slice(event.resultIndex)
        const words = results.filter(result => result.isFinal).map(result => result[0]?.transcript ?? '').join(' ')
        if (words.trim()) { void submit(current, words); return }
        set({ caption: results.map(result => result[0]?.transcript ?? '').join(' ') })
      }
      recognition.onerror = ({ error }) => {
        if (!live(current) || state.getSnapshot().phase !== 'listening' || error === 'no-speech') return
        pause(t(error === 'not-allowed' || error === 'service-not-allowed' ? captureNotes.blocked : "Couldn't hear that"))
      }
      recognition.onend = () => {
        if (!live(current) || state.getSnapshot().phase !== 'listening') return
        const timer = setTimeout(listen, 250)
        current.dispose = () => clearTimeout(timer)
      }
      recognition.start()
    } catch { pause(t("Couldn't start dictation")) }
  }

  async function record(current, speech) {
    try {
      const { catalog, usable } = await speechCatalog(speech)
      if (!live(current)) return
      if (!usable) { pause(t('The speech provider is not ready.')); return }
      const capture = await openCapture(current.controller.signal)
      if (!live(current)) { capture.cancel(); return }
      let frame
      current.dispose = () => { cancelAnimationFrame(frame); capture.cancel() }
      const began = performance.now()
      const limit = Math.max(1, catalog.maxDurationSeconds - 1) * 1000
      const detect = turnDetector()
      const finish = async () => {
        set({ phase: 'thinking', level: 0 })
        try {
          const wave = await capture.finish(catalog.maxDurationSeconds)
          if (!live(current)) return
          const words = wave ? await transcribeWave(speech, catalog, wave, current.controller.signal) : ''
          if (!live(current)) return
          if (!words) { listen(); return }
          await submit(current, words)
        } catch (error) {
          if (live(current)) pause(t(captureNotes[error?.kind] ?? "Couldn't hear that"))
        }
      }
      const tick = now => {
        if (!live(current)) return
        const level = capture.level()
        const detected = detect(level, now)
        if (detected === 'done' || (detected === 'speech' && now - began >= limit)) { void finish(); return }
        if (detected === 'waiting' && now - began >= limit) { listen(); return }
        const rounded = Math.round(level * 100) / 100
        if (rounded !== state.getSnapshot().level) set({ level: rounded })
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    } catch (error) {
      if (live(current)) pause(t(captureNotes[error?.kind] ?? "Couldn't start dictation"))
    }
  }

  function listen() {
    const { question, active, busy } = readMain()
    if (!send || !active || question || document.hidden) return
    if (busy) { pause(t('Main is replying…')); return }
    discard()
    const current = { controller: new AbortController() }
    turn = current
    set({ phase: 'listening', caption: '', note: '', level: 0 })
    const speech = speechRemote()
    if (speech) void record(current, speech)
    else recognize(current)
  }

  return { subscribe: state.subscribe, getSnapshot: state.getSnapshot,
    start(submitInput) { send = submitInput; listen() }, pause, close, sync }
}

const labels = { listening: 'Listening', thinking: 'Waiting for Main…', speaking: 'Speaking', paused: 'Paused' }

export function VoiceMode({ state, error, onPause, onResume, onClose, busy, onStop, stopping }) {
  const toggle = useRef(null)
  useEffect(() => { toggle.current?.focus() }, [])
  const paused = state.phase === 'paused'
  return h('section', { className: 'bt-main-composer bt-main-voice', 'aria-label': t('Voice chat with {name}', { name: 'Main' }),
    onKeyDown: event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose() }
    } },
  h('div', { className: 'bt-voice-stage', 'data-phase': state.phase },
    h('div', { className: 'bt-voice-orb', style: { '--bt-level': state.level }, 'aria-hidden': true },
      h('span', { className: 'bt-voice-ring' }), h('span', { className: 'bt-voice-ring bt-voice-ring-2' }),
      h(BotMark, { size: 48, state: state.phase === 'thinking' ? 'thinking' : state.phase === 'speaking' ? 'sending' : 'idle' })),
    h('div', { className: 'bt-voice-status', role: 'status' }, t(labels[state.phase])),
    state.caption ? h('div', { className: 'bt-voice-caption' }, state.caption) : null,
    error || state.note ? h('div', { className: 'bt-voice-note', role: 'alert' }, error ?? state.note) : null),
  h('div', { className: 'bt-voice-bar' },
    h('button', { ref: toggle, type: 'button', className: 'bt-voice-btn', 'aria-pressed': paused, disabled: paused && busy,
      'aria-label': t(paused ? 'Resume voice chat' : 'Pause voice chat'), onClick: paused ? onResume : onPause },
    h(MicIcon, { size: 20 }), paused ? h('span', { className: 'bt-voice-slash', 'aria-hidden': true }) : null),
    h('button', { type: 'button', className: 'bt-voice-btn bt-voice-end', 'aria-label': t('End voice chat'), onClick: onClose }, h(CloseIcon)),
    onStop ? h('button', { className: 'bt-soft', type: 'button', 'data-action': 'stop-main', disabled: stopping, onClick: onStop },
      t(stopping ? 'Stopping…' : 'Stop reply')) : null))
}

export const MAIN_VOICE_CSS = `
.bt-main-voice .bt-voice-stage{min-width:0;padding:8px;margin-inline:auto;overflow-wrap:anywhere}
.bt-main-voice .bt-voice-orb{width:72px;height:64px;margin:0}
.bt-main-voice .bt-voice-ring{inset:2px}.bt-main-voice .bt-voice-ring-2{inset:-4px}
.bt-main-voice .bt-voice-caption{min-height:0;font-size:var(--bt-font-body)}
.bt-main-voice .bt-voice-bar{justify-content:center;align-items:center;flex-wrap:wrap;gap:8px;padding:4px 0}
.bt-main-voice .bt-voice-btn{width:36px;height:36px}
.bt-main-voice-toggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;animation:bt-icon-swap ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
:is(.bt-main-voice button,.bt-main-voice-toggle):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
body[data-bt-motion=quiet] :is(.bt-main-voice .bt-voice-ring,.bt-main-voice .bt-voice-caption,.bt-main-voice .bt-voice-btn,.bt-main-voice-toggle){animation:none;transition:none}
@media(prefers-reduced-motion:reduce){:is(.bt-main-voice .bt-voice-ring,.bt-main-voice .bt-voice-btn,.bt-main-voice-toggle){animation:none;transition:none}.bt-main-voice .bt-voice-ring{transform:none}}
`
