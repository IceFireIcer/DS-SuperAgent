# 升级 DSH 到官方 0.2.2-rc.1 并记录验证事实：决定

对应决策：[升级 DSH 到官方 0.2.2-rc.1 并记录验证事实](https://github.com/IceFireIcer/DS-SuperAgent/issues/132#issuecomment-7002471286)。

## 结论

1. 基线实际是 `0.2.1-rc.4`（app 与 superagent 都是）。
2. 已升级到官方 `latest` `0.2.2-rc.1`；Cordis `4.1.0`；`cordis-plugin-group` `1.1.0`；`libreoffice-kit` 保持 `0.1.5`。
3. 锁文件全部来自 `registry.npmjs.org`，无 mirror URL；两套 `node_modules` 无旧版嵌套。
4. 已通过：superagent typecheck/build/lint/test:client（169 pass/1 skip）；app package test（5 pass）；profile boot。
5. 未完成：app 全量测试被中止，不計为通过；本机 Node 25.4.0，CI 应使用 Node 24.x。
6. 已知警告：`ui-deliverables` 未激活（等待 `sessionController`），实施切片需复验。

## 回滚

`temp/backup/*-0.2.1-final.json` 与 `temp/backup/*-node_modules-0.2.1-final`；或还原四个 package/lock 文件后重装。
