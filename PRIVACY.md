# Privacy Policy

_Last updated: 2026-05-11_

This privacy policy describes how the **news-to-slack** Chrome extension (the "Extension") handles your data.

## What the Extension does

The Extension lets you send the content of a web page you're currently viewing to a Cloudflare Worker, which summarises it with the Anthropic Claude API and posts the result to a Slack channel.

## What data we collect

The Extension processes the following data, only when you explicitly trigger an action ("Send page to PaxNews"):

| Data | Why | Where it goes |
| --- | --- | --- |
| Your email address | To authenticate you and email a one-time PIN | Stored in Cloudflare KV with a 10-minute TTL; deleted automatically after that |
| A 6-digit login PIN | One-time authentication | Sent to you as a Slack DM; expires in 10 minutes |
| The text content and title of the page you choose to send | Required to generate the summary | Sent to the Anthropic Claude API for processing |
| The page URL | Shown in the Slack post | Sent to the Slack API |
| Your auth token (JWT) | To prove you're logged in on subsequent posts | Stored locally in Chrome's `chrome.storage`; expires after 30 days |

The Extension **does not**:
- Track your browsing in the background.
- Read pages you didn't explicitly choose to summarise.
- Sell, share, or transfer your data to anyone outside the data flow described above.
- Show ads or use any analytics SDK.

## Where the data lives

- **Cloudflare Worker** (operated by the project owner): handles authentication, calls the LLM API, posts to Slack. Source code is public at https://github.com/brunoferrari-comms/news-to-slack
- **Anthropic Claude API**: receives the page content for summarisation. See https://www.anthropic.com/legal/privacy
- **Slack API**: receives the final post and the auth PIN DM. See https://slack.com/trust/privacy/privacy-policy
- **Your local browser**: stores the auth token in `chrome.storage`.

## Retention

- PINs: 10 minutes (Cloudflare KV TTL).
- Auth tokens: 30 days (JWT expiry).
- Slack messages: persist in the destination channel as long as Slack retains them, per your workspace's retention policy.
- The Worker does not log page content or summaries to persistent storage.

## Your choices

- **Stop using the Extension**: uninstall it from `chrome://extensions`. Your local auth token is removed automatically when you uninstall.
- **Revoke access**: anyone with access to the Cloudflare Worker can manually purge your account from KV; contact the project owner.

## Contact

For questions about this policy, open an issue at https://github.com/brunoferrari-comms/news-to-slack/issues
