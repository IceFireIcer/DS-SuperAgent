export { CONNECTOR_CATALOG, CONNECTOR_CATEGORIES, connectorEntry, customConnectorId } from './catalog.js'
export type { ConnectorAuthKind, ConnectorCatalogEntry } from './catalog.js'
export { deleteProductCredential, grantFor, saveProductCredential } from './credentials.js'
export type { ConnectorCredentialPort, SavedCredential } from './credentials.js'
export { CONNECTOR_MAIL_ENDPOINTS, CONNECTOR_MAIL_ENDPOINT_FIELDS, createConnectorMailProducts } from './dispatcher.js'
export type { ConnectorMailDispatchContext, ConnectorMailEndpoint, ConnectorMailProducts,
  ConnectorMailProductsOptions } from './dispatcher.js'
export { HostLoopbackOAuthBroker } from './oauth.js'
export { HOST_CONNECTOR_OAUTH_CALLBACK_URI } from './oauth.js'
export type { ConnectorOAuthBroker, ConnectorOAuthCredential, ConnectorOAuthStart,
  ConnectorOAuthStatus, LoopbackOAuthClient } from './oauth.js'
export { connectorMailDispatchContext, connectorOAuthAppsFromEnvironment, createConfiguredHostConnectorMailProducts,
  createGitHubTokenVerifier, createHostConnectorMailProducts, createHostConnectorOAuthBroker } from './host.js'
export type { HostConnectorMailContext, HostConnectorMailOptions, HostConnectorMailProducts,
  HostOAuthAppConfig } from './host.js'
export { HostConnectorImportAdapter, standardConnectorImportFiles } from './import-host.js'
export type { HostConnectorImportFile, HostConnectorImportOptions } from './import-host.js'
export { ConnectorService, createConnectorService } from './service.js'
export type { ConnectorImportAdapter, ConnectorImportCandidate, ConnectorImportConfig, ConnectorListResult,
  ConnectorOAuthView, ConnectorRegistration, ConnectorServiceOptions, ConnectorSettingsView,
  ConnectorVerifier } from './service.js'
export { CommandJournal, createCredentialRecordStateStore, MemoryConnectorStateStore } from './store.js'
export type { ConnectorStateStore } from './store.js'
export { assertNonToolTarget, grantAllows, normalizeTarget, targetFingerprint, targetKey, targetScope } from './target.js'
export type { ProductTarget, ProductTargetRole } from './target.js'
export { MailService, createMailService, parseMailAddresses } from '../product-mail/service.js'
export type { MailAccountConfig, MailAccountView, MailMessage, MailOutgoing, MailOverview,
  MailReplyView, MailRuleMode, MailRuleView, MailServiceOptions, MailSummary, ProductMailTransport } from '../product-mail/service.js'
export { ALLOWED_MAIL_PROVIDERS, MAIL_PRESETS, MAIL_PROVIDERS, mailPreset, mailPresetFor } from '../product-mail/presets.js'
export type { MailPreset, MailServer } from '../product-mail/presets.js'
export { createImapSmtpTransport, loadHostMailModules, loadHostMailTransport } from '../product-mail/host-transport.js'
export type { HostMailModules } from '../product-mail/host-transport.js'
