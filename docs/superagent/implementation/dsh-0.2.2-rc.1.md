# DSH 0.2.2-rc.1 基线

对应工单 [#143](https://github.com/IceFireIcer/DS-SuperAgent/issues/143)，迁移规格见 [#142](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)。

`app/` 与 `superagent/` 的清单和锁文件统一采用 DSH `0.2.2-rc.1`。两份锁文件均解析到 Cordis `4.1.0`、`cordis-plugin-group` `1.1.0` 和 `libreoffice-kit` `0.1.5`。远程包均来自 `https://registry.npmjs.org/`，桌面包仍通过 `file:../superagent` 安装同仓的产品包。新版 DSH 要求 Node.js `>=24.9.0`。

Docker 默认版本同步到 `0.2.2-rc.1`，与打入镜像的产品包 peer 依赖一致。独立开发与测试 Host 挂载新版公开的原生工具执行插件。恢复既有 Session 时，产品在本轮请求前显式应用当前角色的模型与推理档位。

## 验证

2026-11-19 在 Windows 和 Node.js `24.22.3` 上验证，客户端测试从 npm 安装解析 DSH。

- 两个包均在独立的临时源码副本中通过 `npm ci --registry=https://registry.npmjs.org`，安装后重新构建和启动 mock profile 成功。
- `superagent/` 的 `npm run typecheck`、`npm run build`、`npm run lint` 和 `npm run test:client` 通过。客户端 169 项通过、1 项跳过。`node dsh/scripts/build-client.mjs --check` 通过，生成客户端无差异。
- `node app/scripts/check-superagent-profile.mjs` 使用隔离数据和 mock 模型启动，Main 回复、两项本地委托及观察记录均通过。原生 Session 操作、查询入口和导出均受产品边界限制。
- 桌面全量串行测试在 `main-menu-fallback.test.mjs` 的断言通过后未退出。以 `node --test --test-concurrency=1 --test-force-exit --test-timeout=90000 'test/*.test.mjs'` 重跑后全部用例有结果，246 项通过、1 项失败、1 项跳过。`main-menu.test.mjs` 的 `the app ends` 等待 tray 销毁超过 20 秒，错误为 `the app did not take the tray away`。使用升级前提交和 `0.2.1-rc.4` 的独立安装复现相同失败。
- Capability Locations 与 Native Runtime 定向测试 24 项通过。重新构建后的定向测试覆盖恢复 Router 后使用当前模型、角色切换与 setup 失败后的 Session 清理，3 项通过。会话滚动夹具补齐验证命令并限制工具调用次数后，`context-rollover.test.mjs` 两项通过，覆盖上一代后台作业取消。
- `docker compose -f docker/compose.yml config` 能解析到新版本。[首轮 CI](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44490305437) 完成镜像构建。新版 CLI 输出 `--help` 后未退出，原迁移冒烟因此超时。迁移检查改为启动隔离容器、等待 HTTP 响应、结束容器，再验证卷权限与数据。

## 已知限制

隔离 profile 启动时报告 `ui-deliverables (@deepseek-ai/dsh-client-ui-deliverables): pending (waiting for service: sessionController)`。产品 profile 隔离 `sessionController`，原生交付 UI 插件因此未激活。冒烟同时验证了 `/api/product` 所用的产品 Host 仍能完成工作交付。本次基线保留该隔离边界。

SuperAgent 全量 `npm test` 未通过。协作基准等待 `event-01` 的 Worker 回复超时，输入恢复测试的 `before-claim` 未到达预期退出点，轮询器停止测试实际得到 `failed`，预期为 `stopped`，远端 PTY 等待就绪超时。上述失败在升级前基线也复现。Router 模型选择及会话滚动夹具问题已修复并定向复验。产品终端测试在断言通过后未退出，使用 `--test-force-exit` 单独复验通过。

回退时一并撤销本票提交中的包清单和锁文件、Docker 版本及运行时和测试适配。重装 `superagent/` 后重新构建，再重装 `app/`。回退验证使用隔离的 profile 数据。
