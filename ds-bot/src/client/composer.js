import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, MicIcon, PaperclipIcon, PeopleIcon, PlusIcon, WaveIcon } from './icons.js'
import { BotMark } from './mark.js'
import { useLinger, useViewport, viewBottom } from './motion.js'
import { openCapture, speechCatalog, transcribeWave } from './speech.js'
import { t } from './i18n.js'

export function MainComposer({ onSend, onStop, busy, stopping, readOnly = false, error, value, onValueChange, directoryControl,
  attachments = [], onFiles, onRemoveAttachment, uploading = false, speechRemote }) {
  const [draft, setDraft] = useState('')
  const [voiceState, setVoiceState] = useState('idle')
  const [voiceError, setVoiceError] = useState(null)
  const fileInput = useRef(null)
  const capture = useRef(null)
  const voiceGeneration = useRef(0)
  const text = value ?? draft
  const setText = next => onValueChange ? onValueChange(next) : setDraft(next)
  const latestText = useRef(text)
  latestText.current = text
  const insertTranscript = words => {
    const current = latestText.current
    const next = `${current}${current && !/\s$/u.test(current) ? ' ' : ''}${words}`
    latestText.current = next
    setText(next)
  }
  const dictation = useDictation((words, final) => { if (final) insertTranscript(words.trim()) })
  useEffect(() => () => {
    voiceGeneration.current += 1
    if (capture.current?.timer) clearTimeout(capture.current.timer)
    capture.current?.controller.abort()
    capture.current?.handle.cancel()
  }, [])
  const finishCapture = async () => {
    const active = capture.current
    if (!active) return
    capture.current = null
    clearTimeout(active.timer)
    setVoiceState('transcribing')
    try {
      const wave = await active.handle.finish(active.catalog.maxDurationSeconds)
      const words = wave ? await transcribeWave(active.speech, active.catalog, wave, active.controller.signal) : ''
      if (voiceGeneration.current === active.generation && words.trim()) insertTranscript(words.trim())
    } catch (reason) {
      if (voiceGeneration.current === active.generation) setVoiceError(t(reason?.kind === 'too-long'
        ? 'The recording is too long.' : "Couldn't hear that"))
    } finally { if (voiceGeneration.current === active.generation) setVoiceState('idle') }
  }
  const toggleVoice = async () => {
    if (voiceState === 'preparing' || voiceState === 'transcribing') return
    if (capture.current) { await finishCapture(); return }
    const speech = speechRemote?.()
    if (!speech) {
      if (dictation.listening) dictation.stop()
      else dictation.start()
      return
    }
    setVoiceError(null)
    setVoiceState('preparing')
    const generation = ++voiceGeneration.current
    try {
      const { catalog, usable } = await speechCatalog(speech)
      if (voiceGeneration.current !== generation) return
      if (!usable) { setVoiceError(t('The speech provider is not ready.')); setVoiceState('idle'); return }
      const handle = await openCapture()
      if (voiceGeneration.current !== generation) { handle.cancel(); return }
      const timer = setTimeout(() => { void finishCapture() }, catalog.maxDurationSeconds * 1000)
      capture.current = { handle, catalog, speech, generation, controller: new AbortController(), timer }
      setVoiceState('recording')
    } catch (reason) {
      if (voiceGeneration.current === generation) {
        setVoiceError(t(reason?.kind === 'blocked' ? 'Microphone access is blocked' : "Couldn't start dictation"))
        setVoiceState('idle')
      }
    }
  }
  const hasContent = Boolean(text.trim() || attachments.length)
  const submit = async event => {
    event.preventDefault()
    if (busy || uploading || voiceState !== 'idle' || dictation.listening || readOnly || !hasContent) return
    if (await onSend(text)) setText('')
  }
  return h('form', { className: 'bt-main-composer', onSubmit: submit },
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    voiceError || dictation.note ? h('p', { className: 'bt-main-error', role: 'status' }, voiceError ?? dictation.note) : null,
    h('label', { className: 'bt-main-label', htmlFor: 'main-message' }, t('Message Main')),
    h('textarea', {
      id: 'main-message', value: text, rows: 2, maxLength: 32768, placeholder: readOnly ? t('Read-only connection') : t('Message Main'), disabled: readOnly,
      onChange: event => setText(event.target.value),
      onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event) } },
    }),
    directoryControl,
    attachments.length ? h('div', { className: 'bt-main-attachments', 'aria-label': t('Attached files') },
      attachments.map(attachment => h('span', { className: 'bt-main-attachment', key: attachment.id },
        `${attachment.name} · ${attachment.bytes} ${t('bytes')}`,
        onRemoveAttachment ? h('button', { type: 'button', disabled: busy || uploading,
          'aria-label': t('Remove {name}', { name: attachment.name }), onClick: () => onRemoveAttachment(attachment) }, '×') : null))) : null,
    h('div', { className: 'bt-main-send' },
      !readOnly ? h('button', { type: 'button', className: 'bt-soft', disabled: busy || uploading || voiceState === 'preparing' || voiceState === 'transcribing',
        'aria-pressed': voiceState === 'recording' || dictation.listening,
        'aria-label': t(voiceState === 'recording' || dictation.listening ? 'Stop dictation' : 'Start dictation'),
        title: t(voiceState === 'recording' ? 'Stop dictation' : 'Start dictation'), onClick: () => void toggleVoice() }, h(MicIcon)) : null,
      onFiles && !readOnly ? h('span', null,
        h('input', { type: 'file', ref: fileInput, multiple: true, hidden: true,
          onChange: event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) onFiles(files) } }),
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || uploading,
          'aria-label': t('Add files'), title: t('Add files'), onClick: () => fileInput.current?.click() }, h(PaperclipIcon))) : null,
      busy && onStop && !readOnly ? h('button', { className: 'bt-soft', type: 'button', disabled: stopping, onClick: onStop },
        stopping ? t('Stopping…') : t('Stop reply')) : null,
      h('button', { className: 'bt-soft', type: 'submit', disabled: busy || uploading || voiceState !== 'idle' || dictation.listening || readOnly || !hasContent },
        readOnly ? t('Read-only') : uploading ? t('Uploading…') : busy ? t('Sending…') : t('Send'))))
}

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  // A new recognition makes the previous one's late results stale: after Pause,
  // or after a restart, the browser may still deliver its last final result.
  const generation = useRef(0)
  const latest = useRef(onText)
  latest.current = onText
  useEffect(() => () => { generation.current += 1; recognition.current?.abort() }, [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = ({ continuous = true, onEnd } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    const own = ++generation.current
    engine.lang = navigator.language || 'zh-CN'
    engine.interimResults = true
    engine.continuous = continuous
    engine.onresult = (event) => {
      if (generation.current !== own) return
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (generation.current !== own) return
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
    }
    engine.onend = () => {
      if (generation.current === own) { setListening(false); recognition.current = null }
      onEnd?.()
    }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  // Drops anything the engine still owes us: Pause and Close use it, while a
  // natural stop keeps the final result the user just spoke.
  const discard = () => {
    generation.current += 1
    const engine = recognition.current
    recognition.current = null
    setListening(false)
    try { engine?.abort() } catch {}
  }
  return { listening, note, start, stop, discard }
}

export function ComposerVoice({ sessionId, inputActions, actions, useUi }) {
  const dictation = useDictation((text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  // Reply from a message's hover toolbar quotes it into this composer.
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  useEffect(() => {
    if (!quote || !inputActions) return
    actions.clearQuote(quote.token)
    const excerpt = quote.text.replace(/\s+/g, ' ').trim()
    const line = `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
    inputActions.insertText(line, inputActions.captureInsertion())
    const box = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true]')
    if (box instanceof HTMLElement) {
      box.focus()
      const selection = window.getSelection()
      selection?.selectAllChildren(box)
      selection?.collapseToEnd()
    }
  }, [quote?.token])
  if (sessionId === undefined) return null
  // With the Voice Input plugin on, its own microphone sits in this composer.
  const pluginMic = actions.speech() !== undefined
  return h(Fragment, null,
    pluginMic ? null : h('button', {
      type: 'button', className: 'bt-mic', 'aria-label': dictation.listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': dictation.listening, title: dictation.listening ? t('Stop dictation') : t('Dictate'),
      onMouseDown: keepComposerFocus, onClick: () => (dictation.listening ? dictation.stop() : dictation.start()),
    }, h(MicIcon)),
    h('button', {
      type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      onMouseDown: keepComposerFocus, onClick: () => actions.openVoice(sessionId),
    }, h(WaveIcon, { size: 18 })),
    dictation.note ? h('span', { className: 'bt-mic-note', role: 'status' }, dictation.note) : null)
}

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu
// does not remount its mark on every keystroke.
export function menuIcons(roster) {
  const marks = new Map()
  return (row) => {
    if (!row.bot) return PeopleIcon
    const id = row.bot.id
    if (!marks.has(id)) marks.set(id, ({ size = 14 }) => h(BotMark, { bot: roster.getSnapshot().byId[id] ?? row.bot, size }))
    return marks.get(id)
  }
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another
// chat, or set a scheduled task for this chat. It stands in for the shell's command
// menu, whose plan, permission, model and compact rows reach past what DS Bot keeps
// for its Bots; "/" still opens that menu. Files go through the shell's own file
// input beside it.
export function ComposerPlus({ sessionId, inputActions, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(null) }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(null) } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // Hooks stay above the early return below: the roster may not know the Bot yet, and a
  // render that skips a hook breaks the composer's slot when the roster arrives.
  // Anchored to the "+" each render: the visible viewport can move (on-screen
  // keyboard) while the menu is open.
  const place = useMemo(() => {
    if (!shown || !button.current) return null
    const rect = button.current.getBoundingClientRect()
    return { left: rect.left, bottom: viewBottom() - rect.top + 8 }
  }, [shown, open, tick])
  const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id
  if (sessionId === undefined || target === undefined) return null
  const fileInput = () => button.current?.closest('[data-composer-card]')?.querySelector('input[type=file]')
  const toggle = () => {
    if (open) { setOpen(null); return }
    // Files go through the composer's own file input; a composer without one takes none.
    setOpen({ files: Boolean(fileInput()) })
  }
  const attach = () => {
    setOpen(null)
    fileInput()?.click()
  }
  const schedule = () => {
    setOpen(null)
    actions.openSettings('schedules', target)
  }
  // The chats open in the shell's "@" menu at the caret, so the pick lands where the
  // user was typing.
  const reference = () => {
    setOpen(null)
    actions.referenceChat(sessionId, inputActions?.captureInsertion?.())
  }
  const canReference = typeof inputActions?.captureInsertion === 'function' && actions.canReferenceChat()
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(open), onMouseDown: keepComposerFocus, onClick: toggle,
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-menu-up bt-plus-menu', role: 'menu', 'aria-label': t('Add'),
      style: place ?? {}, 'data-leaving': leaving || undefined,
    },
    shown.files ? h('button', { type: 'button', role: 'menuitem', onClick: attach }, h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))) : null,
    canReference ? h('button', { type: 'button', role: 'menuitem', onMouseDown: keepComposerFocus, onClick: reference }, h(ChatsIcon), h('span', { className: 'bt-menu-label' }, t('Reference a chat'))) : null,
    h('button', { type: 'button', role: 'menuitem', onClick: schedule }, h(ClockIcon), h('span', { className: 'bt-menu-label' }, t('Scheduled task')))), document.body) : null)
}
