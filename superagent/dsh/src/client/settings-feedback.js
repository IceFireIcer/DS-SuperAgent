// Adapts the preview, copy, download and issue actions from DS Bot 0.3.8 ds-bot/src/client/feedback.js (see NOTICE).
import { createElement as h, useEffect, useState } from 'react'
import metadata from '../../../package.json' with { type: 'json' }
import { dateLocale, t } from './i18n.js'
import { DetailList, FieldRow, InlineNotice, SectionCard } from './product-settings-components.js'

const issueLink = `${metadata.bugs.url}/new`
const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const desktopStates = new Set(['starting', 'running', 'stopped', 'failed'])
const hostStates = new Set(['ready', 'running', 'degraded'])
const eventAreas = new Set(['host', 'update', 'backup', 'profile', 'shell'])
const version = value => typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu.test(value)
const boundedCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)

function summarize(host, desktop) {
  const app = desktop && (Object.hasOwn(platformNames, desktop.platform) ? platformNames[desktop.platform] : null)
  const platform = app && ['arm64', 'x64', 'ia32'].includes(desktop.arch) ? `${app} ${desktop.arch}` : app
  const mainState = hostStates.has(host?.main?.state) ? host.main.state : null
  const events = Array.isArray(desktop?.events) ? desktop.events.slice(0, 20).flatMap(event => {
    if (!Number.isSafeInteger(event?.at) || event.at < 0 || event.at > 8.64e15
      || !eventAreas.has(event.area) || !boundedCode(event.code)) return []
    return [{ at: new Date(event.at).toISOString(), area: event.area, code: event.code,
      ...(version(event.version) ? { version: event.version } : {}) }]
  }) : []
  return {
    product: 'DS SuperAgent', pluginVersion: metadata.version,
    ...(version(desktop?.appVersion) ? { appVersion: desktop.appVersion } : {}),
    ...(version(desktop?.dshVersion) ? { dshVersion: desktop.dshVersion } : {}),
    ...(platform ? { platform } : {}),
    ...(desktopStates.has(desktop?.hostState) ? { hostState: desktop.hostState } : {}),
    ...(mainState ? { mainState } : {}),
    ...(typeof host?.processingPaused === 'boolean' ? { processingPaused: host.processingPaused } : {}),
    events,
  }
}

function download(report) {
  const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url; link.download = 'ds-superagent-diagnostics.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function FeedbackSettings({ binding, call, onNavigate, app = globalThis.window?.dsSuperagentApp }) {
  const instanceId = binding?.instanceId
  const [description, setDescription] = useState('')
  const [summary, setSummary] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [copyFallback, setCopyFallback] = useState(null)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const desktop = typeof app?.diagnostics === 'function'
    setSummary(null)
    setCopyFallback(null)
    void Promise.allSettled([
      instanceId ? Promise.resolve().then(() => call('product-status', { instanceId }, controller.signal)) : null,
      desktop ? Promise.resolve().then(() => app.diagnostics()) : null,
    ]).then(([product, native]) => {
      if (controller.signal.aborted) return
      setSummary({ report: summarize(product.value, native.value),
        hostUnavailable: product.status === 'rejected' || !product.value,
        desktopState: !desktop ? 'absent' : native.status === 'rejected' || !native.value ? 'error' : 'ready' })
    })
    return () => controller.abort()
  }, [instanceId, call, app, refresh])

  const text = summary ? `${JSON.stringify(summary.report, null, 2)}\n` : ''
  const copy = async (content, label, message) => {
    if (!content.trim()) return
    setNotice(''); setCopyFallback(null)
    try {
      await navigator.clipboard.writeText(content)
      setNotice(t(message))
    } catch {
      setCopyFallback({ label, content })
      setNotice(t('Could not copy. Select the text below and copy it.'))
    }
  }
  return h('div', { className: 'bt-ps-content' },
    h(SectionCard, { title: t('Report a problem') },
      h(FieldRow, { label: t('What happened?'), layout: 'stack', control: h('textarea', { className: 'bt-bs-input', rows: 4,
        maxLength: 4000, value: description, onChange: event => setDescription(event.target.value) }) }),
      h(FieldRow, { label: t('GitHub issue'), hint: t('The issue opens blank. Paste only what you want to share.'),
        control: h('div', { className: 'bt-ps-actions' },
          h('button', { type: 'button', className: 'bt-soft', disabled: !description.trim(),
            onClick: () => void copy(description, 'Feedback draft', 'Feedback draft copied.') }, t('Copy draft')),
          h('a', { href: issueLink, target: '_blank', rel: 'noopener noreferrer' }, t('Report on GitHub'))) })),
    h(SectionCard, { title: t('Diagnostics') },
      !summary ? h('p', { role: 'status' }, t('Loading…')) : null,
      summary?.hostUnavailable ? h(InlineNotice, { tone: 'warn' }, t('Host diagnostics are unavailable.')) : null,
      summary?.desktopState === 'absent' ? h(InlineNotice, { tone: 'neutral' }, t('Desktop diagnostics are available in the desktop app.')) : null,
      summary?.desktopState === 'error' ? h(InlineNotice, { tone: 'warn' }, t('Desktop diagnostics could not be loaded.')) : null,
      summary ? h(DetailList, { items: [
        { label: t('Plugin version'), value: summary.report.pluginVersion },
        ...(summary.report.appVersion ? [{ label: t('Installed version'), value: summary.report.appVersion }] : []),
        ...(summary.report.dshVersion ? [{ label: 'DSH', value: summary.report.dshVersion }] : []),
      ] }) : null,
      text ? h(FieldRow, { label: t('Review diagnostic summary'), layout: 'stack',
        control: h('textarea', { className: 'bt-bs-input', value: text, readOnly: true, rows: 7, spellCheck: false }) }) : null,
      h(FieldRow, { label: t('Diagnostics'), control: h('div', { className: 'bt-ps-actions' },
        h('button', { type: 'button', className: 'bt-soft', disabled: !text,
          onClick: () => void copy(text, 'Diagnostics', 'Copied the diagnostics.') }, t('Copy')),
        h('button', { type: 'button', className: 'bt-soft', disabled: !text,
          onClick: () => download(text) }, t('Download diagnostic summary')),
        h('button', { type: 'button', className: 'bt-soft', disabled: !summary,
          onClick: () => { setNotice(''); setRefresh(value => value + 1) } }, t('Refresh diagnostics')),
        onNavigate ? h('button', { type: 'button', className: 'bt-soft', onClick: () => onNavigate('status') }, t('Open product status')) : null) }),
      summary?.report.events.length ? h('details', null, h('summary', null, t('Recent operational events')),
        h('ul', null, summary.report.events.map((event, index) => h('li', { key: `${event.at}:${index}` },
          `${new Date(event.at).toLocaleString(dateLocale())} · ${event.area} · ${event.code}`)))) : null,
      notice ? h(InlineNotice, { tone: copyFallback ? 'warn' : 'success' }, notice) : null,
      copyFallback ? h(FieldRow, { label: t(copyFallback.label), layout: 'stack',
        control: h('textarea', { className: 'bt-bs-input', value: copyFallback.content, readOnly: true, rows: 5 }) }) : null))
}
