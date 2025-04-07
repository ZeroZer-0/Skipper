// popup.js

if (typeof browser === 'undefined') {
  // Chrome doesn't natively provide "browser", so assign it to chrome.
  window.browser = chrome;
}

// Define site names with their associated domains as an array.
const siteDomains = {
  netflix: ['netflix.com'],
  disneyPlus: ['disneyplus.com'],
  hulu: ['hulu.com'],
  crunchyroll: ['crunchyroll.com'],
  prime: ['amazon.com', 'primevideo.com'],
  paramountPlus: ['paramountplus.com']
};

// Use Object.keys to get supported site names
const supportedSites = Object.keys(siteDomains);

// Get common elements
const globalToggle = document.getElementById('globalToggle');
const debugToggle = document.getElementById('debugToggle');
const siteOptions = document.getElementById('siteOptions');
const siteToggles = {};

function generateSiteToggles() {
  const container = document.createElement('div');
  supportedSites.forEach(site => {
    const div = document.createElement('div');
    div.className = 'site-options';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `${site}Toggle`;
    siteToggles[site] = checkbox;

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` Enable ${site.charAt(0).toUpperCase() + site.slice(1)} Skipping (${siteDomains[site].join(' or ')})`));
    div.appendChild(label);
    container.appendChild(div);
  });
  siteOptions.appendChild(container);
}

async function loadSettings() {
  try {
    const result = await browser.storage.local.get(['extensionEnabled', 'sites', 'debugMode']);
    const extensionEnabled = result.extensionEnabled !== false;
    const sites = result.sites || {};
    const debugMode = result.debugMode === true;

    globalToggle.checked = extensionEnabled;
    debugToggle.checked = debugMode;

    supportedSites.forEach(site => {
      if (siteToggles[site]) {
        siteToggles[site].checked = sites[site] !== false;
      }
    });

    siteOptions.style.display = extensionEnabled ? 'block' : 'none';
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

function saveSettings() {
  const extensionEnabled = globalToggle.checked;
  const sites = {};
  supportedSites.forEach(site => {
    sites[site] = siteToggles[site] ? siteToggles[site].checked : false;
  });
  const debugMode = debugToggle.checked;

  browser.storage.local.set({
    extensionEnabled,
    sites,
    debugMode,
  }).then(() => {
    console.log('Settings saved:', { extensionEnabled, sites, debugMode });
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) {
        browser.tabs.sendMessage(tabs[0].id, {
          action: 'updateSettings',
          settings: { extensionEnabled, sites, debugMode }
        }).catch(error => {
          console.warn('Message not sent:', error);
        });
      }
    });
  }).catch((error) => {
    console.error('Error saving settings:', error);
  });
}

// Event Listeners
globalToggle.addEventListener('change', () => {
  saveSettings();
  siteOptions.style.display = globalToggle.checked ? 'block' : 'none';
});
debugToggle.addEventListener('change', saveSettings);

function attachSiteListeners() {
  supportedSites.forEach(site => {
    if (siteToggles[site]) {
      siteToggles[site].addEventListener('change', saveSettings);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  generateSiteToggles();
  loadSettings();
  attachSiteListeners();
});
