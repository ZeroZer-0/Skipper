/**
 * src/popup.js — Skipper popup UI.
 *
 * Communicates with the content script and background service worker exclusively
 * via browser.runtime / browser.tabs messages and browser.storage — it never
 * touches the page DOM directly, so it does not import from core/.
 */

// Browser API polyfill
if (typeof browser === 'undefined') {
  window.browser = chrome;
}

// ─── State ────────────────────────────────────────────────────────────────────

let sitesConfig      = null;
let customButtons    = {};     // { siteId: [{label, selector, custom}] }
let buttonToggles    = {};     // { siteId: { label: boolean } }
let healthData       = {};     // { "siteId__label": timestamp }
let currentTabId     = null;
let _candidateSiteId = null;  // siteId returned from last getCandidates response
let _debugSiteId     = null;  // siteId returned from last getDetectedButtons response

// ─── Element refs ─────────────────────────────────────────────────────────────

const globalToggle         = document.getElementById('globalToggle');
const debugToggle          = document.getElementById('debugToggle');
const refreshConfigBtn     = document.getElementById('refreshConfigBtn');
const siteOptions          = document.getElementById('siteOptions');
const siteList             = document.getElementById('siteList');
const localSection         = document.getElementById('localSection');
const localButtonsList     = document.getElementById('localButtonsList');
const exportBtn            = document.getElementById('exportBtn');
const importBtn            = document.getElementById('importBtn');
const importFileInput      = document.getElementById('importFileInput');
const debugPanel           = document.getElementById('debugPanel');
const debugSiteInfo        = document.getElementById('debugSiteInfo');
const detectedButtonsList  = document.getElementById('detectedButtonsList');
const clickAllBtn          = document.getElementById('clickAllBtn');
const selectorTestInput    = document.getElementById('selectorTestInput');
const selectorTestResult   = document.getElementById('selectorTestResult');
const siteBanner           = document.getElementById('siteBanner');
const statusBar            = document.getElementById('statusBar');
const candidateSection     = document.getElementById('candidateSection');
const candidateBadge       = document.getElementById('candidateBadge');
const candidateList        = document.getElementById('candidateList');
const scanCandidatesBtn    = document.getElementById('scanCandidatesBtn');
const saveToLocalWrap      = document.getElementById('saveToLocalWrap');
const saveToLocalLabel     = document.getElementById('saveToLocalLabel');
const saveToLocalBtn       = document.getElementById('saveToLocalBtn');

// ─── Status bar ───────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, type = '', ms = 3000) {
  statusBar.textContent = msg;
  statusBar.className   = type;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { statusBar.textContent = ''; statusBar.className = ''; }, ms);
}

// ─── Site status banner ───────────────────────────────────────────────────────

async function checkPageStatus() {
  // Try to ping the content script on the current tab.
  if (!currentTabId) return;
  try {
    await Promise.race([
      browser.tabs.sendMessage(currentTabId, { action: 'ping' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
    ]);
    // Content script is alive — no banner needed.
    siteBanner.style.display = 'none';
  } catch (_) {
    // Content script didn't respond. Check if we're on a known streaming domain.
    let url = '';
    try { url = (await browser.tabs.get(currentTabId)).url || ''; } catch (_) {}
    const supported = sitesConfig && Object.values(sitesConfig).some(
      s => Array.isArray(s.domains) && s.domains.some(d => url.includes(d))
    );
    if (supported) {
      siteBanner.style.cssText = 'display:block;padding:8px 14px;font-size:11px;line-height:1.5;border-bottom:1px solid #1c1c1c;background:#1e1600;color:#ff9800';
      siteBanner.textContent   = '⚠ Reload this page to activate Skipper.';
    } else {
      siteBanner.style.cssText = 'display:block;padding:8px 14px;font-size:11px;line-height:1.5;border-bottom:1px solid #1c1c1c;background:#1a1a1a;color:#555';
      siteBanner.textContent   = 'Navigate to a supported streaming site (Netflix, Hulu, Disney+…) to use Skipper.';
    }
  }
}

// ─── Load config ──────────────────────────────────────────────────────────────

async function loadSitesConfig() {
  try {
    const resp = await browser.runtime.sendMessage({ action: 'getSitesConfig' });
    if (resp?.config) { sitesConfig = resp.config; return; }
  } catch (_) {}
  try {
    const r = await fetch(browser.runtime.getURL('sites.json'));
    sitesConfig = await r.json();
  } catch (_) {}
}

// ─── Site list helpers ────────────────────────────────────────────────────────

function siteButtonList(siteId) {
  return [
    ...(sitesConfig?.[siteId]?.buttons || []),
    ...(customButtons[siteId] || []),
  ];
}

function isButtonEnabled(siteId, label) {
  return (buttonToggles[siteId] || {})[label] !== false;
}

function setButtonToggle(siteId, label, enabled) {
  if (!buttonToggles[siteId]) buttonToggles[siteId] = {};
  buttonToggles[siteId][label] = enabled;
}

// ─── Build per-site accordion ─────────────────────────────────────────────────

function buildSiteList(enabledSites) {
  siteList.innerHTML = '';
  if (!sitesConfig) return;

  for (const [siteId, site] of Object.entries(sitesConfig)) {
    if (!Array.isArray(site?.domains)) continue;

    const siteEnabled = enabledSites[siteId] !== false;
    const buttons     = siteButtonList(siteId);

    const block = document.createElement('div');
    block.className = 'site-block';

    // ── Header ──────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'site-header';

    const expand = document.createElement('span');
    expand.className = 'site-expand';
    expand.textContent = '▶';

    const favicon = document.createElement('img');
    favicon.className = 'site-favicon';
    favicon.width  = 16;
    favicon.height = 16;
    favicon.src    = `https://icons.duckduckgo.com/ip3/${site.domains[0]}.ico`;
    favicon.onerror = () => { favicon.style.display = 'none'; };

    const info = document.createElement('div');
    info.className = 'site-info';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'site-name';
    nameDiv.textContent = site.name;
    const domainDiv = document.createElement('div');
    domainDiv.className = 'site-domain';
    domainDiv.textContent = site.domains.join(', ');
    info.append(nameDiv, domainDiv);

    const siteSwitch = document.createElement('label');
    siteSwitch.className = 'switch';
    const siteCb = document.createElement('input');
    siteCb.type = 'checkbox';
    siteCb.checked = siteEnabled;
    siteCb.dataset.siteId = siteId;
    siteCb.addEventListener('change', e => { e.stopPropagation(); saveSettings(); });
    const siteSlider = document.createElement('span');
    siteSlider.className = 'slider';
    siteSwitch.append(siteCb, siteSlider);

    header.append(expand, favicon, info, siteSwitch);
    header.addEventListener('click', e => {
      if (siteSwitch.contains(e.target)) return;
      block.classList.toggle('open');
    });

    // ── Per-button list ──────────────────────────────────────────────────
    const btnList = document.createElement('div');
    btnList.className = 'btn-list';

    buttons.forEach(btn => {
      const row = document.createElement('div');
      row.className = 'btn-toggle-row';

      const lbl = document.createElement('span');
      lbl.className = 'btn-toggle-label' + (btn.custom ? ' custom-tag' : '');
      lbl.textContent = btn.label;

      const sw = document.createElement('label');
      sw.className = 'switch';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isButtonEnabled(siteId, btn.label);
      cb.dataset.siteId = siteId;
      cb.dataset.label  = btn.label;
      cb.addEventListener('change', () => {
        setButtonToggle(siteId, btn.label, cb.checked);
        saveSettings();
      });
      const sl = document.createElement('span');
      sl.className = 'slider';
      sw.append(cb, sl);

      row.append(lbl, sw);
      btnList.appendChild(row);
    });

    block.append(header, btnList);
    siteList.appendChild(block);
  }
}

// ─── Settings load / save / broadcast ────────────────────────────────────────

async function loadSettings() {
  const stored = await browser.storage.local.get([
    'extensionEnabled', 'sites', 'debugMode',
    'customButtons', 'buttonToggles', 'healthData',
    'selectorTestValue',
  ]);

  const extensionEnabled = stored.extensionEnabled !== false;
  const sites            = stored.sites   || {};
  const debugMode        = stored.debugMode  === true;
  customButtons          = stored.customButtons || {};
  buttonToggles          = stored.buttonToggles || {};
  healthData             = stored.healthData    || {};

  globalToggle.checked = extensionEnabled;
  debugToggle.checked  = debugMode;

  applyVisibility(extensionEnabled, debugMode);
  buildSiteList(sites);

  if (stored.selectorTestValue) selectorTestInput.value = stored.selectorTestValue;

  renderLocalButtons();
  if (extensionEnabled) refreshCandidates();
  if (debugMode) await refreshDebugPanel();
}

async function saveSettings() {
  const extensionEnabled = globalToggle.checked;
  const debugMode        = debugToggle.checked;

  const sites = {};
  siteList.querySelectorAll('input[type=checkbox][data-site-id]').forEach(cb => {
    if (!cb.dataset.label) sites[cb.dataset.siteId] = cb.checked;
  });

  await browser.storage.local.set({ extensionEnabled, sites, debugMode, customButtons, buttonToggles });

  applyVisibility(extensionEnabled, debugMode);
  await broadcast({ extensionEnabled, sites, debugMode, customButtons, buttonToggles });
  if (debugMode) await refreshDebugPanel();
}

function applyVisibility(extensionEnabled, debugMode) {
  siteOptions.style.display  = extensionEnabled ? 'block' : 'none';
  localSection.style.display = extensionEnabled ? 'block' : 'none';
  debugPanel.style.display   = (extensionEnabled && debugMode) ? 'block' : 'none';
  if (!extensionEnabled) candidateSection.style.display = 'none';
}

async function broadcast(s) {
  try {
    await browser.tabs.sendMessage(currentTabId, { action: 'updateSettings', settings: s });
  } catch (_) {}
}

// ─── Local buttons ────────────────────────────────────────────────────────────

function renderLocalButtons() {
  localButtonsList.innerHTML = '';

  const entries = [];
  for (const [siteId, btns] of Object.entries(customButtons)) {
    (btns || []).forEach((btn, idx) => entries.push({ siteId, btn, idx }));
  }

  if (entries.length === 0) {
    localButtonsList.innerHTML = '<div class="local-empty">No local buttons yet — enable Debug Mode, paste a selector into the test box, then save it.</div>';
    return;
  }

  entries.forEach(({ siteId, btn, idx }) => {
    const siteName   = sitesConfig?.[siteId]?.name || siteId;
    const siteDomain = sitesConfig?.[siteId]?.domains?.[0] || '';

    const row = document.createElement('div');
    row.className = 'local-btn-row';

    const fav = document.createElement('img');
    fav.className = 'local-favicon';
    fav.src = siteDomain ? `https://icons.duckduckgo.com/ip3/${siteDomain}.ico` : '';
    fav.onerror = () => { fav.style.display = 'none'; };

    const info = document.createElement('div');
    info.className = 'local-btn-info';
    const lNameDiv = document.createElement('div');
    lNameDiv.className = 'local-btn-name';
    lNameDiv.textContent = btn.label;
    const lMetaDiv = document.createElement('div');
    lMetaDiv.className = 'local-btn-meta';
    lMetaDiv.textContent = siteName;
    const lSelDiv = document.createElement('div');
    lSelDiv.className = 'local-btn-sel';
    lSelDiv.textContent = btn.selector;
    info.append(lNameDiv, lMetaDiv, lSelDiv);

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Remove';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      customButtons[siteId]?.splice(idx, 1);
      await browser.storage.local.set({ customButtons });
      await broadcast({ customButtons });
      renderLocalButtons();
      const s = await browser.storage.local.get('sites');
      buildSiteList(s.sites || {});
      if (debugToggle.checked) await refreshDebugPanel();
    });

    row.append(fav, info, del);
    localButtonsList.appendChild(row);
  });
}

// ─── Candidate detection ──────────────────────────────────────────────────────

function updateCandidateBadge(count) {
  if (count > 0) {
    candidateBadge.textContent   = count;
    candidateBadge.style.display = 'inline-block';
  } else {
    candidateBadge.style.display = 'none';
  }
}

function renderCandidates(candidates) {
  candidateList.innerHTML = '';
  if (!candidates || candidates.length === 0) {
    candidateSection.style.display = 'none';
    return;
  }
  candidateSection.style.display = 'block';

  candidates.forEach(c => {
    const row = document.createElement('div');
    row.className = 'candidate-row';

    const scoreEl = document.createElement('span');
    scoreEl.className   = c.scoreLabel === 'High' ? 'score-high' : 'score-med';
    scoreEl.textContent = c.scoreLabel;

    const info = document.createElement('div');
    info.className = 'candidate-info';
    const cNameDiv = document.createElement('div');
    cNameDiv.className = 'candidate-name';
    cNameDiv.textContent = c.label;
    const cSelDiv = document.createElement('div');
    cSelDiv.className = 'candidate-sel';
    cSelDiv.textContent = c.selector;
    info.append(cNameDiv, cSelDiv);

    const addBtn = document.createElement('button');
    addBtn.className   = 'add-candidate-btn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', () => promoteCandidateToLocalButton(c));

    row.append(scoreEl, info, addBtn);
    candidateList.appendChild(row);
  });

  updateCandidateBadge(candidates.length);
}

async function refreshCandidates() {
  try {
    const resp = await browser.tabs.sendMessage(currentTabId, { action: 'getCandidates' });
    renderCandidates(resp?.candidates || []);
    if (resp?.siteId) _candidateSiteId = resp.siteId;
    browser.runtime.sendMessage({ action: 'clearCandidateBadge' }).catch(() => {});
  } catch (_) {
    candidateSection.style.display = 'none';
  }
}

async function promoteCandidateToLocalButton(candidate) {
  const siteId = _candidateSiteId;
  if (!siteId) { setStatus('Could not determine current site.', 'err'); return; }

  if (!customButtons[siteId]) customButtons[siteId] = [];
  customButtons[siteId].push({ label: candidate.label, selector: candidate.selector, custom: true });
  setButtonToggle(siteId, candidate.label, true);

  await browser.storage.local.set({ customButtons, buttonToggles });
  await broadcast({ customButtons, buttonToggles });

  renderLocalButtons();
  const s = await browser.storage.local.get('sites');
  buildSiteList(s.sites || {});
  if (debugToggle.checked) await refreshDebugPanel();
  await refreshCandidates();
  setStatus(`Added: ${candidate.label}`, 'ok');
}

// ─── Debug panel ──────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return null;
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30)  return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function healthColor(ts) {
  if (!ts)               return '#444';
  const d = (Date.now() - ts) / 86_400_000;
  if (d < 7)  return '#4caf50';
  if (d < 30) return '#ff9800';
  return '#f44336';
}

async function refreshDebugPanel() {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
  try {
    const resp = await Promise.race([
      browser.tabs.sendMessage(currentTabId, { action: 'getDetectedButtons' }),
      timeout,
    ]);
    renderDebugInfo(resp);
  } catch (_) {
    debugSiteInfo.innerHTML       = '<span style="color:#444">Not on a supported site.</span>';
    detectedButtonsList.innerHTML = '';
    clickAllBtn.style.display     = 'none';
  }
}

function renderDebugInfo(resp) {
  if (!resp?.siteId) {
    _debugSiteId = null;
    debugSiteInfo.innerHTML       = '<span style="color:#444">Not on a supported site.</span>';
    detectedButtonsList.innerHTML = '';
    clickAllBtn.style.display     = 'none';
    return;
  }

  const { siteId, siteName, detected } = resp;
  _debugSiteId = siteId;
  debugSiteInfo.textContent = 'Site: ';
  const siteStrong = document.createElement('strong');
  siteStrong.style.color = '#ccc';
  siteStrong.textContent = siteName || siteId;
  debugSiteInfo.appendChild(siteStrong);
  detectedButtonsList.innerHTML = '';

  const seen = new Set();
  const deduped = (detected || []).filter(b => {
    const key = `${b.selector}|${b.frameUrl}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  deduped.forEach(btn => {
    const row = document.createElement('div');
    row.className = 'detected-row';

    const dot = document.createElement('span');
    dot.className = 'ind';
    if (!btn.enabled)                  dot.classList.add('ind-disabled');
    else if (btn.custom)               dot.classList.add('ind-custom');
    else if (btn.isIframe && btn.found) dot.classList.add('ind-iframe');
    else if (btn.found)                dot.classList.add('ind-found');
    else                               dot.classList.add('ind-missing');

    const ts = healthData[`${siteId}__${btn.label}`] || btn.lastSeen || null;

    const labelEl = document.createElement('span');
    labelEl.className = 'det-label' + (btn.enabled ? '' : ' dim');
    labelEl.textContent = btn.label
      + (!btn.enabled             ? ' (disabled)'     : '')
      + (btn.enabled && !btn.found ? ' — not visible' : '')
      + (btn.isIframe             ? ' [iframe]'        : '')
      + (btn.custom               ? ' (local)'         : '');

    const healthEl = document.createElement('span');
    healthEl.className   = 'det-health';
    healthEl.style.color = healthColor(ts);
    healthEl.textContent = relativeTime(ts) || '';

    row.append(dot, labelEl, healthEl);
    detectedButtonsList.appendChild(row);
  });

  clickAllBtn.style.display = deduped.some(b => b.found && b.enabled) ? 'inline-flex' : 'none';
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportCustomButtons() {
  const blob = new Blob([JSON.stringify({
    version: 1,
    exported: new Date().toISOString().slice(0, 10),
    customButtons,
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: 'skipper-local-buttons.json' });
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Exported!', 'ok');
}

function importCustomButtons(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const parsed   = JSON.parse(e.target.result);
      const incoming = parsed.customButtons || parsed;
      let count = 0;
      for (const [siteId, btns] of Object.entries(incoming)) {
        if (!Array.isArray(btns)) continue;
        if (!customButtons[siteId]) customButtons[siteId] = [];
        btns.forEach(btn => {
          if (btn.selector) { customButtons[siteId].push({ ...btn, custom: true }); count++; }
        });
      }
      await browser.storage.local.set({ customButtons });
      await broadcast({ customButtons });
      renderLocalButtons();
      const s = await browser.storage.local.get('sites');
      buildSiteList(s.sites || {});
      setStatus(`Imported ${count} button(s).`, 'ok');
    } catch (_) {
      setStatus('Invalid JSON file.', 'err');
    }
  };
  reader.readAsText(file);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

globalToggle.addEventListener('change', saveSettings);
debugToggle.addEventListener('change',  saveSettings);

refreshConfigBtn.addEventListener('click', async () => {
  refreshConfigBtn.classList.add('spinning');
  try {
    const result = await browser.runtime.sendMessage({ action: 'refreshConfig' });
    await loadSitesConfig();
    const s = await browser.storage.local.get('sites');
    buildSiteList(s.sites || {});
    if (result?.source === 'remote') {
      setStatus('Config refreshed from remote.', 'ok');
    } else if (result?.ok) {
      setStatus('Remote unavailable — using bundled config.', 'err');
    } else {
      setStatus('Failed to load config.', 'err');
    }
  } catch (_) {
    setStatus('Remote fetch failed — using bundled config.', 'err');
  } finally {
    refreshConfigBtn.classList.remove('spinning');
  }
});

exportBtn.addEventListener('click', exportCustomButtons);
importBtn.addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', e => {
  if (e.target.files[0]) importCustomButtons(e.target.files[0]);
  importFileInput.value = '';
});

clickAllBtn.addEventListener('click', async () => {
  try {
    await browser.tabs.sendMessage(currentTabId, { action: 'clickDetected' });
    setStatus('Clicked!', 'ok');
  } catch (_) { setStatus('Could not reach the page.', 'err'); }
});

let testDebounce = null;
selectorTestInput.addEventListener('input', () => {
  clearTimeout(testDebounce);
  browser.storage.local.set({ selectorTestValue: selectorTestInput.value });
  testDebounce = setTimeout(async () => {
    const sel = selectorTestInput.value.trim();
    if (!sel) { selectorTestResult.textContent = ''; saveToLocalWrap.style.display = 'none'; return; }
    try {
      const resp = await browser.tabs.sendMessage(currentTabId, { action: 'testSelector', selector: sel });
      if (resp.error) {
        selectorTestResult.style.color = '#f44336';
        // Try wrapping in [] — catches bare attribute strings like data-testid="skip"
        const wrapped = `[${sel}]`;
        let suggestion = '';
        try { document.querySelector(wrapped); suggestion = wrapped; } catch (_) {}
        selectorTestResult.textContent = suggestion
          ? `Invalid selector — did you mean: ${suggestion}`
          : 'Invalid selector — use CSS syntax e.g. [attr="val"], .class, button';
        saveToLocalWrap.style.display = 'none';
      } else {
        const found = resp.count > 0 || resp.shadowHit;
        selectorTestResult.style.color = found ? '#4caf50' : '#555';
        selectorTestResult.textContent = found
          ? `Found ${resp.count > 0 ? resp.count : 1} element(s)${resp.shadowHit ? ' (shadow DOM)' : ''}${resp.inIframe ? ' (in iframe)' : ''}`
          : 'No elements matched';
        saveToLocalWrap.style.display = 'block';
      }
    } catch (_) {
      selectorTestResult.style.color = '#444';
      selectorTestResult.textContent = 'Not on a supported page.';
      saveToLocalWrap.style.display = 'block';
    }
  }, 300);
});

saveToLocalBtn.addEventListener('click', async () => {
  const sel   = selectorTestInput.value.trim();
  const label = saveToLocalLabel.value.trim();
  if (!label) { setStatus('Enter a label first.', 'err'); saveToLocalLabel.focus(); return; }
  if (!sel)   { setStatus('No selector to save.', 'err'); return; }

  // Use the detected siteId, or fall back to the current tab's hostname.
  let siteId = _debugSiteId;
  if (!siteId) {
    try {
      const tab = await browser.tabs.get(currentTabId);
      siteId = new URL(tab.url).hostname;
    } catch (_) { setStatus('Could not determine current site.', 'err'); return; }
  }

  if (!customButtons[siteId]) customButtons[siteId] = [];
  // Avoid duplicates.
  if (customButtons[siteId].some(b => b.selector === sel)) {
    setStatus('Selector already saved.', 'err'); return;
  }
  customButtons[siteId].push({ label, selector: sel, custom: true });
  setButtonToggle(siteId, label, true);

  await browser.storage.local.set({ customButtons, buttonToggles });
  await broadcast({ customButtons, buttonToggles });

  saveToLocalLabel.value = '';
  saveToLocalWrap.style.display = 'none';
  renderLocalButtons();
  const s = await browser.storage.local.get('sites');
  buildSiteList(s.sites || {});
  if (debugToggle.checked) await refreshDebugPanel();
  setStatus(`Saved: ${label}`, 'ok');
});

scanCandidatesBtn.addEventListener('click', refreshCandidates);

browser.runtime.onMessage.addListener(msg => {
  if (msg.action === 'candidatesUpdated') {
    updateCandidateBadge(msg.count);
    if (msg.count > 0) refreshCandidates();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const tabs   = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id ?? null;
  await loadSitesConfig();
  await loadSettings();
  await checkPageStatus();
});
