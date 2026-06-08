# PR Bot Worker

[English README](./README.en.md)

这是一个运行在 Cloudflare Workers 上的 GitHub App PR 审查机器人。它接收 GitHub `pull_request` webhook，验证 webhook 签名，把审查任务发送到 Cloudflare Queues，并由 Queue consumer 调用 DeepSeek 生成英文 Pull Request Review。完成后机器人会提交 GitHub Pull Request Review：review body 放总体总结，可靠的 review comments 会落到具体 diff 新增行上。processing / failed 状态仍使用带有 `<!-- pr-bot-review -->` marker 的普通 PR Conversation 评论。不做 Check Run、自动 request changes 或自动 resolve thread。

## GitHub App 配置

仓库权限要求：

- Metadata: Read-only
- Pull requests: Read & write
- Contents: Read-only，可选但推荐

订阅事件：

- Pull request

GitHub App Webhook URL 设置为：

```text
https://<your-worker-domain>/webhook
```

## 本地开发

先从 DeepSeek 平台控制台创建 API Key，并只把它放在 Worker 变量或 Cloudflare secret 中。不要提交真实 secret。

创建本地配置文件：

```bash
cp .dev.vars.example .dev.vars
cp wrangler.example.toml wrangler.toml
```

填写 `.dev.vars`：

```dotenv
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=replace_me
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DEEPSEEK_API_KEY=replace_me
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=8787
```

安装依赖并启动本地 Worker：

```bash
npm install
npm run dev
```

Wrangler 会自动加载 `.dev.vars`。`npm run dev` 还会读取 `.dev.vars` 中的 `PORT`，并用 `--port <PORT>` 启动 Wrangler。Worker 会把 `GITHUB_PRIVATE_KEY` 里的 `\n` 转义恢复成真实换行，所以单行 PEM 可以正常工作。`DEEPSEEK_MODEL` 是可选项，默认值为 `deepseek-v4-flash`。

`wrangler.toml` 是本地配置文件，已被 Git 忽略。真实 Cloudflare 资源 ID 只放在本地 `wrangler.toml` 中；仓库只提交带占位符的 `wrangler.example.toml`。

## Queue 和 KV 配置

部署前先创建 Queue：

```bash
npx wrangler queues create pr-bot-review
```

创建用于记录 Review 状态的 KV namespace：

```bash
npx wrangler kv namespace create REVIEW_STATE
npx wrangler kv namespace create REVIEW_STATE --preview
```

把 Wrangler 输出的生产 `id` 和预览 `preview_id` 填回本地 `wrangler.toml`。不要提交真实 namespace ID。`wrangler.example.toml` 应继续保留占位符。

`wrangler.example.toml` 包含必要的 Queue 和 KV binding：

```toml
[[queues.producers]]
binding = "REVIEW_QUEUE"
queue = "pr-bot-review"

[[queues.consumers]]
queue = "pr-bot-review"
max_batch_size = 1
max_batch_timeout = 5

[[kv_namespaces]]
binding = "REVIEW_STATE"
id = "replace_with_production_kv_namespace_id"
preview_id = "replace_with_preview_kv_namespace_id"
```

`POST /webhook` 只负责验签、过滤 GitHub webhook，并把 `ReviewJob` 发送到 `REVIEW_QUEUE`。Queue consumer 会获取 GitHub App installation token，读取 PR metadata 和 changed files，过滤生成文件或不可审查 patch，调用 DeepSeek 的非流式 chat completions API，然后创建 Pull Request Review。

## Pull Request Review 模式

- Bot 会提交 GitHub Pull Request Review，而不是只更新普通 PR Conversation 评论。
- Review body 包含高层总结和 metadata。
- Inline comments 只会放在 diff 中可验证的新增行上。
- 如果没有安全可靠的 inline comments，Bot 会提交只有 summary 的 review。
- 现有普通 PR Conversation 评论仍用于显示 `processing` 或 `failed` 状态。
- 如果 GitHub 因行号或 diff 位置返回 `422`，Worker 会 fallback 到普通 marker 评论，避免 Queue 无限 retry。

## Review 状态和幂等

`REVIEW_STATE` KV 用于保存每个 PR head SHA 的审查状态，避免同一个 commit 重复调用 DeepSeek。

状态 key 格式：

```text
review:<owner>/<repo>:<pullNumber>:<headSha>
```

状态包括 `processing`、`done`、`failed`。如果 `processing` 状态创建时间小于 10 分钟，会被视为正在处理的重复任务并跳过；超过 10 分钟则允许重新处理。最近失败的 `failed` 状态会短暂跳过，避免明显不可恢复错误被立即反复处理。状态保存 30 天后过期。

KV 是 best-effort：如果 KV 操作失败，Worker 会记录安全 warning 并继续审查，只是幂等能力会暂时降低。

## 可靠性说明

- 如果 Queue 中的旧任务对应的 head SHA 已经不是当前 PR head SHA，会直接跳过，避免 stale review 覆盖新 review。
- PR changed files 使用分页读取。
- 超大 diff 会在发送给 DeepSeek 前截断，prompt 中会包含截断提示。
- Queue consumer batch size 设置为 1，降低 AI 审查并发风险。
- GitHub 和 DeepSeek 错误日志会截断 body，避免输出过长响应或敏感信息。

## 部署

先创建本地 Wrangler 配置，再创建 Cloudflare 资源并配置生产 secrets：

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler queues create pr-bot-review
npx wrangler kv namespace create REVIEW_STATE
npx wrangler kv namespace create REVIEW_STATE --preview
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_PRIVATE_KEY
npx wrangler secret put DEEPSEEK_API_KEY
```

部署前，把本地 `wrangler.toml` 中的 KV `id` 和 `preview_id` 占位符替换为 Wrangler 输出的真实值。`wrangler.example.toml` 继续保持通用占位符。

`DEEPSEEK_MODEL` 是可选配置。如果要覆盖默认模型，可以把它配置为 Worker variable 或 secret，例如 `deepseek-v4-flash`。

部署 Worker：

```bash
npm run deploy
```

部署完成后，把 GitHub App Webhook URL 指向：

```text
https://<your-worker-domain>/webhook
```

## 验证

1. 把 GitHub App 安装到测试仓库。
2. 打开一个 PR，或给已有 PR 推送新 commit。
3. 确认 webhook 请求返回 `202 accepted`。
4. 确认 Queue consumer 没有无限 retry。
5. 确认 PR Conversation 中先出现或更新 `processing` 状态评论。
6. 确认完成后 GitHub PR Review 中出现英文 Markdown summary。
7. 如果模型返回了可靠问题，确认 inline comments 落在具体 diff 新增行上。
8. 如果没有可靠 inline comments，确认仍提交了 summary-only review。
9. 再次更新 PR，确认同一个 head SHA 不会重复调用模型；新 head SHA 会触发新 review。

健康检查：

```bash
curl https://<your-worker-domain>/health
```

期望响应：

```json
{ "ok": true }
```

## 常用脚本

```bash
npm run typecheck
npm run build
npm test
```
