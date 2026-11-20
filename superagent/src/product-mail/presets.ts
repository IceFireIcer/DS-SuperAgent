export interface MailServer {
  host: string
  port: number
  secure: boolean
  starttls?: boolean
}

export interface MailPreset {
  id: string
  name: string
  domains: string[]
  imap: MailServer
  smtp: MailServer
}

export const MAIL_PRESETS: readonly MailPreset[] = Object.freeze([
  { id: 'qq', name: 'QQ Mail', domains: ['qq.com', 'foxmail.com'],
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true } },
  { id: '163', name: '163 Mail', domains: ['163.com'],
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true } },
  { id: '126', name: '126 Mail', domains: ['126.com'],
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true } },
  { id: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  { id: 'icloud', name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, starttls: true } },
])

export const MAIL_PROVIDERS = [...MAIL_PRESETS.map(preset => preset.id), 'other'] as const

export function mailPreset(id: string): MailPreset | undefined {
  return MAIL_PRESETS.find(preset => preset.id === id)
}

export function mailPresetFor(address: string): MailPreset | undefined {
  const domain = address.split('@')[1]?.toLowerCase() ?? ''
  return MAIL_PRESETS.find(preset => preset.domains.includes(domain))
}

export const ALLOWED_MAIL_PROVIDERS = new Set<string>(MAIL_PROVIDERS)
