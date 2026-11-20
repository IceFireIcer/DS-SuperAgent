export const IM_PLATFORM_IDS = [
  'feishu',
  'dingtalk',
  'wecom',
  'qq',
  'weixin',
  'discord',
  'slack',
  'telegram',
] as const

export type ImPlatformId = typeof IM_PLATFORM_IDS[number]

export interface ImFieldOption {
  value: string
  label: string
}

export interface ImField {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  hint?: string
  defaultValue?: string
  options?: ImFieldOption[]
}

export interface ImPlatformDescriptor {
  id: ImPlatformId
  name: string
  fields: ImField[]
  buttons: boolean
  groups: boolean
  login?: 'qr'
  help?: string
}

export interface ImAccount {
  id: string
  name: string
}

export interface ImChat {
  key: string
  kind: 'direct' | 'group'
  title?: string
}

export interface ImSender {
  id: string
  name: string
}

export interface ImImage {
  mediaType: string
  data: string
}

export interface ImFile {
  name: string
  data?: Uint8Array
  note?: string
}

export interface ImInbound {
  chat: ImChat
  sender: ImSender
  text: string
  mentioned: boolean
  messageId: string
  timestamp?: number
  images?: ImImage[]
  files?: ImFile[]
}

export interface ImButton {
  label: string
  data: string
}

export interface ImSendRequest {
  chat: ImChat
  text: string
  buttons?: ImButton[]
}

export interface ImSendResult {
  messageId?: string
}

export type ImConnectionState = 'connecting' | 'ready' | 'retrying' | 'error' | 'off'

export interface ImAdapterStatus {
  state: ImConnectionState
  account?: ImAccount
  error?: string
}

export interface ImAdapterHandlers {
  onMessage(message: ImInbound): Promise<void>
  onAction(action: ImInbound & { data: string }): Promise<void>
  onStatus(status: ImAdapterStatus): void
}

export interface ImRuntime {
  get(): Readonly<Record<string, unknown>>
  set(patch: Record<string, unknown>): void
}

export interface ImSocket {
  readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  terminate?(): void
  addEventListener?(type: string, listener: (event: { data?: unknown }) => void): void
  on?(type: string, listener: (event: unknown) => void): void
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void
}

export type ImSocketConstructor = new (url: string) => ImSocket

export interface ImAdapterEnvironment {
  fetch: typeof fetch
  WebSocket?: ImSocketConstructor
  config?: Readonly<Record<string, unknown>>
  runtime: ImRuntime
  log?: { warn?(template: string, ...args: unknown[]): void }
  now?: () => number
}

export interface ImAdapterConnection {
  send(chat: ImChat, request: Omit<ImSendRequest, 'chat'>): Promise<ImSendResult>
  edit?(chat: ImChat, messageId: string, request: Omit<ImSendRequest, 'chat'>): Promise<void>
  typing?(chat: ImChat): Promise<void>
  stop(): Promise<void> | void
}

export interface ImLoginConnection {
  fields: Record<string, string>
  account: ImAccount
  chats?: ImChat[]
}

export interface ImLoginStart {
  qr: string
  state: unknown
  expiresAt?: number
}

export interface ImLoginWait {
  status: 'waiting' | 'scanned' | 'expired' | 'done'
  connection?: ImLoginConnection
  owner?: ImSender
}

export interface ImAdapter {
  id: ImPlatformId
  check(fields: Record<string, string>, env: ImAdapterEnvironment): Promise<{ account: ImAccount }>
  connect(fields: Record<string, string>, env: ImAdapterEnvironment, handlers: ImAdapterHandlers): Promise<ImAdapterConnection>
  login?: {
    start(env: ImAdapterEnvironment): Promise<ImLoginStart>
    wait(state: unknown, env: ImAdapterEnvironment): Promise<ImLoginWait>
  }
}

export interface ImSourceReceipt {
  status: 'recorded' | 'filtered'
  eventId?: string
  reason?: string
}

export interface ImMainEvent {
  commandId: string
  platform: ImPlatformId
  connectionId: string
  sourceInstanceId: string
  threadId: string
  objectId: string
  version: string
  chat: ImChat
  sender: ImSender
  requesterId: string
  text: string
  addressing: 'direct' | 'mention'
  messageId: string
  timestamp: number
}

export interface ImMainSink {
  accept(event: ImMainEvent): Promise<ImSourceReceipt>
}

export interface ImPairingView {
  id: string
  name: string
  pairedAt: number
}

export interface ImPairRequestView {
  id: string
  name: string
  chatKey: string
  createdAt: number
  expiresAt: number
}

export interface ImChatView extends ImChat {
  lastMessageAt: number
}

export interface ImConnectionView {
  id: string
  platform: ImPlatformId
  account: ImAccount
  enabled: boolean
  state: ImConnectionState
  lastError?: string
  secretFields: string[]
  paired: ImPairingView[]
  pairRequests: ImPairRequestView[]
  chats: ImChatView[]
  createdAt: number
  updatedAt: number
  lastInboundAt?: number
}

export interface ImRegistryView {
  platforms: ImPlatformDescriptor[]
  connections: ImConnectionView[]
}

export interface ImLoginStartView {
  loginId: string
  platform: ImPlatformId
  qr: string
  status: 'waiting'
  expiresAt: number
}

export interface ImLoginWaitView {
  status: 'waiting' | 'scanned' | 'expired' | 'done'
  expiresAt: number
  connection?: ImConnectionView
}

export interface ImSendView {
  connectionId: string
  chatKey: string
  status: 'sent' | 'failed'
  attempts: number
  messageId?: string
  reason?: string
}

export interface ImFailedSendView {
  id: string
  chatKey: string
  attempts: number
  reason: string
  createdAt: number
}

export interface ImRetryView {
  sent: number
  failed: number
  remaining: ImFailedSendView[]
}

export interface ImInboundResult {
  status: 'recorded' | 'filtered' | 'pairing-required' | 'duplicate' | 'failed'
  eventId?: string
  reason?: string
  request?: ImPairRequestView
}

export interface ImStoredPairRequest extends ImPairRequestView {
  senderId: string
}

export interface ImStoredFailedSend {
  id: string
  chat: ImChat
  text: string
  buttons?: ImButton[]
  attempts: number
  reason: string
  createdAt: number
}

/** Host-only snapshot. Secret field values never pass through ImConnectionView. */
export interface ImStoredConnection {
  version: 1
  id: string
  platform: ImPlatformId
  fields: Record<string, string>
  runtime: Record<string, unknown>
  account: ImAccount
  enabled: boolean
  paired: ImPairingView[]
  pairRequests: ImStoredPairRequest[]
  chats: ImChatView[]
  failedSends: ImStoredFailedSend[]
  createdAt: number
  updatedAt: number
  lastInboundAt?: number
}

export interface ImPersistence {
  load(): Promise<ImStoredConnection[]>
  save(connection: ImStoredConnection): Promise<void>
  remove(id: string): Promise<void>
}
