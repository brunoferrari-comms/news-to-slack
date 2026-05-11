// Copy this file to config.js and fill in your values.
//   WORKER_URL: the URL printed by `wrangler deploy`
//   ALLOWED_EMAIL_DOMAIN: same domain you set in wrangler.toml (include the leading @)

const PAXNEWS_CONFIG = {
  WORKER_URL: 'https://YOUR-WORKER.workers.dev',
  ALLOWED_EMAIL_DOMAIN: '@yourcompany.com'
};

if (typeof self !== 'undefined') {
  self.PAXNEWS_CONFIG = PAXNEWS_CONFIG;
}
if (typeof window !== 'undefined') {
  window.PAXNEWS_CONFIG = PAXNEWS_CONFIG;
}
