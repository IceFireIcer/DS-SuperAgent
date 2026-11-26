# 明确桌面多平台构建与逐平台放行的边界

正式决策票：[明确桌面多平台构建与逐平台放行的边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/201)。类型：`wayfinder:grilling`。状态：已关闭。

## Question

桌面发布候选要为哪些操作系统构建？已有的 Windows x64 预览验收是否限定其他平台的构建，或能代替其他包的发布签核？

## Resolution

[正式决议](https://github.com/IceFireIcer/DS-SuperAgent/issues/201#issuecomment-7136231623)：发布候选从同一提交 SHA 分别打出 Windows、macOS、Linux 桌面包。按系统和实际架构记录各包与 SHA-256；失败或缺包不记为三平台构建完成。这不是对每次本地开发构建的要求。

Windows x64 是已有明确验收约定的公开预览目标，不是唯一构建目标。对外声明某个平台受支持时，需要该平台实际分发包的证据和维护者签核，不沿用另一平台的验收记录。本决议不要求三端同日发布，也不表示已有候选通过。
