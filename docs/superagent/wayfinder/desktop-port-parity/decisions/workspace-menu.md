## Question

桌面侧栏的文件夹入口究竟是在选择下一次 Main 提交的授权工作目录，还是在分组浏览记录、修改实例默认目录，或应明确区分这些动作？

分别核对 DS-Bot `sidebar.js` 的 `New section`（侧栏分组）和 `folder-menu.js` 的 `FolderMenu`（目录选择），与 [选择工作目录的既有约束](https://github.com/IceFireIcer/DS-SuperAgent/blob/50491ff160ccf1a5bc86226d52d2a3e0162ed31f/docs/superagent/implementation/r5-17.md) 对照。用「已有工作在目录 A 执行，用户选 B 后折叠侧栏并发出下一条消息」确定显示、授权、持久化和提交边界；覆盖无目录、拒绝授权、取消及键盘路径。不把搜索当成文件夹入口，不改变已接纳工作的执行环境，不复活新建 Bot 或群的按钮。

以 [核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166) 识别出的现有入口和缺口为起点。
