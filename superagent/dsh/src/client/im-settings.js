import { createElement as h, useEffect, useRef, useState } from 'react'
import { dateLocale, t } from './i18n.js'
import { EmptyState, FieldRow, InlineNotice, SectionCard, StatusChip } from './product-settings-components.js'

const names = {
  feishu: 'Feishu', dingtalk: 'DingTalk', wecom: 'WeCom', qq: 'QQ',
  wechat: 'WeChat', discord: 'Discord', slack: 'Slack', telegram: 'Telegram',
}
const setup = {
  feishu: 'Use a Feishu app with bot access to an existing direct chat.',
  dingtalk: 'Enable Stream mode and direct bot messaging for this DingTalk app.',
  wecom: 'Use an intelligent bot with long connection enabled.',
  qq: 'Enable direct messages for your QQ bot.',
  discord: 'Use the application bot token and enable direct messages.',
  slack: 'Enable Socket Mode and subscribe to message.im. Grant im:history and chat:write to the bot.',
  telegram: 'Use a bot token from BotFather and disable any existing webhook for the bot.',
}
const statuses = {
  disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected', retrying: 'Reconnecting…',
  'login-expired': 'Sign-in expired', attention: 'Check credentials', 'remove-pending': 'Removal needs attention',
}
const errors = {
  IM_PAIRING_EXPIRED: 'Start a new messaging pairing.',
  IM_ALREADY_PAIRED: 'Revoke the current pairing before pairing another conversation.',
  IM_ACCOUNT_EXISTS: 'Disconnect the existing account before signing in again.',
  IM_AUTH_FAILED: 'The messaging provider rejected the login.',
  UNAVAILABLE: 'Messaging accounts are unavailable on this Host.',
  SOURCE_NOT_AUTHORIZED: 'Messaging accounts can only be managed on the Host.',
}
const button = (label, props = {}) => h('button', { type: 'button', className: 'bt-soft', ...props }, t(label))
const expiresAt = value => t('Expires at {time}', { time: new Date(value).toLocaleTimeString(dateLocale()) })

export function ProductImSettings({ binding, call }) {
  return h(ImSettings, { key: binding.instanceId, instanceId: binding.instanceId, call })
}

function ImSettings({ instanceId, call }) {
  const [accounts, setAccounts] = useState(null)
  const [platform, setPlatform] = useState('feishu')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [readError, setReadError] = useState(null)
  const [clock, setClock] = useState(() => Date.now())
  const mounted = useRef(false)
  const working = useRef(false)
  const reading = useRef(false)
  const revision = useRef(0)
  const invoke = (operation, extra = {}) => call('im-accounts', { instanceId, operation, ...extra })
  const load = async () => {
    if (reading.current || working.current) return
    reading.current = true
    const started = revision.current
    try {
      const result = await invoke('list')
      if (mounted.current && started === revision.current) { setAccounts(result.accounts); setReadError(null) }
    } catch (failure) {
      if (mounted.current && started === revision.current) {
        setReadError(t(errors[failure?.code] ?? 'Could not read messaging accounts.'))
      }
    } finally { reading.current = false }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => { setClock(Date.now()); void load() }, 1500)
    return () => { mounted.current = false; revision.current++; window.clearInterval(timer) }
  }, [call, instanceId])
  const run = async (operation, extra = {}) => {
    if (working.current) return null
    working.current = true
    revision.current++
    setBusy(true)
    setError(null)
    try {
      const result = await invoke(operation, { platform, ...extra })
      if (mounted.current && result?.platform === platform) {
        setAccounts(current => current?.map(account => account.platform === platform ? result : account))
      }
      return result
    } catch (failure) {
      if (mounted.current) setError(t(errors[failure?.code] ?? 'Could not update the messaging account.'))
      return null
    } finally {
      working.current = false
      if (mounted.current) { setBusy(false); setClock(Date.now()); void load() }
    }
  }
  const account = accounts?.find(candidate => candidate.platform === platform)
  return h('div', { className: 'bt-ps-content' },
    readError || error ? h(InlineNotice, { tone: 'danger' }, error ?? readError) : null,
    accounts ? h(SectionCard, { title: t('Messaging accounts') },
      h(FieldRow, { label: t('Platform'), control: h('select', { className: 'bt-bs-input', value: platform, disabled: busy,
        onChange: event => { setPlatform(event.target.value); setError(null) } },
      accounts.map(candidate => h('option', { value: candidate.platform, key: candidate.platform }, t(names[candidate.platform])))) }),
      account ? h(AccountSettings, { key: platform, account, busy, clock, run }) : null)
      : readError ? h(EmptyState, { title: t('Messaging accounts are unavailable.'), action: button('Retry', { onClick: () => void load() }) })
        : h('p', { role: 'status' }, t('Loading…')))
}

function AccountSettings({ account, busy, clock, run }) {
  const [qr, setQr] = useState(null)
  const [pairCode, setPairCode] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const status = account.state
  const wechat = account.platform === 'wechat'
  const candidate = account.pairing?.proposalId
  const confirm = (operation, label, confirmed) => button(confirmation === operation ? confirmed : label, {
    disabled: busy, className: 'bt-soft bt-bs-danger',
    onClick: () => {
      if (confirmation !== operation) { setConfirmation(operation); return }
      setConfirmation(null)
      setPairCode(null)
      void run(operation)
    },
  })
  const credentialForm = event => {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const fields = Object.fromEntries(account.fields.map(field => [field.name, form.elements.namedItem(field.name).value]))
    form.reset()
    void run('connect', { credentials: fields })
  }
  const verifyForm = event => {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const code = form.elements.namedItem('code').value
    form.reset()
    void run('qr-verify', { code })
  }
  const qrActive = qr?.expiresAt > clock && account.qrState !== 'expired' && account.qrState !== 'failed'
  const pairActive = account.pairing?.expiresAt > clock
  return h('div', null,
    h(FieldRow, { label: t('Connection status'), hint: account.loginExpiresAt > clock ? expiresAt(account.loginExpiresAt) : null,
      control: h(StatusChip, { tone: status === 'connected' ? 'accent' : 'neutral' }, t(statuses[status] ?? 'Unavailable')) }),
    account.configured ? h('div', { className: 'bt-ps-content' },
      h(FieldRow, { label: t('Pairing status'), control: h(StatusChip, { tone: account.paired ? 'accent' : 'neutral' },
        t(account.paired ? 'Paired' : 'Not paired')) }),
      account.error ? h(InlineNotice, { tone: 'danger' }, t(errors[account.error] ?? 'The messaging provider is unavailable.')) : null,
      pairActive && pairCode?.expiresAt === account.pairing.expiresAt && !candidate ? h(InlineNotice, { title: t('Send this in a direct message to the bot') },
        h('p', null, h('code', null, `pair ${pairCode.code}`)), h('p', null, expiresAt(pairCode.expiresAt))) : null,
      pairActive && candidate ? h(InlineNotice, { title: t('Approve this direct chat?') },
        h('p', null, t('Sender ID {id}', { id: account.pairing.senderId })),
        button('Approve pairing', { disabled: busy, onClick: () => { setPairCode(null); void run('pair-approve', { proposalId: candidate }) } })) : null,
      h('div', { className: 'bt-ps-actions' },
        status === 'connected' && !account.paired && !pairActive ? button('Start pairing', { disabled: busy,
          onClick: async () => { setConfirmation(null); setPairCode(await run('pair-start')) } }) : null,
        pairActive ? button('Cancel pairing', { disabled: busy,
          onClick: () => { setPairCode(null); void run('pair-cancel') } }) : null,
        account.paired ? confirm('pair-revoke', 'Revoke pairing', 'Confirm revoke pairing') : null,
        status !== 'remove-pending' ? button('Reconnect', { disabled: busy || status === 'connecting',
          onClick: () => { setConfirmation(null); void run('reconnect') } }) : null,
        confirm('disconnect', 'Disconnect', 'Confirm disconnect'),
        confirmation ? button('Cancel', { disabled: busy, onClick: () => setConfirmation(null) }) : null))
      : wechat ? h('div', { className: 'bt-ps-content' },
        qrActive && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(qr.qrImage) ? h(InlineNotice, { title: t('Scan with WeChat') },
          h('img', { src: qr.qrImage, alt: t('WeChat sign-in QR code'), width: 256, height: 256 }),
          h('p', null, expiresAt(qr.expiresAt))) : null,
        account.qrState === 'scanned' ? h(InlineNotice, null, t('Confirm the sign-in on your phone.')) : null,
        account.qrState === 'expired' || qr && qr.expiresAt <= clock ? h(InlineNotice, null, t('Sign-in expired')) : null,
        account.qrState === 'failed' ? h(InlineNotice, { tone: 'danger' }, t('The messaging provider rejected the login.')) : null,
        account.qrState === 'verify' && account.qrExpiresAt > clock ? h('form', { autoComplete: 'off', onSubmit: verifyForm },
          h(FieldRow, { label: t('Verification code'), hint: t('Enter the code shown by WeChat.'),
            control: h('input', { className: 'bt-bs-input', name: 'code', type: 'password', required: true,
              maxLength: 8, pattern: '[0-9]{4,8}', autoComplete: 'one-time-code', inputMode: 'numeric' }) }),
          button('Verify', { type: 'submit', disabled: busy })) : null,
        h('div', { className: 'bt-ps-actions' },
          button('Start WeChat sign-in', { disabled: busy, onClick: async () => { setQr(null); setQr(await run('qr-start')) } }),
          ['waiting', 'scanned', 'verify'].includes(account.qrState) ? button('Cancel sign-in', { disabled: busy,
            onClick: () => { setQr(null); void run('qr-cancel') } }) : null))
        : h('form', { autoComplete: 'off', onSubmit: credentialForm, className: 'bt-ps-content' },
          h('p', { className: 'bt-ps-description' }, t(setup[account.platform])),
          account.fields.map(field => h(FieldRow, { key: field.name, label: t(field.label), layout: 'stack',
            control: h('input', { name: field.name, type: field.secret ? 'password' : 'text', className: 'bt-bs-input',
              required: true, maxLength: 2048, disabled: busy, autoComplete: field.secret ? 'new-password' : 'off', spellCheck: false }) })),
          h('div', { className: 'bt-ps-actions' }, button('Connect', { type: 'submit', disabled: busy }))))
}
