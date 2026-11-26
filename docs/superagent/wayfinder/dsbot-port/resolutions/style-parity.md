# 原型验证产品页与 DS-Bot 视觉系统的一致性：决定

对应决策：[原型验证产品页与 DS-Bot 视觉系统的一致性](https://github.com/IceFireIcer/DS-SuperAgent/issues/134#issuecomment-7002213537)。

## 结论

1. 视觉基线：DS-Bot 0.3.8 `--bt-*` token；设置壳 1100×780、20px 圆角、198px 导航；行高与卡片按原型。
2. 主题：4 套主题 × 浅/深、7 强调色、3 动效档位；内容字号 12–18px 仅作用于会话正文。
3. 共享组件：`SettingsPage`、`SectionCard`、`FieldRow`、`EmptyState`、`StatGrid`、`StatusChip`、`InlineNotice`、`DetailList`，接口按原型规格页。
4. 排除页完全不渲染，不做灰置。
5. 派生 token 必须挂在 `documentElement`，否则暗色不重算。

## 资产

- 原型：`docs/superagent/wayfinder/dsbot-port/prototypes/style-parity.html`
- 截图：`temp/explore/style-parity-*.png`
- 原型是一次性资产，不进入产品构建。
