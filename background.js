// background.js — MV3 service worker
// Fetches the remote sites.json once per browser session and caches it.
// Content scripts and the popup request it via browser.runtime.sendMessage.

if (typeof browser === 'undefined') {
  self.browser = chrome;
}

// ─── Config ───────────────────────────────────────────────────────────────────

// Point this at the raw file in your repo. Anyone forking the project can swap
// this URL to host their own selector database.
const REMOTE_URL  = 'https://raw.githubusercontent.com/ZeroZer-0/Skipper/main/sites.json';
const SESSION_KEY = 'cachedSitesConfig';
const FETCH_TIMEOUT_MS = 8_000;

// ─── Storage helpers ──────────────────────────────────────────────────────────

// browser.storage.session exists in Chrome 102+ and Firefox 115+.
// Fall back to browser.storage.local so older versions still work.
function sessionStore() {
  return browser.storage.session ?? browser.storage.local;
}

// ─── Fetch logic ──────────────────────────────────────────────────────────────

async function fetchRemote() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp  = await fetch(REMOTE_URL, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = await resp.json();
    console.log('[Skipper] Remote config loaded OK');
    return config;
  } catch (err) {
    console.warn('[Skipper] Remote config fetch failed:', err.message);
    return null;
  }
}

async function fetchBundled() {
  try {
    const resp = await fetch(browser.runtime.getURL('sites.json'));
    return await resp.json();
  } catch (err) {
    console.error('[Skipper] Could not load bundled sites.json:', err);
    return null;
  }
}

/**
 * Fetch remote, fall back to bundled, write result to session storage.
 * Returns the loaded config (or null on total failure).
 */
async function refreshConfig() {
  const remote = await fetchRemote();
  const config = remote ?? (await fetchBundled());
  if (!config) return null;

  const store = sessionStore();
  await store.set({
    [SESSION_KEY]:            config,
    [`${SESSION_KEY}_source`]: remote ? 'remote' : 'bundled',
    [`${SESSION_KEY}_ts`]:     Date.now(),
  });
  return config;
}

async function getCachedConfig() {
  const store = sessionStore();
  const data  = await store.get(SESSION_KEY);
  return data[SESSION_KEY] ?? null;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(refreshConfig);
browser.runtime.onStartup.addListener(refreshConfig);

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'getSitesConfig') {
    // If nothing is cached yet (fresh install before onInstalled fires),
    // go fetch it now.
    getCachedConfig()
      .then(config => config ? sendResponse({ config }) : refreshConfig().then(c => sendResponse({ config: c })))
      .catch(() => sendResponse({ config: null }));
    return true; // keep channel open for async response
  }

  if (msg.action === 'refreshConfig') {
    refreshConfig()
      .then(config => sendResponse({ ok: !!config }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
