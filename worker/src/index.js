// PaxNews Worker - backend for the Chrome extension.
// Endpoints:
//   POST /auth/request-access  { email } -> sends a 6-digit PIN to the user's Slack DM
//   POST /auth/verify-pin      { email, pin, version } -> returns { token, name, expiresAt }
//   POST /api/analyze          (Authorization: Bearer <token>) { content, url, title } -> summarises and posts to Slack
//   GET  /healthz              -> { ok: true }

const TEXT_JSON = { 'Content-Type': 'application/json' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Extension-Version'
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...TEXT_JSON, ...CORS_HEADERS, ...extraHeaders }
  });
}

function badRequest(error) { return json({ error }, 400); }
function unauthorized(error = 'unauthorized') { return json({ error }, 401); }
function tooMany(retryAfter = 60) {
  return json({ error: 'rate limit exceeded', retryAfter }, 429, { 'Retry-After': String(retryAfter) });
}
function serverError(error = 'internal error') { return json({ error }, 500); }

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz') return json({ ok: true });
      if (url.pathname === '/auth/request-access' && request.method === 'POST') {
        return await handleRequestAccess(request, env);
      }
      if (url.pathname === '/auth/verify-pin' && request.method === 'POST') {
        return await handleVerifyPin(request, env);
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        return await handleLogout(request, env);
      }
      if (url.pathname === '/api/analyze' && request.method === 'POST') {
        return await handleAnalyze(request, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error('Worker error:', e);
      return serverError();
    }
  }
};

// ---------------- helpers ----------------

async function readJson(request) {
  try { return await request.json(); }
  catch { return null; }
}

function isValidEmail(email, allowedDomain) {
  if (!email || typeof email !== 'string') return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (allowedDomain && !email.toLowerCase().endsWith(allowedDomain.toLowerCase())) return false;
  return true;
}

function generatePin() {
  // 6-digit numeric PIN
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return n.toString().padStart(6, '0');
}

async function rateLimited(env, key, max, windowSec) {
  // simple sliding-window counter via KV
  const k = `rl:${key}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await env.PAXNEWS_KV.get(k);
  let bucket = raw ? JSON.parse(raw) : { count: 0, reset: now + windowSec };
  if (now >= bucket.reset) bucket = { count: 0, reset: now + windowSec };
  bucket.count += 1;
  const retryAfter = bucket.reset - now;
  await env.PAXNEWS_KV.put(k, JSON.stringify(bucket), { expirationTtl: windowSec + 5 });
  return { limited: bucket.count > max, retryAfter };
}

// ---------------- JWT (HS256) ----------------

function b64urlEncode(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function utf8(str) { return new TextEncoder().encode(str); }
function fromUtf8(bytes) { return new TextDecoder().decode(bytes); }

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signJwt(payload, secret, ttlSeconds = 60 * 60 * 24 * 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttlSeconds, ...payload, jti: crypto.randomUUID() };
  const h = b64urlEncode(utf8(JSON.stringify(header)));
  const p = b64urlEncode(utf8(JSON.stringify(body)));
  const data = `${h}.${p}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(data)));
  return { token: `${data}.${b64urlEncode(sig)}`, expiresAt: new Date(body.exp * 1000).toISOString() };
}

async function verifyJwt(token, secret, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await hmacKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(`${h}.${p}`)));
  const actual = b64urlDecode(s);
  if (expected.length !== actual.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  if (diff !== 0) return null;
  let payload;
  try {
    payload = JSON.parse(fromUtf8(b64urlDecode(p)));
  } catch { return null; }
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
  if (payload.jti && env?.PAXNEWS_KV) {
    const revoked = await env.PAXNEWS_KV.get(`rev:${payload.jti}`);
    if (revoked) return null;
  }
  return payload;
}

// ---------------- Slack ----------------

async function slackApi(env, method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) console.error(`Slack ${method} error:`, data.error, data);
  return data;
}

async function lookupSlackUserByEmail(env, email) {
  const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  const data = await res.json();
  if (!data.ok) return null;
  return data.user; // { id, real_name, profile, ... }
}

async function sendSlackDm(env, userId, text) {
  // Open a DM channel, then post the message
  const open = await slackApi(env, 'conversations.open', { users: userId });
  if (!open.ok) return null;
  const channelId = open.channel.id;
  return slackApi(env, 'chat.postMessage', { channel: channelId, text });
}

async function postNewsToChannel(env, { meta, url, siteName }) {
  // meta = { emoji, title, summary, tags }
  const safeSite = (siteName || '').trim().toLowerCase();
  const tagsLine = (meta.tags || []).length
    ? (meta.tags || []).map((t) => `\`${escapeMrkdwn(String(t).trim())}\``).join('  ')
    : '';

  const blocks = [];

  // Site chip on top (small grey context line)
  if (safeSite) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🌐 \`${escapeMrkdwn(safeSite)}\`` }]
    });
  }

  // Big title with thematic emoji
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${meta.emoji || '📰'} ${truncate(meta.title || 'PaxNews item', 145)}`,
      emoji: true
    }
  });

  // Single-paragraph summary (rendered as a Slack blockquote — gray box with vertical bar)
  const quotedSummary = (meta.summary || '')
    .split('\n')
    .map((line) => `> ${escapeMrkdwn(line)}`)
    .join('\n');
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: quotedSummary }
  });

  // Tags (only if we have any)
  if (tagsLine) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: tagsLine }]
    });
  }

  // CTA button — Read article
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Read article 📖', emoji: true },
        url
      }
    ]
  });

  // Footer signature
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_Added by PaxNews_' }]
  });

  // Fallback text (notifications / clients without block support)
  const text = `${meta.emoji || '📰'} ${escapeMrkdwn(meta.title || 'PaxNews item')}\n${escapeMrkdwn(meta.summary || '')}\n${escapeMrkdwn(url)}`;

  const res = await slackApi(env, 'chat.postMessage', {
    channel: env.SLACK_NEWS_CHANNEL,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false
  });
  if (!res.ok) return false;

  // Post detailed bullets as a thread reply (more depth for readers who want it)
  if (Array.isArray(meta.bullets) && meta.bullets.length && res.ts) {
    const bulletText = meta.bullets
      .map((b) => `• ${escapeMrkdwn(String(b).trim())}`)
      .join('\n\n');
    await slackApi(env, 'chat.postMessage', {
      channel: res.channel || env.SLACK_NEWS_CHANNEL,
      thread_ts: res.ts,
      text: bulletText,
      unfurl_links: false,
      unfurl_media: false
    });
  }

  return true;
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function escapeMrkdwn(s) {
  if (!s) return '';
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// ---------------- Anthropic ----------------

async function summariseWithClaude(env, { content, title, url, siteName, language }) {
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const langHint =
    language === 'pt' ? 'Portuguese (Brazilian)' :
    language === 'en' ? 'English' :
    language === 'es' ? 'Spanish' :
    'the SAME language as the article';

  const system = `You are PaxNews, summarising a news article for the #breaking-news Slack channel at PAX/Paladium (a Brazilian fintech/AI company).

Detect the article's language and write the summary, title, and tags ALL in ${langHint}.

Return ONLY a single valid JSON object — no prose, no markdown, no code fences. Shape:
{
  "emoji": "<one single emoji that thematically matches the news>",
  "title": "<cleaned article title — remove publication/campaign suffixes like '| Dino', '| Valor Econômico', '— Folha de S.Paulo', '| Reuters', etc; keep only the actual headline>",
  "summary": "<a SINGLE short paragraph, 2-4 sentences, ~40-70 words, focusing on the most important facts: who, what, numbers, dates, names. No bullets. No line breaks.>",
  "tags": ["<2 to 5 short lowercase tags, no leading hash, e.g. 'fintech', 'mercado pago', 'unicórnio brasileiro'>"],
  "bullets": ["<5 to 8 short bullet strings (NO leading bullet character), each one ~10-25 words, with the most important specific facts: numbers, percentages, dates, names, comparisons; meant to be posted as a thread reply for readers who want more depth than the summary>"]
}

Emoji guide (match the topic, do not invent emojis):
🦄 unicorn startups · 📈 growth/financials · 💰 funding/M&A · 🤖 AI/automation · 🚓 public safety/policing · 💳 fintech/payments · 🛡️ security/cybersec · 🌎 international/geopolitics · 📊 data/research · 🛒 e-commerce · 🏦 banking · ⚖️ legal/regulation · 🚀 product launch · 📱 tech/consumer · ⚡ energy · 🏥 health · 🎓 education · 📰 generic news

Stay strictly grounded in the provided text. Do NOT invent facts, numbers, or quotes. If something is unclear, omit it.`;

  const userText = `Site: ${siteName || '(unknown)'}\nTitle: ${title || '(unknown)'}\nURL: ${url}\n\n---\n${content}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: userText.slice(0, 60000) }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Anthropic error:', res.status, errText);
    throw new Error(`anthropic api error (${res.status})`);
  }
  const data = await res.json();
  const out = data.content?.[0]?.text?.trim();
  if (!out) throw new Error('claude returned empty response');

  // Try to parse JSON (Claude may wrap in code fences or add prose around it)
  let parsed = tryParseJson(out);
  if (!parsed) {
    console.error('Failed to parse Claude JSON, raw:', out);
    parsed = { emoji: '📰', title: title || 'PaxNews item', summary: out, tags: [] };
  }
  return {
    emoji: parsed.emoji || '📰',
    title: cleanTitle(parsed.title || title || 'PaxNews item'),
    summary: parsed.summary || '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 8) : []
  };
}

function tryParseJson(text) {
  if (!text) return null;
  const candidates = [];
  candidates.push(text.trim());
  const stripped = text.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
  candidates.push(stripped);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch {}
  }
  return null;
}

// Strip leftover publication/campaign suffixes that Claude may have missed
function cleanTitle(t) {
  if (!t) return '';
  // Common separators: " | ", " — ", " – ", " - ", " :: "
  const noise = [
    /\s[|—–‐\-]\s+dino(\s[|—–‐\-].*)?$/i,
    /\s[|—–‐\-]\s+pr newswire.*$/i,
    /\s[|—–‐\-]\s+globe newswire.*$/i,
    /\s[|—–‐\-]\s+business wire.*$/i
  ];
  for (const re of noise) t = t.replace(re, '');
  return t.trim();
}

// ---------------- handlers ----------------

async function handleRequestAccess(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest('invalid json');
  const allowed = env.ALLOWED_EMAIL_DOMAIN || '@yourcompany.com';
  const email = (body.email || '').toLowerCase().trim();

  if (!isValidEmail(email, allowed)) {
    return badRequest(`email must end with ${allowed}`);
  }

  const rl = await rateLimited(env, `pin:${email}`, 5, 600); // 5 pin requests per 10 min per email
  if (rl.limited) return tooMany(rl.retryAfter);

  const user = await lookupSlackUserByEmail(env, email);
  if (!user) {
    return json({ ok: true });
  }

  const pin = generatePin();
  await env.PAXNEWS_KV.put(
    `pin:${email}`,
    JSON.stringify({ pin, attempts: 0, slackUserId: user.id, name: user.real_name || user.name || email.split('@')[0] }),
    { expirationTtl: 600 } // 10 min
  );

  const sent = await sendSlackDm(env, user.id, `🔐 your paxnews login pin is *${pin}*. it expires in 10 minutes.`);
  if (!sent || !sent.ok) {
    return serverError('failed to send pin via slack dm');
  }

  return json({ ok: true });
}

async function handleVerifyPin(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest('invalid json');
  const email = (body.email || '').toLowerCase().trim();
  const pin = (body.pin || '').trim();
  if (!email || !pin) return badRequest('email and pin required');

  const stored = await env.PAXNEWS_KV.get(`pin:${email}`);
  if (!stored) return unauthorized('pin expired or not requested');

  let record;
  try { record = JSON.parse(stored); } catch { return unauthorized('invalid pin record'); }

  if (record.attempts >= 5) {
    await env.PAXNEWS_KV.delete(`pin:${email}`);
    return unauthorized('too many attempts, request a new pin');
  }

  if (record.pin !== pin) {
    record.attempts += 1;
    await env.PAXNEWS_KV.put(`pin:${email}`, JSON.stringify(record), { expirationTtl: 600 });
    return unauthorized('invalid pin');
  }

  // success
  await env.PAXNEWS_KV.delete(`pin:${email}`);

  const { token, expiresAt } = await signJwt(
    { sub: email, name: record.name, slackUserId: record.slackUserId },
    env.JWT_SECRET
  );

  return json({
    token,
    name: record.name,
    expiresAt,
    version: {
      current: body.version || 'unknown',
      expected: env.EXPECTED_EXTENSION_VERSION,
      needsUpdate: body.version && body.version !== env.EXPECTED_EXTENSION_VERSION
    }
  });
}

async function handleAnalyze(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = await verifyJwt(token, env.JWT_SECRET, env);
  if (!payload) return unauthorized('invalid or expired token');

  const rl = await rateLimited(env, `analyze:${payload.sub}`, 20, 60); // 20 per minute per user
  if (rl.limited) return tooMany(rl.retryAfter);

  const body = await readJson(request);
  if (!body) return badRequest('invalid json');

  const content = (body.content || '').toString();
  const url = (body.url || '').toString();
  const title = (body.title || '').toString();
  const siteName = (body.siteName || '').toString();
  const language = (body.language || 'auto').toString();
  if (!content || content.length < 100) return badRequest('content too short');
  if (!url) return badRequest('url required');

  // 1) summarise → returns { emoji, title, summary, tags }
  let meta;
  try {
    meta = await summariseWithClaude(env, { content, title, url, siteName, language });
  } catch (e) {
    return serverError(`summarisation failed: ${e.message}`);
  }

  // 2) post to slack
  const slackPosted = await postNewsToChannel(env, { meta, url, siteName });

  return json({
    ok: true,
    slackPosted,
    summary: meta.summary,
    meta,
    version: {
      current: request.headers.get('X-Extension-Version') || 'unknown',
      expected: env.EXPECTED_EXTENSION_VERSION,
      needsUpdate:
        request.headers.get('X-Extension-Version') &&
        request.headers.get('X-Extension-Version') !== env.EXPECTED_EXTENSION_VERSION
    }
  });
}

async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = await verifyJwt(token, env.JWT_SECRET, env);
  if (!payload) return unauthorized('invalid or expired token');
  if (payload.jti && payload.exp) {
    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) {
      await env.PAXNEWS_KV.put(`rev:${payload.jti}`, '1', { expirationTtl: ttl });
    }
  }
  return json({ ok: true });
}
