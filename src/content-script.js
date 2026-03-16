/**
 * src/content-script.js — Skipper entry point for the injected content script.
 *
 * Runs in the main frame AND every sub-frame (all_frames: true in manifest).
 * Imports generic utilities from core/ and adds all Skipper-specific logic:
 *   • Site detection from sites.json
 *   • Auto-clicking skip/next buttons with cooldown + health tracking
 *   • Debug mode (outlines + debug panel)
 *   • Element picker (delegates UI to core/picker.js)
 *   • Candidate detection (delegates scoring to core/candidates.js)
 *   • Cross-frame aggregation via postMessage
 */

// Browser API polyfill (Firefox uses `browser`, Chrome uses `chrome`).
if (typeof browser === 'undefined') {
  window.browser = chrome;
}

import { queryInTree, safeQuery, isElementVisible, generateSelector } from './core/dom.js';
import { activatePicker, deactivatePicker }                           from './core/picker.js';
import { scanForCandidates }                                          from './core/candidates.js';

// ─── State ────────────────────────────────────────────────────────────────────

const IS_TOP_FRAME = window === window.top;

let sitesConfig   = null;
let currentSiteId = null;
let currentSite   = null;
let customButtons = {};  // { siteId: [{label, selector}] }
let buttonToggles = {};  // { siteId: { label: boolean } }
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
let candidateBadgeCount   = 0;
let candidateScanDebounce = null;

// Cross-frame aggregation (top frame only).
const frameDetections = new Map(); // frameUrl → { siteId, detected }

// ─── Skipper-specific helpers ─────────────────────────────────────────────────

function getTopHostname() {
  try { return window.top.location.hostname; } catch (_) { return null; }
}

function log(...args) {
  if (settings.debugMode) console.log('[Skipper]', ...args);
}

/** All active buttons for the current site, filtered by per-button toggles. */
function activeButtons() {
  const base   = (currentSite?.buttons || []).filter(btn =>
    (buttonToggles[currentSiteId] || {})[btn.label] !== false
  );
  const custom = customButtons[currentSiteId] || [];
  return [...base, ...custom];
}

/** All buttons including disabled ones — used by the debug panel. */
function allButtons() {
  return [
    ...(currentSite?.buttons || []),
    ...(customButtons[currentSiteId] || []),
  ];
}

/**
 * Thin wrapper: query a selector on this page, respecting the site's shadow DOM
 * flag.  Replaces the old global `safeQuery`.
 */
function domQuery(selector) {
  return safeQuery(selector, document, currentSite?.searchShadowDom ?? false);
}

// ─── Site detection ───────────────────────────────────────────────────────────

function detectSite() {
  if (!sitesConfig) return null;
  const here = window.location.hostname;
  const top  = getTopHostname();

  for (const [id, site] of Object.entries(sitesConfig)) {
    if (!Array.isArray(site?.domains)) continue;
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
    const enabled = (buttonToggles[currentSiteId] || {})[btn.label] !== false;
    const el = domQuery(btn.selector);
    if (el) {
      el.style.outline       = enabled ? '3px solid #00e676' : '3px solid #555';
      el.style.outlineOffset = '2px';
      el.setAttribute(HL_ATTR, btn.label);
    }
  });
  broadcastDetections();
}

// ─── Click logic ──────────────────────────────────────────────────────────────

function scheduleClick(btn, el) {
  if (pendingClicks.has(btn.selector)) return;
  const delay = btn.delayMs || 0;

  const timerId = setTimeout(() => {
    pendingClicks.delete(btn.selector);
    const current = domQuery(btn.selector);
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
  if (Date.now() - lastClickTime < 10_000) return; // 10-second cooldown
  activeButtons().forEach(btn => {
    const el = domQuery(btn.selector);
    if (el) scheduleClick(btn, el);
  });
  broadcastDetections();
}

function forceClick() {
  lastClickTime = 0;
  pendingClicks.forEach(clearTimeout);
  pendingClicks.clear();
  runClicks();
}

// ─── Health tracking ──────────────────────────────────────────────────────────

function updateHealth(label) {
  const key = `${currentSiteId}__${label}`;
  const now = Date.now();
  if (!healthCache[key] || now - healthCache[key] > 3_600_000) {
    healthCache[key] = now;
    healthDirty = true;
  }
}

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
    found:    !!domQuery(btn.selector),
    custom:   !!btn.custom,
    enabled:  (buttonToggles[currentSiteId] || {})[btn.label] !== false,
  }));

  const msg = {
    type:     'skipper-frame-detection',
    siteId:   currentSiteId,
    frameUrl: window.location.href,
    detected,
  };

  try { window.top.postMessage(msg, '*'); }
  catch (_) { try { window.parent.postMessage(msg, '*'); } catch (_) {} }
}

if (IS_TOP_FRAME) {
  window.addEventListener('message', e => {
    if (e.data?.type !== 'skipper-frame-detection') return;
    frameDetections.set(e.data.frameUrl, {
      siteId:   e.data.siteId,
      detected: e.data.detected,
    });
  });
}

// ─── Observer ─────────────────────────────────────────────────────────────────

let mutationObserver   = null;
let fallbackIntervalId = null;
let debounceTimer      = null;

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
  fallbackIntervalId = setInterval(runCheck, 5_000);
  runCheck();
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

// ─── Candidate detection ──────────────────────────────────────────────────────

function runCandidateScan() {
  clearTimeout(candidateScanDebounce);
  candidateScanDebounce = setTimeout(() => {
    const results = scanForCandidates({
      isTracked: sel => activeButtons().some(b => b.selector === sel),
    });
    candidateBadgeCount = results.length;
    if (candidateBadgeCount > 0) {
      browser.runtime.sendMessage({ action: 'candidatesFound', count: candidateBadgeCount }).catch(() => {});
    }
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
    activatePicker({
      hint:     'Open Skipper to label and save it.',
      onPick:   ({ selector, label }) => {
        const result = {
          action:   'elementPicked',
          selector,
          label,
          siteId:   currentSiteId,
          isIframe: !IS_TOP_FRAME,
          frameUrl: window.location.href,
        };
        browser.storage.local.set({ pickerMode: false, lastPickedButton: result });
        browser.runtime.sendMessage(result).catch(() => {});
      },
      onCancel: () => {
        browser.storage.local.set({ pickerMode: false });
        browser.runtime.sendMessage({ action: 'pickerCancelled' }).catch(() => {});
      },
    });
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
      if (msg.settings.customButtons !== undefined) customButtons = msg.settings.customButtons;
      if (msg.settings.buttonToggles !== undefined) buttonToggles = msg.settings.buttonToggles;
      Object.assign(settings, msg.settings);
      applySettings();
      break;

    case 'activatePicker':
      settings.pickerMode = true;
      applySettings();
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
      const ownDetected   = allButtons().map(btn => ({
        label:    btn.label,
        selector: btn.selector,
        found:    !!domQuery(btn.selector),
        custom:   !!btn.custom,
        enabled:  siteToggleMap[btn.label] !== false,
        lastSeen: healthCache[`${currentSiteId}__${btn.label}`] || null,
        frameUrl: window.location.href,
        isIframe: !IS_TOP_FRAME,
      }));

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
        const all      = document.querySelectorAll(msg.selector);
        const inShadow = currentSite?.searchShadowDom ? !!domQuery(msg.selector) : false;
        sendResponse({ count: all.length, shadowHit: inShadow });
      } catch (e) {
        sendResponse({ count: 0, error: e.message });
      }
      break;
    }

    case 'ping':
      sendResponse({ ok: true });
      break;

    case 'getCandidates':
      sendResponse({
        siteId: currentSiteId,
        candidates: scanForCandidates({
          isTracked: sel => activeButtons().some(b => b.selector === sel),
        }),
      });
      break;

    case 'enableCandidateWatch':
      candidateWatchEnabled = !!msg.enabled;
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // 1. Sites config — background cache, then bundled fallback.
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
    customButtons             = stored.customButtons || {};
    buttonToggles             = stored.buttonToggles || {};
    healthCache               = stored.healthData    || {};

    if (!settings.extensionEnabled) { log('Extension disabled'); return; }

    // 3. Detect site.
    const match = detectSite();
    if (!match) {
      log(`No site match for: ${window.location.hostname}` +
          (!IS_TOP_FRAME ? ` (iframe, top: ${getTopHostname()})` : ''));
      return;
    }

    const [siteId, site] = match;
    const enabledSites   = stored.sites || {};
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
