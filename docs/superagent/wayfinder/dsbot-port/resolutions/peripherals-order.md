# 确定桌面壳、手机/link、浏览器插件与电脑操控的搬迁顺序：决定

对应决策：[确定桌面壳、手机/link、浏览器插件与电脑操控的搬迁顺序](https://github.com/IceFireIcer/DS-SuperAgent/issues/139#issuecomment-7001969734)。

## 结论

1. 桌面壳整包搬：启动窗、数据目录/place、picker、导入、日志、通知、下载、电脑指示器、材质 CSS、打包脚本。它是阶段②的批次 0。
2. 手机：先搬 `link` 中继与 Host phone relay（阶段②）；Expo App 单独后置，读模型从 Bot/群重写到 Main/来源。
3. 浏览器：3 个 DSH 插件 + 选择器 + `host/browser` + 页面同批。
4. 电脑操控：`host/computer` + app 悬浮指示器/光标 + CUA 打包同批。
5. 阶段②顺序：桌面壳 → 连接器 → IM（8 平台；飞书可先接，但不得提前宣称完成）→ 能力库 → 手机/link → 浏览器插件 → 电脑操控。

## 约束

- `app/ui`、`app/engine` 不搬。
- 未接线页面保留并 fail-closed。
- 桌面壳与电脑操控的 `app/` 变更按已获准的 UI 变更执行，提交前跑 UI boundary。
