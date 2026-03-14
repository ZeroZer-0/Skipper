// popup/popup.js

if (typeof browser === 'undefined') {
  window.browser = chrome;
}

// ─── State ────────────────────────────────────────────────────────────────────

let sitesConfig   = null;   // Loaded from background (remote-cached) or bundled
let customButtons = {};     // { siteId: [{label, selector, custom}] }
let buttonToggles = {};     // { siteId: { label: boolean } }
let healthData    = {};     // { "siteId__label": timestamp }
let currentTabId  = null;

// ─── Element refs ─────────────────────────────────────────────────────────────

const globalToggle        = document.getElementById('globalToggle');
const debugToggle         = document.getElementById('debugToggle');
const refreshConfigBtn    = document.getElementById('refreshConfigBtn');
const siteOptions         = document.getElementById('siteOptions');
const siteList            = document.getElementById('siteList');
const debugPanel          = document.getElementById('debugPanel');
const debugSiteInfo       = document.getElementById('debugSiteInfo');
const detectedButtonsList = document.getElementById('detectedButtonsList');
const clickAllBtn         = document.getElementById('clickAllBtn');
const pickElementBtn      = document.getElementById('pickElementBtn');
const pickerBar           = document.getElementById('pickerBar');
const cancelPickerBtn     = document.getElementById('cancelPickerBtn');
const pickedPanel         = document.getElementById('pickedPanel');
const pickedSel           = document.getElementById('pickedSel');
const pickedLabel         = document.getElementById('pickedLabel');
const savePickedBtn       = document.getElementById('savePickedBtn');
const discardPickedBtn    = document.getElementById('discardPickedBtn');
const selectorTestInput   = document.getElementById('selectorTestInput');
const selectorTestResult  = document.getElementById('selectorTestResult');
const customButtonsSection = document.getElementById('customButtonsSection');
const customButtonsList   = document.getElementById('customButtonsList');
const exportBtn           = document.getElementById('exportBtn');
const importBtn           = document.getElementById('importBtn');
const importFileInput     = document.getElementById('importFileInput');
const statusBar           = document.getElementById('statusBar');

// ─── Status ───────────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, type = '', ms = 3000) {
  statusBar.textContent = msg;
  statusBar.className   = type;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { statusBar.textContent = ''; statusBar.className = ''; }, ms);
}

// ─── Load config ──────────────────────────────────────────────────────────────

async function loadSitesConfig() {
  // Ask the background service worker for its cached (possibly remote) copy.
  try {
    const resp = await browser.runtime.sendMessage({ action: 'getSitesConfig' });
    if (resp?.config) { sitesConfig = resp.config; return; }
  } catch (_) {}
  // Fallback: fetch the bundled file directly.
  try {
    const r = await fetch(browser.runtime.getURL('sites.json'));
    sitesConfig = await r.json();
  } catch (_) {}
}

// ─── Per-site / per-button toggles ───────────────────────────────────────────

/**
 * Returns the known button list for a site: base config + user custom buttons.
 * Excludes metadata-only keys from sites.json.
 */
function siteButtonList(siteId) {
  const base   = (sitesConfig?.[siteId]?.buttons || []);
  const custom = (customButtons[siteId] || []);
  return [...base, ...custom];
}

function isButtonEnabled(siteId, label) {
  return (buttonToggles[siteId] || {})[label] !== false;
}

function setButtonToggle(siteId, label, enabled) {
  if (!buttonToggles[siteId]) buttonToggles[siteId] = {};
  buttonToggles[siteId][label] = enabled;
}

function buildSiteList(enabledSites) {
  siteList.innerHTML = '';
  if (!sitesConfig) return;

  for (const [siteId, site] of Object.entries(sitesConfig)) {
    if (!site?.domains) continue; // skip metadata keys

    const siteEnabled = enabledSites[siteId] !== false;
    const buttons     = siteButtonList(siteId);

    // ── Site block ──────────────────────────────────────────────────
    const block = document.createElement('div');
    block.className = 'site-block';

    // Header row (click to expand/collapse)
    const header = document.createElement('div');
    header.className = 'site-header';

    // Favicon — fetched from DuckDuckGo's icon service (no extra permissions needed).
    const favicon = document.createElement('img');
    favicon.className = 'site-favicon';
    favicon.width  = 16;
    favicon.height = 16;
    favicon.src    = `https://icons.duckduckgo.com/ip3/${site.domains[0]}.ico`;
    favicon.onerror = () => { favicon.style.display = 'none'; }; // hide if unavailable

    header.innerHTML = `<span class="site-expand">&#9654;</span>`;
    header.appendChild(favicon);
    const siteInfo = document.createElement('div');
    siteInfo.className = 'site-info';
    siteInfo.innerHTML = `
      <div class="site-name">${site.name}</div>
      <div class="site-domain">${site.domains.join(', ')}</div>
    `;
    header.appendChild(siteInfo);

    // Site-level toggle switch
    const siteSwitch = document.createElement('label');
    siteSwitch.className = 'switch';
    const siteCb = document.createElement('input');
    siteCb.type = 'checkbox';
    siteCb.checked = siteEnabled;
    siteCb.dataset.siteId = siteId;
    siteCb.addEventListener('change', e => {
      e.stopPropagation(); // don't toggle collapse
      saveSettings();
    });
    const siteSlider = document.createElement('span');
    siteSlider.className = 'slider';
    siteSwitch.append(siteCb, siteSlider);
    header.appendChild(siteSwitch);

    header.addEventListener('click', e => {
      if (e.target === siteCb || e.target === siteSlider || e.target === siteSwitch) return;
      block.classList.toggle('open');
    });

    // ── Per-button list (collapsible) ────────────────────────────────
    const btnList = document.createElement('div');
    btnList.className = 'btn-list';

    buttons.forEach(btn => {
      const row = document.createElement('div');
      row.className = 'btn-toggle-row';

      const lbl = document.createElement('span');
      lbl.className = 'btn-toggle-label';
      lbl.textContent = btn.label + (btn.custom ? ' (custom)' : '');

      const sw  = document.createElement('label');
      sw.className = 'switch';
      const cb  = document.createElement('input');
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
  const sites            = stored.sites    || {};
  const debugMode        = stored.debugMode === true;
  const pickerMode       = stored.pickerMode === true;
  customButtons          = stored.customButtons  || {};
  buttonToggles          = stored.buttonToggles  || {};
  healthData             = stored.healthData     || {};
  const lastPicked       = stored.lastPickedButton || null;

  globalToggle.checked = extensionEnabled;
  debugToggle.checked  = debugMode;

  siteOptions.style.display  = extensionEnabled ? 'block' : 'none';
  debugPanel.style.display   = debugMode        ? 'block' : 'none';

  buildSiteList(sites);

  if (pickerMode) pickerBar.classList.add('visible');

  if (lastPicked && !pickerMode) showPickedPanel(lastPicked);

  renderCustomButtons();
  if (debugMode) await refreshDebugPanel();
}

async function saveSettings() {
  const extensionEnabled = globalToggle.checked;
  const debugMode        = debugToggle.checked;

  // Collect site-level enabled state from checkboxes.
  const sites = {};
  siteList.querySelectorAll('input[type=checkbox][data-site-id]').forEach(cb => {
    // Only the site-level checkboxes (not per-button ones)
    if (!cb.dataset.label) sites[cb.dataset.siteId] = cb.checked;
  });

  await browser.storage.local.set({ extensionEnabled, sites, debugMode, customButtons, buttonToggles });

  siteOptions.style.display = extensionEnabled ? 'block' : 'none';
  debugPanel.style.display  = debugMode        ? 'block' : 'none';

  await broadcast({ extensionEnabled, sites, debugMode, customButtons, buttonToggles, pickerMode: false });
  if (debugMode) await refreshDebugPanel();
}

async function broadcast(s) {
  try {
    await browser.tabs.sendMessage(currentTabId, { action: 'updateSettings', settings: s });
  } catch (_) {}
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
  if (!ts)                                   return '#444';     // never seen — grey
  const days = (Date.now() - ts) / 86_400_000;
  if (days < 7)  return '#4caf50';                             // green
  if (days < 30) return '#ff9800';                             // orange
  return '#f44336';                                            // red
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

  // Deduplicate by selector (same button may appear from both main + iframe frame)
  const seen = new Set();
  const deduped = (detected || []).filter(b => {
    const key = b.selector + '|' + b.frameUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.forEach(btn => {
    const row = document.createElement('div');
    row.className = 'detected-row';

    const dot = document.createElement('span');
    dot.className = 'ind';
    if (!btn.enabled)    dot.classList.add('ind-disabled');
    else if (btn.custom) dot.classList.add('ind-custom');
    else if (btn.isIframe && btn.found) dot.classList.add('ind-iframe');
    else if (btn.found)  dot.classList.add('ind-found');
    else                 dot.classList.add('ind-missing');

    const healthKey = `${siteId}__${btn.label}`;
    const ts        = healthData[healthKey] || btn.lastSeen || null;

    const labelEl = document.createElement('span');
    labelEl.className = 'det-label' + (btn.enabled ? '' : ' dim');
    labelEl.textContent = btn.label
      + (!btn.enabled ? ' (disabled)' : !btn.found ? ' — not visible' : '')
      + (btn.isIframe ? ' [iframe]' : '')
      + (btn.custom   ? ' (custom)'  : '');

    const healthEl = document.createElement('span');
    healthEl.className   = 'det-health';
    healthEl.style.color = healthColor(ts);
    healthEl.textContent = relativeTime(ts) || '';

    row.append(dot, labelEl, healthEl);
    detectedButtonsList.appendChild(row);
  });

  const anyFound = deduped.some(b => b.found && b.enabled);
  clickAllBtn.style.display = anyFound ? 'inline-flex' : 'none';
}

// ─── Picker ───────────────────────────────────────────────────────────────────

function showPickedPanel(data) {
  pickedPanel.classList.add('visible');
  pickedSel.textContent  = data.selector;
  pickedLabel.value      = data.label || '';
  pickedPanel.dataset.siteId   = data.siteId   || '';
  pickedPanel.dataset.selector = data.selector || '';
}

function hidePickedPanel() {
  pickedPanel.classList.remove('visible');
  pickedLabel.value            = '';
  pickedPanel.dataset.siteId   = '';
  pickedPanel.dataset.selector = '';
}

// ─── Custom buttons ───────────────────────────────────────────────────────────

function renderCustomButtons() {
  customButtonsList.innerHTML = '';
  let hasAny = false;

  for (const [siteId, btns] of Object.entries(customButtons)) {
    if (!btns?.length) continue;
    hasAny = true;
    const siteName = sitesConfig?.[siteId]?.name || siteId;

    btns.forEach((btn, idx) => {
      const row = document.createElement('div');
      row.className = 'custom-row';
      row.innerHTML = `
        <div class="custom-info">
          <div class="custom-name">${btn.label}</div>
          <div class="custom-sel">${btn.selector}</div>
          <div class="custom-site">${siteName}</div>
        </div>
        <button class="del-btn" data-site="${siteId}" data-idx="${idx}" title="Remove">&#x2715;</button>
      `;
      customButtonsList.appendChild(row);
    });
  }

  customButtonsSection.style.display = hasAny ? 'block' : 'none';

  customButtonsList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const sid = e.currentTarget.dataset.site;
      const idx = parseInt(e.currentTarget.dataset.idx, 10);
      customButtons[sid]?.splice(idx, 1);
      await browser.storage.local.set({ customButtons });
      await broadcast({ customButtons });
      renderCustomButtons();
      if (debugToggle.checked) await refreshDebugPanel();
    });
  });
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportCustomButtons() {
  const payload = {
    version:       1,
    exported:      new Date().toISOString().slice(0, 10),
    customButtons,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'skipper-custom-buttons.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Exported!', 'ok');
}

function importCustomButtons(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const parsed  = JSON.parse(e.target.result);
      const imported = parsed.customButtons || parsed; // accept both formats
      let count = 0;
      for (const [siteId, btns] of Object.entries(imported)) {
        if (!Array.isArray(btns)) continue;
        if (!customButtons[siteId]) customButtons[siteId] = [];
        btns.forEach(btn => {
          if (btn.selector) { customButtons[siteId].push({ ...btn, custom: true }); count++; }
        });
      }
      await browser.storage.local.set({ customButtons });
      await broadcast({ customButtons });
      renderCustomButtons();
      // Rebuild site list so new custom buttons show up
      const stored = await browser.storage.local.get('sites');
      buildSiteList(stored.sites || {});
      setStatus(`Imported ${count} button(s).`, 'ok');
    } catch (_) {
      setStatus('Invalid JSON file.', 'err');
    }
  };
  reader.readAsText(file);
}

// ─── Selector test box ────────────────────────────────────────────────────────

let testDebounce = null;
async function runSelectorTest() {
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
        ? `Found ${resp.count} element(s)${resp.shadowHit ? ' (includes shadow DOM)' : ''}`
        : 'No elements matched';
    }
  } catch (_) {
    selectorTestResult.style.color = '#444';
    selectorTestResult.textContent = 'Not on a supported page.';
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

globalToggle.addEventListener('change', saveSettings);
debugToggle.addEventListener('change',  saveSettings);

refreshConfigBtn.addEventListener('click', async () => {
  refreshConfigBtn.classList.add('spinning');
  try {
    await browser.runtime.sendMessage({ action: 'refreshConfig' });
    await loadSitesConfig();
    const stored = await browser.storage.local.get('sites');
    buildSiteList(stored.sites || {});
    setStatus('Config refreshed from remote.', 'ok');
  } catch (_) {
    setStatus('Remote fetch failed — using bundled config.', 'err');
  } finally {
    refreshConfigBtn.classList.remove('spinning');
  }
});

clickAllBtn.addEventListener('click', async () => {
  try {
    await browser.tabs.sendMessage(currentTabId, { action: 'clickDetected' });
    setStatus('Clicked!', 'ok');
  } catch (_) { setStatus('Could not reach the page.', 'err'); }
});

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
  // Default-enable the new button.
  setButtonToggle(siteId, label, true);

  await browser.storage.local.set({ customButtons, buttonToggles, lastPickedButton: null });
  await broadcast({ customButtons, buttonToggles });

  hidePickedPanel();
  renderCustomButtons();
  // Rebuild site list to show the new per-button toggle.
  const stored = await browser.storage.local.get('sites');
  buildSiteList(stored.sites || {});
  if (debugToggle.checked) await refreshDebugPanel();
  setStatus(`Saved: ${label}`, 'ok');
});

discardPickedBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ lastPickedButton: null });
  hidePickedPanel();
});

selectorTestInput.addEventListener('input', () => {
  clearTimeout(testDebounce);
  testDebounce = setTimeout(runSelectorTest, 300);
});

exportBtn.addEventListener('click', exportCustomButtons);
importBtn.addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', e => {
  if (e.target.files[0]) importCustomButtons(e.target.files[0]);
  importFileInput.value = ''; // reset so the same file can be re-imported
});

// Real-time messages from content script (while popup is open).
browser.runtime.onMessage.addListener(msg => {
  if (msg.action === 'elementPicked') {
    pickerBar.classList.remove('visible');
    showPickedPanel(msg);
    setStatus('Element captured — give it a label and save it.', 'ok', 0);
  } else if (msg.action === 'pickerCancelled') {
    pickerBar.classList.remove('visible');
    setStatus('Picker cancelled.');
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const tabs   = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id ?? null;

  await loadSitesConfig();
  await loadSettings();
});
