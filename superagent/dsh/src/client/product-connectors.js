import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { t } from './i18n.js'

export const CONNECTOR_PRODUCT_ENDPOINTS = Object.freeze({
  list: 'connector-list',
  save: 'connector-save',
  remove: 'connector-remove',
  importScan: 'connector-import-scan',
  importCommit: 'connector-import-commit',
  bindCredential: 'connector-credential-bind',
  saveToken: 'connector-token-save',
  oauthStart: 'connector-oauth-start',
  oauthStatus: 'connector-oauth-status',
  oauthCancel: 'connector-oauth-cancel',
  disconnect: 'connector-disconnect',
  mailAccounts: 'mail-account-list',
  saveMailAccount: 'mail-account-save',
  removeMailAccount: 'mail-account-remove',
  rules: 'mail-rules',
  saveRule: 'mail-rule-save',
  search: 'mail-search',
  read: 'mail-read',
  reply: 'mail-reply',
  sendReply: 'mail-reply-send',
  cancelReply: 'mail-reply-cancel',
})

export const CONNECTOR_PRODUCT_ENDPOINT_NAMES = Object.freeze(Object.values(CONNECTOR_PRODUCT_ENDPOINTS))
const endpointSet = new Set(CONNECTOR_PRODUCT_ENDPOINT_NAMES)
const targetRoles = new Set(['main', 'router', 'worker'])
const defaultConnectorTarget = Object.freeze({ role: 'main' })

function productError(message, code) {
  return Object.assign(new Error(message), { code })
}

function commandId(value) {
  if (value !== undefined) {
    if (typeof value !== 'string' || value.trim() === '') throw productError(t('A command ID is required.'), 'INVALID_INPUT')
    return value
  }
  return globalThis.crypto?.randomUUID?.() ?? `connector-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function targetValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw productError(t('Choose an explicit target.'), 'INVALID_INPUT')
  }
  const keys = ['role', 'workItemId', 'environmentId', 'sourceInstanceId']
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw productError(t('The target contains unsupported fields.'), 'INVALID_INPUT')
  }
  if (!targetRoles.has(value.role)) throw productError(t('Choose a main, router, or worker target.'), 'INVALID_INPUT')
  const target = { role: value.role }
  for (const key of ['workItemId', 'environmentId', 'sourceInstanceId']) {
    if (value[key] === undefined || value[key] === '') continue
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw productError(t('The target scope is invalid.'), 'INVALID_INPUT')
    }
    target[key] = value[key]
  }
  if (target.role === 'worker' && !target.workItemId && !target.environmentId) {
    throw productError(t('A worker target needs a work item or Environment.'), 'INVALID_INPUT')
  }
  return target
}

/**
 * Browser-side product API for #153. The caller injects the existing product
 * transport; this adapter never reaches a mailbox, OAuth token endpoint, or
 * callback listener directly.
 */
export function createProductConnectorsClient({ call, target: initialTarget, instanceId }) {
  if (typeof call !== 'function') throw productError(t('The product connection is unavailable.'), 'UNAVAILABLE')
  if (instanceId !== undefined && (typeof instanceId !== 'string' || instanceId.trim() === '')) {
    throw productError(t('The product Instance is unavailable.'), 'INVALID_INPUT')
  }
  const target = targetValue(initialTarget)

  const invoke = async (endpoint, payload = {}) => {
    if (!endpointSet.has(endpoint)) throw productError(t('This capability is not connected yet.'), 'UNAVAILABLE')
    if (Object.hasOwn(payload, 'botId')) throw productError(t('Legacy botId is not accepted; use an explicit target.'), 'INVALID_INPUT')
    return call(endpoint, payload)
  }
  const scoped = (payload = {}) => ({ ...(instanceId === undefined ? {} : { instanceId }),
    ...payload, scope: target })
  const instance = (payload = {}) => ({ ...(instanceId === undefined ? {} : { instanceId }), ...payload })

  return Object.freeze({
    target: Object.freeze({ ...target }),
    list: () => invoke(CONNECTOR_PRODUCT_ENDPOINTS.list, scoped()),
    save: (input) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.save, scoped({ ...input, commandId: commandId(input?.commandId) })),
    remove: (connectorId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.remove,
      scoped({ connectorId, commandId: commandId(id) })),
    importScan: () => invoke(CONNECTOR_PRODUCT_ENDPOINTS.importScan, instance()),
    importCommit: (sourceId, options = {}) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.importCommit,
      scoped({ sourceId, commandId: commandId(options.commandId), ...(options.name ? { name: options.name } : {}) })),
    bindCredential: (connectorId, resourceId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.bindCredential,
      scoped({ connectorId, resourceId, commandId: commandId(id) })),
    saveToken: (connectorId, value, options = {}) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.saveToken,
      scoped({ connectorId, value, commandId: commandId(options.commandId),
        ...(options.label ? { label: options.label } : {}) })),
    oauthStart: (connectorId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.oauthStart,
      scoped({ connectorId, commandId: commandId(id) })),
    oauthStatus: (attemptId) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.oauthStatus, instance({ attemptId })),
    oauthCancel: (attemptId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.oauthCancel,
      instance({ attemptId, commandId: commandId(id) })),
    disconnect: (connectorId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.disconnect,
      scoped({ connectorId, commandId: commandId(id) })),
    mailAccounts: () => invoke(CONNECTOR_PRODUCT_ENDPOINTS.mailAccounts, scoped()),
    saveMailAccount: (input) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.saveMailAccount,
      scoped({ ...input, commandId: commandId(input?.commandId) })),
    removeMailAccount: (accountId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.removeMailAccount,
      scoped({ accountId, commandId: commandId(id) })),
    rules: () => invoke(CONNECTOR_PRODUCT_ENDPOINTS.rules, scoped()),
    saveRule: (input) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.saveRule,
      scoped({ ...input, commandId: commandId(input?.commandId) })),
    search: (input = {}) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.search, scoped(input)),
    read: (input) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.read, scoped(input)),
    reply: (input) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.reply,
      scoped({ ...input, commandId: commandId(input?.commandId) })),
    sendReply: (input) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.sendReply,
      scoped({ ...input, commandId: commandId(input?.commandId) })),
    cancelReply: (replyId, id) => invoke(CONNECTOR_PRODUCT_ENDPOINTS.cancelReply,
      scoped({ replyId, commandId: commandId(id) })),
    invoke,
  })
}

function useConnectorClient(call, target, instanceId) {
  return useMemo(() => createProductConnectorsClient({ call, target, instanceId }), [call, target, instanceId])
}

function Button({ children, onClick, disabled = false, kind = 'secondary', type = 'button' }) {
  return h('button', { type, disabled, onClick, className: `pc-button pc-button-${kind}` }, children)
}

function ErrorNotice({ error }) {
  return error ? h('div', { className: 'pc-notice pc-error', role: 'alert' },
    typeof error === 'string' ? error : error.message) : null
}

function Notice({ children }) {
  return children ? h('div', { className: 'pc-notice', role: 'status' }, children) : null
}

function TargetFields({ target, onChange }) {
  if (!onChange) return null
  const update = (key, value) => onChange({ ...target, [key]: value || undefined })
  return h('div', { className: 'pc-target' },
    h('label', null, t('Target'),
      h('select', { value: target.role, onChange: event => update('role', event.target.value) },
        h('option', { value: 'main' }, 'Main'),
        h('option', { value: 'router' }, 'Router'),
        h('option', { value: 'worker' }, 'Worker'))),
    h('label', null, t('Work item'),
      h('input', { value: target.workItemId ?? '', onChange: event => update('workItemId', event.target.value),
        placeholder: t('Optional exact work item') })),
    h('label', null, t('Environment'),
      h('input', { value: target.environmentId ?? '', onChange: event => update('environmentId', event.target.value),
        placeholder: t('Optional exact Environment') })),
    h('label', null, t('Source'),
      h('input', { value: target.sourceInstanceId ?? '', onChange: event => update('sourceInstanceId', event.target.value),
        placeholder: t('Exact source Instance when required') })))
}

function ConnectorCard({ item, client, onChanged, run, local }) {
  const [token, setToken] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const busyRef = useRef(false)
  const action = async (name, task, done) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(null)
    try {
      const result = await run(task, name)
      done?.(result)
      await onChanged()
    } catch (failure) { setError(failure) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const canToken = item.custom || item.auth.kind === 'token' || item.auth.kind === 'oauth' && item.auth.token === true
  const connected = item.status === 'configured' || item.status === 'ready' || item.status === 'pending'
    || item.credentialKind !== undefined
  const canDisconnect = item.credentialKind !== undefined
    || !item.custom && item.auth.kind === 'none' && item.status === 'configured'
  return h('article', { className: 'pc-card', 'data-status': item.status },
    h('div', { className: 'pc-card-head' },
      h('div', null,
        h('h4', null, item.name, item.custom ? h('span', { className: 'pc-tag' }, t('Added')) : null),
        h('p', null, item.about)),
      h('span', { className: 'pc-status' }, t(item.status.replaceAll('-', ' ')))),
    item.pending ? h('div', { className: 'pc-pending' },
      h('span', null, local ? t('Finish signing in in your browser.') : t('Sign-in is pending on the Host.')),
      local ? h('a', { href: item.pending.authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Open sign-in')) : null,
      local && item.pending.userCode ? h('code', null, item.pending.userCode) : null,
      local ? h(Button, { onClick: () => action('oauth-cancel', () => client.oauthCancel(item.pending.attemptId)), disabled: busy },
        t('Cancel')) : null) : null,
    local && item.auth.kind === 'oauth' && !item.pending ? h('div', { className: 'pc-row' },
      h(Button, { onClick: () => action('oauth-start', async () => {
        const pending = await client.oauthStart(item.id)
        if (pending.authorizationUrl) globalThis.open?.(pending.authorizationUrl, '_blank', 'noopener,noreferrer')
        return pending
      }), disabled: busy || item.authorizationAvailable === false, kind: 'primary' }, t('Sign in')),
      item.authorizationAvailable === false ? h('span', { className: 'pc-hint' },
        t('The Host has not configured OAuth for this connector.')) : null) : null,
    local && item.auth.kind === 'none' && item.status === 'off' ? h('div', { className: 'pc-row' },
      h(Button, { onClick: () => action('save', () => client.save({ connectorId: item.id })), disabled: busy,
        kind: 'primary' }, t('Connect'))) : null,
    local && canToken ? h('form', { className: 'pc-row', onSubmit: event => {
      event.preventDefault()
      if (!token.trim()) return
      void action('token-save', () => client.saveToken(item.id, token), () => setToken(''))
    } },
    h('input', { type: 'password', value: token, autoComplete: 'off', placeholder: t('Token or API key'),
      onChange: event => setToken(event.target.value) }),
    h(Button, { type: 'submit', disabled: busy || !token.trim(), kind: 'primary' }, t('Save token'))) : null,
    local ? h('form', { className: 'pc-row', onSubmit: event => {
      event.preventDefault()
      if (!resourceId.trim()) return
      void action('credential-bind', () => client.bindCredential(item.id, resourceId.trim()), () => setResourceId(''))
    } },
    h('input', { value: resourceId, placeholder: t('Existing credential resource ID'),
      onChange: event => setResourceId(event.target.value) }),
     h(Button, { type: 'submit', disabled: busy || !resourceId.trim() }, t('Bind credential'))) : null,
    h('div', { className: 'pc-row pc-actions' },
      local && connected ? h('label', { className: 'pc-check' },
        h('input', { type: 'checkbox', checked: item.readOnly,
          onChange: event => void action('save', () => client.save({ connectorId: item.id, readOnly: event.target.checked })) }),
        t('Read-only')) : null,
      local && canDisconnect ? h(Button, { disabled: busy, onClick: () => action('disconnect', () => client.disconnect(item.id)) },
        t('Disconnect')) : null,
      local && item.custom ? h(Button, { disabled: busy, kind: 'danger',
        onClick: () => action('remove', () => client.remove(item.id)) }, t('Remove')) : null),
    h(ErrorNotice, { error }))
}

function CustomConnector({ client, onChanged, run }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [command, setCommand] = useState('')
  const [error, setError] = useState(null)
  const save = async event => {
    event.preventDefault()
    setError(null)
    try {
      await run(() => client.save({ name: name.trim(), ...(address.trim() ? { url: address.trim() } : { command: command.trim() }) }), 'save')
      setName(''); setAddress(''); setCommand('')
      await onChanged()
    } catch (failure) { setError(failure) }
  }
  return h('form', { className: 'pc-panel', onSubmit: save },
    h('strong', null, t('Custom MCP connector')),
    h('input', { value: name, placeholder: t('Name'), onChange: event => setName(event.target.value) }),
    h('input', { value: address, placeholder: t('HTTPS address'), onChange: event => setAddress(event.target.value) }),
    h('input', { value: command, placeholder: t('Or a local command'), onChange: event => setCommand(event.target.value) }),
    h(Button, { type: 'submit', kind: 'primary', disabled: !name.trim() || !address.trim() && !command.trim() }, t('Save connector')),
    h(ErrorNotice, { error }))
}

export function ProductTargetFields({ target, onChange }) {
  return h(TargetFields, { target, onChange })
}

export function ProductConnectorsSettings({ call, target = defaultConnectorTarget, onTargetChange, instanceId, binding,
  local = true, capabilities = ['read', 'command'], initialTab = 'connectors' }) {
  const scopedInstanceId = instanceId ?? binding?.instanceId
  const client = useConnectorClient(call, target, scopedInstanceId)
  const canRead = local || capabilities.includes('read')
  const canCommand = local || capabilities.includes('command')
  const [tab, setTab] = useState(initialTab === 'mail' ? 'mail' : 'connectors')
  const [connectors, setConnectors] = useState(null)
  const [mail, setMail] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [custom, setCustom] = useState(false)
  const [importSources, setImportSources] = useState(null)
  const [query, setQuery] = useState('')
  const [messages, setMessages] = useState([])
  const [original, setOriginal] = useState(null)
  const [replyBody, setReplyBody] = useState('')
  const [accountId, setAccountId] = useState('')
  const [provider, setProvider] = useState('')
  const [feishuSource, setFeishuSource] = useState(undefined)
  const [preparingReply, setPreparingReply] = useState(false)
  const [replyBusy, setReplyBusy] = useState(null)
  const preparingReplyRef = useRef(false)
  const replyBusyRef = useRef(false)
  const replyCommand = useRef(null)
  const mounted = useRef(true)

  const selectedAccountId = accountId || (mail?.accounts?.length === 1 ? mail.accounts[0].id : '')
  const mailAvailable = mail?.available !== false

  const refresh = async () => {
    setError(null)
    try {
      const [nextConnectors, nextMail] = await Promise.all([client.list(), client.mailAccounts()])
      if (!mounted.current) return
      setConnectors(nextConnectors)
      setMail(nextMail)
      setAccountId(current => current && nextMail.accounts.some(account => account.id === current) ? current
        : nextMail.accounts.length === 1 ? nextMail.accounts[0].id : '')
    } catch (failure) { if (mounted.current) setError(failure) }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [client])

  useEffect(() => {
    if (!local) return undefined
    let live = true
    const payload = scopedInstanceId ? { instanceId: scopedInstanceId } : {}
    call('feishu-status', payload).then(status => {
      if (live) setFeishuSource(status ?? null)
    }).catch(() => { if (live) setFeishuSource(null) })
    return () => { live = false }
  }, [call, local, scopedInstanceId])

  const pending = connectors?.items?.filter(item => item.pending) ?? []
  useEffect(() => {
    if (pending.length === 0) return undefined
    let live = true
    const timer = setInterval(async () => {
      for (const item of pending) {
        try {
          const status = await client.oauthStatus(item.pending.attemptId)
          if (!live) return
          if (status.state !== 'pending') {
            await refresh()
            return
          }
        } catch { /* Keep the attempt visible for an explicit retry. */ }
      }
    }, 2500)
    return () => { live = false; clearInterval(timer) }
  }, [client, pending.map(item => `${item.pending.attemptId}:${item.pending.expiresAt}`).join('|')])

  const run = async (task, label) => {
    setError(null); setNotice(null)
    try {
      const result = await task()
      if (label) setNotice(t('Done.'))
      return result
    } catch (failure) {
      setError(failure)
      throw failure
    }
  }

  const search = async event => {
    event.preventDefault()
    setError(null); setOriginal(null)
    if (!selectedAccountId && (mail?.accounts?.length ?? 0) > 1) {
      setError(new Error(t('Choose a mail account first.')))
      return
    }
    const text = query.trim()
    try {
      setMessages((await client.search({ limit: 30, ...(text ? { query: text } : {}),
        ...(selectedAccountId ? { accountId: selectedAccountId } : {}) })).items)
    } catch (failure) { setError(failure) }
  }
  const openMessage = async message => {
    setError(null)
    try {
      const result = await client.read({ uid: message.uid, folder: message.folder,
        ...(selectedAccountId ? { accountId: selectedAccountId } : {}) })
      setOriginal(result.messages[0] ?? null)
      setReplyBody('')
      replyCommand.current = commandId()
    } catch (failure) { setError(failure) }
  }
  const prepareReply = async event => {
    event.preventDefault()
    if (!original || preparingReplyRef.current) return
    preparingReplyRef.current = true
    setPreparingReply(true)
    setError(null)
    try {
      replyCommand.current ??= commandId()
      const reply = await client.reply({ uid: original.uid, folder: original.folder, body: replyBody,
        replyAll: false, commandId: replyCommand.current,
        ...(selectedAccountId ? { accountId: selectedAccountId } : {}) })
      setReplyBody('')
      replyCommand.current = commandId()
      await refresh()
      setNotice(reply.status === 'sent' ? t('Reply sent.') : t('Reply is waiting for approval.'))
    } catch (failure) { setError(failure) }
    finally { preparingReplyRef.current = false; setPreparingReply(false) }
  }
  const sendReply = async replyId => {
    if (replyBusyRef.current) return
    replyBusyRef.current = true
    setReplyBusy(replyId)
    setError(null)
    try {
      await client.sendReply({ replyId, commandId: `mail-reply-send:${replyId}` })
      await refresh()
      setNotice(t('Reply sent.'))
    } catch (failure) { setError(failure) }
    finally { replyBusyRef.current = false; setReplyBusy(null) }
  }
  const discardReply = async replyId => {
    if (replyBusyRef.current) return
    replyBusyRef.current = true
    setReplyBusy(replyId)
    setError(null)
    try {
      await client.cancelReply(replyId, `mail-reply-cancel:${replyId}`)
      await refresh()
      setNotice(t('Reply discarded.'))
    } catch (failure) { setError(failure) }
    finally { replyBusyRef.current = false; setReplyBusy(null) }
  }
  const saveMailAccount = async event => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const chosenProvider = String(data.get('provider') ?? '')
    const address = String(data.get('address') ?? '')
    const password = String(data.get('password') ?? '')
    const account = { address, password, ...(chosenProvider ? { provider: chosenProvider } : {}) }
    if (chosenProvider === 'other') {
      const imapHost = String(data.get('imapHost') ?? '').trim()
      const smtpHost = String(data.get('smtpHost') ?? '').trim()
      const imapPort = Number(data.get('imapPort'))
      const smtpPort = Number(data.get('smtpPort'))
      if (!imapHost || !smtpHost || !Number.isSafeInteger(imapPort) || !Number.isSafeInteger(smtpPort)) {
        setError(new Error(t('Enter both mail servers and their ports.')))
        return
      }
      const imapStarttls = String(data.get('imapSecurity') ?? '') === 'starttls'
      const smtpStarttls = String(data.get('smtpSecurity') ?? '') === 'starttls'
      account.imap = { host: imapHost, port: imapPort, secure: !imapStarttls,
        ...(imapStarttls ? { starttls: true } : {}) }
      account.smtp = { host: smtpHost, port: smtpPort, secure: !smtpStarttls,
        ...(smtpStarttls ? { starttls: true } : {}) }
    }
    setError(null)
    try {
      await client.saveMailAccount(account)
      form.reset()
      setProvider('')
      await refresh()
      setNotice(t('Mail account saved.'))
    } catch (failure) { setError(failure) }
  }
  const saveRule = async event => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    setError(null)
    try {
      await client.saveRule({ mode: String(data.get('mode') ?? 'require-approval'),
        recipients: String(data.get('recipients') ?? '').split(/[,;]+/u).map(value => value.trim()).filter(Boolean) })
      await refresh()
      setNotice(t('Sending rule saved.'))
    } catch (failure) { setError(failure) }
  }
  const scanImport = async () => {
    setError(null)
    try { setImportSources(await client.importScan()) }
    catch (failure) { setError(failure) }
  }
  const commitImport = async sourceId => {
    setError(null)
    try {
      await client.importCommit(sourceId)
      setImportSources(null)
      await refresh()
      setNotice(t('Connector imported.'))
    } catch (failure) { setError(failure) }
  }

  const connectorItems = (connectors?.items ?? []).filter(item => item.id !== 'mail')
  return h('section', { className: 'pc-root' },
    h('div', { className: 'pc-head' },
      h('div', null, h('h3', null, t('Connectors and mailbox')),
        h('p', null, local
          ? t('Authorization and mail actions stay on this Host. Tokens are never shown again after saving.')
          : canCommand ? t('This client can read connections and send approved mail replies. Connector administration stays on the Host.')
            : t('This client has read-only access to connections and mailbox history.'))),
      h(Button, { onClick: () => void refresh() }, t('Refresh'))),
    h(TargetFields, { target, onChange: onTargetChange }),
    local && onTargetChange && feishuSource?.sourceInstanceId ? h('div', { className: 'pc-source' },
      h(Button, { onClick: () => onTargetChange({ role: 'main', sourceInstanceId: feishuSource.sourceInstanceId }) },
        t('Use Feishu source')),
      h('span', { className: 'pc-hint' }, feishuSource.sourceInstanceId))
      : local && onTargetChange && feishuSource && !feishuSource.sourceInstanceId
        ? h('p', { className: 'pc-hint' }, t('Configure a Feishu source before authorizing it here.')) : null,
    h('div', { className: 'pc-tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', id: 'pc-tab-connectors', 'aria-controls': 'pc-panel-connectors',
        'aria-selected': tab === 'connectors', onClick: () => setTab('connectors') }, t('Connectors')),
      h('button', { type: 'button', role: 'tab', id: 'pc-tab-mail', 'aria-controls': 'pc-panel-mail',
        'aria-selected': tab === 'mail', onClick: () => setTab('mail') }, t('Mailbox'))),
    h(ErrorNotice, { error }),
    h(Notice, null, notice),
    tab === 'connectors' ? h('div', { className: 'pc-body', id: 'pc-panel-connectors', role: 'tabpanel',
      'aria-labelledby': 'pc-tab-connectors' },
      h('div', { className: 'pc-toolbar' },
        local ? h(Button, { onClick: () => setCustom(value => !value) }, t('Custom connector')) : null,
        local ? h(Button, { onClick: () => void scanImport() }, t('Import')) : null),
      local && custom ? h(CustomConnector, { client, onChanged: refresh, run }) : null,
      local && importSources !== null ? h('section', { className: 'pc-panel' },
        h('strong', null, t('MCP configurations found')),
        importSources.length === 0 ? h('p', null, t('No connector configuration was found.')) : null,
        importSources.map(source => h('div', { key: source.id, className: 'pc-row' },
          h('span', null, `${source.name} · ${source.source}`,
            source.envNames.length || source.headerNames.length
              ? h('small', null, ` · ${[...source.envNames, ...source.headerNames].join(', ')}`) : null),
          h(Button, { onClick: () => void commitImport(source.id) }, t('Import'))))) : null,
      connectorItems.map(item => h(ConnectorCard, { key: item.id, item, client, onChanged: refresh, run, local })))
      : h('div', { className: 'pc-body', id: 'pc-panel-mail', role: 'tabpanel', 'aria-labelledby': 'pc-tab-mail' },
        mail?.available === false ? h('p', { className: 'pc-notice pc-error', role: 'alert' },
          t('Mail is unavailable on this Host. Add a mail transport, then reload.')) : null,
        h('section', { className: 'pc-panel' },
          h('strong', null, t('Mail accounts')),
          mail?.accounts?.length ? mail.accounts.map(account => h('div', { key: account.id, className: 'pc-row' },
            h('span', null, account.address, h('small', null, ` · ${t(account.state === 'ready' ? 'Ready' : 'Needs authorization')}`)),
            local ? h(Button, { onClick: async () => {
              setError(null)
              try { await client.removeMailAccount(account.id); await refresh() }
              catch (failure) { setError(failure) }
            } }, t('Remove')) : null)) : h('p', null, t('No mail account is connected.'))),
        local && mailAvailable ? h('form', { className: 'pc-panel', onSubmit: saveMailAccount },
          h('strong', null, t('Add a mail account')),
          h('input', { name: 'address', type: 'email', placeholder: t('Mailbox address'), autoComplete: 'username' }),
          h('label', null, t('Provider'),
            h('select', { name: 'provider', value: provider, onChange: event => setProvider(event.target.value) },
              h('option', { value: '' }, t('Detect from address')),
              h('option', { value: 'qq' }, 'QQ Mail'),
              h('option', { value: '163' }, '163 Mail'),
              h('option', { value: '126' }, '126 Mail'),
              h('option', { value: 'gmail' }, 'Gmail'),
              h('option', { value: 'icloud' }, 'iCloud Mail'),
              h('option', { value: 'other' }, t('Other IMAP/SMTP')))),
          provider === 'other' ? h('div', { className: 'pc-server-fields' },
            h('label', null, t('IMAP host'), h('input', { name: 'imapHost', placeholder: 'imap.example.com', spellCheck: false })),
            h('label', null, t('IMAP port'), h('input', { name: 'imapPort', type: 'number', min: 1, max: 65535, defaultValue: 993 })),
            h('label', null, t('IMAP security'), h('select', { name: 'imapSecurity', defaultValue: 'tls' },
              h('option', { value: 'tls' }, t('Implicit TLS')),
              h('option', { value: 'starttls' }, 'STARTTLS'))),
            h('label', null, t('SMTP host'), h('input', { name: 'smtpHost', placeholder: 'smtp.example.com', spellCheck: false })),
            h('label', null, t('SMTP port'), h('input', { name: 'smtpPort', type: 'number', min: 1, max: 65535, defaultValue: 465 })),
            h('label', null, t('SMTP security'), h('select', { name: 'smtpSecurity', defaultValue: 'tls' },
              h('option', { value: 'tls' }, t('Implicit TLS')),
              h('option', { value: 'starttls' }, 'STARTTLS')))) : null,
          h('input', { name: 'password', type: 'password', placeholder: t('App password or authorization code'), autoComplete: 'current-password' }),
          h(Button, { type: 'submit', kind: 'primary', disabled: !mailAvailable }, t('Save account'))) : null,
        local && mailAvailable ? h('form', { className: 'pc-panel', onSubmit: saveRule },
          h('strong', null, t('Sending rule')),
          h('select', { name: 'mode', defaultValue: mail?.rule?.mode ?? 'require-approval' },
            h('option', { value: 'require-approval' }, t('Require approval')),
            h('option', { value: 'allow-recipients' }, t('Allow listed recipients')),
            h('option', { value: 'direct' }, t('Send directly'))),
          h('input', { name: 'recipients', defaultValue: (mail?.rule?.recipients ?? []).join(', '),
            placeholder: t('Allowed recipients, comma separated') }),
          h(Button, { type: 'submit' }, t('Save rule'))) : h('section', { className: 'pc-panel' },
          h('strong', null, t('Sending rule')),
          h('p', null, `${t(mail?.rule?.mode ?? 'require-approval')}: ${(mail?.rule?.recipients ?? []).join(', ') || t('No recipients')}`)),
        canRead && mailAvailable ? h('div', { className: 'pc-mail-search' },
          mail?.accounts?.length > 1 ? h('label', null, t('Mail account'),
            h('select', { value: selectedAccountId, onChange: event => {
              setAccountId(event.target.value)
              setMessages([])
              setOriginal(null)
              replyCommand.current = null
            } },
            h('option', { value: '' }, t('Choose a mail account')),
            mail.accounts.map(account => h('option', { key: account.id, value: account.id },
              `${account.address} · ${t(account.state === 'ready' ? 'Ready' : 'Needs authorization')}`)))) : null,
          h('form', { className: 'pc-row', onSubmit: search },
            h('input', { type: 'search', value: query, placeholder: t('Search mail'),
              onChange: event => setQuery(event.target.value) }),
            h(Button, { type: 'submit', kind: 'primary', disabled: mail?.accounts?.length > 1 && !selectedAccountId },
              t('Search'))),
          messages.map(message => h('button', { key: `${message.folder}:${message.uid}`, type: 'button',
            className: 'pc-mail-row', onClick: () => void openMessage(message) },
            h('strong', null, message.subject || t('(no subject)')),
            h('span', null, `${message.from} · ${message.date}`)))) : null,
        original ? h('section', { className: 'pc-panel' },
          h('strong', null, original.subject),
          h('p', { className: 'pc-mail-from' }, `${original.from} → ${original.to}`),
          h('pre', { className: 'pc-mail-body' }, original.text),
          canCommand ? h('form', { onSubmit: prepareReply },
            h('textarea', { value: replyBody, rows: 6, placeholder: t('Reply body'),
              onChange: event => setReplyBody(event.target.value) }),
            h(Button, { type: 'submit', kind: 'primary', disabled: preparingReply || !replyBody.trim() },
              t(preparingReply ? 'Preparing…' : 'Prepare reply'))) : null) : null,
        mail?.replies?.length ? h('section', { className: 'pc-panel' },
          h('strong', null, t('Pending replies')),
          mail.replies.map(reply => h('div', { key: reply.replyId, className: 'pc-reply' },
            h('p', null, `${reply.to} · ${reply.subject}`),
            h('pre', { className: 'pc-mail-body' }, reply.body),
            canCommand ? h('div', { className: 'pc-row' },
              h(Button, { kind: 'primary', disabled: Boolean(replyBusy),
                onClick: () => void sendReply(reply.replyId) }, t('Send')),
              h(Button, { disabled: Boolean(replyBusy),
                onClick: () => void discardReply(reply.replyId) }, t('Discard'))) : null))) : null))
}

export const PRODUCT_CONNECTORS_CSS = `
.pc-root{display:flex;flex-direction:column;gap:14px;color:var(--bt-ink,inherit)}
.pc-head,.pc-row,.pc-toolbar,.pc-tabs{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-head{justify-content:space-between}.pc-head h3,.pc-card h4{margin:0}
.pc-head p{margin:4px 0 0;color:var(--bt-ink-3,color-mix(in srgb,currentColor 65%,transparent));font-size:12px}
.pc-tabs button{border:0;border-radius:999px;padding:5px 12px;background:var(--bt-hover,color-mix(in srgb,currentColor 8%,transparent));color:inherit}
.pc-tabs button[aria-selected=true]{background:var(--bt-ink,currentColor);color:var(--bt-main,Canvas)}
.pc-body{display:flex;flex-direction:column;gap:12px}
.pc-card,.pc-panel{border:1px solid var(--bt-line,color-mix(in srgb,currentColor 18%,transparent));border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px}
.pc-card-head{display:flex;justify-content:space-between;gap:12px}.pc-card p{margin:2px 0 0;font-size:12px;color:var(--bt-ink-3,color-mix(in srgb,currentColor 65%,transparent))}
.pc-card[data-status=error]{border-color:var(--bt-danger,currentColor)}
.pc-status,.pc-tag{font-size:11px;border-radius:999px;padding:2px 7px;background:var(--bt-hover,color-mix(in srgb,currentColor 8%,transparent))}
.pc-row>input,.pc-card input,.pc-panel input,.pc-panel select,.pc-panel textarea{flex:1;min-width:140px;border:1px solid var(--bt-line,color-mix(in srgb,currentColor 18%,transparent));border-radius:8px;padding:7px 9px;background:var(--bt-card,Canvas);color:inherit;font:inherit}
.pc-panel label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.pc-panel textarea{width:100%;resize:vertical}.pc-button{border:1px solid var(--bt-line,color-mix(in srgb,currentColor 18%,transparent));border-radius:999px;padding:5px 11px;background:var(--bt-card,Canvas);color:inherit;font:inherit;cursor:pointer}
.pc-button:disabled{opacity:.5;cursor:default}.pc-button-primary{background:var(--bt-ink,currentColor);color:var(--bt-main,Canvas);border-color:transparent}.pc-button-danger{color:var(--bt-danger,currentColor)}
.pc-notice{border-radius:8px;padding:8px 10px;background:var(--bt-hover,color-mix(in srgb,currentColor 8%,transparent));font-size:12px}.pc-error{color:var(--bt-danger,currentColor)}
.pc-check{display:inline-flex;align-items:center;gap:6px;font-size:12px}.pc-check input{flex:none;min-width:0}
.pc-pending{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}.pc-pending a{color:inherit}
.pc-target{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.pc-target label{display:flex;flex-direction:column;gap:4px;font-size:11px}
.pc-target input,.pc-target select{border:1px solid var(--bt-line,color-mix(in srgb,currentColor 18%,transparent));border-radius:8px;padding:6px 8px;background:var(--bt-card,Canvas);color:inherit;font:inherit}
.pc-source{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pc-hint{color:var(--bt-ink-3,color-mix(in srgb,currentColor 65%,transparent));font-size:12px;overflow-wrap:anywhere}
.pc-server-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.pc-mail-search{display:flex;flex-direction:column;gap:8px}.pc-reply{border-top:1px solid var(--bt-line,color-mix(in srgb,currentColor 18%,transparent));padding-top:10px;display:flex;flex-direction:column;gap:8px}.pc-reply:first-of-type{border-top:0;padding-top:0}
.pc-mail-row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:0;border-bottom:1px solid var(--bt-line,color-mix(in srgb,currentColor 18%,transparent));background:none;color:inherit;padding:8px 2px;text-align:left;font:inherit;cursor:pointer}
.pc-mail-row span,.pc-mail-from{font-size:11px;color:var(--bt-ink-3,color-mix(in srgb,currentColor 65%,transparent))}.pc-mail-body{white-space:pre-wrap;max-height:260px;overflow:auto;font:12px/1.5 ui-monospace,monospace;margin:0}
@media (max-width:720px){.pc-target,.pc-server-fields{grid-template-columns:1fr 1fr}}@media (max-width:460px){.pc-target,.pc-server-fields{grid-template-columns:1fr}}
`
