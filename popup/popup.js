// popup/popup.js

if (typeof browser === 'undefined') {
  window.browser = chrome;
}

// ─── State ────────────────────────────────────────────────────────────────────

let sitesConfig   = null;   // Loaded from sites.json
let customButtons = {};     // { siteId: [{label, selector, custom}] }
let currentTabId  = null;
const siteToggles = {};     // { siteId: <input checkbox> }

// ─── Element refs ─────────────────────────────────────────────────────────────

const globalToggle        = document.getElementById('globalToggle');
const debugToggle         = document.getElementById('debugToggle');
const siteOptionsSection  = document.getElementById('siteOptions');
const debugPanel          = document.getElementById('debugPanel');
const debugSiteInfo       = document.getElementById('debugSiteInfo');
const detectedButtonsList = document.getElementById('detectedButtonsList');
const clickAllBtn         = document.getElementById('clickAllBtn');
const pickElementBtn      = document.getElementById('pickElementBtn');
const pickerActiveBar     = document.getElementById('pickerActiveBar');
const cancelPickerBtn     = document.getElementById('cancelPickerBtn');
const pickedPanel         = document.getElementById('pickedPanel');
const pickedSelector      = document.getElementById('pickedSelector');
const pickedLabel         = document.getElementById('pickedLabel');
const savePickedBtn       = document.getElementById('savePickedBtn');
const discardPickedBtn    = document.getElementById('discardPickedBtn');
const customButtonsSection = document.getElementById('customButtonsSection');
const customButtonsList   = document.getElementById('customButtonsList');
const statusBar           = document.getElementById('statusBar');

// ─── Status helper ────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, type = '', ms = 3000) {
  statusBar.textContent  = msg;
  statusBar.className    = type;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { statusBar.textContent = ''; statusBar.className = ''; }, ms);
}

// ─── Load sites config ────────────────────────────────────────────────────────

async function loadSitesConfig() {
  const url  = browser.runtime.getURL('sites.json');
  const resp = await fetch(url);
  sitesConfig = await resp.json();
}

// ─── Generate per-site toggle rows ───────────────────────────────────────────

function generateSiteToggles() {
  if (!sitesConfig) return;
  siteOptionsSection.innerHTML = '<div class="section-title">Sites</div>';

  for (const [siteId, site] of Object.entries(sitesConfig)) {
    const row = document.createElement('div');
    row.className = 'site-row';

    const info = document.createElement('div');
    info.innerHTML = `
      <div class="site-name">${site.name}</div>
      <div class="site-domains">${site.domains.join(', ')}</div>
    `;

    const label  = document.createElement('label');
    label.className = 'switch';
    const cb     = document.createElement('input');
    cb.type = 'checkbox';
    const slider = document.createElement('span');
    slider.className = 'slider';
    label.append(cb, slider);

    siteToggles[siteId] = cb;
    cb.addEventListener('change', saveSettings);

    row.append(info, label);
    siteOptionsSection.appendChild(row);
  }
}

// ─── Settings: load / save / broadcast ───────────────────────────────────────

async function loadSettings() {
  const stored = await browser.storage.local.get([
    'extensionEnabled', 'sites', 'debugMode',
    'customButtons', 'pickerMode', 'lastPickedButton',
  ]);

  const extensionEnabled = stored.extensionEnabled !== false;
  const sites            = stored.sites   || {};
  const debugMode        = stored.debugMode === true;
  const pickerMode       = stored.pickerMode === true;
  customButtons          = stored.customButtons || {};
  const lastPicked       = stored.lastPickedButton || null;

  globalToggle.checked = extensionEnabled;
  debugToggle.checked  = debugMode;

  for (const [siteId, cb] of Object.entries(siteToggles)) {
    cb.checked = sites[siteId] !== false;
  }

  siteOptionsSection.style.display = extensionEnabled ? 'block' : 'none';
  debugPanel.style.display         = debugMode        ? 'block' : 'none';

  if (pickerMode) {
    pickerActiveBar.classList.add('visible');
  }

  // If a button was picked since the popup last opened, surface the save panel.
  if (lastPicked && !pickerMode) {
    showPickedPanel(lastPicked);
  }

  renderCustomButtons();

  if (debugMode) await refreshDebugPanel();
}

async function saveSettings() {
  const extensionEnabled = globalToggle.checked;
  const debugMode        = debugToggle.checked;
  const sites            = {};
  for (const [id, cb] of Object.entries(siteToggles)) sites[id] = cb.checked;

  await browser.storage.local.set({ extensionEnabled, sites, debugMode, customButtons });

  siteOptionsSection.style.display = extensionEnabled ? 'block' : 'none';
  debugPanel.style.display         = debugMode        ? 'block' : 'none';

  await broadcast({ extensionEnabled, sites, debugMode, customButtons, pickerMode: false });

  if (debugMode) await refreshDebugPanel();
}

/** Send updated settings to the active tab's content script (all frames). */
async function broadcast(settings) {
  try {
    if (!currentTabId) {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      currentTabId = tabs[0]?.id;
    }
    if (!currentTabId) return;

    await browser.tabs.sendMessage(currentTabId, {
      action: 'updateSettings',
      settings,
    }).catch(() => {}); // Silently ignore "no content script" errors.
  } catch (_) {}
}

// ─── Debug panel ──────────────────────────────────────────────────────────────

async function refreshDebugPanel() {
  try {
    if (!currentTabId) {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      currentTabId = tabs[0]?.id;
    }
    const resp = await browser.tabs.sendMessage(currentTabId, { action: 'getDetectedButtons' });
    renderDebugInfo(resp);
  } catch (_) {
    // Not on a supported site, or content script not ready.
    debugSiteInfo.innerHTML       = 'Not on a supported site.';
    detectedButtonsList.innerHTML = '';
    clickAllBtn.style.display     = 'none';
  }
}

function renderDebugInfo(resp) {
  if (!resp?.siteId) {
    debugSiteInfo.innerHTML       = 'Not on a supported site.';
    detectedButtonsList.innerHTML = '';
    clickAllBtn.style.display     = 'none';
    return;
  }

  const { siteId, siteName, detected, isIframe } = resp;
  debugSiteInfo.innerHTML = `Site: <strong>${siteName || siteId}</strong>` +
    (isIframe ? ' <span style="color:#555;font-size:10px">(iframe)</span>' : '');

  detectedButtonsList.innerHTML = '';

  if (detected?.length) {
    detected.forEach(btn => {
      const row  = document.createElement('div');
      row.className = 'btn-row';

      const dot  = document.createElement('span');
      dot.className = 'indicator ' + (btn.custom ? 'ind-custom' : btn.found ? 'ind-found' : 'ind-not-found');

      const text = document.createElement('span');
      text.className = btn.found ? 'found-label' : '';
      text.textContent = btn.label + (btn.found ? '' : ' — not visible') + (btn.custom ? ' (custom)' : '');

      row.append(dot, text);
      detectedButtonsList.appendChild(row);
    });

    clickAllBtn.style.display = detected.some(b => b.found) ? 'block' : 'none';
  } else {
    detectedButtonsList.innerHTML = '<div style="color:#555;font-size:12px">No buttons configured for this site.</div>';
    clickAllBtn.style.display     = 'none';
  }
}

// ─── Picker ───────────────────────────────────────────────────────────────────

function showPickedPanel(data) {
  pickedPanel.classList.add('visible');
  pickedSelector.textContent = data.selector;
  pickedLabel.value          = data.label || '';
  pickedPanel.dataset.siteId   = data.siteId   || '';
  pickedPanel.dataset.selector = data.selector || '';
}

function hidePickedPanel() {
  pickedPanel.classList.remove('visible');
  pickedLabel.value            = '';
  pickedPanel.dataset.siteId   = '';
  pickedPanel.dataset.selector = '';
}

// ─── Custom buttons rendering ─────────────────────────────────────────────────

function renderCustomButtons() {
  customButtonsList.innerHTML = '';
  let hasAny = false;

  for (const [siteId, btns] of Object.entries(customButtons)) {
    if (!btns?.length) continue;
    hasAny = true;
    const siteName = sitesConfig?.[siteId]?.name || siteId;

    btns.forEach((btn, idx) => {
      const row = document.createElement('div');
      row.className = 'custom-btn-row';
      row.innerHTML = `
        <div class="custom-btn-info">
          <div class="custom-btn-label">${btn.label}</div>
          <div class="custom-btn-sel">${btn.selector}</div>
          <div class="custom-btn-site">${siteName}</div>
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

// ─── Event listeners ──────────────────────────────────────────────────────────

globalToggle.addEventListener('change', saveSettings);
debugToggle.addEventListener('change', saveSettings);

clickAllBtn.addEventListener('click', async () => {
  try {
    await browser.tabs.sendMessage(currentTabId, { action: 'clickDetected' });
    setStatus('Clicked!', 'ok');
  } catch (_) {
    setStatus('Could not reach the page.', 'err');
  }
});

pickElementBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ pickerMode: true, lastPickedButton: null });
  hidePickedPanel();
  pickerActiveBar.classList.add('visible');
  await broadcast({ pickerMode: true });
  setStatus('Click any element on the page to capture its selector.', '', 0);
});

cancelPickerBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ pickerMode: false });
  await broadcast({ pickerMode: false });
  pickerActiveBar.classList.remove('visible');
  setStatus('Picker cancelled.');
});

savePickedBtn.addEventListener('click', async () => {
  const siteId   = pickedPanel.dataset.siteId;
  const selector = pickedPanel.dataset.selector;
  const label    = pickedLabel.value.trim() || 'Custom Button';

  if (!siteId || !selector) return;

  if (!customButtons[siteId]) customButtons[siteId] = [];
  customButtons[siteId].push({ label, selector, custom: true });

  await browser.storage.local.set({ customButtons, lastPickedButton: null });
  await broadcast({ customButtons });

  hidePickedPanel();
  renderCustomButtons();
  if (debugToggle.checked) await refreshDebugPanel();
  setStatus(`Saved: ${label}`, 'ok');
});

discardPickedBtn.addEventListener('click', async () => {
  await browser.storage.local.set({ lastPickedButton: null });
  hidePickedPanel();
});

// Listen for real-time messages from the content script while the popup is open.
browser.runtime.onMessage.addListener(msg => {
  if (msg.action === 'elementPicked') {
    pickerActiveBar.classList.remove('visible');
    showPickedPanel(msg);
    setStatus('Element captured — give it a label and save it.', 'ok', 0);
  } else if (msg.action === 'pickerCancelled') {
    pickerActiveBar.classList.remove('visible');
    setStatus('Picker cancelled.');
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSitesConfig();
  generateSiteToggles();

  const tabs   = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id || null;

  await loadSettings();
});
