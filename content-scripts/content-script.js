// content-scripts/content-script.js
// Runs in the main frame AND all sub-frames (all_frames: true in manifest).
// This is the key fix for sites like Crunchyroll whose player lives inside an iframe.

if (typeof browser === 'undefined') {
  window.browser = chrome;
}

// ─── State ───────────────────────────────────────────────────────────────────

const IS_TOP_FRAME = window === window.top;

let sitesConfig    = null;   // Loaded from sites.json
let currentSiteId  = null;
let currentSite    = null;   // The matching entry from sitesConfig
let customButtons  = {};     // { siteId: [{label, selector}] } — user-added via picker
let settings = {
  extensionEnabled: true,
  debugMode:        false,
  pickerMode:       false,
};
let intervalId    = null;
let lastClickTime = 0;

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Try to get the top-level page hostname. Fails silently for cross-origin frames. */
function getTopHostname() {
  try { return window.top.location.hostname; } catch (_) { return null; }
}

function log(...args) {
  if (settings.debugMode) console.log('[Skipper]', ...args);
}

/** Returns all buttons for the active site: base config + user-added custom ones. */
function allButtons() {
  const base   = currentSite?.buttons  || [];
  const custom = customButtons[currentSiteId] || [];
  return [...base, ...custom];
}

/** querySelector with graceful failure for malformed selectors. */
function safeQuery(sel) {
  try { return document.querySelector(sel); }
  catch (e) { log('Bad selector:', sel, e.message); return null; }
}

// ─── Site detection ───────────────────────────────────────────────────────────

/**
 * Walk the config and return [siteId, siteObj] for the first match.
 * Checks both the current frame's hostname AND the top-level hostname so that
 * content injected inside same-origin iframes (e.g. Crunchyroll's player) is
 * detected correctly.
 */
function detectSite() {
  if (!sitesConfig) return null;
  const here = window.location.hostname;
  const top  = getTopHostname();

  for (const [id, site] of Object.entries(sitesConfig)) {
    const domains = site.domains || [];
    if (domains.some(d => here.includes(d)))            return [id, site];
    if (top && domains.some(d => top.includes(d)))      return [id, site];
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
    const el = safeQuery(btn.selector);
    if (el) {
      el.style.outline      = '3px solid #00e676';
      el.style.outlineOffset = '2px';
      el.setAttribute(HL_ATTR, btn.label);
      log(`Highlighted: ${btn.label}`);
    }
  });
}

// ─── Auto-click ──────────────────────────────────────────────────────────────

function runClicks() {
  const now = Date.now();
  // 10-second cooldown so we don't spam-click repeatedly.
  if (now - lastClickTime < 10_000) return;

  let clicked = false;
  allButtons().forEach(btn => {
    const el = safeQuery(btn.selector);
    if (el) {
      log(`Clicking: ${btn.label}`);
      el.click();
      clicked = true;
    }
  });
  if (clicked) lastClickTime = Date.now();
}

/** Bypass the cooldown — used by the debug "Click All Now" button. */
function forceClick() {
  lastClickTime = 0;
  runClicks();
}

// ─── Interval helpers ─────────────────────────────────────────────────────────

function stopInterval() {
  if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
}

function startAutoMode() {
  stopInterval();
  runClicks();
  intervalId = setInterval(runClicks, 500);
}

function startDebugMode() {
  stopInterval();
  applyHighlights();
  intervalId = setInterval(applyHighlights, 500);
}

// ─── Element picker ───────────────────────────────────────────────────────────

let pickerActive  = false;
let pickerHovered = null;

/**
 * Generate the most stable CSS selector we can for a given element.
 * Priority: data-* attributes > id > aria-label > class-based.
 */
function generateSelector(el) {
  const stableDataAttrs = [
    'data-testid', 'data-automationid', 'data-uia', 'data-qa', 'data-id',
  ];

  for (const attr of stableDataAttrs) {
    const val = el.getAttribute(attr);
    if (!val) continue;
    const s = `[${attr}="${val}"]`;
    try {
      const count = document.querySelectorAll(s).length;
      return count <= 3 ? s : `${el.tagName.toLowerCase()}${s}`;
    } catch (_) {}
  }

  if (el.id && !/^\d/.test(el.id) && el.id.length < 40) {
    const s = `#${el.id}`;
    try { if (document.querySelectorAll(s).length === 1) return s; } catch (_) {}
  }

  const aria = el.getAttribute('aria-label');
  if (aria) {
    const escaped = aria.replace(/"/g, '\\"');
    const s = `${el.tagName.toLowerCase()}[aria-label="${escaped}"]`;
    try { if (document.querySelectorAll(s).length <= 3) return s; } catch (_) {}
  }

  // Class-based — filter out auto-generated class names.
  const stableClasses = [...el.classList].filter(c =>
    c.length > 2 &&
    !/^\d/.test(c) &&
    // Skip React/CSS-module hashes like "sc-abc123" or "abc-a1b2c3d4"
    !/^[a-z]+-[a-z0-9]{5,}$/.test(c) &&
    // Skip camelCase-mixed names that look machine-generated
    !(/[a-z][A-Z]/.test(c) && /[A-Z][a-z]/.test(c) && c.length > 12)
  );

  if (stableClasses.length > 0) {
    const tag = el.tagName.toLowerCase();
    const s = `${tag}.${stableClasses.slice(0, 2).join('.')}`;
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

  // Persist result so the popup can read it when it re-opens.
  browser.storage.local.set({ pickerMode: false, lastPickedButton: result });

  // Also push to the popup immediately if it's currently open.
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

/** Brief on-page confirmation toast — tells the user to open Skipper to save. */
function showPickerToast(selector) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    background: #121212; color: #4caf50;
    border: 2px solid #4caf50; border-radius: 8px;
    padding: 10px 14px; font-family: system-ui, sans-serif; font-size: 13px;
    max-width: 320px; word-break: break-all;
    box-shadow: 0 4px 24px rgba(0,0,0,0.6); line-height: 1.5;
  `;
  el.innerHTML = `
    <strong>Element captured!</strong><br>
    <span style="color:#aaa;font-size:11px;font-family:monospace">${selector}</span><br>
    <span style="color:#888;font-size:11px">Open Skipper to label and save it.</span>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function activatePicker() {
  if (pickerActive) return;
  pickerActive = true;
  stopInterval();
  clearHighlights();
  document.addEventListener('mouseover', pickerMouseover, true);
  document.addEventListener('mouseout',  pickerMouseout,  true);
  document.addEventListener('click',     pickerClick,     true);
  document.addEventListener('keydown',   pickerKeydown,   true);
  log('Picker activated');
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

// ─── Apply settings ───────────────────────────────────────────────────────────

function applySettings() {
  if (!settings.extensionEnabled || !currentSiteId) {
    stopInterval();
    clearHighlights();
    deactivatePicker();
    return;
  }

  if (settings.pickerMode) {
    activatePicker();
  } else if (settings.debugMode) {
    deactivatePicker();
    startDebugMode();
  } else {
    deactivatePicker();
    clearHighlights();
    startAutoMode();
  }
}

// ─── Message listener ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {

    case 'updateSettings':
      if (msg.settings.customButtons !== undefined) {
        customButtons = msg.settings.customButtons;
      }
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
      // "Click All Now" from the debug panel.
      if (settings.debugMode && currentSiteId) {
        forceClick();
        sendResponse({ ok: true });
      }
      break;

    case 'getDetectedButtons':
      if (!currentSiteId) {
        sendResponse({ siteId: null, detected: [] });
      } else {
        sendResponse({
          siteId,
          siteName: currentSite?.name || currentSiteId,
          isIframe: !IS_TOP_FRAME,
          detected: allButtons().map(btn => ({
            label:    btn.label,
            selector: btn.selector,
            found:    !!safeQuery(btn.selector),
            custom:   !!btn.custom,
          })),
        });
      }
      break;
  }
  // Do NOT return true globally — only async handlers need it.
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // Fetch the sites config bundled with the extension.
    const resp = await fetch(browser.runtime.getURL('sites.json'));
    sitesConfig = await resp.json();

    // Load persisted settings.
    const stored = await browser.storage.local.get([
      'extensionEnabled', 'sites', 'debugMode', 'customButtons', 'pickerMode',
    ]);

    settings.extensionEnabled = stored.extensionEnabled !== false;
    settings.debugMode        = stored.debugMode  === true;
    settings.pickerMode       = stored.pickerMode === true;
    customButtons             = stored.customButtons || {};

    if (!settings.extensionEnabled) {
      log('Extension disabled');
      return;
    }

    const match = detectSite();
    if (!match) {
      log(`No site match for: ${window.location.hostname}` +
          (IS_TOP_FRAME ? '' : ` (iframe, top: ${getTopHostname()})`));
      return;
    }

    const [siteId, site] = match;
    const enabledSites   = stored.sites || {};
    if (enabledSites[siteId] === false) {
      log(`Site ${siteId} is disabled by user`);
      return;
    }

    currentSiteId = siteId;
    currentSite   = site;

    log(`Active on "${siteId}" — ${IS_TOP_FRAME ? 'main frame' : 'iframe @ ' + window.location.hostname}`);
    applySettings();

  } catch (err) {
    console.error('[Skipper] Init error:', err);
  }
}

init();
