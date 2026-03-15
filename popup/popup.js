// popup/popup.js

if (typeof browser === 'undefined') {
  window.browser = chrome;
}

// ─── State ────────────────────────────────────────────────────────────────────

let sitesConfig   = null;
let customButtons = {};     // { siteId: [{label, selector, custom}] }
let buttonToggles = {};     // { siteId: { label: boolean } }
let healthData    = {};     // { "siteId__label": timestamp }
let currentTabId  = null;

// ─── Element refs ─────────────────────────────────────────────────────────────

const globalToggle         = document.getElementById('globalToggle');
const debugToggle          = document.getElementById('debugToggle');
const refreshConfigBtn     = document.getElementById('refreshConfigBtn');
const siteOptions          = document.getElementById('siteOptions');
const siteList             = document.getElementById('siteList');
const localSection         = document.getElementById('localSection');
const pickElementBtn       = document.getElementById('pickElementBtn');
const pickerBar            = document.getElementById('pickerBar');
const cancelPickerBtn      = document.getElementById('cancelPickerBtn');
const pickedPanel          = document.getElementById('pickedPanel');
const pickedSel            = document.getElementById('pickedSel');
const pickedLabel          = document.getElementById('pickedLabel');
const savePickedBtn        = document.getElementById('savePickedBtn');
const discardPickedBtn     = document.getElementById('discardPickedBtn');
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
const statusBar            = document.getElementById('statusBar');
const candidateSection     = document.getElementById('candidateSection');
const candidateBadge       = document.getElementById('candidateBadge');
const candidateList        = document.getElementById('candidateList');
const scanCandidatesBtn    = document.getElementById('scanCandidatesBtn');

// ─── Status bar ───────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, type = '', ms = 3000) {
  statusBar.textContent = msg;
  statusBar.className   = type;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { statusBar.textContent = ''; statusBar.className = ''; }, ms);
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
    if (!site?.domains) continue;

    const siteEnabled = enabledSites[siteId] !== false;
    const buttons     = siteButtonList(siteId);

    const block = document.createElement('div');
    block.className = 'site-block';

    // ── Header (favicon + name + site toggle) ──────────────────────
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
    info.innerHTML = `<div class="site-name">${site.name}</div>
                      <div class="site-domain">${site.domains.join(', ')}</div>`;

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

    // ── Per-button list ────────────────────────────────────────────
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
    'customButtons', 'buttonToggles', 'pickerMode', 'lastPickedButton', 'healthData',
  ]);

  const extensionEnabled = stored.extensionEnabled !== false;
  const sites            = stored.sites   || {};
  const debugMode        = stored.debugMode  === true;
  const pickerMode       = stored.pickerMode === true;
  customButtons          = stored.customButtons  || {};
  buttonToggles          = stored.buttonToggles  || {};
  healthData             = stored.healthData     || {};
  const lastPicked       = stored.lastPickedButton || null;

  globalToggle.checked = extensionEnabled;
  debugToggle.checked  = debugMode;

  applyVisibility(extensionEnabled, debugMode);
  buildSiteList(sites);

  if (pickerMode) pickerBar.classList.add('visible');
  if (lastPicked && !pickerMode) showPickedPanel(lastPicked);

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
  await broadcast({ extensionEnabled, sites, debugMode, customButtons, buttonToggles, pickerMode: false });
  if (debugMode) await refreshDebugPanel();
}

/** Show/hide the three main collapsible sections. */
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

// ─── Local buttons list ───────────────────────────────────────────────────────

function renderLocalButtons() {
  localButtonsList.innerHTML = '';

  // Collect all custom buttons across all sites
  const entries = [];
  for (const [siteId, btns] of Object.entries(customButtons)) {
    (btns || []).forEach((btn, idx) => entries.push({ siteId, btn, idx }));
  }

  if (entries.length === 0) {
    localButtonsList.innerHTML = '<div class="local-empty">No local buttons yet — use the picker above to add some.</div>';
    return;
  }

  entries.forEach(({ siteId, btn, idx }) => {
    const siteName   = sitesConfig?.[siteId]?.name || siteId;
    const siteDomain = sitesConfig?.[siteId]?.domains?.[0] || '';

    const row = document.createElement('div');
    row.className = 'local-btn-row';

    // Small site favicon for quick identification
    const fav = document.createElement('img');
    fav.className = 'local-favicon';
    fav.src = siteDomain ? `https://icons.duckduckgo.com/ip3/${siteDomain}.ico` : '';
    fav.onerror = () => { fav.style.display = 'none'; };

    const info = document.createElement('div');
    info.className = 'local-btn-info';
    info.innerHTML = `
      <div class="local-btn-name">${btn.label}</div>
      <div class="local-btn-meta">${siteName}</div>
      <div class="local-btn-sel">${btn.selector}</div>
    `;

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Remove';
    del.textContent = '✕';
    del.dataset.site = siteId;
    del.dataset.idx  = idx;
    del.addEventListener('click', async () => {
      customButtons[siteId]?.splice(idx, 1);
      await browser.storage.local.set({ customButtons });
      await broadcast({ customButtons });
      renderLocalButtons();
      // Rebuild site list so the per-button toggle disappears too
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
    info.innerHTML = `<div class="candidate-name">${c.label}</div>
                      <div class="candidate-sel">${c.selector}</div>`;

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
    const candidates = await browser.tabs.sendMessage(currentTabId, { action: 'getCandidates' });
    renderCandidates(candidates);
  } catch (_) {
    candidateSection.style.display = 'none';
  }
}

async function promoteCandidateToLocalButton(candidate) {
  let siteId = null;
  try {
    const resp = await browser.tabs.sendMessage(currentTabId, { action: 'getDetectedButtons' });
    siteId = resp?.siteId || null;
  } catch (_) {}
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

// ─── Picker ───────────────────────────────────────────────────────────────────

function showPickedPanel(data) {
  pickedPanel.classList.add('visible');
  pickedSel.textContent        = data.selector;
  pickedLabel.value            = data.label || '';
  pickedPanel.dataset.siteId   = data.siteId   || '';
  pickedPanel.dataset.selector = data.selector || '';
}

function hidePickedPanel() {
  pickedPanel.classList.remove('visible');
  pickedLabel.value            = '';
  pickedPanel.dataset.siteId   = '';
  pickedPanel.dataset.selector = '';
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
  try {
    const resp = await browser.tabs.sendMessage(currentTabId, { action: 'getDetectedButtons' });
    renderDebugInfo(resp);
  } catch (_) {
    debugSiteInfo.innerHTML       = '<span style="color:#444">Not on a supported site.</span>';
    detectedButtonsList.innerHTML = '';
    clickAllBtn.style.display     = 'none';
  }
}

function renderDebugInfo(resp) {
  if (!resp?.siteId) {
    debugSiteInfo.innerHTML       = '<span style="color:#444">Not on a supported site.</span>';
    detectedButtonsList.innerHTML = '';
    clickAllBtn.style.display     = 'none';
    return;
  }

  const { siteId, siteName, detected } = resp;
  debugSiteInfo.innerHTML = `Site: <strong style="color:#ccc">${siteName || siteId}</strong>`;
  detectedButtonsList.innerHTML = '';

  // Deduplicate — same button can be reported by both main frame and iframe
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
    if (!btn.enabled)             dot.classList.add('ind-disabled');
    else if (btn.custom)          dot.classList.add('ind-custom');
    else if (btn.isIframe && btn.found) dot.classList.add('ind-iframe');
    else if (btn.found)           dot.classList.add('ind-found');
    else                          dot.classList.add('ind-missing');

    const ts = healthData[`${siteId}__${btn.label}`] || btn.lastSeen || null;

    const labelEl = document.createElement('span');
    labelEl.className = 'det-label' + (btn.enabled ? '' : ' dim');
    labelEl.textContent = btn.label
      + (!btn.enabled          ? ' (disabled)'     : '')
      + (btn.enabled && !btn.found ? ' — not visible' : '')
      + (btn.isIframe          ? ' [iframe]'        : '')
      + (btn.custom            ? ' (local)'         : '');

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
    await browser.runtime.sendMessage({ action: 'refreshConfig' });
    await loadSitesConfig();
    const s = await browser.storage.local.get('sites');
    buildSiteList(s.sites || {});
    setStatus('Config refreshed from remote.', 'ok');
  } catch (_) {
    setStatus('Remote fetch failed — using bundled config.', 'err');
  } finally {
    refreshConfigBtn.classList.remove('spinning');
  }
});

// Local section: picker
pickElementBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ pickerMode: true, lastPickedButton: null });
  hidePickedPanel();
  pickerBar.classList.add('visible');
  await broadcast({ pickerMode: true });
  setStatus('Click any element on the page to capture its selector.', '', 0);
});

cancelPickerBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ pickerMode: false });
  await broadcast({ pickerMode: false });
  pickerBar.classList.remove('visible');
  setStatus('Picker cancelled.');
});

savePickedBtn.addEventListener('click', async () => {
  const siteId   = pickedPanel.dataset.siteId;
  const selector = pickedPanel.dataset.selector;
  const label    = pickedLabel.value.trim() || 'Custom Button';
  if (!siteId || !selector) return;

  if (!customButtons[siteId]) customButtons[siteId] = [];
  customButtons[siteId].push({ label, selector, custom: true });
  setButtonToggle(siteId, label, true);

  await browser.storage.local.set({ customButtons, buttonToggles, lastPickedButton: null });
  await broadcast({ customButtons, buttonToggles });

  hidePickedPanel();
  renderLocalButtons();
  const s = await browser.storage.local.get('sites');
  buildSiteList(s.sites || {});
  if (debugToggle.checked) await refreshDebugPanel();
  setStatus(`Saved: ${label}`, 'ok');
});

discardPickedBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ lastPickedButton: null });
  hidePickedPanel();
});

exportBtn.addEventListener('click', exportCustomButtons);
importBtn.addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', e => {
  if (e.target.files[0]) importCustomButtons(e.target.files[0]);
  importFileInput.value = '';
});

// Debug section
clickAllBtn.addEventListener('click', async () => {
  try {
    await browser.tabs.sendMessage(currentTabId, { action: 'clickDetected' });
    setStatus('Clicked!', 'ok');
  } catch (_) { setStatus('Could not reach the page.', 'err'); }
});

let testDebounce = null;
selectorTestInput.addEventListener('input', () => {
  clearTimeout(testDebounce);
  testDebounce = setTimeout(async () => {
    const sel = selectorTestInput.value.trim();
    if (!sel) { selectorTestResult.textContent = ''; return; }
    try {
      const resp = await browser.tabs.sendMessage(currentTabId, { action: 'testSelector', selector: sel });
      if (resp.error) {
        selectorTestResult.style.color = '#f44336';
        selectorTestResult.textContent = `Error: ${resp.error}`;
      } else {
        selectorTestResult.style.color = resp.count > 0 ? '#4caf50' : '#555';
        selectorTestResult.textContent = resp.count > 0
          ? `Found ${resp.count} element(s)${resp.shadowHit ? ' (shadow DOM)' : ''}`
          : 'No elements matched';
      }
    } catch (_) {
      selectorTestResult.style.color = '#444';
      selectorTestResult.textContent = 'Not on a supported page.';
    }
  }, 300);
});

scanCandidatesBtn.addEventListener('click', refreshCandidates);

// Real-time messages from content script (picker result while popup is open)
browser.runtime.onMessage.addListener(msg => {
  if (msg.action === 'elementPicked') {
    pickerBar.classList.remove('visible');
    showPickedPanel(msg);
    setStatus('Element captured — give it a label and save it.', 'ok', 0);
  } else if (msg.action === 'pickerCancelled') {
    pickerBar.classList.remove('visible');
    setStatus('Picker cancelled.');
  } else if (msg.action === 'candidatesUpdated') {
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
});
