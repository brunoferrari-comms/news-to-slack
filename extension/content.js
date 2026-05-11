// content.js - PaxNews content script
// Extracts article content from the current page (or selected text), sends it
// to the PaxNews Worker for AI summarization and posting to Slack.

const WORKER_URL = (self.PAXNEWS_CONFIG && self.PAXNEWS_CONFIG.WORKER_URL) || '';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let progressOverlay = null;

function createProgressUI() {
  if (progressOverlay) return progressOverlay;

  const overlay = document.createElement('div');
  overlay.id = 'paxnews-progress';
  overlay.innerHTML = `
    <style>
      #paxnews-progress {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #000;
        color: #00d9ff;
        padding: 20px 24px;
        border-radius: 12px;
        font-family: 'Courier New', Courier, monospace;
        font-size: 13px;
        box-shadow: 0 8px 32px rgba(0, 217, 255, 0.3);
        z-index: 999999;
        min-width: 280px;
        border: 1px solid #222;
        animation: paxSlideIn 0.3s ease-out;
      }
      @keyframes paxSlideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      @keyframes paxSlideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(400px); opacity: 0; } }
      #paxnews-progress.removing { animation: paxSlideOut 0.3s ease-out; }
      #paxnews-progress .title { font-size: 14px; font-weight: bold; margin-bottom: 12px; color: #00d9ff; text-transform: uppercase; letter-spacing: 1px; }
      #paxnews-progress .step { display: flex; align-items: center; margin: 8px 0; color: #666; }
      #paxnews-progress .step.active { color: #00d9ff; }
      #paxnews-progress .step.complete { color: #4CAF50; }
      #paxnews-progress .step.error { color: #ff6464; }
      #paxnews-progress .icon { margin-right: 8px; font-size: 16px; }
      #paxnews-progress .spinner {
        width: 12px; height: 12px;
        border: 2px solid #222; border-top-color: #00d9ff;
        border-radius: 50%; animation: paxSpin 0.8s linear infinite;
        margin-right: 8px;
      }
      @keyframes paxSpin { to { transform: rotate(360deg); } }
      #paxnews-progress .error-actions { margin-top: 16px; display: flex; gap: 8px; }
      #paxnews-progress .retry-button {
        flex: 1; background: #00d9ff; color: #000; border: none;
        padding: 10px 16px; border-radius: 6px; font-family: 'Courier New', Courier, monospace;
        font-size: 11px; font-weight: bold; text-transform: uppercase; cursor: pointer; letter-spacing: 1px;
      }
      #paxnews-progress .retry-button:hover { background: #00ffff; box-shadow: 0 0 12px rgba(0, 217, 255, 0.4); }
      #paxnews-progress .close-button {
        flex: 1; background: transparent; color: #999; border: 1px solid #222;
        padding: 10px 16px; border-radius: 6px; font-family: 'Courier New', Courier, monospace;
        font-size: 11px; font-weight: bold; text-transform: uppercase; cursor: pointer; letter-spacing: 1px;
      }
      #paxnews-progress .close-button:hover { border-color: #00d9ff; color: #00d9ff; }
    </style>
    <div class="title">paxnews 📰</div>
    <div id="paxnews-steps">
      <div class="step" data-step="extract"><span class="icon">○</span><span class="text">extracting content...</span></div>
      <div class="step" data-step="analyze"><span class="icon">○</span><span class="text">analyzing with claude...</span></div>
      <div class="step" data-step="post"><span class="icon">○</span><span class="text">posting to slack...</span></div>
    </div>
    <div id="paxnews-error" style="display: none;"></div>
  `;
  document.body.appendChild(overlay);
  progressOverlay = overlay;
  return overlay;
}

function updateProgress(step, status, customText = null) {
  if (!progressOverlay) return;
  const stepEl = progressOverlay.querySelector(`[data-step="${step}"]`);
  if (!stepEl) return;
  stepEl.classList.remove('active', 'complete', 'error');
  stepEl.classList.add(status);
  const icon = stepEl.querySelector('.icon');
  const textEl = stepEl.querySelector('.text');
  if (status === 'active') {
    icon.innerHTML = '<div class="spinner"></div>';
    if (customText) textEl.textContent = customText;
  } else if (status === 'complete') {
    icon.textContent = '✓';
    if (customText) textEl.textContent = customText;
  } else if (status === 'error') {
    icon.textContent = '✕';
    if (customText) textEl.textContent = customText;
  }
}

function showErrorWithRetry(errorMessage) {
  if (!progressOverlay) return;
  const errorDiv = progressOverlay.querySelector('#paxnews-error');
  errorDiv.style.display = 'block';
  errorDiv.innerHTML = `
    <div class="error-actions">
      <button class="retry-button" id="paxnews-retry">retry</button>
      <button class="close-button" id="paxnews-close">close</button>
    </div>
  `;
  document.getElementById('paxnews-retry').addEventListener('click', () => {
    errorDiv.style.display = 'none';
    analyzePage();
  });
  document.getElementById('paxnews-close').addEventListener('click', () => removeProgressUI(0));
  console.error('[PaxNews]', errorMessage);
}

function removeProgressUI(delay = 3000) {
  if (!progressOverlay) return;
  setTimeout(() => {
    if (progressOverlay) {
      progressOverlay.classList.add('removing');
      setTimeout(() => {
        if (progressOverlay && progressOverlay.parentNode) {
          progressOverlay.parentNode.removeChild(progressOverlay);
        }
        progressOverlay = null;
      }, 300);
    }
  }, delay);
}

const SecurityUtils = {
  rateLimiter: {
    requests: [],
    maxRequests: 10,
    timeWindow: 60000,
    canMakeRequest() {
      const now = Date.now();
      this.requests = this.requests.filter(t => now - t < this.timeWindow);
      if (this.requests.length >= this.maxRequests) return false;
      this.requests.push(now);
      return true;
    },
    getResetTime() {
      if (this.requests.length === 0) return 0;
      const oldest = Math.min(...this.requests);
      return this.timeWindow - (Date.now() - oldest);
    }
  },
  isValidUrl(url) {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      const h = u.hostname.toLowerCase();
      const privatePatterns = [/^localhost$/i, /^127\./, /^192\.168\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^::1$/, /^fc00:/, /^fe80:/];
      return !privatePatterns.some(p => p.test(h));
    } catch { return false; }
  },
  sanitizeContent(content) {
    if (!content || typeof content !== 'string') return '';
    let s = content;
    s = s.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[REDACTED]');
    s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]');
    s = s.replace(/\/\/[^:]+:[^@]+@/g, '//[REDACTED]@');
    s = s.replace(/sk-[A-Za-z0-9]{32,}/g, '[API_KEY]');
    s = s.replace(/sk-ant-[A-Za-z0-9_-]{32,}/g, '[API_KEY]');
    s = s.replace(/ghp_[A-Za-z0-9]{36}/g, '[TOKEN]');
    s = s.replace(/github_pat_[A-Za-z0-9_]{82}/g, '[TOKEN]');
    s = s.replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY]');
    s = s.replace(/eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, '[JWT_TOKEN]');
    s = s.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[PRIVATE_KEY]');
    s = s.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]');
    const max = 50000;
    if (s.length > max) s = s.substring(0, max);
    return s;
  }
};

let isInitialized = false;
function initializeContentScript() {
  if (isInitialized) return;
  isInitialized = true;
  console.log('[PaxNews] Content script loaded');

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ status: 'alive' });
      return true;
    }
    if (request.action === 'analyzePage') {
      sendResponse({ success: true, timestamp: Date.now() });
      analyzePage();
    }
    if (request.action === 'analyzeSelection') {
      sendResponse({ success: true, timestamp: Date.now() });
      if (request.selectedText && request.selectedText.length >= 100) {
        analyzePage(request.selectedText);
      } else {
        alert('PaxNews: select at least 100 characters of text to send.');
      }
    }
    return true;
  });
}
initializeContentScript();
document.addEventListener('DOMContentLoaded', initializeContentScript);

// Detect the page language (returns "pt", "en", "es" or "auto")
function detectLanguage() {
  const lang = (document.documentElement.lang || '').toLowerCase();
  if (lang.startsWith('pt')) return 'pt';
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('es')) return 'es';
  return 'auto';
}

// Extract the publication / site name. Tries og:site_name, application-name, then hostname.
function extractSiteName() {
  const og = document.querySelector('meta[property="og:site_name"]');
  if (og && og.content && og.content.trim().length > 1) return og.content.trim();
  const appName = document.querySelector('meta[name="application-name"]');
  if (appName && appName.content && appName.content.trim().length > 1) return appName.content.trim();
  try {
    const host = window.location.hostname.replace(/^www\./, '');
    return host.split('.')[0];
  } catch { return ''; }
}

async function getAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['authToken', 'authExpiresAt'], (result) => {
      if (!result.authToken || !result.authExpiresAt) return resolve(null);
      const expiresAt = new Date(result.authExpiresAt);
      if (expiresAt <= new Date()) return resolve(null);
      resolve(result.authToken);
    });
  });
}

function extractFullArticleContent() {
  const selectors = [
    'article', 'main', '[role="main"]',
    '.article-content', '.post-content', '.entry-content',
    '.content-area', '.post-body', '.article-body',
    '[class*="article"]', '[class*="content"]', '[class*="post"]'
  ];
  let article = null;
  for (const s of selectors) {
    article = document.querySelector(s);
    if (article) break;
  }
  if (!article) article = document.body;

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside', 'button', 'form'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      const pc = (parent.className?.toString() || '').toLowerCase();
      const pid = (parent.id || '').toLowerCase();
      const skip = ['menu', 'sidebar', 'widget', ' ad ', 'banner', 'comment', 'related', 'share', 'social'];
      if (skip.some(p => pc.includes(p.trim()) || pid.includes(p.trim()))) return NodeFilter.FILTER_REJECT;
      if (node.textContent.trim().length < 10) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const parts = [];
  let n;
  while ((n = walker.nextNode())) parts.push(n.textContent.trim());
  let content = parts.join('\n\n');
  if (content.length < 100 && article !== document.body) {
    content = article.innerText || article.textContent || '';
  }
  if (content.length < 100) content = document.body.innerText || '';
  return content;
}

async function analyzePage(customContent = null) {
  if (!WORKER_URL || WORKER_URL.includes('YOUR-SUBDOMAIN')) {
    alert('PaxNews: extension is not configured. Edit config.js with your Worker URL.');
    return;
  }

  if (!SecurityUtils.rateLimiter.canMakeRequest()) {
    const resetTime = Math.ceil(SecurityUtils.rateLimiter.getResetTime() / 1000);
    alert(`PaxNews: rate limit reached. Wait ${resetTime}s.`);
    return;
  }

  const currentUrl = window.location.href;
  if (!SecurityUtils.isValidUrl(currentUrl)) {
    alert('PaxNews: cannot analyze this page (invalid URL).');
    return;
  }

  const authToken = await getAuthToken();
  if (!authToken) {
    alert('PaxNews: not authenticated. Open the extension popup and log in.');
    return;
  }

  try {
    createProgressUI();

    let fullContent;
    if (customContent) {
      updateProgress('extract', 'active', 'using selected text...');
      fullContent = customContent;
      updateProgress('extract', 'complete');
    } else {
      updateProgress('extract', 'active', 'reading page content...');
      fullContent = extractFullArticleContent();
      if (!fullContent || fullContent.length < 100) {
        updateProgress('extract', 'error', 'not enough content found');
        showErrorWithRetry('Could not extract enough content from page');
        return;
      }
      updateProgress('extract', 'complete');
    }

    updateProgress('analyze', 'active', 'sending to claude...');
    const sanitized = SecurityUtils.sanitizeContent(fullContent);

    const response = await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'X-Extension-Version': EXTENSION_VERSION
      },
      body: JSON.stringify({
        content: sanitized,
        url: currentUrl,
        title: document.title || '',
        siteName: extractSiteName(),
        language: detectLanguage(),
        version: EXTENSION_VERSION
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      updateProgress('analyze', 'error', 'analysis failed');
      if (response.status === 401) {
        showErrorWithRetry('Authentication expired. Log in again via the popup.');
        return;
      }
      if (response.status === 429) {
        showErrorWithRetry(`Rate limit exceeded. ${err.retryAfter ? `Wait ${err.retryAfter}s.` : 'Try again later.'}`);
        return;
      }
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    updateProgress('analyze', 'complete');

    updateProgress('post', 'active', 'posting to slack...');
    await new Promise((r) => setTimeout(r, 400));
    if (result.slackPosted) {
      updateProgress('post', 'complete', 'posted to slack!');
    } else {
      updateProgress('post', 'complete', 'analysis complete');
    }

    removeProgressUI(3000);
  } catch (error) {
    console.error('[PaxNews] Error:', error);
    if (progressOverlay) {
      updateProgress('analyze', 'error', 'analysis failed');
      showErrorWithRetry(`Analysis failed: ${error.message}`);
    } else {
      alert(`PaxNews error: ${error.message}`);
    }
  }
}
