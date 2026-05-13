// popup.js - PaxNews popup (PIN-based authentication via Slack DM)

const WORKER_URL = (window.PAXNEWS_CONFIG && window.PAXNEWS_CONFIG.WORKER_URL) || '';
const ALLOWED_DOMAIN = (window.PAXNEWS_CONFIG && window.PAXNEWS_CONFIG.ALLOWED_EMAIL_DOMAIN) || '@yourcompany.com';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let currentEmail = '';
let authToken = null;

let loadingView, loginView, loggedInView, message;
let emailInput, requestPinBtn, pinSection, pinInput, verifyPinBtn;
let userName, userEmail, logoutBtn;

document.addEventListener('DOMContentLoaded', async () => {
  loadingView = document.getElementById('loadingView');
  loginView = document.getElementById('loginView');
  loggedInView = document.getElementById('loggedInView');
  message = document.getElementById('message');
  emailInput = document.getElementById('email');
  requestPinBtn = document.getElementById('requestPinBtn');
  pinSection = document.getElementById('pinSection');
  pinInput = document.getElementById('pinInput');
  verifyPinBtn = document.getElementById('verifyPinBtn');
  userName = document.getElementById('userName');
  userEmail = document.getElementById('userEmail');
  logoutBtn = document.getElementById('logoutBtn');

  document.getElementById('versionDisplay').textContent = `v${EXTENSION_VERSION}`;

  setupEventListeners();
  await checkAuthState();
});

function setupEventListeners() {
  requestPinBtn.addEventListener('click', handleRequestPin);
  emailInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleRequestPin(); });
  pinInput.addEventListener('input', () => { verifyPinBtn.disabled = pinInput.value.trim().length === 0; });
  pinInput.addEventListener('keypress', (e) => { if (e.key === 'Enter' && pinInput.value.trim().length > 0) handleVerifyPin(); });
  verifyPinBtn.addEventListener('click', handleVerifyPin);
  logoutBtn.addEventListener('click', handleLogout);
}

async function checkAuthState() {
  try {
    const result = await chrome.storage.local.get(['authToken', 'authEmail', 'authName', 'authExpiresAt']);
    if (result.authToken && result.authExpiresAt) {
      const expiresAt = new Date(result.authExpiresAt);
      if (expiresAt > new Date()) {
        authToken = result.authToken;
        currentEmail = result.authEmail;
        showLoggedInView(result.authName || result.authEmail.split('@')[0], result.authEmail);
        return;
      }
    }
    showLoginView();
  } catch (error) {
    console.error('[Popup] Auth check error:', error);
    showLoginView();
  }
}

function configError() {
  if (!WORKER_URL || WORKER_URL.includes('YOUR-SUBDOMAIN')) {
    showMessage('extension not configured. edit config.js with worker url.', 'error');
    return true;
  }
  return false;
}

async function handleRequestPin() {
  if (configError()) return;
  const email = emailInput.value.trim().toLowerCase();
  if (!email) return showMessage('please enter your email', 'error');
  if (!email.endsWith(ALLOWED_DOMAIN)) {
    return showMessage(`only ${ALLOWED_DOMAIN} emails allowed`, 'error');
  }

  setLoading(true);
  try {
    const response = await fetch(`${WORKER_URL}/auth/request-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await response.json();
    if (response.ok) {
      currentEmail = email;
      showMessage('pin sent! check your slack dm and enter below', 'success');
      pinSection.classList.add('active');
      requestPinBtn.textContent = 'resend pin';
    } else {
      showMessage(data.error || 'failed to request pin', 'error');
    }
  } catch (error) {
    console.error('[Popup] Request error:', error);
    showMessage('network error - check connection', 'error');
  } finally {
    setLoading(false);
  }
}

async function handleVerifyPin() {
  if (configError()) return;
  const pin = pinInput.value.trim();
  if (!pin) return showMessage('please enter pin', 'error');

  setLoading(true);
  try {
    const response = await fetch(`${WORKER_URL}/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, pin, version: EXTENSION_VERSION })
    });
    const data = await response.json();

    if (response.ok && data.token) {
      authToken = data.token;
      const authData = {
        authToken: data.token,
        authEmail: currentEmail,
        authName: data.name || currentEmail.split('@')[0],
        authExpiresAt: data.expiresAt
      };
      await chrome.storage.local.set(authData);
      showMessage('authenticated successfully!', 'success');
      pinInput.value = '';
      setTimeout(() => showLoggedInView(authData.authName, authData.authEmail), 800);
    } else {
      showMessage(data.error || 'invalid pin', 'error');
      pinInput.value = '';
      pinInput.focus();
    }
  } catch (error) {
    console.error('[Popup] Verify error:', error);
    showMessage('network error - try again', 'error');
  } finally {
    setLoading(false);
  }
}

async function handleLogout() {
  if (authToken && WORKER_URL && !WORKER_URL.includes('YOUR-SUBDOMAIN')) {
    try {
      await fetch(`${WORKER_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
    } catch (error) {
      console.warn('[Popup] Logout request failed; clearing local state anyway:', error);
    }
  }
  await chrome.storage.local.remove(['authToken', 'authEmail', 'authName', 'authExpiresAt']);
  authToken = null;
  currentEmail = '';
  showLoginView();
  showMessage('logged out successfully', 'info');
}

function showLoginView() {
  loadingView.classList.remove('active');
  loginView.classList.add('active');
  loggedInView.classList.remove('active');
}

function showLoggedInView(name, email) {
  loadingView.classList.remove('active');
  loginView.classList.remove('active');
  loggedInView.classList.add('active');
  userName.textContent = name;
  userEmail.textContent = email;
}

function showMessage(text, type = 'info') {
  message.className = `message ${type}`;
  message.textContent = text;
  message.style.display = 'block';
  setTimeout(() => { message.style.display = 'none'; }, 5000);
}

function setLoading(loading) {
  requestPinBtn.disabled = loading;
  verifyPinBtn.disabled = loading || pinInput.value.trim().length === 0;
  emailInput.disabled = loading;
  pinInput.disabled = loading;
  if (loading) {
    requestPinBtn.textContent = 'loading...';
  } else {
    requestPinBtn.textContent = pinSection.classList.contains('active') ? 'resend pin' : 'request pin';
  }
}
