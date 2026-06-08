# PR Bot Worker

Cloudflare Worker GitHub App MVP. It receives GitHub `pull_request` webhooks, verifies the webhook signature, enqueues a review job, and processes that job with Cloudflare Queues. The queue consumer reads PR metadata and changed files, sends a bounded diff to DeepSeek, and creates or updates one PR conversation comment marked with `<!-- pr-bot-review -->`.

## GitHub App Setup

Required repository permissions:

- Metadata: Read-only
- Pull requests: Read & write
- Contents: Read-only, optional but recommended

Subscribe to events:

- Pull request

Set the GitHub App Webhook URL to:

```text
https://<your-worker-domain>/webhook
```

## Local Development

Create a DeepSeek API key from the DeepSeek platform console, then keep it in Worker variables only. Do not commit real secrets.

Create local Worker variables:

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=replace_me
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DEEPSEEK_API_KEY=replace_me
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=8787
```

Install dependencies and start Wrangler:

```bash
npm install
npm run dev
```

Wrangler loads `.dev.vars` automatically. `npm run dev` also reads `PORT` from `.dev.vars` and starts Wrangler with `--port <PORT>`. The Worker normalizes escaped newlines in `GITHUB_PRIVATE_KEY`, so a single-line PEM with `\n` works. `DEEPSEEK_MODEL` is optional and defaults to `deepseek-v4-flash`.

## Queue Setup

Create the queue before deploying:

```bash
npx wrangler queues create pr-bot-review
```

`wrangler.toml` binds the same queue as both producer and consumer:

```toml
[[queues.producers]]
binding = "REVIEW_QUEUE"
queue = "pr-bot-review"

[[queues.consumers]]
queue = "pr-bot-review"
max_batch_size = 1
max_batch_timeout = 5
```

`POST /webhook` only verifies and filters the GitHub webhook, then sends a `ReviewJob` to `REVIEW_QUEUE`. The queue consumer gets the GitHub App installation token, reads PR metadata and files, filters generated or unreviewable patches, calls DeepSeek with a non-streaming chat completions request, and upserts the PR comment.

## Reliability Notes

- Stale queue jobs are skipped when the current PR head SHA no longer matches the queued job head SHA.
- PR changed files are fetched with pagination.
- Very large diffs are truncated before sending to DeepSeek, and the review prompt includes a truncation notice.
- Queue batch size is set to 1 for safer AI review processing.

## Deployment

Create the queue, then configure production secrets:

```bash
npx wrangler queues create pr-bot-review
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_PRIVATE_KEY
npx wrangler secret put DEEPSEEK_API_KEY
```

`DEEPSEEK_MODEL` is optional. If you want to override the default model, configure it as a Worker variable or secret with value such as `deepseek-v4-flash`.

Deploy:

```bash
npm run deploy
```

After deployment, point the GitHub App Webhook URL to:

```text
https://<your-worker-domain>/webhook
```

## Verification

1. Install the GitHub App to a test repository.
2. Open a pull request, or push a new commit to an existing PR.
3. Confirm the webhook request receives `202 accepted`.
4. Confirm the queue consumer runs without retrying indefinitely.
5. Confirm the PR conversation contains or updates a `🤖 AI PR Review` comment.
6. Confirm the comment includes English Markdown sections: `Summary`, `Issues to Watch`, `Suggestions`, and `Conclusion`.
7. Update the PR again and confirm the same marked comment is updated instead of creating duplicate comments.

Health check:

```bash
curl https://<your-worker-domain>/health
```

Expected response:

```json
{ "ok": true }
```

## Scripts

```bash
npm run typecheck
npm run build
npm test
```
