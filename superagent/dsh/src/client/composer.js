import { createElement as h, useEffect, useRef, useState } from 'react'
import { MicIcon, PaperclipIcon, WaveIcon } from './icons.js'
import { openCapture, speechCatalog, transcribeWave } from './speech.js'
import { t } from './i18n.js'
import { VoiceMode } from './main-voice.js'

export function MainComposer({ onSend, onStop, busy, stopping, ready = true, readOnly = false, error, value, onValueChange, directoryControl,
  errorAction,
  directoryBusy = false, attachments = [], onFiles, onRemoveAttachment, uploading = false, speechRemote,
  voice, onVoiceStart, onVoicePause, onVoiceResume, onVoiceClose }) {
  const [draft, setDraft] = useState('')
  const [voiceState, setVoiceState] = useState('idle')
  const [voiceError, setVoiceError] = useState(null)
  const fileInput = useRef(null)
  const capture = useRef(null)
  const voiceGeneration = useRef(0)
  const voiceStart = useRef(null)
  const textInput = useRef(null)
  const restoreFocus = useRef(false)
  const voiceOpen = Boolean(voice && voice.phase !== 'off')
  useEffect(() => {
    if (!voiceOpen && restoreFocus.current) {
      restoreFocus.current = false
      ;(voiceStart.current ?? textInput.current)?.focus()
    }
  }, [voiceOpen])
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
  const showVoiceStart = onVoiceStart && !hasContent && !readOnly && !busy
  const submit = async event => {
    event.preventDefault()
    if (!ready || busy || directoryBusy || uploading || voiceState !== 'idle' || dictation.listening || readOnly || !hasContent) return
    if (await onSend(text) && !onValueChange) setDraft(current => current === text ? '' : current)
  }
  if (voiceOpen) return h(VoiceMode, { state: voice, error, onPause: onVoicePause, onResume: onVoiceResume,
    onClose: () => { restoreFocus.current = true; onVoiceClose() }, busy: busy || directoryBusy || uploading, onStop, stopping })

  return h('form', { className: 'bt-main-composer', 'data-main-input-ready': ready ? '' : undefined, onSubmit: submit },
    error ? h('div', { className: `bt-main-error${errorAction ? ' bt-main-error-action' : ''}`, role: 'alert' }, h('p', null, error), errorAction ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: errorAction }, t('Send again')) : null) : null,
    voiceError || dictation.note ? h('p', { className: 'bt-main-error', role: 'status' }, voiceError ?? dictation.note) : null,
    h('label', { className: 'bt-main-label', htmlFor: 'main-message' }, t('Message Main')),
    h('textarea', {
      id: 'main-message', ref: textInput, value: text, rows: 2, maxLength: 32768, placeholder: readOnly ? t('Read-only connection') : t('Message Main'), disabled: readOnly,
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
        h('button', { type: 'button', className: 'bt-soft', disabled: busy || directoryBusy || uploading,
          'aria-label': t('Add files'), title: t('Add files'), onClick: () => fileInput.current?.click() }, h(PaperclipIcon))) : null,
      busy && onStop && !readOnly ? h('button', { className: 'bt-soft', type: 'button', 'data-action': 'stop-main', disabled: stopping, onClick: onStop },
        stopping ? t('Stopping…') : t('Stop reply')) : null,
      showVoiceStart ? h('button', { className: 'bt-soft bt-main-voice-toggle', type: 'button', ref: voiceStart,
        disabled: !ready || directoryBusy || uploading || voiceState !== 'idle' || dictation.listening, 'aria-label': t('Start voice chat'),
        onClick: onVoiceStart }, h(WaveIcon), t('Voice chat'))
        : h('button', { className: 'bt-soft', type: 'submit', disabled: !ready || busy || directoryBusy || uploading || voiceState !== 'idle' || dictation.listening || readOnly || !hasContent },
          readOnly ? t('Read-only') : uploading ? t('Uploading…') : busy ? t('Sending…') : t('Send'))))
}

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition

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
