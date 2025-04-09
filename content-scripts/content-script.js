// content-scripts/content-script.js

if (typeof browser === 'undefined') {
  // Chrome doesn't natively provide "browser", so assign it to chrome.
  window.browser = chrome;
}

// Add any buttons you want to be pressed automatically here
const siteSelectors = {
  netflix: {
    domains: ['netflix.com'],
    skipIntroButton: 'button[data-uia="player-skip-intro"]',
    nextEpisodeButton: 'button[data-uia="player-skip-seamless-button"]',
    skipRecapButton: 'button[data-uia="player-skip-recap"]'
  },
  disneyPlus: {
    domains: ['disneyplus.com'],
    skipRecapButton: 'button.skip__button[aria-label="SKIP RECAP"]',
    skipIntroButton: 'button.skip__button[aria-label="SKIP INTRO"]',
    nextEpisodeButton: 'button.skip__button:not([aria-label])',
    altNextEpisodeButton: 'button[data-testid="icon-restart"]'
  },
  hulu: {
    domains: ['hulu.com'],
    skipRecapButton: 'button[data-automationid="player-skip-button"]',
    skipIntroButton: 'button[data-automationid="player-skip-button"]',
    nextEpisodeButton: 'button[data-testid="next-episode-button"]'
  },
  crunchyroll: {
    domains: ['crunchyroll.com'],
    skipAllButton: '[data-testid="SkipIntroText"]',
  }, 
  paramountPlus: {
    domains: ['paramountplus.com'],
    skipIntroButton: 'button[class="skip-button"]',
    nextEpisodeButton: 'button[class="play-button"]'
  },
  amazonPrime: {
    domains: ['amazon.com', 'primevideo.com'],
    skipIntroButton: 'button[class*="atvwebplayersdk-skipelement-button"]',
    nextEpisodeButton: 'div[class*="atvwebplayersdk-nextupcard-button"]'
  }
};

function debugLog(message, debugMode) {
  if (debugMode) {
    console.log(`[Skipper Debug] ${message}`);
  }
}

function clickButton(site, buttonKey, debugMode) {
  const selector = siteSelectors[site][buttonKey];
  if (!selector) {
    debugLog(`${site}: Selector for "${buttonKey}" not found in siteSelectors`, debugMode);
    return false;
  }
  const button = document.querySelector(selector);
  if (button) {
    button.click();
    debugLog(`${site}: "${buttonKey}" button clicked`, debugMode);
    return true;
  } else {
    debugLog(`${site}: "${buttonKey}" button not found`, debugMode);
    return false;
  }
}

function handleSite(site, debugMode) {
  let lastClickTime = 0;
  function clickButtons() {
    const now = Date.now();
    // If less than 1 second has passed since the last click, skip this cycle
    if (now - lastClickTime < 10000) return;
    
    let anyClicked = false;
    Object.keys(siteSelectors[site]).forEach(key => {
      if (key === 'domains') return;
      const clicked = clickButton(site, key, debugMode);
      if (clicked) {
        anyClicked = true;
      }
    });
    if (anyClicked) {
      // Record the time of this click to enforce a 1-second delay
      lastClickTime = now;
    }
  }
  clickButtons();
  window[`${site}IntervalId`] = setInterval(clickButtons, 500);
}

browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateSettings') {
    debugLog('Settings updated from popup', message.settings.debugMode);

    Object.keys(siteSelectors).forEach(site => {
      if (window[`${site}IntervalId`]) {
        clearInterval(window[`${site}IntervalId`]);
      }
    });

    if (message.settings.extensionEnabled) {
      Object.entries(siteSelectors).forEach(([site, selectors]) => {
        if (message.settings.sites[site] !== false &&
            selectors.domains &&
            selectors.domains.some(domain => window.location.hostname.includes(domain))) {
          handleSite(site, message.settings.debugMode);
        }
      });
    }
  }
});

(function init() {
  console.log("Typeof browser:", typeof browser);
  const hostname = window.location.hostname;
  browser.storage.local.get(['extensionEnabled', 'sites', 'debugMode'])
    .then((result) => {
      const extensionEnabled = result.extensionEnabled !== false;
      const sites = result.sites || {};
      const debugMode = result.debugMode === true;
      if (!extensionEnabled) {
        debugLog('Extension is globally disabled.', debugMode);
        return;
      }
      let supportedSiteFound = false;
      Object.entries(siteSelectors).forEach(([site, selectors]) => {
        if (sites[site] !== false &&
            selectors.domains &&
            selectors.domains.some(domain => hostname.includes(domain))) {
          debugLog(`Successfully loaded on site ${hostname}.`, debugMode);
          handleSite(site, debugMode);
          supportedSiteFound = true;
        }
      });
      if (!supportedSiteFound && debugMode) {
        setInterval(() => {
          debugLog('Invalid site: This site is not supported by Skipper.', debugMode);
        }, 500);
      }
    })
    .catch((error) => {
      console.error('Error initializing Skipper extension:', error);
    });
})();
