# PR Bot Worker

Cloudflare Worker GitHub App MVP. It receives GitHub `pull_request` webhooks, verifies the webhook signature, reads changed files, and creates or updates one PR conversation comment marked with `<!-- pr-bot-review -->`.

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

Create local Worker variables:

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=replace_me
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
PORT=8787
```

Install dependencies and start Wrangler:

```bash
npm install
npm run dev
```

Wrangler loads `.dev.vars` automatically. `npm run dev` also reads `PORT` from `.dev.vars` and starts Wrangler with `--port <PORT>`. The Worker normalizes escaped newlines in `GITHUB_PRIVATE_KEY`, so a single-line PEM with `\n` works.

## Deployment

Configure production secrets:

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_PRIVATE_KEY
```

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
3. Confirm the PR conversation contains or updates a `🤖 PR Bot` comment.
4. Confirm the comment lists the changed files and the PR head SHA.

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
