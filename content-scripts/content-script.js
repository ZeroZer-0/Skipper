// content-scripts/content-script.js
// Runs in the main frame AND every sub-frame (all_frames: true).

if (typeof browser === 'undefined') {
  window.browser = chrome;
}

// ─── State ────────────────────────────────────────────────────────────────────

const IS_TOP_FRAME = window === window.top;

let sitesConfig    = null;
let currentSiteId  = null;
let currentSite    = null;
let customButtons  = {};    // { siteId: [{label, selector}] }
let buttonToggles  = {};    // { siteId: { label: boolean } }
let settings = {
  extensionEnabled: true,
  debugMode:        false,
  pickerMode:       false,
};

// Health tracking — written to storage in batches.
let healthCache = {};
let healthDirty = false;

// Click throttle.
let lastClickTime = 0;

// Pending delayed clicks — keyed by selector.
const pendingClicks = new Map();

// Candidate detection state.
let candidateWatchEnabled = false;
let candidateCache        = new Map();  // selector → ScoredCandidate
let candidateBadgeCount   = 0;
let candidateScanDebounce = null;

// ─── Candidate scoring constants ──────────────────────────────────────────────

const MIN_CANDIDATE_SCORE  = 40;
const HIGH_CANDIDATE_SCORE = 60;
const MAX_TEXT_LEN = 40;

const TEXT_PATTERNS = [
  { re: /^(skip intro|skip recap|skip credits|skip opening|next episode|skip outro)$/i, pts: 35 },
  { re: /^skip\s/i,                                    pts: 25 },
  { re: /\b(intro|recap|credits|opening|episode)\b/i,  pts: 20 },
  { re: /\bnext\s+(episode|chapter)\b/i,               pts: 20 },
  { re: /\bskip\b/i,                                   pts: 10 },
  { re: /\bnext\b/i,                                   pts:  5 },
];
const ATTR_TERMS  = /skip|next.?ep|intro|recap|credits|episode|outro|opening/i;
const CLASS_TERMS = /\b(skip|next.ep|intro|recap|credits|episode)\b/i;

// ─── Cross-frame aggregation (top frame only) ─────────────────────────────────
// Each sub-frame posts its detected buttons up to the top frame via postMessage.
// The top frame stores them here so the popup can see a merged picture.
const frameDetections = new Map(); // frameUrl → [{label, selector, found}]

// ─── Utilities ────────────────────────────────────────────────────────────────

function getTopHostname() {
  try { return window.top.location.hostname; } catch (_) { return null; }
}

function log(...args) {
  if (settings.debugMode) console.log('[Skipper]', ...args);
}

/** All active buttons: base config filtered by per-button toggles, plus custom buttons. */
function activeButtons() {
  const base   = (currentSite?.buttons   || []).filter(btn => {
    const siteToggles = buttonToggles[currentSiteId] || {};
    return siteToggles[btn.label] !== false; // default enabled
  });
  const custom = customButtons[currentSiteId] || [];
  return [...base, ...custom];
}

/** All buttons (including disabled) — used by the debug panel to show toggle state. */
function allButtons() {
  const base   = currentSite?.buttons   || [];
  const custom = customButtons[currentSiteId] || [];
  return [...base, ...custom];
}

// ─── DOM querying (with shadow DOM support) ───────────────────────────────────

function queryInTree(root, selector) {
  const direct = root.querySelector(selector);
  if (direct) return direct;

  // Walk shadow roots (only when the site config requests it — it's expensive).
  if (currentSite?.searchShadowDom) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = queryInTree(el.shadowRoot, selector);
        if (found) return found;
      }
    }
  }
  return null;
}

function safeQuery(selector) {
  try { return queryInTree(document, selector); }
  catch (e) { log('Bad selector:', selector, e.message); return null; }
}

// ─── Site detection ───────────────────────────────────────────────────────────

function detectSite() {
  if (!sitesConfig) return null;
  const here = window.location.hostname;
  const top  = getTopHostname();

  for (const [id, site] of Object.entries(sitesConfig)) {
    // Skip metadata-only keys (like "_comment")
    if (!site?.domains) continue;
    const domains = site.domains;
    if (domains.some(d => here.includes(d)))       return [id, site];
    if (top && domains.some(d => top.includes(d))) return [id, site];
  }
  return null;
}

// ─── Debug highlighting ───────────────────────────────────────────────────────

const HL_ATTR = 'data-skipper-hl';

function clearHighlights() {
  document.querySelectorAll(`[${HL_ATTR}]`).forEach(el => {
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-offset');
    el.removeAttribute(HL_ATTR);
  });
}

function applyHighlights() {
  clearHighlights();
  allButtons().forEach(btn => {
    const siteToggles = buttonToggles[currentSiteId] || {};
    const enabled = siteToggles[btn.label] !== false;
    const el = safeQuery(btn.selector);
    if (el) {
      // Green = enabled, grey outline = disabled (would not auto-click)
      el.style.outline       = enabled ? '3px solid #00e676' : '3px solid #555';
      el.style.outlineOffset = '2px';
      el.setAttribute(HL_ATTR, btn.label);
    }
  });
  broadcastDetections(); // keep cross-frame data fresh
}

// ─── Click logic ──────────────────────────────────────────────────────────────

function scheduleClick(btn, el) {
  if (pendingClicks.has(btn.selector)) return; // already queued
  const delay = btn.delayMs || 0;

  const timerId = setTimeout(() => {
    pendingClicks.delete(btn.selector);
    // Re-query in case the DOM changed during the delay.
    const current = safeQuery(btn.selector);
    if (current) {
      log(`Clicking (${delay}ms delay): ${btn.label}`);
      current.click();
      lastClickTime = Date.now();
      updateHealth(btn.label);
    }
  }, delay);

  pendingClicks.set(btn.selector, timerId);
}

function runClicks() {
  const now = Date.now();
  if (now - lastClickTime < 10_000) return; // 10-second cooldown

  activeButtons().forEach(btn => {
    const el = safeQuery(btn.selector);
    if (el) scheduleClick(btn, el);
  });

  broadcastDetections();
}

/** Bypass cooldown — used by the debug "Click All Now" action. */
function forceClick() {
  lastClickTime = 0;
  pendingClicks.forEach(clearTimeout);
  pendingClicks.clear();
  runClicks();
}

// ─── Selector health tracking ─────────────────────────────────────────────────

function updateHealth(label) {
  const key = `${currentSiteId}__${label}`;
  const now = Date.now();
  // Only mark dirty if the stored value is absent or stale by > 1 hour.
  if (!healthCache[key] || now - healthCache[key] > 3_600_000) {
    healthCache[key] = now;
    healthDirty = true;
  }
}

// Flush health cache to storage every 60 s.
setInterval(async () => {
  if (!healthDirty) return;
  try {
    await browser.storage.local.set({ healthData: healthCache });
    healthDirty = false;
  } catch (_) {}
}, 60_000);

// ─── Cross-frame detection broadcasting ───────────────────────────────────────

function broadcastDetections() {
  if (IS_TOP_FRAME || !currentSiteId) return;
  const detected = allButtons().map(btn => ({
    label:    btn.label,
    selector: btn.selector,
    found:    !!safeQuery(btn.selector),
    custom:   !!btn.custom,
    enabled:  (buttonToggles[currentSiteId] || {})[btn.label] !== false,
  }));

  try {
    window.top.postMessage({
      type:     'skipper-frame-detection',
      siteId:   currentSiteId,
      frameUrl: window.location.href,
      detected,
    }, '*');
  } catch (_) {
    try {
      window.parent.postMessage({
        type:     'skipper-frame-detection',
        siteId:   currentSiteId,
        frameUrl: window.location.href,
        detected,
      }, '*');
    } catch (_) {}
  }
}

// Top frame: collect cross-frame detections.
if (IS_TOP_FRAME) {
  window.addEventListener('message', e => {
    if (e.data?.type !== 'skipper-frame-detection') return;
    frameDetections.set(e.data.frameUrl, {
      siteId:   e.data.siteId,
      detected: e.data.detected,
    });
  });
}

// ─── Observer + interval (replacing the old plain setInterval) ────────────────

let mutationObserver  = null;
let fallbackIntervalId = null;
let debounceTimer     = null;

function onMutation() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runCheck, 100);
}

function runCheck() {
  if (!currentSiteId || !settings.extensionEnabled) return;
  if (settings.pickerMode) return;
  if (settings.debugMode) applyHighlights();
  else runClicks();
  if (candidateWatchEnabled) runCandidateScan();
}

function startObserving() {
  stopObserving();
  mutationObserver = new MutationObserver(onMutation);
  mutationObserver.observe(document.documentElement, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-testid'],
  });
  // Safety-net interval in case the observer misses purely CSS visibility changes.
  fallbackIntervalId = setInterval(runCheck, 5_000);
  runCheck(); // immediate first pass
}

function stopObserving() {
  mutationObserver?.disconnect();
  mutationObserver = null;
  if (fallbackIntervalId !== null) { clearInterval(fallbackIntervalId); fallbackIntervalId = null; }
  clearTimeout(debounceTimer);
  pendingClicks.forEach(clearTimeout);
  pendingClicks.clear();
  candidateWatchEnabled = false;
  clearTimeout(candidateScanDebounce);
}

// ─── Element picker ───────────────────────────────────────────────────────────

let pickerActive  = false;
let pickerHovered = null;

function generateSelector(el) {
  const stableDataAttrs = ['data-testid', 'data-automationid', 'data-uia', 'data-qa', 'data-id'];

  for (const attr of stableDataAttrs) {
    const val = el.getAttribute(attr);
    if (!val) continue;
    const s = `[${attr}="${val}"]`;
    try {
      return document.querySelectorAll(s).length <= 3 ? s : `${el.tagName.toLowerCase()}${s}`;
    } catch (_) {}
  }

  if (el.id && !/^\d/.test(el.id) && el.id.length < 40) {
    const s = `#${el.id}`;
    try { if (document.querySelectorAll(s).length === 1) return s; } catch (_) {}
  }

  const aria = el.getAttribute('aria-label');
  if (aria) {
    const s = `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    try { if (document.querySelectorAll(s).length <= 3) return s; } catch (_) {}
  }

  const stableClasses = [...el.classList].filter(c =>
    c.length > 2 &&
    !/^\d/.test(c) &&
    !/^[a-z]+-[a-z0-9]{5,}$/.test(c) &&
    !(/[a-z][A-Z]/.test(c) && /[A-Z][a-z]/.test(c) && c.length > 12)
  );
  if (stableClasses.length > 0) {
    const s = `${el.tagName.toLowerCase()}.${stableClasses.slice(0, 2).join('.')}`;
    try { if (document.querySelectorAll(s).length <= 5) return s; } catch (_) {}
  }

  const role = el.getAttribute('role');
  if (role) return `${el.tagName.toLowerCase()}[role="${role}"]`;
  return el.tagName.toLowerCase();
}

function pickerMouseover(e) {
  e.stopPropagation();
  if (pickerHovered && pickerHovered !== e.target) clearPickerHover();
  pickerHovered = e.target;
  pickerHovered.style.outline       = '2px dashed #ff6d00';
  pickerHovered.style.outlineOffset = '2px';
  pickerHovered.style.cursor        = 'crosshair';
}

function clearPickerHover() {
  if (!pickerHovered) return;
  pickerHovered.style.removeProperty('outline');
  pickerHovered.style.removeProperty('outline-offset');
  pickerHovered.style.removeProperty('cursor');
  pickerHovered = null;
}

function pickerMouseout(e) {
  if (pickerHovered === e.target) clearPickerHover();
}

function pickerClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const selector  = generateSelector(e.target);
  const labelText = (e.target.textContent || '').trim().substring(0, 60)
                 || e.target.getAttribute('aria-label')
                 || e.target.tagName.toLowerCase();

  deactivatePicker();

  const result = {
    action:   'elementPicked',
    selector,
    label:    labelText,
    siteId:   currentSiteId,
    isIframe: !IS_TOP_FRAME,
    frameUrl: window.location.href,
  };

  browser.storage.local.set({ pickerMode: false, lastPickedButton: result });
  browser.runtime.sendMessage(result).catch(() => {});
  showPickerToast(selector);
}

function pickerKeydown(e) {
  if (e.key === 'Escape') {
    deactivatePicker();
    browser.storage.local.set({ pickerMode: false });
    browser.runtime.sendMessage({ action: 'pickerCancelled' }).catch(() => {});
  }
}

function showPickerToast(selector) {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;top:16px;right:16px;z-index:2147483647;
    background:#121212;color:#4caf50;border:2px solid #4caf50;border-radius:8px;
    padding:10px 14px;font-family:system-ui,sans-serif;font-size:13px;
    max-width:320px;word-break:break-all;line-height:1.5;
    box-shadow:0 4px 24px rgba(0,0,0,.6);
  `;
  el.innerHTML = `
    <strong>Element captured!</strong><br>
    <span style="color:#aaa;font-size:11px;font-family:monospace">${selector}</span><br>
    <span style="color:#777;font-size:11px">Open Skipper to label and save it.</span>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5_000);
}

function activatePicker() {
  if (pickerActive) return;
  pickerActive = true;
  stopObserving();
  clearHighlights();
  document.addEventListener('mouseover', pickerMouseover, true);
  document.addEventListener('mouseout',  pickerMouseout,  true);
  document.addEventListener('click',     pickerClick,     true);
  document.addEventListener('keydown',   pickerKeydown,   true);
  log('Picker activated in', IS_TOP_FRAME ? 'main frame' : 'iframe');
}

function deactivatePicker() {
  if (!pickerActive) return;
  pickerActive = false;
  clearPickerHover();
  document.removeEventListener('mouseover', pickerMouseover, true);
  document.removeEventListener('mouseout',  pickerMouseout,  true);
  document.removeEventListener('click',     pickerClick,     true);
  document.removeEventListener('keydown',   pickerKeydown,   true);
  log('Picker deactivated');
}

// ─── Candidate detection ──────────────────────────────────────────────────────

function isElementVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

function isAlreadyTracked(selector) {
  return activeButtons().some(btn => btn.selector === selector);
}

function scoreElement(el) {
  const text = (el.textContent || '').trim();
  if (!text || text.length > MAX_TEXT_LEN) return null;

  let score = 0;
  const reasons = [];

  // 1. Text pattern scoring
  for (const { re, pts } of TEXT_PATTERNS) {
    if (re.test(text)) { score += pts; reasons.push(`text:${pts}`); break; }
  }

  // 2. Attribute scoring
  const attrs = ['data-testid', 'data-automationid', 'data-uia', 'aria-label'];
  for (const attr of attrs) {
    const val = el.getAttribute(attr) || '';
    if (ATTR_TERMS.test(val)) { score += 5; reasons.push(`${attr}:5`); }
  }
  if (CLASS_TERMS.test(el.className || '')) { score += 4; reasons.push('class:4'); }

  // 3. Element type bonus
  const tag  = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  if (tag === 'button' || role === 'button') { score += 2; reasons.push('tag:2'); }

  // 4. Size guard — must be visible and not too wide (nav bars, etc.)
  if (!isElementVisible(el)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width > 300) return null;

  if (score < MIN_CANDIDATE_SCORE) return null;

  const selector = generateSelector(el);
  if (isAlreadyTracked(selector)) return null;

  return {
    score,
    label:      text.substring(0, 60) || el.getAttribute('aria-label') || tag,
    selector,
    reasons,
    scoreLabel: score >= HIGH_CANDIDATE_SCORE ? 'High' : 'Medium',
  };
}

function scanForCandidates() {
  const candidates = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button,[role=button],[tabindex]')) {
    try {
      const result = scoreElement(el);
      if (!result) continue;
      if (seen.has(result.selector)) continue;
      seen.add(result.selector);
      candidates.push(result);
    } catch (_) {}
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

function runCandidateScan() {
  clearTimeout(candidateScanDebounce);
  candidateScanDebounce = setTimeout(() => {
    const results = scanForCandidates();
    candidateCache.clear();
    results.forEach(c => candidateCache.set(c.selector, c));
    candidateBadgeCount = results.length;
    browser.runtime.sendMessage({ action: 'candidatesUpdated', count: candidateBadgeCount }).catch(() => {});
  }, 2_000);
}

// ─── Apply settings ───────────────────────────────────────────────────────────

function applySettings() {
  if (!settings.extensionEnabled || !currentSiteId) {
    stopObserving();
    clearHighlights();
    deactivatePicker();
    return;
  }

  if (settings.pickerMode) {
    stopObserving();
    activatePicker();
  } else if (settings.debugMode) {
    deactivatePicker();
    startObserving();
    candidateWatchEnabled = true;
  } else {
    deactivatePicker();
    clearHighlights();
    startObserving();
    candidateWatchEnabled = true;
  }
}

// ─── Message listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    case 'updateSettings':
      if (msg.settings.customButtons  !== undefined) customButtons  = msg.settings.customButtons;
      if (msg.settings.buttonToggles  !== undefined) buttonToggles  = msg.settings.buttonToggles;
      Object.assign(settings, msg.settings);
      applySettings();
      break;

    case 'activatePicker':
      settings.pickerMode = true;
      activatePicker();
      break;

    case 'deactivatePicker':
      settings.pickerMode = false;
      deactivatePicker();
      applySettings();
      break;

    case 'clickDetected':
      if (settings.debugMode && currentSiteId) {
        forceClick();
        sendResponse({ ok: true });
      }
      break;

    case 'getDetectedButtons': {
      const siteToggleMap = buttonToggles[currentSiteId] || {};

      // Own frame detections
      const ownDetected = allButtons().map(btn => ({
        label:    btn.label,
        selector: btn.selector,
        found:    !!safeQuery(btn.selector),
        custom:   !!btn.custom,
        enabled:  siteToggleMap[btn.label] !== false,
        lastSeen: healthCache[`${currentSiteId}__${btn.label}`] || null,
        frameUrl: window.location.href,
        isIframe: !IS_TOP_FRAME,
      }));

      // Merge cross-frame detections collected via postMessage (top frame only)
      const crossFrameDetected = [];
      if (IS_TOP_FRAME) {
        frameDetections.forEach(({ siteId, detected }, frameUrl) => {
          if (siteId === currentSiteId) {
            detected.forEach(btn => crossFrameDetected.push({ ...btn, frameUrl, isIframe: true }));
          }
        });
      }

      sendResponse({
        siteId:   currentSiteId,
        siteName: currentSite?.name || currentSiteId,
        detected: [...ownDetected, ...crossFrameDetected],
      });
      break;
    }

    case 'testSelector': {
      try {
        const all  = document.querySelectorAll(msg.selector);
        const inShadow = currentSite?.searchShadowDom ? !!safeQuery(msg.selector) : false;
        sendResponse({ count: all.length, shadowHit: inShadow });
      } catch (e) {
        sendResponse({ count: 0, error: e.message });
      }
      break;
    }

    case 'getCandidates':
      sendResponse(scanForCandidates());
      break;

    case 'enableCandidateWatch':
      candidateWatchEnabled = !!msg.enabled;
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Get sites config — prefer background's cached copy, fall back to
    //    direct fetch of the bundled file.
    try {
      const resp = await browser.runtime.sendMessage({ action: 'getSitesConfig' });
      sitesConfig = resp?.config ?? null;
    } catch (_) {}

    if (!sitesConfig) {
      const r = await fetch(browser.runtime.getURL('sites.json'));
      sitesConfig = await r.json();
    }

    // 2. Load persisted settings.
    const stored = await browser.storage.local.get([
      'extensionEnabled', 'sites', 'debugMode',
      'customButtons', 'buttonToggles', 'pickerMode', 'healthData',
    ]);

    settings.extensionEnabled = stored.extensionEnabled !== false;
    settings.debugMode        = stored.debugMode  === true;
    settings.pickerMode       = stored.pickerMode === true;
    customButtons             = stored.customButtons  || {};
    buttonToggles             = stored.buttonToggles  || {};
    healthCache               = stored.healthData     || {};

    if (!settings.extensionEnabled) { log('Extension disabled'); return; }

    // 3. Detect site.
    const match = detectSite();
    if (!match) {
      log(`No site match for: ${window.location.hostname}` +
          (!IS_TOP_FRAME ? ` (iframe, top: ${getTopHostname()})` : ''));
      return;
    }

    const [siteId, site]   = match;
    const enabledSites     = stored.sites || {};
    if (enabledSites[siteId] === false) { log(`${siteId} disabled by user`); return; }

    currentSiteId = siteId;
    currentSite   = site;

    log(`Active on "${siteId}" — ${IS_TOP_FRAME ? 'main frame' : 'iframe @ ' + window.location.hostname}`);
    applySettings();

  } catch (err) {
    console.error('[Skipper] Init error:', err);
  }
}

init();
