# Contributing

Thanks for your interest in `news-to-slack`. This is a small project — issues, PRs, and forks are all welcome.

## Getting set up locally

Follow the [README](README.md) to deploy your own Worker and load the extension. You'll need:

- Node.js 18+
- A Cloudflare account
- An Anthropic API key
- A Slack workspace where you can install a custom app

## Project structure

```
extension/   Chrome MV3 extension (popup, background, content script)
worker/      Cloudflare Worker (single-file: src/index.js)
docs/        Screenshots and supplementary docs
```

The Worker is intentionally one file (~480 lines) — easier to read and fork than spread across modules.

## Opening an issue

Use the templates in [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE/) — bug report or feature request. For bugs, please include logs from `npx wrangler tail` (Worker) or the Chrome devtools console (extension popup → right-click → Inspect).

## Submitting a PR

1. Fork the repo and create a branch off `main`.
2. Keep changes focused — one concern per PR.
3. Test end-to-end before opening the PR:
   - `npx wrangler deploy` succeeds
   - `curl <worker-url>/healthz` returns `{"ok":true}`
   - You can authenticate and post a real article to a test Slack channel
4. Commit messages: present-tense, imperative ("add tag routing", not "added tag routing").
5. Open the PR against `main`. Describe what changed and why.

## Customising for your own use

You don't need to upstream changes if you're just rebranding for your team. Common edits:

- **Name + branding**: `extension/manifest.json`, `extension/popup.html` styles, context-menu label in `extension/background.js`.
- **Slack card layout**: `worker/src/index.js` → `postToSlack()` builds the Block Kit payload.
- **Summary voice / length / emoji map**: `worker/src/index.js` → `summariseWithClaude()` system prompt.
- **Multiple channels**: replace `env.SLACK_NEWS_CHANNEL` with routing based on `meta.tags`.
- **Different LLM**: rewrite `summariseWithClaude()` body; keep the return shape `{ emoji, title, summary, tags, bullets }`.

## Security

Do not commit:
- `worker/wrangler.toml` (has your real Cloudflare account id and KV id — `.gitignore` already blocks it)
- `extension/config.js` (has your real Worker URL — also gitignored)
- Anything under `.secrets/`

If you accidentally commit a secret, rotate it immediately (Anthropic key + Slack bot token + JWT secret) and force-push history rewrite.
