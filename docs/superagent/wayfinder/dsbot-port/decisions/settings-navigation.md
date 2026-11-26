# 确定设置导航树与冲突页归属：待决问题

对应决策：[确定设置导航树与冲突页归属](https://github.com/IceFireIcer/DS-SuperAgent/issues/137)。

## 问题

确定设置导航与冲突页：19 个 DS-Bot 设置页 + 9 个 SuperAgent 产品页的最终分组与顺序；浏览器、定时任务、记忆是“一页两 Tab”还是两个独立页；记忆保留产品页的同时是否保留 DS-Bot 的 MemoryDialog 入口；角色与 Provider 页如何与 DS-Bot 的模型页合并。

## 约束与已知依据

- 以 `settings-shell.js` 为唯一外壳，产品页注册为 `settings.section`。
- 设置壳现有分组：通用、模型、本地 Agent、Bot、Bot 模型、群聊、连接器、IM、手机、能力、浏览器、电脑操控、定时任务、用量、密钥、内置插件、Agent 预设、反馈、关于。
- 产品页：角色与 Provider、执行策略、日程、主动准备、记忆、浏览器资源、监督、状态与用量、客户端授权。
- 依赖 roster 语义决策的结果。

## 产出

最终导航树（一级/二级/Tab）、冲突页归属、产品页改名清单、验收点击路径。
