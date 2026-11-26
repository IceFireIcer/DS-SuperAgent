## Question

用最小的状态稿或同路径对照短片，确认哪些按钮切换、菜单/弹窗进退场、角色状态和启动交接必须与参考行为等价，以及怎样从键盘与减少动态效果场景判定通过？

在现有 UI 设计标准内取代表性路径，比较窄/宽窗口、四主题浅深、普通/减少动态效果、焦点返回、`Esc`、外部点击、空态/忙态/失败；列明哪些是所有路径共用的硬条件、哪些可按代表路径抽验。只产出供维护者选择的测试样板，不替换产品 renderer，不直接复制未授权图标或品牌资产；静态相似和全局 token 不算可操作性通过。

使用 [确定侧栏文件夹与工作目录的关系](https://github.com/IceFireIcer/DS-SuperAgent/issues/169)、[确定底栏账户、连接器与模型引导的分工](https://github.com/IceFireIcer/DS-SuperAgent/issues/170) 和 [确定 Main 连续语音的暂停与恢复规则](https://github.com/IceFireIcer/DS-SuperAgent/issues/171) 的决议选取代表状态，不在样板里重定这些行为。
