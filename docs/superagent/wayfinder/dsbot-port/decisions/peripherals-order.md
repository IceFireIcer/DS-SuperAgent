# 确定桌面壳、手机/link、浏览器插件与电脑操控的搬迁顺序：待决问题

对应决策：[确定桌面壳、手机/link、浏览器插件与电脑操控的搬迁顺序](https://github.com/IceFireIcer/DS-SuperAgent/issues/139)。

## 问题

确定外围搬迁顺序与依赖：桌面壳（启动窗/通知/picker/日志/下载）、mobile + link、browser-plugins（3 个 DSH 插件 + host/browser + 页面）、computer 控制（host + app 悬浮层 + CUA）各自何时进入；哪些必须与 C 域同批、哪些可以后置？手机端与 link、browser-plugins 与 app CDP、computer 与执行授权的绑定关系如何排？

## 约束与已知依据

- 不搬 `app/ui`、`app/engine`（0.3.8 退役物）。
- 未接线的页面保留并 fail-closed。
- 手机端读模型是 Bot/群，只能重写；浏览器插件与电脑操控涉及权限/租约/CDP token，安全面最大。
- 依赖“首版与全量 C 域范围”的结论。

## 产出

外围子系统的依赖图、搬迁批次、每批的前后端配套清单与验收点。
