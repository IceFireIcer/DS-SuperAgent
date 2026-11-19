import { createElement as h, useEffect, useState } from 'react'
import { Card } from './product-card.js'
import { t } from './i18n.js'

const targets = [['local', 'Local'], ['remote-only', 'Remote only'], ['auto', 'Auto']]
const permissions = ['read', 'write', 'search', 'command']
const permissionLabels = { read: 'Read access', write: 'Write access', search: 'Search access',
  command: 'Command access', browser: 'Browser', mcp: 'MCP', office: 'Office' }

function permissionLabel(permission) {
  return t(permissionLabels[permission] ?? permission)
}

function permissionCopy(permissions) {
  return permissions.map(permissionLabel).join(', ')
}

function candidateReasonCopy(reason) {
  const target = /^target ([^ ]+) excludes (local|remote) Environments$/u.exec(reason)
  if (target) return t('target {target} excludes {kind} Environments',
    { target: target[1] === 'remote-only' ? t('Remote only') : t('Local'), kind: target[2] === 'local' ? t('Local') : t('Remote') })
  if (reason.startsWith('Environment is offline:')) return t('Environment is offline: {reason}',
    { reason: reason.slice('Environment is offline: '.length) })
  if (reason === 'Environment is offline') return t('Environment is offline')
  if (reason === 'Environment version is unverified') return t('Environment version is unverified')
  if (reason === 'Environment fingerprint is unverified') return t('Environment fingerprint is unverified')
  if (reason === 'Environment capacity is unknown') return t('Environment capacity is unknown')
  const missing = /^missing capability: ([^ (]+)(?: \((.+)\))?$/u.exec(reason)
  if (missing) return missing[2]
    ? t('Missing capability: {capability} ({detail})', { capability: t(missing[1]), detail: missing[2] })
    : t('Missing capability: {capability}', { capability: t(missing[1]) })
  const capacity = /^capacity is full \((.+)\)$/u.exec(reason)
  if (capacity) return t('Execution capacity is full ({count}).', { count: capacity[1] })
  return t(reason)
}

function environmentLabel(environment) {
  const name = environment.label || environment.title
  return `${name || environment.id} · ${environment.kind === 'remote' ? t('Remote') : t('Local')}`
}

function capabilityReadErrorCopy(reason) {
  if (reason === 'RESOURCE_UNAVAILABLE') return t('The remote Environment credential record is unavailable.')
  if (reason === 'ENVIRONMENT_DENIED') return t('This Environment is not authorized for the current Instance.')
  if (/^[A-Z][A-Z0-9_]+$/u.test(reason)) return t('Capabilities could not be read. Check this Environment before assigning work.')
  return t(reason)
}

function pairingStatusCopy(status) {
  return ({ pending: t('Pairing running'), unknown: t('Pairing unknown'), completed: t('Pairing completed'),
    abandoned: t('Pairing abandoned') })[status] ?? t('Unknown')
}

export function ProductExecutionSettings({ binding, call, onChanged }) {
  const [snapshot, setSnapshot] = useState(null)
  const [draft, setDraft] = useState(null)
  const [pairing, setPairing] = useState(null)
  const [pairIssue, setPairIssue] = useState(null)
  const [confirmPairAbandon, setConfirmPairAbandon] = useState(false)
  const [revocation, setRevocation] = useState(null)
  const [cleanup, setCleanup] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = async () => {
    const value = await call('execution-options', { instanceId: binding.instanceId })
    setSnapshot(value)
    setDraft(current => current ?? { ...value.policy, requiredPermissions: [...value.policy.requiredPermissions] })
    return value
  }
  useEffect(() => {
    let live = true
    setSnapshot(null); setDraft(null); setError('')
    void load().catch(failure => { if (live) setError(t(failure.message)) })
    return () => { live = false }
  }, [binding.instanceId])
  const run = async operation => {
    setBusy(true); setError(''); setNotice('')
    try { await operation() }
    catch (failure) { setError(t(failure.message)) }
    finally { setBusy(false) }
  }
  const savePolicy = () => run(async () => {
    await call('execution-policy-save', { instanceId: binding.instanceId, commandId: crypto.randomUUID(),
      expectedRevision: snapshot.policy.revision,
      policy: { defaultTarget: draft.defaultTarget,
        requiredPermissions: draft.requiredPermissions,
        preferredEnvironmentId: draft.preferredEnvironmentId || null } })
    await load(); setNotice(t('Execution policy saved.')); onChanged?.()
  })
  const openPairing = () => {
    setPairIssue(null); setConfirmPairAbandon(false)
    setPairing({ commandId: crypto.randomUUID(), label: '',
      environmentId: `remote-${crypto.randomUUID().slice(0, 8)}`,
      endpoint: '', deviceId: '', deviceKey: '', pairingCode: '', permissions: ['read', 'write', 'search'] })
  }
  const checkPairing = async () => {
    const result = await call('remote-environment-pair-read', { instanceId: binding.instanceId,
      commandId: pairing.commandId })
    setPairIssue(result)
    return result
  }
  const pair = event => {
    event.preventDefault()
    void run(async () => {
      try {
        await call('remote-environment-pair', { instanceId: binding.instanceId, commandId: pairing.commandId,
          environmentId: pairing.environmentId, label: pairing.label, endpoint: pairing.endpoint,
          pairingCode: pairing.pairingCode, expectedDeviceId: pairing.deviceId,
          expectedDeviceKey: pairing.deviceKey, permissions: pairing.permissions })
      } catch (failure) {
        if (['PAIRING_UNKNOWN', 'PAIRING_PENDING', 'PAIRING_STALE'].includes(failure.code)) {
          await checkPairing().catch(() => {})
        }
        throw failure
      }
      setPairing(null); setPairIssue(null); await load(); setNotice(t('Device paired.')); onChanged?.()
    })
  }
  const abandonPairing = () => {
    if (!confirmPairAbandon) { setConfirmPairAbandon(true); return }
    setConfirmPairAbandon(false)
    void run(async () => {
      const result = await call('remote-environment-pair-abandon', { instanceId: binding.instanceId,
        commandId: pairing.commandId })
      setPairing(null); setPairIssue(null); await load()
      if (result.secretCleanupPending) {
        setCleanup({ kind: 'pair', commandId: pairing.commandId })
        setNotice(t('Pairing state abandoned; credential cleanup is pending.'))
      } else setNotice(t('Pairing state abandoned. Check the device before pairing again.'))
      onChanged?.()
    })
  }
  const revoke = environmentId => {
    if (revocation?.environmentId !== environmentId) {
      setRevocation({ environmentId, commandId: crypto.randomUUID() })
      return
    }
    void run(async () => {
      const result = await call('remote-environment-revoke', { instanceId: binding.instanceId,
        commandId: revocation.commandId, environmentId })
      await load()
      setRevocation(null)
      if (result.secretCleanupPending) {
        setCleanup({ kind: 'revoke', commandId: revocation.commandId, environmentId })
        setNotice(t('Device revoked; credential cleanup is pending.'))
      } else setNotice(result.deviceConfirmed ? t('Device revoked.')
        : t('Host revoked this device; confirmation was unavailable.'))
      onChanged?.()
    })
  }
  const retryCleanup = () => {
    if (!cleanup) return
    void run(async () => {
      const result = cleanup.kind === 'pair'
        ? await call('remote-environment-pair-abandon', { instanceId: binding.instanceId, commandId: cleanup.commandId })
        : await call('remote-environment-revoke', { instanceId: binding.instanceId, commandId: cleanup.commandId,
          environmentId: cleanup.environmentId })
      if (result.secretCleanupPending) {
        setNotice(t('Credential cleanup is still pending. Retry after the credential service recovers.'))
        return
      }
      setCleanup(null)
      setNotice(t('Credential cleanup completed.'))
    })
  }
  const update = (path, value) => setDraft(current => {
    const next = structuredClone(current)
    let target = next
    for (const key of path.slice(0, -1)) target = target[key]
    target[path.at(-1)] = value
    return next
  })
  if (!snapshot || !draft) return h('p', { role: 'status' }, error || t('Loading…'))
  return h('section', { className: 'bt-product-execution', 'aria-label': t('Execution targets') },
    error ? h('p', { className: 'bt-main-error', role: 'alert' }, error) : null,
    notice ? h('p', { className: 'bt-main-status', role: 'status' }, notice) : null,
    cleanup ? h('div', { className: 'bt-product-execution-cleanup' },
      h('p', { className: 'bt-main-error' }, t('Credential cleanup is pending for a device operation.')),
      h('button', { type: 'button', className: 'bt-soft bt-danger', disabled: busy, onClick: retryCleanup },
        t('Retry credential cleanup'))) : null,
    snapshot.remoteLoadErrors?.length ? h(Card, { title: t('Unavailable remote devices') },
      snapshot.remoteLoadErrors.map(item => h('p', { key: item.id, className: 'bt-main-error' },
        `${item.id}: ${capabilityReadErrorCopy(item.reason)}`))) : null,
    h(Card, { title: t('Execution policy') },
      h('p', null, t('This policy chooses a target for new work. Active assignments keep their original Environment.')),
      h('label', null, t('Default target'), h('select', { className: 'bt-select', value: draft.defaultTarget,
        onChange: event => update(['defaultTarget'], event.target.value) }, targets.map(([value, label]) =>
        h('option', { key: value, value }, t(label))))),
      h('label', null, t('Preferred Environment'), h('select', { className: 'bt-select',
        value: draft.preferredEnvironmentId ?? '', onChange: event => update(['preferredEnvironmentId'], event.target.value || undefined) },
      h('option', { value: '' }, t('No preference')), snapshot.environments.map(environment =>
        h('option', { key: environment.id, value: environment.id }, environmentLabel(environment))))),
      h('fieldset', null, h('legend', null, t('Required capabilities')),
        permissions.map(permission => h('label', { key: permission },
          h('input', { type: 'checkbox', checked: draft.requiredPermissions.includes(permission),
            onChange: event => update(['requiredPermissions'], event.target.checked
              ? [...draft.requiredPermissions, permission] : draft.requiredPermissions.filter(item => item !== permission)) }),
          permissionLabel(permission)))),
      h('button', { type: 'button', className: 'bt-soft', disabled: busy || !draft.requiredPermissions.length,
        onClick: savePolicy }, t('Save execution policy'))),
    h(Card, { title: t('Devices and Environments') },
      snapshot.environments.map(environment => h('article', { key: environment.id, className: 'bt-product-execution-row' },
        h('strong', null, environmentLabel(environment)),
        h('p', null, `${t('Status')}: ${environment.kind === 'remote'
          ? environment.online === false ? t('Offline') : t('Configured')
          : t('Local')} · ${t('Permissions')}: ${permissionCopy(environment.permissions)}`),
        h('p', null, `${t('Device')}: ${environment.deviceId ?? t('This Host')} · ${t('Directory')}: ${environment.root}`),
        environment.reasons?.length ? h('p', { className: 'bt-main-work-detail' },
          `${t('Selection issues')}: ${environment.reasons.map(candidateReasonCopy).join('; ')}`) : null,
        environment.capabilities?.unavailable ? h('p', { className: 'bt-main-error' },
          `${t('Capabilities unavailable')}: ${capabilityReadErrorCopy(environment.capabilities.reason)}`) : h('p', null,
          `${t('Attachments')}: ${environment.capabilities?.attachments?.supported ? t('Available') : t('Unavailable')}`
          + ` · ${t('Skills')}: ${environment.capabilities?.skills?.supported ? t('Available') : t('Unavailable')}`),
        environment.kind === 'remote' ? h('button', { type: 'button',
          className: `bt-soft bt-soft-sm${revocation?.environmentId === environment.id ? ' bt-danger' : ''}`, disabled: busy,
          onClick: () => revoke(environment.id) }, t(revocation?.environmentId === environment.id
          ? 'Confirm revoke device' : 'Revoke device')) : null)),
      pairing ? h('form', { className: 'bt-product-execution-form', onSubmit: pair },
        pairIssue ? h('section', { className: 'bt-product-execution-pair-issue' },
          h('p', { role: 'status' }, `${t('Pairing status')}: ${pairingStatusCopy(pairIssue.status)}`
            + `${pairIssue.active ? ` · ${t('Command running')}` : ''}`
            + `${pairIssue.recoverable ? ` · ${t('Saved device can be restored after Host restart')}` : ''}`),
          h('div', { className: 'bt-actions' },
            h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => void run(checkPairing) },
              t('Check pairing status')),
            pairIssue.canAbandon ? h('button', { type: 'button', className: 'bt-soft bt-danger', disabled: busy,
              onClick: abandonPairing }, t(confirmPairAbandon ? 'Confirm abandon pairing' : 'Abandon uncertain pairing')) : null)) : null,
        h('label', null, t('Device name'), h('input', { className: 'bt-bs-input', required: true, maxLength: 128,
          value: pairing.label, onChange: event => setPairing(current => ({ ...current, label: event.target.value })) })),
        h('label', null, t('Environment ID'), h('input', { className: 'bt-bs-input', required: true,
          value: pairing.environmentId, onChange: event => setPairing(current => ({ ...current, environmentId: event.target.value })) })),
        h('label', null, t('Device endpoint'), h('input', { className: 'bt-bs-input', required: true, inputMode: 'url',
          placeholder: 'https://device.example', value: pairing.endpoint,
          onChange: event => setPairing(current => ({ ...current, endpoint: event.target.value })) })),
        h('label', null, t('Device ID'), h('input', { className: 'bt-bs-input', required: true,
          value: pairing.deviceId, onChange: event => setPairing(current => ({ ...current, deviceId: event.target.value })) })),
        h('label', null, t('Device key fingerprint'), h('input', { className: 'bt-bs-input', required: true,
          pattern: '[a-f0-9]{64}', value: pairing.deviceKey,
          onChange: event => setPairing(current => ({ ...current, deviceKey: event.target.value })) })),
        h('label', null, t('Pairing code'), h('input', { className: 'bt-bs-input', required: true, type: 'password',
          autoComplete: 'one-time-code', value: pairing.pairingCode,
          onChange: event => setPairing(current => ({ ...current, pairingCode: event.target.value })) })),
        h('fieldset', null, h('legend', null, t('Device permissions')),
          permissions.map(permission => h('label', { key: permission },
            h('input', { type: 'checkbox', checked: pairing.permissions.includes(permission),
              onChange: event => setPairing(current => ({ ...current, permissions: event.target.checked
                ? [...current.permissions, permission] : current.permissions.filter(item => item !== permission) })) }),
            permissionLabel(permission)))),
        h('div', { className: 'bt-actions' },
          h('button', { type: 'submit', className: 'bt-soft', disabled: busy || !pairing.permissions.length }, t('Pair device')),
          h('button', { type: 'button', className: 'bt-soft', onClick: () => setPairing(null) }, t('Cancel'))))
        : h('button', { type: 'button', className: 'bt-soft', onClick: openPairing }, t('Pair a device'))))
}

export const PRODUCT_EXECUTION_CSS = `
.bt-product-execution{display:grid;gap:12px}
.bt-product-execution label{display:grid;gap:6px;font-size:13px}
.bt-product-execution fieldset{display:flex;gap:12px;flex-wrap:wrap;border:1px solid var(--bt-line);border-radius:12px}
.bt-product-execution fieldset label{display:flex;align-items:center;gap:6px}
.bt-product-execution-row{display:grid;gap:5px;padding:12px 0;border-top:1px solid var(--bt-line);overflow-wrap:anywhere}
.bt-product-execution-row button{justify-self:start}
.bt-product-execution-form{display:grid;gap:12px}
.bt-product-execution-pair-issue{display:grid;gap:8px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:12px}
.bt-product-execution-cleanup{display:grid;gap:8px;justify-items:start}
`
