# PR Bot Worker

Cloudflare Worker GitHub App MVP. It receives GitHub `pull_request` webhooks, verifies the webhook signature, enqueues a review job, and processes that job with Cloudflare Queues. The queue consumer reads PR metadata and changed files, sends a bounded diff to DeepSeek, and submits a GitHub Pull Request Review. The review body contains the high-level summary, and reliable review comments are placed on specific added diff lines. Ordinary PR conversation comments marked with `<!-- pr-bot-review -->` are still used for `processing` and `failed` status. The bot does not create Check Runs, automatically request changes, or resolve review threads.

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
cp wrangler.example.toml wrangler.toml
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

`wrangler.toml` is local-only and ignored by Git. Keep real Cloudflare resource IDs in `wrangler.toml`; commit shared placeholders and structure in `wrangler.example.toml`.

## Queue Setup

Create the queue before deploying:

```bash
npx wrangler queues create pr-bot-review
```

Create the KV namespaces used for review state:

```bash
npx wrangler kv namespace create REVIEW_STATE
npx wrangler kv namespace create REVIEW_STATE --preview
```

Copy the generated production `id` and preview `preview_id` into your local `wrangler.toml`. Do not commit real namespace IDs. `wrangler.example.toml` should keep placeholders.

`wrangler.example.toml` documents the required queue and KV bindings:

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

`POST /webhook` only verifies and filters the GitHub webhook, then sends a `ReviewJob` to `REVIEW_QUEUE`. The queue consumer gets the GitHub App installation token, reads PR metadata and files, filters generated or unreviewable patches, calls DeepSeek with a non-streaming chat completions request, and submits a Pull Request Review.

## Pull Request Review Mode

- The bot submits a GitHub Pull Request Review instead of only updating an ordinary PR conversation comment.
- The review body contains high-level feedback and metadata.
- Inline comments are only placed on added lines that are present in the diff.
- If no safe inline comments are available, the bot submits a summary-only review.
- The existing ordinary PR conversation comment may still be used for `processing` or `failed` status.
- If GitHub returns `422` for review comment positioning, the Worker falls back to the ordinary marker comment to avoid infinite Queue retries.

## Review State and Idempotency

`REVIEW_STATE` KV stores best-effort review status for each PR head SHA so the same commit does not repeatedly call DeepSeek.

State keys use this format:

```text
review:<owner>/<repo>:<pullNumber>:<headSha>
```

Possible statuses are `processing`, `done`, and `failed`. A `processing` state younger than 10 minutes is treated as an in-flight duplicate and skipped. A `processing` state older than 10 minutes can be retried. A recent `failed` state is skipped briefly to avoid immediate repeated failures. Review state expires after 30 days.

KV failures do not block PR review. If KV is unavailable, the Worker logs a safe warning and continues, with reduced idempotency until KV works again.

## Reliability Notes

- Stale queue jobs are skipped when the current PR head SHA no longer matches the queued job head SHA.
- PR changed files are fetched with pagination.
- Very large diffs are truncated before sending to DeepSeek, and the review prompt includes a truncation notice.
- Queue batch size is set to 1 for safer AI review processing.

## Deployment

Create the local Wrangler config, then create Cloudflare resources and configure production secrets:

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

Before deploying, replace the placeholder KV `id` and `preview_id` in your local `wrangler.toml` with the values printed by Wrangler. Keep `wrangler.example.toml` generic for the repository.

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
5. Confirm the PR conversation first contains or updates a `processing` status comment.
6. Confirm a GitHub Pull Request Review appears with an English Markdown summary.
7. If the model found reliable issues, confirm inline comments appear on specific added diff lines.
8. If no reliable inline comments are available, confirm a summary-only review is still submitted.
9. Update the PR again and confirm the same head SHA does not call the model again; a new head SHA triggers a new review.

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
