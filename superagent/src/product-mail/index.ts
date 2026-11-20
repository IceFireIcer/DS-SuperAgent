export { MailService, createMailService, parseMailAddresses } from './service.js'
export type { MailAccountConfig, MailAccountView, MailMessage, MailOutgoing, MailOverview,
  MailReplyView, MailRuleMode, MailRuleView, MailServiceOptions, MailSummary, ProductMailTransport } from './service.js'
export { ALLOWED_MAIL_PROVIDERS, MAIL_PRESETS, MAIL_PROVIDERS, mailPreset, mailPresetFor } from './presets.js'
export type { MailPreset, MailServer } from './presets.js'
export { createImapSmtpTransport, loadHostMailModules, loadHostMailTransport } from './host-transport.js'
export type { HostMailModules } from './host-transport.js'
