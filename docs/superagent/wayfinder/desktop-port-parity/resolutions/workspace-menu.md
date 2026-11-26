## Resolution · 复用工作目录选择器

维护者确认复用 [`FolderMenu`](https://github.com/Fei2411/DS-Bot/blob/5e9b7da8882da3b68d8a0624342708c2150a9156/ds-bot/src/client/folder-menu.js#L16) 和[产品现有的目录动作](https://github.com/IceFireIcer/DS-SuperAgent/blob/50491ff160ccf1a5bc86226d52d2a3e0162ed31f/superagent/dsh/src/client/product.js#L1028)。侧栏文件夹入口选择下一条 Main 输入的本机工作目录，与输入框共享同一临时选择。它不切换主对话、不改实例默认值，也不迁入上游 `New section` 的列表分组或旧 Bot/群入口。

- 选择获准目录可以登记目录供日后再选，但不会保存为实例默认目录；默认值仍只在设置里修改。即使没有默认目录，也可以从侧栏明确选择并登记一个获准目录。沿用当前本机目录的权限与附件约束，不为远端连接提供本机选择器，也不改变远程或自动执行策略。
- 验收路径：已有工作在 A，用户用键盘打开侧栏选择器，选 B 后折叠再展开，输入框和侧栏仍反映 B。下一条发起的新本机工作使用 B；已接纳的工作及其跟进仍绑定 A。提交被接纳并收到回执后清除此次选择、恢复实例默认（如没有，回到未选择）。
- 取消、授权失败或已有附件阻止换目录时保留原选择，错误可见；未接纳的发送保留选择供重试。窄栏仍可用键盘打开和关闭，焦点返回入口。这一行为在[远端 CI 验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055)时用隔离目录夹具验证；本决议不修改产品代码。
