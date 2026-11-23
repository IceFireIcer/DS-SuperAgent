import { dingtalkAdapter, wecomAdapter } from './enterprise.js'
import { discordAdapter, qqAdapter, slackAdapter } from './gateways.js'
import { feishuAdapter, telegramAdapter } from './polling.js'
import type { ImAdapter, ImPlatform, ImTransport } from './types.js'
import { wechatAdapter } from './wechat.js'

export function createAdapters(transport: ImTransport): Record<ImPlatform, ImAdapter> {
  return {
    feishu: feishuAdapter(transport), dingtalk: dingtalkAdapter(transport), wecom: wecomAdapter(transport),
    qq: qqAdapter(transport), wechat: wechatAdapter(transport), discord: discordAdapter(transport),
    slack: slackAdapter(transport), telegram: telegramAdapter(transport),
  }
}
