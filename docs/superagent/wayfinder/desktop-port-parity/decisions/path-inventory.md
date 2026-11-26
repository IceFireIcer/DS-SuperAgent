## Question

从本地 `temp/DS-Bot` 的 `v0.3.8`（`5e9b7da8`）直接核对：三张参考图对应哪段实际 UI、动效与功能代码？对照产品 `dev` 的 `50491ff1`，哪些已经接通，哪些可复用，哪些只需换成现有 SuperAgent action，哪些缺后端、明确排除或仍无真环境证据？

先看 `temp/DS-Bot/ds-bot/src/client/` 下的 `sidebar.js`（`New section`、账户、连接器和返回入口）、`folder-menu.js`（目录选择）、`model-menu.js`（首次模型引导）、输入框、`voice.js` / `overlays.js`（附件和语音），以及 `index.js` / `surface.js`（实际 slot 安装、切换和恢复）。往下追到样式、事件、action 和必要的桌面桥；逐项记录上游源文件及符号、已同步/未同步、当前产品入口及回执、迁移方式与验收动作。[同步清单](https://github.com/IceFireIcer/DS-SuperAgent/blob/50491ff160ccf1a5bc86226d52d2a3e0162ed31f/superagent/dsh/scripts/sync-client.manifest.json) 是对照索引，不把复制文件或单张截图算作已接通。只做盘点，不补接线、不操作真实账户。
