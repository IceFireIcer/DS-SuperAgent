# 产品 Host 的 GitHub 结果交付

[GitHub #129](https://github.com/IceFireIcer/DS-SuperAgent/issues/129) · [T55 本机验收](t55-r5-local.md) · [复核](reviews/github-product-delivery.md)

T55 通过产品 Host 复现了已委托工作完成后，GitHub 结果被标记为 `dropped` 且原因是 `DESTINATION_SOURCE_DISABLED`。旧的 Engine 夹具注入了外发适配器，产品路径没有接上。

现有 Outbox 按精确来源选择 GitHub 适配器。部署用 `DS_SUPERAGENT_GITHUB_POSTING_ACTOR_ID` 指定发帖账号，本地设置选择现有凭据资源，并分别给 Main 授予 `source`、给 Router 授予 `outbound`。每次 GitHub API 查询和提交都重新检查选择、授权和凭据。一次发送的账号校验、原目标核查、回执查询和提交绑定到同一个凭据。轮换或撤权发生在提交前时，外部写入被拒绝。只接收模式仍可使用。

发送使用原 Outbox 代次和平台查询标记。GitHub 接受评论但响应丢失时，按讨论和原标记核对精确正文与账号。已发送历史显示经确认的评论 ID 和 URL，原评论删除后仍可核对同一讨论的回执。没有配置目标时，待发送动作显示明确拒绝，未知动作保持未知。由本产品回复造成的父讨论时间变化，在正文与状态保持相同且可核对回复归属时保留当前请求。

## 验证

- Node 24 定向回归覆盖了完整产品 Host 授权路径。无外发 grant、其他来源 grant、提交前轮换及撤权全部拒绝。正确 grant 的结果在模拟响应丢失后读回原评论，POST 只执行一次。
- 同轮验证 GitHub 接收与传输、Main 来源委托、已存在的凭据和飞书替身。Windows 上两个 embedded PostgreSQL 夹具按该平台现有限制跳过。
- 使用隔离产品 Host、本机 mock 模型和受限 GitHub 请求入口，从既有测试仓库 #21 的真实 Issue 发起。Main 委托后本地 Worker 验证虚构文件，结果状态为 `sent`。工单与评论通过 GitHub API 回读，结果评论 ID 与产品持久记录一致。Fixture 工单已关闭，保留一条确认和一条结果供核验。[测试工单和回执](https://github.com/IceFireIcer/SuperAgentTest/issues/21#issuecomment-6985981343)

```powershell
gh api repos/IceFireIcer/SuperAgentTest/issues/comments/6985981343 --jq '{id,html_url,actor:.user.login}'
```

本轮真实平台证据使用 mock 模型，真实模型语义仍由 T55 独立验证。
