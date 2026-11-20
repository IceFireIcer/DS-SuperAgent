import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { EmptyState, FieldRow, InlineNotice, SectionCard, StatusChip } from './product-settings-components.js'

const connectorNames = { github: 'GitHub', feishu: 'Feishu' }
const connectorStates = {
  'not-configured': 'Not configured', configured: 'Ready to authorize', authorized: 'Authorized',
  expired: 'Authorization expired', 'credential-unavailable': 'Credential unavailable',
}
const oauthStates = {
  CONNECTOR_OAUTH_DENIED: 'Authorization was cancelled at the provider.',
  CONNECTOR_OAUTH_UNAVAILABLE: 'The local authorization port is unavailable.',
  CONNECTOR_OAUTH_BUSY: 'Finish or cancel the current authorization first.',
  CONNECTOR_OAUTH_FAILED: 'Authorization failed. Check the OAuth app and callback URL.',
  CONNECTOR_LOGIN_NOT_FOUND: 'Start a new authorization on this Host.',
  CONNECTOR_NOT_CONFIGURED: 'Save the OAuth app before authorizing it.',
  CONNECTOR_IMPORT_FAILED: 'The provider could not verify the selected credential.',
  CONNECTOR_IMPORT_UNAVAILABLE: 'Import is available in the desktop app.',
  CONNECTOR_SCOPE_DENIED: 'The provider grant does not cover the configured repository or tenant.',
  CONNECTOR_VAULT_UNAVAILABLE: 'This Host has no secure credential store.',
  RESOURCE_UNAVAILABLE: 'The stored credential is unavailable.',
  CONFIG_REVISION_CONFLICT: 'The settings changed. Reload them before saving again.',
  SOURCE_NOT_AUTHORIZED: 'Open these settings on the Host to continue.',
  MAILBOX_CONNECTION_FAILED: 'Check the mail server settings and credentials.',
  MAILBOX_HOST_DENIED: 'Use a public mail server hostname.',
  MAILBOX_NOT_FOUND: 'The selected mailbox account is unavailable.',
  MAILBOX_RULE_NOT_FOUND: 'The selected mailbox rule is unavailable.',
  MAILBOX_BUSY: 'Wait for the current mailbox operation to finish.',
  MAILBOX_LIMIT: 'The mailbox settings limit has been reached.',
  MAILBOX_MESSAGE_STALE: 'Refresh the inbox before replying to this message.',
  MAILBOX_REPLY_UNKNOWN: 'Delivery could not be confirmed. Check Sent mail before starting another reply.',
  CREDENTIAL_WRITE_FAILED: 'The credential could not be saved.',
}

function failureMessage(failure) {
  if (failure?.code === 'INVALID_INPUT' && typeof failure.message === 'string') return failure.message
  return t(oauthStates[failure?.code] ?? 'Could not finish the request. Check the Host connection and try again.')
}

function Action({ label, action, disabled, submit = false, danger = false }) {
  return h('button', { type: submit ? 'submit' : 'button', className: `bt-soft${danger ? ' bt-bs-danger' : ''}`,
    disabled, onClick: action ? () => { void action() } : undefined }, t(label))
}

function Field({ label, hint, value, update, type = 'text', required, disabled, maxLength, autoComplete, min, max }) {
  return h(FieldRow, { label: t(label), hint: hint ? t(hint) : undefined,
    control: h('input', { className: 'bt-bs-input', type, value, required, disabled, maxLength, autoComplete, min, max,
      onChange: event => update(event.target.value) }) })
}

function selectControl(value, onChange, options, disabled) {
  return h('select', { className: 'bt-bs-input', value, disabled, onChange: event => onChange(event.target.value) },
    options.map(([id, label]) => h('option', { key: id, value: id }, label)))
}

function SourceConnectionControl({ provider, instanceId, call, run, locked }) {
  const [status, setStatus] = useState(null)
  const [readFailed, setReadFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const value = await call(`${provider}-status`, { instanceId }, controller.signal)
        if (!controller.signal.aborted) { setStatus(value); setReadFailed(false) }
      } catch {
        if (!controller.signal.aborted) setReadFailed(true)
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [provider, instanceId, call])
  if (readFailed) return h(InlineNotice, { tone: 'danger' }, t('Could not read source status.'))
  if (!status?.configured) return null
  const running = status.state === 'polling' || status.state === 'setup'
  const label = ({ polling: 'Receiving messages', setup: 'Connecting', stopped: 'Stopped', failed: 'Needs attention' })[status.state] ?? 'Idle'
  const toggle = () => run(async () => setStatus(await call(`${provider}-${running ? 'stop' : 'start'}`, { instanceId })))
  return h(FieldRow, { label: t('Source status'), hint: status.lastError ? failureMessage({ code: status.lastError }) : null,
    control: h('div', { className: 'bt-ps-actions' }, h(StatusChip, { tone: running ? 'success' : status.lastError ? 'warn' : 'neutral' }, t(label)),
      h(Action, { label: running ? 'Stop source' : 'Start source', disabled: locked, action: toggle })) })
}

function OAuthApp({ provider, item, canStore, canImport, readOnly, locked, login, run, invoke, reload, setLogin, credentialImportBridge, call, instanceId }) {
  const [editing, setEditing] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [repositoryAccess, setRepositoryAccess] = useState('public')
  const [batch, setBatch] = useState(null)
  const [selected, setSelected] = useState('')
  const trustedLink = login?.provider === provider && login.openUrl
    && /^http:\/\/127\.0\.0\.1:\d{1,5}\/superagent\/oauth\/open\/[\da-f-]{36}$/u.test(login.openUrl) ? login.openUrl : null
  const start = () => run(async () => setLogin(await invoke('connector-auth', { action: 'start', provider })))
  const cancel = () => run(async () => setLogin(await invoke('connector-auth', { action: 'cancel', provider, loginId: login.loginId })))
  const disconnect = () => run(async () => {
    await invoke('connector-auth', { action: 'disconnect', provider, commandId: crypto.randomUUID(), expectedRevision: item.revision })
    await reload()
  }, 'Provider disconnected.')
  const save = event => {
    event.preventDefault()
    void run(async () => {
      const secret = clientSecret
      setClientSecret('')
      await invoke('connector-save', { provider, commandId: crypto.randomUUID(), expectedRevision: item.revision, clientId,
        ...(secret ? { clientSecret: secret } : {}), ...(item.repository ? { repositoryAccess } : {}) })
      setEditing(false)
      await reload()
    }, 'OAuth app saved.')
  }
  const pick = () => run(async () => {
    const choice = await credentialImportBridge.pick()
    if (choice.canceled) return
    if (choice.error) throw Object.assign(new Error(), { code: 'CONNECTOR_IMPORT_FAILED' })
    if (batch) await credentialImportBridge.cancel(batch.id)
    const entries = choice.preview.entries.filter(entry => entry.type === 'token')
    if (!entries.length) {
      await credentialImportBridge.cancel(choice.id)
      throw Object.assign(new Error(), { code: 'CONNECTOR_IMPORT_FAILED' })
    }
    setBatch({ id: choice.id, entries })
    setSelected(entries[0].id)
  })
  const importSelected = () => run(async () => {
    const entry = batch.entries.find(value => value.id === selected)
    if (!entry) return
    await invoke('connector-import', { provider, commandId: crypto.randomUUID(), expectedRevision: item.revision,
      pendingId: batch.id, sourceRef: entry.sourceRef, credentialId: entry.id })
    setBatch(null)
    await reload()
  }, 'Credential authorized.')
  const closeImport = () => run(async () => { await credentialImportBridge.cancel(batch.id); setBatch(null) })
  const authorizing = login?.state === 'pending'
  const disabled = locked || authorizing

  return h(SectionCard, { title: connectorNames[provider] },
    h(FieldRow, { label: t('Connection status'), control: h(StatusChip,
      { tone: item.state === 'authorized' ? 'success' : item.state === 'expired' ? 'warn' : 'neutral' },
      t(connectorStates[item.state] ?? 'Unavailable')) }),
    item.repository ? h(FieldRow, { label: t('GitHub source repository'), hint: item.repository,
      control: h(StatusChip, null, t(item.repositoryAccess === 'private' ? 'Private repository access' : 'Public repository access')) }) : null,
    item.sourceConfigured && !readOnly ? h(SourceConnectionControl, { provider, instanceId, call, run, locked }) : null,
    item.redirectUri ? h(FieldRow, { label: t('OAuth callback URL'), hint: t('Register this URL with your OAuth app.'),
      control: h('code', null, item.redirectUri) }) : null,
    h(FieldRow, { label: t('OAuth app'), hint: item.clientId || t('Set up a provider OAuth app to authorize this connection.'),
      control: h('div', { className: 'bt-ps-actions' },
        h(Action, { label: editing ? 'Close' : 'Configure OAuth', disabled: disabled || !canStore, action: () => {
          setClientId(item.clientId ?? ''); setClientSecret(''); setRepositoryAccess(item.repositoryAccess ?? 'public'); setEditing(!editing)
        } }),
        h(Action, { label: 'Authorize', action: start, disabled: disabled || !canStore || !item.hasClientSecret }),
        item.authorization ? h(Action, { label: 'Disconnect', action: disconnect, disabled: disabled || !canStore, danger: true }) : null) }),
    editing ? h('form', { onSubmit: save, 'aria-label': t('{provider} OAuth app', { provider: connectorNames[provider] }) },
      h(Field, { label: 'OAuth client ID', value: clientId, update: setClientId, required: true, maxLength: 160, disabled }),
      h(Field, { label: 'OAuth client secret', value: clientSecret, update: setClientSecret, type: 'password',
        autoComplete: 'new-password', required: !item.hasClientSecret || item.clientId !== clientId,
        hint: item.hasClientSecret ? 'Leave blank to keep the saved secret.' : undefined, maxLength: 4096, disabled }),
      item.repository ? h(FieldRow, { label: t('GitHub repository permissions'),
        hint: repositoryAccess === 'private' ? t('GitHub grants the OAuth app access to your private repositories. This Host uses the configured repository.') : null,
        control: selectControl(repositoryAccess, setRepositoryAccess, [['public', t('Public repositories')], ['private', t('Private repositories')]], disabled) }) : null,
      h(FieldRow, { label: t('Save OAuth settings'), control: h(Action, { label: 'Save', submit: true, disabled }) })) : null,
    authorizing && login.provider === provider ? h(InlineNotice, { title: t('Authorization pending'), action: [
      trustedLink ? h('a', { href: trustedLink, target: '_blank', rel: 'noreferrer', className: 'bt-soft', key: 'open' },
        t('Open provider authorization')) : null,
      h(Action, { key: 'cancel', label: 'Cancel', action: cancel, disabled: locked }),
    ] }, t('Complete authorization in the browser on this Host.')) : null,
    h(FieldRow, { label: t('Import a credential'), hint: t(canImport && credentialImportBridge
      ? 'Choose a token from a credential export.' : 'Import is available in the desktop app.'),
    control: h(Action, { label: 'Choose export', action: pick, disabled: disabled || !canImport || !credentialImportBridge }) }),
    batch ? h(FieldRow, { label: t('Exported token'), control: h('div', { className: 'bt-ps-actions' },
      h('label', null, h('span', { className: 'bt-ps-description' }, t('Exported token')),
        selectControl(selected, setSelected, batch.entries.map(entry => [entry.id, entry.label]), disabled)),
      h(Action, { label: 'Verify and import', action: importSelected, disabled }),
      h(Action, { label: 'Cancel', action: closeImport, disabled })) }) : null)
}

function draftAccount(account) {
  return { label: account?.label ?? '', email: account?.email ?? '', username: account?.username ?? '',
    incomingHost: account?.incoming.host ?? '', incomingPort: String(account?.incoming.port ?? 993),
    outgoingHost: account?.outgoing.host ?? '', outgoingPort: String(account?.outgoing.port ?? 465),
    security: account?.outgoing.security ?? 'tls', password: '' }
}

function AccountForm({ account, run, invoke, reload, close, disabled }) {
  const [draft, setDraft] = useState(() => draftAccount(account))
  const [confirm, setConfirm] = useState(false)
  const change = (name, value) => setDraft(current => ({ ...current, [name]: value }))
  const field = (name, label, extras = {}) => h(Field, { key: name, label, value: draft[name], update: value => change(name, value),
    disabled, required: true, ...extras })
  const save = event => {
    event.preventDefault()
    void run(async () => {
      const password = draft.password
      change('password', '')
      await invoke('mailbox-account', { action: 'save', commandId: crypto.randomUUID(), expectedRevision: account?.revision ?? 0,
        ...(account ? { accountId: account.id } : {}), ...(password ? { password } : {}),
        account: { label: draft.label, email: draft.email, username: draft.username,
          incoming: { host: draft.incomingHost, port: Number(draft.incomingPort) },
          outgoing: { host: draft.outgoingHost, port: Number(draft.outgoingPort), security: draft.security } } })
      close(); await reload()
    }, 'Mailbox settings saved.')
  }
  const remove = () => run(async () => {
    await invoke('mailbox-account', { action: 'remove', accountId: account.id, commandId: crypto.randomUUID(), expectedRevision: account.revision })
    close(); await reload()
  }, 'Mailbox removed.')
  return h(SectionCard, { title: t(account ? 'Edit mailbox' : 'Add mailbox') },
    h('form', { onSubmit: save, 'aria-label': t(account ? 'Edit mailbox' : 'Add mailbox') },
      field('label', 'Mailbox name', { maxLength: 100 }), field('email', 'Email address', { type: 'email', maxLength: 254 }),
      field('username', 'Mail username', { maxLength: 254 }), field('incomingHost', 'IMAP hostname', { maxLength: 253 }),
      field('incomingPort', 'IMAP over TLS port', { type: 'number', min: 1, max: 65535 }),
      field('outgoingHost', 'SMTP hostname', { maxLength: 253 }), field('outgoingPort', 'SMTP port', { type: 'number', min: 1, max: 65535 }),
      h(FieldRow, { label: t('SMTP security'), control: selectControl(draft.security, value => {
        change('security', value)
        if (draft.outgoingPort === '465' || draft.outgoingPort === '587') change('outgoingPort', value === 'tls' ? '465' : '587')
      }, [['tls', 'TLS'], ['starttls', 'STARTTLS']], disabled) }),
      field('password', 'Mail password', { type: 'password', autoComplete: 'new-password', maxLength: 4096, required: !account,
        hint: account ? 'Enter the password again when changing server settings.' : undefined }),
      h(FieldRow, { label: t('Mailbox settings'), control: h('div', { className: 'bt-ps-actions' },
        h(Action, { label: 'Save', submit: true, disabled }), h(Action, { label: 'Cancel', action: close, disabled }),
        account ? h(Action, { label: confirm ? 'Confirm mailbox removal' : 'Remove mailbox', action: confirm ? remove : () => setConfirm(true),
          danger: true, disabled }) : null) })))
}

function RuleForm({ rule, accountId, save, remove, editing, disabled, close }) {
  const [label, setLabel] = useState(rule?.label ?? '')
  const [sender, setSender] = useState(rule?.sender ?? '')
  const [subjectContains, setSubject] = useState(rule?.subjectContains ?? '')
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  return h('form', { 'aria-label': t(editing ? 'Edit mailbox rule' : 'Add mailbox rule'), onSubmit: event => {
    event.preventDefault()
    void save(accountId, rule, { label, sender, subjectContains, enabled })
  } },
  h(Field, { label: 'Rule name', value: label, update: setLabel, required: true, maxLength: 100, disabled }),
  h(Field, { label: 'Sender address', value: sender, update: setSender, type: 'email', maxLength: 254, disabled }),
  h(Field, { label: 'Subject contains', value: subjectContains, update: setSubject, maxLength: 200, disabled }),
  h(FieldRow, { label: t('Rule active'), control: h('input', { type: 'checkbox', checked: enabled,
    disabled, onChange: event => setEnabled(event.target.checked) }) }),
  h(FieldRow, { label: t('Rule settings'), control: h('div', { className: 'bt-ps-actions' },
    h(Action, { label: 'Save rule', submit: true, disabled: disabled || !(sender.trim() || subjectContains.trim()) }),
    h(Action, { label: 'Cancel', action: close, disabled }),
    editing ? h(Action, { label: confirmRemoval ? 'Confirm rule removal' : 'Remove rule',
      action: confirmRemoval ? () => remove(accountId, rule) : () => setConfirmRemoval(true), disabled, danger: true }) : null) }))
}

function ReplyForm({ item, send, close, disabled }) {
  const [text, setText] = useState('')
  const [confirm, setConfirm] = useState(false)
  return h('form', { 'aria-label': t('Reply to message'), onSubmit: event => {
    event.preventDefault()
    if (confirm) void send(text)
    else setConfirm(true)
  } },
  h(FieldRow, { label: t('Reply recipient'), control: h('strong', null, item.replyTo) }),
  h(FieldRow, { label: t('Reply text'), layout: 'stack', control: h('textarea', { className: 'bt-bs-input', rows: 4,
    required: true, maxLength: 8000, value: text, disabled,
    onChange: event => { setText(event.target.value); setConfirm(false) } }) }),
  h(FieldRow, { label: t('Mail reply'), control: h('div', { className: 'bt-ps-actions' },
    h(Action, { label: confirm ? 'Confirm send reply' : 'Review reply', submit: true, disabled: disabled || !text.trim() }),
    h(Action, { label: 'Cancel', action: close, disabled })) }))
}

function MailboxSettings({ state, invoke, run, locked, reload }) {
  const [selected, setSelected] = useState(null)
  const [editor, setEditor] = useState(null)
  const [rules, setRules] = useState(null)
  const [ruleEditor, setRuleEditor] = useState(null)
  const [messages, setMessages] = useState(null)
  const [reply, setReply] = useState(null)
  const account = state.items.find(item => item.id === selected) ?? state.items[0] ?? null
  const readOnly = Boolean(state.readOnly)
  const refreshRules = async accountId => setRules((await invoke('mailbox-rule', { action: 'list', accountId })).items)

  useEffect(() => {
    const controller = new AbortController()
    setRules(null); setMessages(null); setReply(null); setRuleEditor(null)
    if (account?.id) void invoke('mailbox-rule', { action: 'list', accountId: account.id }, controller.signal)
      .then(result => setRules(result.items)).catch(() => { if (!controller.signal.aborted) setRules(false) })
    return () => controller.abort()
  }, [account?.id, account?.revision])

  const check = () => run(async () => {
    await invoke('mailbox-account', { action: 'check', accountId: account.id })
  }, 'IMAP and SMTP connected.')
  const read = () => run(async () => {
    setReply(null)
    setMessages((await invoke('mailbox-reply', { action: 'inbox', accountId: account.id })).items)
  })
  const saveRule = (accountId, rule, draft) => run(async () => {
    await invoke('mailbox-rule', { action: 'save', accountId, commandId: crypto.randomUUID(), expectedRevision: rule?.revision ?? 0,
      ...(rule ? { ruleId: rule.id } : {}), rule: draft })
    setRuleEditor(null); setMessages(null); setReply(null); await refreshRules(accountId)
  }, 'Mailbox rule saved.')
  const removeRule = (accountId, rule) => run(async () => {
    await invoke('mailbox-rule', { action: 'remove', accountId, ruleId: rule.id, expectedRevision: rule.revision, commandId: crypto.randomUUID() })
    setRuleEditor(null); setMessages(null); setReply(null); await refreshRules(accountId)
  }, 'Mailbox rule removed.')
  const send = text => run(async () => {
    try {
      await invoke('mailbox-reply', { action: 'send', accountId: account.id, messageKey: reply.key, commandId: crypto.randomUUID(), text })
    } catch (error) {
      if (error?.code !== 'MAILBOX_REPLY_UNKNOWN' && error?.code !== 'MAILBOX_MESSAGE_STALE') throw error
      setMessages(null); setReply(null)
      throw error
    }
    setMessages(current => current.map(item => item.key === reply.key ? { ...item, canReply: false } : item))
    setReply(null)
  }, 'Reply sent.')

  return h('div', { className: 'bt-ps-content' },
    h(SectionCard, { title: t('Mailbox accounts') },
      account ? h(FieldRow, { label: t('Mailbox account'),
        control: selectControl(account.id, setSelected, state.items.map(item => [item.id, item.email ? `${item.label} · ${item.email}` : item.label]), locked) })
        : h(EmptyState, { title: t('No mailbox accounts'), detail: t('Add an account with TLS-enabled IMAP and SMTP servers.') }),
      h(FieldRow, { label: t('Manage mailboxes'), control: h('div', { className: 'bt-ps-actions' },
        h(Action, { label: 'Add mailbox', action: () => setEditor('new'), disabled: locked || !state.canStoreCredentials }),
        account ? h(Action, { label: 'Edit mailbox', action: () => setEditor(account.id), disabled: locked || !state.canStoreCredentials }) : null,
        account ? h(Action, { label: 'Check connection', action: check, disabled: locked || !state.canStoreCredentials }) : null) })),
    editor ? h(AccountForm, { key: editor, account: state.items.find(item => item.id === editor), run, invoke, locked,
      reload, close: () => setEditor(null), disabled: locked }) : null,
    account ? h(SectionCard, { title: t('Mailbox rules'), description: t('Rules label incoming messages by sender or subject.') },
      rules === false ? h(InlineNotice, { tone: 'danger', action: h(Action, { label: 'Retry', action: () => run(() => refreshRules(account.id)), disabled: locked }) },
        t('Could not read mailbox rules.')) : rules === null ? h('p', { role: 'status' }, t('Loading mailbox rules…'))
          : rules.length ? rules.map(rule => h(FieldRow, { key: rule.id, label: rule.label, hint: [rule.sender, rule.subjectContains].filter(Boolean).join(' · '),
            control: h('div', { className: 'bt-ps-actions' }, h(StatusChip, { tone: rule.enabled ? 'success' : 'neutral' },
              t(rule.enabled ? 'Enabled' : 'Disabled')), !readOnly ? h(Action, { label: 'Edit rule', action: () => setRuleEditor(rule.id), disabled: locked }) : null) }))
            : h(EmptyState, { title: t('No mailbox rules') }),
      ruleEditor ? h(RuleForm, { key: ruleEditor, rule: (rules || []).find(rule => rule.id === ruleEditor),
        editing: ruleEditor !== 'new', accountId: account.id, save: saveRule, remove: removeRule, disabled: locked, close: () => setRuleEditor(null) })
        : !readOnly ? h(Action, { label: 'Add mailbox rule', action: () => setRuleEditor('new'), disabled: locked }) : null) : null,
    account && !readOnly ? h(SectionCard, { title: t('Inbox') },
      h(FieldRow, { label: t('Latest messages'), control: h(Action, { label: 'Refresh inbox', action: read, disabled: locked }) }),
      messages === null ? null : messages.length ? messages.map(item => h('div', { key: item.key },
        h(FieldRow, { label: item.subject || t('No subject'), hint: [item.from, item.receivedAt ? new Date(item.receivedAt).toLocaleString() : null].filter(Boolean).join(' · '),
          control: h('div', { className: 'bt-ps-actions' }, ...item.rules.map((rule, index) => h(StatusChip, { key: `${index}:${rule}` }, rule)),
            item.canReply ? h(Action, { label: 'Reply', action: () => setReply(item), disabled: locked }) : null) }),
        item.preview ? h('p', { className: 'bt-ps-description' }, item.preview) : null,
        reply?.key === item.key ? h(ReplyForm, { item, send, disabled: locked, close: () => setReply(null) }) : null))
        : h(EmptyState, { title: t('No messages in the inbox') })) : null)
}

export function ConnectorSettings({ binding, call, credentialImportBridge = globalThis.dsSuperagentApp?.browser?.credentialImport }) {
  const [section, setSection] = useState('connectors')
  const [registry, setRegistry] = useState(null)
  const [mailboxes, setMailboxes] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [locked, setLocked] = useState(false)
  const [login, setLogin] = useState(null)
  const pending = useRef(false)
  const instanceId = binding?.instanceId
  const invoke = (endpoint, fields, signal) => call(endpoint, { instanceId, scope: { role: 'main' }, ...fields }, signal)
  const loadRegistry = async signal => {
    const value = await invoke('connector-registry', {}, signal)
    if (signal?.aborted) return
    setRegistry(value)
    if (value.login?.provider) setLogin(value.login)
  }
  const loadMailboxes = async signal => setMailboxes(await invoke('mailbox-account', { action: 'list' }, signal))

  useEffect(() => {
    if (!instanceId) return undefined
    const controller = new AbortController()
    const load = section === 'connectors' ? loadRegistry : loadMailboxes
    void load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failureMessage(failure)) })
    return () => controller.abort()
  }, [instanceId, call, section])

  useEffect(() => {
    if (login?.state !== 'pending') return undefined
    const controller = new AbortController()
    const check = async () => {
      try {
        const next = await invoke('connector-auth', { action: 'status', provider: login.provider, loginId: login.loginId }, controller.signal)
        if (controller.signal.aborted || next.state === 'pending') return
        if (next.state === 'authorized') {
          try { await loadRegistry(controller.signal) }
          catch (failure) { if (!controller.signal.aborted) setError(failureMessage(failure)) }
          if (controller.signal.aborted) return
          setNotice(t('Provider authorized.'))
        } else if (next.state === 'failed') setError(failureMessage({ code: next.error }))
        else if (next.state === 'expired') setError(t('Authorization expired. Start again.'))
        setLogin(next)
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(failureMessage(failure))
        if (failure?.code === 'CONNECTOR_LOGIN_NOT_FOUND' || Date.now() >= login.expiresAt) setLogin(null)
      }
    }
    const timer = setInterval(() => { void check() }, 1200)
    return () => { controller.abort(); clearInterval(timer) }
  }, [instanceId, call, login?.loginId, login?.state])

  const run = async (operation, success) => {
    if (pending.current) return
    pending.current = true
    setLocked(true); setError(null); setNotice(null)
    try {
      await operation()
      if (success) setNotice(t(success))
    } catch (failure) { setError(failureMessage(failure)) }
    finally { pending.current = false; setLocked(false) }
  }
  const switchTo = next => { setError(null); setNotice(null); setSection(next) }
  const current = section === 'connectors' ? registry : mailboxes
  return h('div', { className: 'bt-ps-content' },
    h('div', { className: 'bt-ps-actions', 'aria-label': t('Connection settings') },
      h('button', { type: 'button', className: 'bt-soft', 'aria-pressed': section === 'connectors', disabled: locked,
        onClick: () => switchTo('connectors') }, t('Connectors')),
      h('button', { type: 'button', className: 'bt-soft', 'aria-pressed': section === 'mailboxes', disabled: locked,
        onClick: () => switchTo('mailboxes') }, t('Mailbox'))),
    error ? h(InlineNotice, { tone: 'danger', action: !current ? h(Action, { label: 'Retry', disabled: locked,
      action: () => run(section === 'connectors' ? loadRegistry : loadMailboxes) }) : null }, error) : null,
    notice ? h(InlineNotice, { tone: 'success' }, notice) : null,
    !error && !current ? h('p', { role: 'status' }, t('Loading connection settings…')) : null,
    current && !current.canStoreCredentials ? h(InlineNotice, { tone: 'warn' }, t(current.readOnly
      ? 'Open these settings on the Host to continue.' : 'This Host has no secure credential store.')) : null,
    section === 'connectors' && registry ? registry.items.map(item => h(OAuthApp, { key: item.provider, provider: item.provider,
      item, canStore: registry.canStoreCredentials, canImport: registry.canImport, readOnly: registry.readOnly, locked, login, run, invoke, call, instanceId,
      reload: loadRegistry, setLogin, credentialImportBridge })) : null,
    section === 'mailboxes' && mailboxes ? h(MailboxSettings, { state: mailboxes, invoke, run, locked, reload: loadMailboxes }) : null)
}

export { ConnectorSettings as ProductConnectorSettings }
