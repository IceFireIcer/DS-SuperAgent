// Adapted from DS Bot v0.3.8 (Apache-2.0), ds-bot/src/client/{notifications,notify,feedback}.js.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'

export const NOTIFY_KEY = 'ds-superagent:notify'
const TOAST_MS = 5200
const bridge = () => window.dsSuperagentApp

function notificationsEnabled() {
  try { return JSON.parse(window.localStorage.getItem(NOTIFY_KEY))?.enabled !== false } catch { return true }
}

export function shellNoticeKind({ before, after, viewing, focused, enabled }) {
  if (!before || !after || !enabled || (viewing && focused)) return undefined
  if (after.pending && after.pending !== before.pending) return 'question'
  if (after.unread && after.unread !== before.unread) return 'reply'
  return undefined
}

export function ShellNotificationWatcher({ useShell, onOpenMain, showNotice }) {
  const { notificationScope, unread, pending, activity } = useShell()
  const previous = useRef(null)
  useEffect(() => {
    const dispose = bridge()?.onOpenSession?.(id => { if (id === 'main') onOpenMain() })
    return typeof dispose === 'function' ? dispose : undefined
  }, [onOpenMain])
  useEffect(() => {
    const current = notificationScope ? { notificationScope, unread, pending } : null
    const before = previous.current
    previous.current = current
    const kind = shellNoticeKind({ before: current?.notificationScope === before?.notificationScope ? before : null,
      after: current, viewing: !activity, focused: document.hasFocus() && document.visibilityState !== 'hidden',
      enabled: notificationsEnabled() })
    const shell = bridge()
    if (kind) {
      const body = t(kind === 'question' ? 'Waiting for your answer' : 'A new reply is waiting')
      if (shell?.notify) {
        void Promise.resolve().then(() => shell.notify({ sessionId: 'main', title: 'DS SuperAgent', body })).catch(() => showNotice(body))
      } else {
        showNotice(body)
      }
    }
    shell?.setBadge?.(current && (unread || pending) ? 1 : 0)
  }, [notificationScope, unread, pending, activity, showNotice])
  useEffect(() => () => bridge()?.setBadge?.(0), [])
  return null
}

export function ShellToast({ toast, onDismiss, onOpenMain }) {
  const [leaving, setLeaving] = useState(false)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    setLeaving(false)
    const fade = setTimeout(() => setLeaving(true), TOAST_MS)
    const gone = setTimeout(() => dismiss.current(), TOAST_MS + 200)
    return () => { clearTimeout(fade); clearTimeout(gone) }
  }, [toast])
  const notice = toast.tone === 'notice'
  return h('div', { className: 'bt-toast', role: notice ? 'status' : 'alert', 'data-tone': toast.tone, 'data-leaving': leaving || undefined },
    h('span', { className: 'bt-toast-text' }, toast.text),
    notice ? h('button', { type: 'button', className: 'bt-toast-link', onClick: () => {
      onDismiss()
      onOpenMain()
    } }, t('Open Main')) : null,
    h('button', { type: 'button', className: 'bt-icon-btn bt-toast-close', 'aria-label': t('Dismiss'), onClick: onDismiss }, h(CloseIcon)))
}
