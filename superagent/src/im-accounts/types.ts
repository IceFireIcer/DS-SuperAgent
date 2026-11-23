export const imPlatforms = ['feishu', 'dingtalk', 'wecom', 'qq', 'wechat', 'discord', 'slack', 'telegram'] as const
export type ImPlatform = typeof imPlatforms[number]

export interface ImAddress {
  platform: ImPlatform
  accountId: string
  pairId: string
  senderId: string
  conversationId: string
  messageId: string
}

export interface ImInbound extends ImAddress {
  text: string
}

export interface NativeImMessage {
  senderId: string
  conversationId: string
  messageId: string
  text: string
  contextToken?: string
}

export interface ImField {
  name: string
  label: string
  secret: boolean
}

export interface ImTransport {
  fetch?: typeof fetch
  socket?: (url: string) => WebSocket
  now?: () => number
}

export interface ImConnection {
  readonly account: string
  receive(hooks: ImReceiveHooks, signal: AbortSignal): Promise<void>
  send(address: Omit<NativeImMessage, 'text'>, text: string, key: string, signal: AbortSignal): Promise<string>
  stop?(): void
}

export interface ImReceiveHooks {
  ready(): void
  message(message: NativeImMessage): Promise<void>
  cursor(): Promise<string | undefined>
  checkpoint(cursor: string): Promise<void>
}

export interface ImAdapter {
  platform: ImPlatform
  fields: readonly ImField[]
  connect(credentials: Readonly<Record<string, string>>, signal: AbortSignal): Promise<ImConnection>
}
