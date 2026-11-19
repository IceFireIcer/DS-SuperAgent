// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/{cells,text,turn-error}.js.
import { createElement as h, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { dateLocale, t } from './i18n.js'

const SEPARATOR_GAP_MS = 30 * 60 * 1000
const noEvents = () => undefined
const noSubscription = () => () => {}

const hostFailureLabels = new Map([
  ['ACCOUNT_SIGNED_OUT', 'message.failure.accountSignedOut'],
  ['ACCOUNT_SIGN_IN_REQUIRED', 'message.failure.accountSignInRequired'],
  ['AUTH', 'message.failure.auth'],
  ['INTERRUPTED', 'message.failure.interrupted'],
  ['QUOTA', 'message.failure.quota'],
  ['ACCOUNT_QUOTA', 'message.failure.quota'],
])
const failureLabels = new Map([
  ['MISSING_CREDENTIAL', 'The selected model needs an API key.'],
  ['INVALID_CREDENTIAL', 'This API key is not in the right format.'],
  ['ACCOUNT_TOKEN_INVALID', 'The DeepSeek account sign-in has expired.'],
  ['CONTENT_POLICY', 'The model service blocked this request with its content filter.'],
  ['TRANSPORT', 'Could not reach the model service.'],
  ['TIMEOUT', 'Could not reach the model service.'],
  ['RATE_LIMIT', 'Too many requests. Wait a moment, then try again.'],
  ['SERVER', 'The model service failed.'],
])
const credentialCodes = new Set(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_TOKEN_INVALID'])

function MainReasoningBody({ text, running, renderFactorySlot }) {
  const body = useRef(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    if (running && atEnd.current && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [running, text])
  return h('div', {
    ref: body,
    className: 'bt-think-text',
    role: 'region',
    'aria-label': t('Thinking'),
    tabIndex: 0,
    onScroll(event) {
      const element = event.currentTarget
      atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 2
    },
  }, renderFactorySlot('conversation.chat.reasoning.content', { text, running }))
}

function MainFailureCell({ node, t: chatText }) {
  const { code, message } = node.data
  const stopped = code === 'ACCOUNT_SIGNED_OUT' || code === 'INTERRUPTED'
  const hostLabel = hostFailureLabels.get(code)
  const label = failureLabels.get(code)
  const summary = hostLabel ? chatText(hostLabel) : label ? t(label) : message
  const detail = !hostLabel && !credentialCodes.has(code) && message !== summary ? message : null

  return h('div', { className: 'bt-main-system-fact', role: 'status' },
    h('span', null, chatText(stopped ? 'message.taskStopped' : 'message.turnError')),
    summary ? h('p', { className: 'bt-main-error' }, summary) : null,
    code && code !== 'INTERRUPTED' ? h('code', null, code) : null,
    detail ? h('details', null, h('summary', null, t('Technical details')), h('p', null, detail)) : null)
}

function clockLabel(time) {
  const date = new Date(time)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const locale = dateLocale()
  const stamp = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === today.toDateString()) return t('Today {time}', { time: stamp })
  if (date.toDateString() === yesterday.toDateString()) return t('Yesterday {time}', { time: stamp })
  const year = date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  return `${date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year })} ${stamp}`
}

function MainTurnSeparator({ turn, eventSource }) {
  const events = useSyncExternalStore(eventSource ? listener => eventSource.subscribe(listener) : noSubscription,
    eventSource ? () => eventSource.getSnapshot() : noEvents, noEvents)
  const end = turn.end
  if (!Number.isFinite(end?.time)) return null
  const nextStart = events?.entries.find(({ event }) => event.type === 'turn/start' && event.seq > end.seq)?.event.time
  if (!Number.isFinite(nextStart) || nextStart - end.time < SEPARATOR_GAP_MS) return null
  const label = clockLabel(nextStart)
  return h('div', { className: 'bt-time-sep', role: 'separator', 'aria-label': label }, label)
}

export function installMainCells(ctx) {
  const register = (options, component) => ctx.slots.inject(options.name, () => ctx.slots.register(options, component))
  const disposers = [
    register({ name: 'conversation.chat.reasoning.body', priority: -100 }, MainReasoningBody),
    register({ name: 'conversation.chat.node', key: 'turn-error', locale: 'chat', priority: -100 }, MainFailureCell),
    register({ name: 'conversation.chat.turnTail', id: 'superagent-turn-separator', order: 1000,
      inject: sessionId => ({ eventSource: ctx.sessions.binding(sessionId)?.eventSource }) }, MainTurnSeparator),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
