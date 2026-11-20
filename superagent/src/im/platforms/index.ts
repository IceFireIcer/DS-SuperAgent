import { dingtalk } from './dingtalk.js'
import { discord } from './discord.js'
import { feishu } from './feishu.js'
import { qq } from './qq.js'
import { slack } from './slack.js'
import { telegram } from './telegram.js'
import { wecom } from './wecom.js'
import { weixin } from './weixin.js'
import type { ImAdapter, ImPlatformDescriptor, ImPlatformId } from '../types.js'

export const adapters: Record<ImPlatformId, ImAdapter> = {
  feishu,
  dingtalk,
  wecom,
  qq,
  weixin,
  discord,
  slack,
  telegram,
}

export const IM_PLATFORMS: ImPlatformDescriptor[] = [
  {
    id: 'feishu',
    name: 'Feishu / Lark',
    fields: [
      { key: 'domain', label: 'Edition', defaultValue: 'feishu', options: [
        { value: 'feishu', label: 'Feishu' },
        { value: 'lark', label: 'Lark' },
      ] },
      { key: 'appId', label: 'App ID', required: true },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true },
    ],
    buttons: true,
    groups: true,
    help: 'https://open.feishu.cn/app',
  },
  {
    id: 'dingtalk',
    name: 'DingTalk',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true },
      { key: 'clientSecret', label: 'Client Secret', required: true, secret: true },
    ],
    buttons: false,
    groups: true,
    help: 'https://open-dev.dingtalk.com/',
  },
  {
    id: 'wecom',
    name: 'WeCom',
    fields: [
      { key: 'botId', label: 'Bot ID', required: true },
      { key: 'secret', label: 'Secret', required: true, secret: true },
    ],
    buttons: true,
    groups: true,
    help: 'https://work.weixin.qq.com/',
  },
  {
    id: 'qq',
    name: 'QQ',
    fields: [
      { key: 'appId', label: 'App ID', required: true },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true },
    ],
    buttons: false,
    groups: true,
    help: 'https://q.qq.com/qqbot/',
  },
  {
    id: 'weixin',
    name: 'WeChat',
    fields: [],
    buttons: false,
    groups: false,
    login: 'qr',
  },
  {
    id: 'discord',
    name: 'Discord',
    fields: [{ key: 'token', label: 'Bot token', required: true, secret: true }],
    buttons: true,
    groups: true,
    help: 'https://discord.com/developers/applications',
  },
  {
    id: 'slack',
    name: 'Slack',
    fields: [
      { key: 'appToken', label: 'App-Level Token', required: true, secret: true, hint: 'xapp-' },
      { key: 'botToken', label: 'Bot Token', required: true, secret: true, hint: 'xoxb-' },
    ],
    buttons: true,
    groups: true,
    help: 'https://api.slack.com/apps',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    fields: [{ key: 'token', label: 'Bot token', required: true, secret: true }],
    buttons: true,
    groups: true,
    help: 'https://t.me/BotFather',
  },
]

export function platformById(id: string): ImPlatformDescriptor | undefined {
  return IM_PLATFORMS.find(platform => platform.id === id)
}
