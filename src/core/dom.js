/**
 * core/dom.js — generic DOM utilities for browser extensions.
 *
 * No browser-extension APIs (browser.*, chrome.*) are used here.
 * No project-specific state is referenced.
 * Safe to import into any content script or background page.
 */

/**
 * Query `selector` starting from `root`, recursively walking into shadow roots
 * when `searchShadow` is true. Returns the first matching element or null.
 *
 * @param {Document|Element|ShadowRoot} root
 * @param {string} selector
 * @param {boolean} [searchShadow=false]
 * @returns {Element|null}
 */
export function queryInTree(root, selector, searchShadow = false) {
  const direct = root.querySelector(selector);
  if (direct) return direct;

  if (searchShadow) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = queryInTree(el.shadowRoot, selector, true);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Like `queryInTree` but swallows invalid-selector errors.
 *
 * @param {string} selector
 * @param {Document|Element|ShadowRoot} [root=document]
 * @param {boolean} [searchShadow=false]
 * @returns {Element|null}
 */
export function safeQuery(selector, root = document, searchShadow = false) {
  try { return queryInTree(root, selector, searchShadow); }
  catch (_) { return null; }
}

/**
 * Returns true when `el` is visible: non-zero bounding box, not
 * display:none, not visibility:hidden, not opacity:0.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isElementVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

/**
 * Generates a stable, human-readable CSS selector for `el`.
 * Preference order:
 *   1. Stable data-* attributes (data-testid, data-automationid, …)
 *   2. Unique #id
 *   3. aria-label attribute
 *   4. Non-obfuscated class names
 *   5. [role] attribute
 *   6. Tag name fallback
 *
 * @param {Element} el
 * @returns {string}
 */
export function generateSelector(el) {
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
