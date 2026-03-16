/**
 * core/picker.js — reusable visual element picker for browser extensions.
 *
 * Highlights the hovered element with a dashed orange outline.  When the user
 * clicks, `onPick` is called with `{ el, selector, label }`.  Pressing Escape
 * calls `onCancel`.
 *
 * Usage:
 *   import { activatePicker, deactivatePicker } from './core/picker.js';
 *
 *   activatePicker({
 *     onPick:   ({ el, selector, label }) => { … },
 *     onCancel: () => { … },
 *     hint:     'Open MyExtension to save it.',   // shown in toast
 *   });
 *
 * No browser.* / chrome.* APIs are used here — all side-effects live in the
 * caller's onPick / onCancel callbacks.
 */

import { generateSelector } from './dom.js';

let pickerActive  = false;
let pickerHovered = null;
let _onPick       = null;
let _onCancel     = null;
let _hint         = '';

// ─── Internal handlers ────────────────────────────────────────────────────────

function onMouseover(e) {
  e.stopPropagation();
  if (pickerHovered && pickerHovered !== e.target) clearHover();
  pickerHovered = e.target;
  pickerHovered.style.outline       = '2px dashed #ff6d00';
  pickerHovered.style.outlineOffset = '2px';
  pickerHovered.style.cursor        = 'crosshair';
}

function clearHover() {
  if (!pickerHovered) return;
  pickerHovered.style.removeProperty('outline');
  pickerHovered.style.removeProperty('outline-offset');
  pickerHovered.style.removeProperty('cursor');
  pickerHovered = null;
}

function onMouseout(e) {
  if (pickerHovered === e.target) clearHover();
}

function onClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const el       = e.target;
  const selector = generateSelector(el);
  const label    = (el.textContent || '').trim().substring(0, 60)
                || el.getAttribute('aria-label')
                || el.tagName.toLowerCase();

  deactivatePicker();
  showToast(selector);
  _onPick?.({ el, selector, label });
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    deactivatePicker();
    _onCancel?.();
  }
}

function showToast(selector) {
  const el = document.createElement('div');
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
  setTimeout(() => el.remove(), 5_000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enable the visual element picker.
 *
 * @param {object} opts
 * @param {function} opts.onPick     - Called with `{ el, selector, label }` after a click.
 * @param {function} [opts.onCancel] - Called when the user presses Escape.
 * @param {string}  [opts.hint]      - Short help text shown in the capture toast.
 */
export function activatePicker({ onPick, onCancel, hint = 'Open the extension to save it.' } = {}) {
  if (pickerActive) return;
  pickerActive = true;
  _onPick      = onPick;
  _onCancel    = onCancel;
  _hint        = hint;

  document.addEventListener('mouseover', onMouseover, true);
  document.addEventListener('mouseout',  onMouseout,  true);
  document.addEventListener('click',     onClick,     true);
  document.addEventListener('keydown',   onKeydown,   true);
}

/**
 * Disable the element picker and clean up all listeners / hover styles.
 */
export function deactivatePicker() {
  if (!pickerActive) return;
  pickerActive = false;
  clearHover();
  document.removeEventListener('mouseover', onMouseover, true);
  document.removeEventListener('mouseout',  onMouseout,  true);
  document.removeEventListener('click',     onClick,     true);
  document.removeEventListener('keydown',   onKeydown,   true);
  _onPick   = null;
  _onCancel = null;
}
