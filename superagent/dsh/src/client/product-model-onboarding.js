import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { MAIN_LOOK } from './characters.js'
import { t } from './i18n.js'
import { BotMark as MainMark } from './mark.js'
import { SPRING_POP } from './motion.js'

export const DEEPSEEK_SIGN_IN_SLOT = 'settings.models.sign-in'

const hasModelCredential = provider => provider.id !== 'deepseek-official' || provider.key?.configured !== false

export function mainModelSetup({ roles, providers }) {
  const model = roles.main?.model
  const selected = providers.find(provider => provider.id === model?.provider)
  if (selected?.models.some(candidate => candidate.model === model.model) && hasModelCredential(selected)) return null
  const official = providers.find(provider => provider.id === 'deepseek-official')
  return {
    keyProvider: official?.key?.writable && !official.key.configured ? official.id : null,
    canChooseModel: providers.some(provider => provider.models.length > 0 && hasModelCredential(provider)),
  }
}

export function SuperagentModelChoice({ setup, signIn, saveKey, refreshModels, focusMain, openModels, openCustomModels, openRoles }) {
  const [expanded, setExpanded] = useState(false)
  const [editingKey, setEditingKey] = useState(false)
  const [visibleKey, setVisibleKey] = useState(false)
  const [progress, setProgress] = useState('idle')
  const [key, setKey] = useState('')
  const [error, setError] = useState(null)
  const keyTrigger = useRef(null)
  const keyInput = useRef(null)
  const retryButton = useRef(null)
  const restoreKeyTrigger = useRef(false)
  const editedProvider = useRef(null)
  const pending = useRef(false)
  const methodsId = useId()
  const busy = progress === 'saving' || progress === 'refreshing'
  useEffect(() => {
    if (!editingKey && restoreKeyTrigger.current) {
      restoreKeyTrigger.current = false
      keyTrigger.current?.focus()
    }
  }, [editingKey])
  useEffect(() => {
    if (!editingKey || setup.keyProvider === editedProvider.current) return
    setKey('')
    setVisibleKey(false)
    setError(null)
    setEditingKey(false)
  }, [editingKey, setup.keyProvider])
  const cancelKey = () => {
    setKey('')
    setVisibleKey(false)
    setError(null)
    restoreKeyTrigger.current = true
    setEditingKey(false)
  }
  const refresh = async () => {
    setProgress('refreshing')
    try { setProgress(await refreshModels() ? 'saved' : 'retry') }
    finally { pending.current = false }
  }
  const retry = () => {
    if (pending.current) return
    pending.current = true
    if (retryButton.current?.matches(':focus')) focusMain()
    void refresh()
  }
  const submit = async event => {
    event.preventDefault()
    if (pending.current || !key.trim()) return
    const form = event.currentTarget
    pending.current = true
    keyInput.current?.focus()
    setKey('')
    setVisibleKey(false)
    setProgress('saving')
    setError(null)
    try {
      await saveKey(setup.keyProvider, key)
    } catch {
      pending.current = false
      setProgress('idle')
      setError(t('Could not save the API key. Enter it again to retry.'))
      return
    }
    if (form.contains(form.ownerDocument.activeElement)) focusMain()
    setEditingKey(false)
    setExpanded(false)
    await refresh()
  }
  const choice = (label, action, ref) => h('button', { className: 'bt-model-chip', type: 'button', disabled: busy, onClick: action, ref }, t(label))
  const toggleMethods = primary => h('button', { className: primary ? 'bt-model-chip bt-model-primary' : 'bt-model-chip', type: 'button',
    'aria-expanded': expanded, 'aria-controls': methodsId, onClick: () => setExpanded(!expanded) },
  t(primary ? 'Set up a model' : 'Set up another model'))
  const showActions = !editingKey && progress !== 'retry' && progress !== 'refreshing'
  return h('div', { className: 'bt-superagent-model-dock' },
    h('div', { className: 'bt-astack', 'data-lead': '' }, h('div', { className: 'bt-msg' },
      h('div', { className: 'bt-msg-line' }, h(MainMark, { look: MAIN_LOOK, size: 22 }),
        h('div', { className: 'bt-bubble' }, t('I need a model before I can reply.'))))),
    showActions ? h('div', { className: 'bt-model-chips' },
      setup.canChooseModel ? h('button', { className: 'bt-model-chip bt-model-primary', type: 'button', onClick: openRoles }, t('Choose a model')) : null,
      toggleMethods(!setup.canChooseModel)) : null,
    h('div', { id: methodsId, className: 'bt-model-chips', role: 'group', 'aria-label': t('Model setup methods'), hidden: !showActions || !expanded },
      signIn ? choice('Sign in to DeepSeek', signIn) : null,
      setup.keyProvider ? choice('Enter a DeepSeek API key', () => {
        editedProvider.current = setup.keyProvider
        setProgress('idle')
        setEditingKey(true)
      }, keyTrigger) : null,
      choice(openCustomModels ? 'Open settings to set up a custom model' : 'Open Models settings', openCustomModels ?? openModels)),
    editingKey && setup.keyProvider ? h('form', { className: 'bt-q bt-main-model-key', onSubmit: event => { void submit(event) },
      onKeyDown: event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        if (!busy) cancelKey()
      } },
      h('label', { className: 'bt-q-field' }, t('{provider} API key', { provider: 'DeepSeek' }),
        h('input', { ref: keyInput, type: visibleKey ? 'text' : 'password', autoComplete: 'new-password', autoFocus: true, value: key, readOnly: busy,
          maxLength: 16384, onChange: event => setKey(event.target.value) })),
      error ? h('p', { role: 'alert', className: 'bt-main-error' }, error) : null,
      h('div', { className: 'bt-q-foot' },
        h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => setVisibleKey(!visibleKey) },
          t(visibleKey ? 'Hide API key' : 'Show API key')),
        h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: cancelKey }, t('Cancel')),
        h('button', { type: 'submit', className: 'bt-q-submit', disabled: busy || !key.trim() }, t(busy ? 'Saving…' : 'Save key')))) : null,
    progress === 'refreshing' ? h('p', { role: 'status', className: 'bt-main-status' }, t('Provider key saved. Checking model setup…')) : null,
    progress === 'saved' ? h('p', { role: 'status', className: 'bt-main-status' }, t('Provider key saved.')) : null,
    progress === 'retry' ? h('div', { className: 'bt-model-chips' },
      h('p', { role: 'status', className: 'bt-main-status' }, t('Provider key saved. Could not refresh model settings.')),
      choice('Retry', retry, retryButton)) : null)
}

export const MODEL_ONBOARDING_CSS = `
.bt-superagent-model-dock{width:min(100% - 32px,var(--dsh-chat-content-width,748px));margin:0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding-block:8px;animation:bt-model-appear ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
.bt-superagent-model-dock .bt-model-chips{display:flex;flex-wrap:wrap;gap:6px;margin-inline-start:30px;max-width:calc(100% - 30px)}
.bt-superagent-model-dock .bt-model-chips[hidden]{display:none}
.bt-superagent-model-dock .bt-model-chip{min-height:30px;padding:5px 12px;border:.5px solid var(--bt-line-2);border-radius:var(--bt-radius-pill);background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:var(--bt-font-body);text-align:start;cursor:pointer}
.bt-superagent-model-dock .bt-model-chip:hover:not(:disabled,.bt-model-primary){background:var(--bt-hover)}
.bt-superagent-model-dock .bt-model-primary,.bt-superagent-model-dock .bt-model-primary:hover{background:var(--bt-accent);color:var(--bt-accent-ink);border-color:transparent}
.bt-superagent-model-dock :is(button,input):focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-main-model-key{margin-inline-start:30px;max-width:calc(100% - 30px);box-sizing:border-box}
.bt-main-model-key input{display:block;margin-top:6px;width:100%;min-height:36px;padding-inline:8px;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:var(--bt-radius-input);background:var(--bt-main);color:var(--bt-ink);font:inherit}
@keyframes bt-model-appear{from{opacity:0;translate:0 4px}}
body[data-bt-motion=quiet] :is(.bt-superagent-model-dock,.bt-main-model-key){animation:none}
@media(prefers-reduced-motion:reduce){:is(.bt-superagent-model-dock,.bt-main-model-key){animation:none}}
`
