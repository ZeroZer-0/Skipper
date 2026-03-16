/**
 * core/candidates.js — heuristic scoring for "skip / next" button candidates.
 *
 * Finds interactive elements on a streaming (or any) page that look like skip
 * intro / next episode buttons, scores them 0–100, and returns the top results.
 *
 * Zero project-specific state.  Pass an `isTracked` function to exclude elements
 * that are already handled by the caller's configuration.
 *
 * Usage:
 *   import { scanForCandidates } from './core/candidates.js';
 *
 *   const results = scanForCandidates({
 *     isTracked: selector => myConfig.some(b => b.selector === selector),
 *   });
 */

import { isElementVisible, generateSelector } from './dom.js';

// ─── Scoring constants ────────────────────────────────────────────────────────

export const MIN_CANDIDATE_SCORE  = 40;
export const HIGH_CANDIDATE_SCORE = 60;

const MAX_TEXT_LEN = 40;

// Ordered: first match wins for the text check (higher points → more specific).
const TEXT_PATTERNS = [
  { re: /^(skip intro|skip recap|skip credits|skip opening|next episode|skip outro)$/i, pts: 35 },
  { re: /^skip\s/i,                                    pts: 25 },
  { re: /\b(intro|recap|credits|opening|episode)\b/i,  pts: 20 },
  { re: /\bnext\s+(episode|chapter)\b/i,               pts: 20 },
  { re: /\bskip\b/i,                                   pts: 10 },
  { re: /\bnext\b/i,                                   pts:  5 },
];

const ATTR_TERMS  = /skip|next.?ep|intro|recap|credits|episode|outro|opening/i;
const CLASS_TERMS = /\b(skip|next.ep|intro|recap|credits|episode)\b/i;

// ─── Core scoring ─────────────────────────────────────────────────────────────

/**
 * Score a single element.
 *
 * @param {Element} el
 * @param {object}  [opts]
 * @param {function} [opts.isTracked] - `(selector: string) => boolean`
 *   Return true to exclude an element that is already tracked.
 * @returns {{ score: number, label: string, selector: string,
 *             reasons: string[], scoreLabel: string } | null}
 *   Returns null when the element should be ignored entirely.
 */
export function scoreElement(el, { isTracked = () => false } = {}) {
  const text = (el.textContent || '').trim();
  if (!text || text.length > MAX_TEXT_LEN) return null;

  let score = 0;
  const reasons = [];

  // 1. Text pattern scoring (first match only)
  for (const { re, pts } of TEXT_PATTERNS) {
    if (re.test(text)) { score += pts; reasons.push(`text:${pts}`); break; }
  }

  // 2. Attribute scoring
  for (const attr of ['data-testid', 'data-automationid', 'data-uia', 'aria-label']) {
    const val = el.getAttribute(attr) || '';
    if (ATTR_TERMS.test(val)) { score += 5; reasons.push(`${attr}:5`); }
  }
  if (CLASS_TERMS.test(el.className || '')) { score += 4; reasons.push('class:4'); }

  // 3. Element type bonus
  if (el.tagName.toLowerCase() === 'button' || el.getAttribute('role') === 'button') {
    score += 2;
    reasons.push('tag:2');
  }

  // 4. Visibility + size guard
  if (!isElementVisible(el)) return null;
  if (el.getBoundingClientRect().width > 300) return null;

  if (score < MIN_CANDIDATE_SCORE) return null;

  const selector = generateSelector(el);
  if (isTracked(selector)) return null;

  return {
    score,
    label:      text.substring(0, 60) || el.getAttribute('aria-label') || el.tagName.toLowerCase(),
    selector,
    reasons,
    scoreLabel: score >= HIGH_CANDIDATE_SCORE ? 'High' : 'Medium',
  };
}

/**
 * Scan the current document for candidate skip/next buttons.
 *
 * @param {object}   [opts]
 * @param {function} [opts.isTracked] - Passed through to `scoreElement`.
 * @param {number}   [opts.limit=10]  - Maximum results to return.
 * @returns {Array}  Candidates sorted by score descending.
 */
export function scanForCandidates({ isTracked = () => false, limit = 10 } = {}) {
  const candidates = [];
  const seen = new Set();

  for (const el of document.querySelectorAll('button,[role=button],[tabindex]')) {
    try {
      const result = scoreElement(el, { isTracked });
      if (!result) continue;
      if (seen.has(result.selector)) continue;
      seen.add(result.selector);
      candidates.push(result);
    } catch (_) {}
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
