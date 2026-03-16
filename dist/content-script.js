(() => {
  // src/core/dom.js
  function queryInTree(root, selector, searchShadow = false) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    if (searchShadow) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const found = queryInTree(el.shadowRoot, selector, true);
          if (found) return found;
        }
      }
    }
    return null;
  }
  function safeQuery(selector, root = document, searchShadow = false) {
    try {
      return queryInTree(root, selector, searchShadow);
    } catch (_) {
      return null;
    }
  }
  function isElementVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function generateSelector(el) {
    const stableDataAttrs = ["data-testid", "data-automationid", "data-uia", "data-qa", "data-id"];
    for (const attr of stableDataAttrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      const s = `[${attr}="${val}"]`;
      try {
        return document.querySelectorAll(s).length <= 3 ? s : `${el.tagName.toLowerCase()}${s}`;
      } catch (_) {
      }
    }
    if (el.id && !/^\d/.test(el.id) && el.id.length < 40) {
      const s = `#${el.id}`;
      try {
        if (document.querySelectorAll(s).length === 1) return s;
      } catch (_) {
      }
    }
    const aria = el.getAttribute("aria-label");
    if (aria) {
      const s = `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
      try {
        if (document.querySelectorAll(s).length <= 3) return s;
      } catch (_) {
      }
    }
    const stableClasses = [...el.classList].filter(
      (c) => c.length > 2 && !/^\d/.test(c) && !/^[a-z]+-[a-z0-9]{5,}$/.test(c) && !(/[a-z][A-Z]/.test(c) && /[A-Z][a-z]/.test(c) && c.length > 12)
    );
    if (stableClasses.length > 0) {
      const s = `${el.tagName.toLowerCase()}.${stableClasses.slice(0, 2).join(".")}`;
      try {
        if (document.querySelectorAll(s).length <= 5) return s;
      } catch (_) {
      }
    }
    const role = el.getAttribute("role");
    if (role) return `${el.tagName.toLowerCase()}[role="${role}"]`;
    return el.tagName.toLowerCase();
  }

  // src/core/picker.js
  var pickerActive = false;
  var pickerHovered = null;
  var _onPick = null;
  var _onCancel = null;
  var _hint = "";
  function onMouseover(e) {
    e.stopPropagation();
    if (pickerHovered && pickerHovered !== e.target) clearHover();
    pickerHovered = e.target;
    pickerHovered.style.outline = "2px dashed #ff6d00";
    pickerHovered.style.outlineOffset = "2px";
    pickerHovered.style.cursor = "crosshair";
  }
  function clearHover() {
    if (!pickerHovered) return;
    pickerHovered.style.removeProperty("outline");
    pickerHovered.style.removeProperty("outline-offset");
    pickerHovered.style.removeProperty("cursor");
    pickerHovered = null;
  }
  function onMouseout(e) {
    if (pickerHovered === e.target) clearHover();
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    const selector = generateSelector(el);
    const label = (el.textContent || "").trim().substring(0, 60) || el.getAttribute("aria-label") || el.tagName.toLowerCase();
    deactivatePicker();
    showToast(selector);
    _onPick?.({ el, selector, label });
  }
  function onKeydown(e) {
    if (e.key === "Escape") {
      deactivatePicker();
      _onCancel?.();
    }
  }
  function showToast(selector) {
    const el = document.createElement("div");
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
    <span style="color:#777;font-size:11px">${_hint}</span>
  `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5e3);
  }
  function activatePicker({ onPick, onCancel, hint = "Open the extension to save it." } = {}) {
    if (pickerActive) return;
    pickerActive = true;
    _onPick = onPick;
    _onCancel = onCancel;
    _hint = hint;
    document.addEventListener("mouseover", onMouseover, true);
    document.addEventListener("mouseout", onMouseout, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeydown, true);
  }
  function deactivatePicker() {
    if (!pickerActive) return;
    pickerActive = false;
    clearHover();
    document.removeEventListener("mouseover", onMouseover, true);
    document.removeEventListener("mouseout", onMouseout, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    _onPick = null;
    _onCancel = null;
  }

  // src/core/candidates.js
  var MIN_CANDIDATE_SCORE = 40;
  var HIGH_CANDIDATE_SCORE = 60;
  var MAX_TEXT_LEN = 40;
  var TEXT_PATTERNS = [
    { re: /^(skip intro|skip recap|skip credits|skip opening|next episode|skip outro)$/i, pts: 35 },
    { re: /^skip\s/i, pts: 25 },
    { re: /\b(intro|recap|credits|opening|episode)\b/i, pts: 20 },
    { re: /\bnext\s+(episode|chapter)\b/i, pts: 20 },
    { re: /\bskip\b/i, pts: 10 },
    { re: /\bnext\b/i, pts: 5 }
  ];
  var ATTR_TERMS = /skip|next.?ep|intro|recap|credits|episode|outro|opening/i;
  var CLASS_TERMS = /\b(skip|next.ep|intro|recap|credits|episode)\b/i;
  function scoreElement(el, { isTracked = () => false } = {}) {
    const text = (el.textContent || "").trim();
    if (!text || text.length > MAX_TEXT_LEN) return null;
    let score = 0;
    const reasons = [];
    for (const { re, pts } of TEXT_PATTERNS) {
      if (re.test(text)) {
        score += pts;
        reasons.push(`text:${pts}`);
        break;
      }
    }
    for (const attr of ["data-testid", "data-automationid", "data-uia", "aria-label"]) {
      const val = el.getAttribute(attr) || "";
      if (ATTR_TERMS.test(val)) {
        score += 5;
        reasons.push(`${attr}:5`);
      }
    }
    if (CLASS_TERMS.test(el.className || "")) {
      score += 4;
      reasons.push("class:4");
    }
    if (el.tagName.toLowerCase() === "button" || el.getAttribute("role") === "button") {
      score += 2;
      reasons.push("tag:2");
    }
    if (!isElementVisible(el)) return null;
    if (el.getBoundingClientRect().width > 300) return null;
    if (score < MIN_CANDIDATE_SCORE) return null;
    const selector = generateSelector(el);
    if (isTracked(selector)) return null;
    return {
      score,
      label: text.substring(0, 60) || el.getAttribute("aria-label") || el.tagName.toLowerCase(),
      selector,
      reasons,
      scoreLabel: score >= HIGH_CANDIDATE_SCORE ? "High" : "Medium"
    };
  }
  function scanForCandidates({ isTracked = () => false, limit = 10 } = {}) {
    const candidates = [];
    const seen = /* @__PURE__ */ new Set();
    for (const el of document.querySelectorAll("button,[role=button],[tabindex]")) {
      try {
        const result = scoreElement(el, { isTracked });
        if (!result) continue;
        if (seen.has(result.selector)) continue;
        seen.add(result.selector);
        candidates.push(result);
      } catch (_) {
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
  }

  // src/content-script.js
  if (typeof browser === "undefined") {
    window.browser = chrome;
  }
  var IS_TOP_FRAME = window === window.top;
  var sitesConfig = null;
  var currentSiteId = null;
  var currentSite = null;
  var customButtons = {};
  var buttonToggles = {};
  var settings = {
    extensionEnabled: true,
    debugMode: false,
    pickerMode: false
  };
  var healthCache = {};
  var healthDirty = false;
  var lastClickTime = 0;
  var pendingClicks = /* @__PURE__ */ new Map();
  var candidateWatchEnabled = false;
  var candidateBadgeCount = 0;
  var candidateScanDebounce = null;
  var frameDetections = /* @__PURE__ */ new Map();
  function getTopHostname() {
    try {
      return window.top.location.hostname;
    } catch (_) {
      return null;
    }
  }
  function log(...args) {
    if (settings.debugMode) console.log("[Skipper]", ...args);
  }
  function activeButtons() {
    const base = (currentSite?.buttons || []).filter(
      (btn) => (buttonToggles[currentSiteId] || {})[btn.label] !== false
    );
    const custom = customButtons[currentSiteId] || [];
    return [...base, ...custom];
  }
  function allButtons() {
    return [
      ...currentSite?.buttons || [],
      ...customButtons[currentSiteId] || []
    ];
  }
  function domQuery(selector) {
    return safeQuery(selector, document, currentSite?.searchShadowDom ?? false);
  }
  function detectSite() {
    if (!sitesConfig) return null;
    const here = window.location.hostname;
    const top = getTopHostname();
    for (const [id, site] of Object.entries(sitesConfig)) {
      if (!Array.isArray(site?.domains)) continue;
      const domains = site.domains;
      if (domains.some((d) => here.includes(d))) return [id, site];
      if (top && domains.some((d) => top.includes(d))) return [id, site];
    }
    return null;
  }
  var HL_ATTR = "data-skipper-hl";
  function clearHighlights() {
    document.querySelectorAll(`[${HL_ATTR}]`).forEach((el) => {
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
      el.removeAttribute(HL_ATTR);
    });
  }
  function applyHighlights() {
    clearHighlights();
    allButtons().forEach((btn) => {
      const enabled = (buttonToggles[currentSiteId] || {})[btn.label] !== false;
      const el = domQuery(btn.selector);
      if (el) {
        const target = findClickTarget(el);
        target.style.outline = enabled ? "3px solid #00e676" : "3px solid #555";
        target.style.outlineOffset = "2px";
        target.setAttribute(HL_ATTR, btn.label);
      }
    });
    broadcastDetections();
  }
  function findClickTarget(el) {
    if (["BUTTON", "A", "INPUT", "SUMMARY"].includes(el.tagName)) return el;
    const inner = el.querySelector('button, a, input[type="submit"]');
    return inner ?? el;
  }
  function scheduleClick(btn, el) {
    if (pendingClicks.has(btn.selector)) return;
    const delay = btn.delayMs || 0;
    const timerId = setTimeout(() => {
      pendingClicks.delete(btn.selector);
      const current = domQuery(btn.selector);
      if (current) {
        const target = findClickTarget(current);
        log(`Clicking (${delay}ms delay): ${btn.label}`);
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
        lastClickTime = Date.now();
        updateHealth(btn.label);
      }
    }, delay);
    pendingClicks.set(btn.selector, timerId);
  }
  function runClicks() {
    if (Date.now() - lastClickTime < 1e4) return;
    activeButtons().forEach((btn) => {
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
  function updateHealth(label) {
    const key = `${currentSiteId}__${label}`;
    const now = Date.now();
    if (!healthCache[key] || now - healthCache[key] > 36e5) {
      healthCache[key] = now;
      healthDirty = true;
    }
  }
  setInterval(async () => {
    if (!healthDirty) return;
    try {
      await browser.storage.local.set({ healthData: healthCache });
      healthDirty = false;
    } catch (_) {
    }
  }, 6e4);
  function broadcastDetections() {
    if (IS_TOP_FRAME || !currentSiteId) return;
    const detected = allButtons().map((btn) => ({
      label: btn.label,
      selector: btn.selector,
      found: !!domQuery(btn.selector),
      custom: !!btn.custom,
      enabled: (buttonToggles[currentSiteId] || {})[btn.label] !== false
    }));
    const msg = {
      type: "skipper-frame-detection",
      siteId: currentSiteId,
      frameUrl: window.location.href,
      detected
    };
    try {
      window.top.postMessage(msg, "*");
    } catch (_) {
      try {
        window.parent.postMessage(msg, "*");
      } catch (_2) {
      }
    }
  }
  if (!IS_TOP_FRAME) {
    window.addEventListener("message", (e) => {
      if (e.data?.type !== "skipper-test-selector") return;
      try {
        const count = document.querySelectorAll(e.data.selector).length;
        window.parent.postMessage(
          { type: "skipper-selector-result", reqId: e.data.reqId, count },
          "*"
        );
      } catch (_) {
      }
    });
  }
  if (IS_TOP_FRAME) {
    window.addEventListener("message", (e) => {
      if (e.data?.type === "skipper-frame-detection") {
        frameDetections.set(e.data.frameUrl, {
          siteId: e.data.siteId,
          detected: e.data.detected
        });
      }
    });
  }
  var mutationObserver = null;
  var fallbackIntervalId = null;
  var debounceTimer = null;
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
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-testid"]
    });
    fallbackIntervalId = setInterval(runCheck, 5e3);
    runCheck();
  }
  function stopObserving() {
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (fallbackIntervalId !== null) {
      clearInterval(fallbackIntervalId);
      fallbackIntervalId = null;
    }
    clearTimeout(debounceTimer);
    pendingClicks.forEach(clearTimeout);
    pendingClicks.clear();
    candidateWatchEnabled = false;
    clearTimeout(candidateScanDebounce);
  }
  function runCandidateScan() {
    clearTimeout(candidateScanDebounce);
    candidateScanDebounce = setTimeout(() => {
      const results = scanForCandidates({
        isTracked: (sel) => activeButtons().some((b) => b.selector === sel)
      });
      candidateBadgeCount = results.length;
      if (candidateBadgeCount > 0) {
        browser.runtime.sendMessage({ action: "candidatesFound", count: candidateBadgeCount }).catch(() => {
        });
      }
      browser.runtime.sendMessage({ action: "candidatesUpdated", count: candidateBadgeCount }).catch(() => {
      });
    }, 2e3);
  }
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
        hint: "Open Skipper to label and save it.",
        onPick: ({ selector, label }) => {
          const result = {
            action: "elementPicked",
            selector,
            label,
            siteId: currentSiteId,
            isIframe: !IS_TOP_FRAME,
            frameUrl: window.location.href
          };
          browser.storage.local.set({ pickerMode: false, lastPickedButton: result });
          browser.runtime.sendMessage(result).catch(() => {
          });
        },
        onCancel: () => {
          browser.storage.local.set({ pickerMode: false });
          browser.runtime.sendMessage({ action: "pickerCancelled" }).catch(() => {
          });
        }
      });
    } else {
      deactivatePicker();
      clearHighlights();
      startObserving();
      candidateWatchEnabled = true;
    }
  }
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "updateSettings":
        if (msg.settings.customButtons !== void 0) customButtons = msg.settings.customButtons;
        if (msg.settings.buttonToggles !== void 0) buttonToggles = msg.settings.buttonToggles;
        Object.assign(settings, msg.settings);
        applySettings();
        break;
      case "activatePicker":
        settings.pickerMode = true;
        applySettings();
        break;
      case "deactivatePicker":
        settings.pickerMode = false;
        deactivatePicker();
        applySettings();
        break;
      case "clickDetected":
        if (currentSiteId) {
          forceClick();
          sendResponse({ ok: true });
        }
        break;
      case "getDetectedButtons": {
        const siteToggleMap = buttonToggles[currentSiteId] || {};
        const ownDetected = allButtons().map((btn) => ({
          label: btn.label,
          selector: btn.selector,
          found: !!domQuery(btn.selector),
          custom: !!btn.custom,
          enabled: siteToggleMap[btn.label] !== false,
          lastSeen: healthCache[`${currentSiteId}__${btn.label}`] || null,
          frameUrl: window.location.href,
          isIframe: !IS_TOP_FRAME
        }));
        const crossFrameDetected = [];
        if (IS_TOP_FRAME) {
          frameDetections.forEach(({ siteId, detected }, frameUrl) => {
            if (siteId === currentSiteId) {
              detected.forEach((btn) => crossFrameDetected.push({ ...btn, frameUrl, isIframe: true }));
            }
          });
        }
        sendResponse({
          siteId: currentSiteId,
          siteName: currentSite?.name || currentSiteId,
          detected: [...ownDetected, ...crossFrameDetected]
        });
        break;
      }
      case "testSelector": {
        try {
          const ownCount = document.querySelectorAll(msg.selector).length;
          const inShadow = currentSite?.searchShadowDom ? !!domQuery(msg.selector) : false;
          if (!IS_TOP_FRAME) {
            sendResponse({ count: ownCount, shadowHit: inShadow });
            break;
          }
          const reqId = Math.random().toString(36).slice(2);
          let frameCount = 0;
          let inIframe = false;
          const onResult = (e) => {
            if (e.data?.type === "skipper-selector-result" && e.data.reqId === reqId) {
              frameCount += e.data.count;
              if (e.data.count > 0) inIframe = true;
            }
          };
          window.addEventListener("message", onResult);
          document.querySelectorAll("iframe").forEach((f) => {
            try {
              f.contentWindow.postMessage({ type: "skipper-test-selector", selector: msg.selector, reqId }, "*");
            } catch (_) {
            }
          });
          setTimeout(() => {
            window.removeEventListener("message", onResult);
            sendResponse({ count: ownCount + frameCount, shadowHit: inShadow, inIframe });
          }, 500);
          return true;
        } catch (e) {
          sendResponse({ count: 0, error: e.message });
        }
        break;
      }
      case "ping":
        sendResponse({ ok: true });
        break;
      case "getCandidates":
        sendResponse({
          siteId: currentSiteId,
          candidates: scanForCandidates({
            isTracked: (sel) => activeButtons().some((b) => b.selector === sel)
          })
        });
        break;
      case "enableCandidateWatch":
        candidateWatchEnabled = !!msg.enabled;
        break;
    }
  });
  async function init() {
    try {
      try {
        const resp = await browser.runtime.sendMessage({ action: "getSitesConfig" });
        sitesConfig = resp?.config ?? null;
      } catch (_) {
      }
      if (!sitesConfig) {
        const r = await fetch(browser.runtime.getURL("sites.json"));
        sitesConfig = await r.json();
      }
      const stored = await browser.storage.local.get([
        "extensionEnabled",
        "sites",
        "debugMode",
        "customButtons",
        "buttonToggles",
        "pickerMode",
        "healthData"
      ]);
      settings.extensionEnabled = stored.extensionEnabled !== false;
      settings.debugMode = stored.debugMode === true;
      settings.pickerMode = stored.pickerMode === true;
      customButtons = stored.customButtons || {};
      buttonToggles = stored.buttonToggles || {};
      healthCache = stored.healthData || {};
      if (!settings.extensionEnabled) {
        log("Extension disabled");
        return;
      }
      const match = detectSite();
      if (!match) {
        log(`No site match for: ${window.location.hostname}` + (!IS_TOP_FRAME ? ` (iframe, top: ${getTopHostname()})` : ""));
        return;
      }
      const [siteId, site] = match;
      const enabledSites = stored.sites || {};
      if (enabledSites[siteId] === false) {
        log(`${siteId} disabled by user`);
        return;
      }
      currentSiteId = siteId;
      currentSite = site;
      log(`Active on "${siteId}" \u2014 ${IS_TOP_FRAME ? "main frame" : "iframe @ " + window.location.hostname}`);
      applySettings();
    } catch (err) {
      console.error("[Skipper] Init error:", err);
    }
  }
  init();
})();
