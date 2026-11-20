import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card, Row, SwitchRow } from './product-card.js'
import { InlineNotice } from './product-settings-components.js'
import { t } from './i18n.js'

export function ProductPhoneSettings({ binding, call }) {
  const [phone, setPhone] = useState(null)
  const [server, setServer] = useState('')
  const [command, setCommand] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [removing, setRemoving] = useState('')
  const [copied, setCopied] = useState(false)
  const running = useRef(false)
  const revision = useRef(0)
  const invoke = (endpoint, payload = {}) => call(endpoint, { instanceId: binding.instanceId, ...payload })
  useEffect(() => {
    let live = true
    let timer
    let first = true
    const poll = async () => {
      const request = revision.current
      try {
        if (running.current) return
        const value = await invoke('phone-status')
        if (live && request === revision.current) {
          setPhone(value); setStatusError('')
          if (first) { setServer(value.server); first = false }
        }
      } catch (failure) { if (live && request === revision.current) setStatusError(failure.message) }
      finally { if (live) timer = setTimeout(poll, 2500) }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [call, binding.instanceId])
  const run = async (endpoint, payload) => {
    if (running.current) return
    running.current = true
    revision.current++
    setBusy(true); setError(''); setCopied(false)
    try {
      const value = await invoke(endpoint, payload)
      setPhone(value); setStatusError(''); setRemoving('')
      if (endpoint === 'phone-set') setServer(value.server)
    } catch (failure) { setError(failure.message) }
    finally { running.current = false; setBusy(false) }
  }
  const button = (label, onClick, disabled) => h('button', { className: 'bt-soft bt-soft-sm', type: 'button', onClick, disabled: busy || disabled }, t(label))
  const online = phone?.status === 'online'
  const pair = phone?.pairing?.expiresAt > Date.now() ? phone.pairing : null
  const copy = async () => {
    if (!pair?.uri || pair.expiresAt <= Date.now()) return
    try { await navigator.clipboard.writeText(pair.uri); setCopied(true) }
    catch { setError(t('Could not copy the pairing link.')) }
  }
  return h('div', { className: 'bt-ps-content bt-phone' },
    error || statusError ? h(InlineNotice, { tone: 'danger' }, t(error || statusError)) : null,
    h(Card, { title: t('Connection') },
      h(SwitchRow, { label: t('Phone access'), on: phone?.on ?? false, disabled: busy || !phone || !phone.server,
        onChange: on => void run('phone-set', { on }) }),
      h(Row, { label: t('Relay server') }, h('input', { className: 'bt-bs-input', 'aria-label': t('Relay server'), value: server, placeholder: 'wss://',
        disabled: busy || !phone, spellCheck: false, onChange: event => setServer(event.target.value) }),
      button('Save', () => run('phone-set', { server: server.trim() }), !phone || server.trim() === phone.server)),
      h(Row, { label: t('Status') }, t(!phone ? statusError ? 'Unavailable' : 'Loading…' : online ? 'Connected'
        : !phone.on ? 'Off' : phone.status === 'connecting' ? 'Connecting…' : 'Relay not connected'))),
    h(Card, { title: t('Pair a phone') },
      h(Row, { label: t('Phone app') }, h('a', { href: 'https://github.com/IceFireIcer/DS-SuperAgent/tree/dev/mobile',
        target: '_blank', rel: 'noopener noreferrer' }, t('Mobile build instructions'))),
      pair ? h(Row, { label: t('Pairing QR code') }, h('div', null,
        h('img', { src: pair.qrImage, alt: t('Pairing QR code'), width: 192, height: 192 }),
        h('p', { className: 'bt-set-hint' }, t('The code works once. It stops working in {count} min.', { count: Math.ceil((pair.expiresAt - Date.now()) / 60_000) })),
        button(copied ? 'Pairing link copied' : 'Copy pairing link', () => void copy(), !navigator.clipboard?.writeText),
        button('Cancel', () => run('phone-pair-cancel')))) : h('div', null,
        h(SwitchRow, { label: t('Allow this phone to send messages'), on: command, disabled: busy, onChange: setCommand }),
        h(Row, { label: t('Pairing QR code') }, button('Show', () => run('phone-pair', { command }), !online)))),
    h(Card, { title: t('Phones') }, phone?.phones.length ? phone.phones.map(device => h(Row, {
      key: device.id, label: device.name || t('Phone'), hint: [t(device.connected ? 'Connected' : 'Disconnected'),
        t(device.command ? 'Read and command' : 'Read only')].join(' · '),
    }, button(removing === device.id ? 'Confirm removal' : 'Remove', () => removing === device.id
      ? run('phone-remove', { id: device.id }) : setRemoving(device.id)))) : h(Row, { label: t('No phones yet') })))
}
