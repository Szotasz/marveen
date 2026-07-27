// i18n runtime module (S-2, issue #3).
//
// Priority: localStorage['marveen.lang'] > DASHBOARD_LANG (server setting) > 'hu'.
// Rick's spec (kanban card 209696a9): t(key,params), window._i18n={hu,en}, {name}
// interpolation, EN-fallback then key, dev-mode warning.
//
// Load-order contract:
//   1. web/lang/hu.js and en.js are plain <script> tags that run first and write
//      window._i18n.{hu,en}. This module reads from that object -- do NOT change
//      how the lang files work.
//   2. This module is imported by app.js (type="module", deferred). Module-level
//      code here runs synchronously as part of module evaluation, so _lang is
//      initialised from localStorage before any t() call in app.js.
//   3. The DASHBOARD_LANG fetch is deferred via queueMicrotask so it fires after
//      the auth-wrapping IIFE in app.js has replaced window.fetch with the
//      Bearer-injecting version -- otherwise the /api/settings call goes out
//      unauthenticated and gets a 401.

const LS_KEY = 'marveen.lang'
const VALID = new Set(['hu', 'en'])

// Module-private language state. window._lang is kept in sync for any code that
// still reads it directly (e.g. the language-toggle button before S-3 cleans it up).
let _lang = 'hu'

// Callbacks fired whenever the active language changes (setLang, DASHBOARD_LANG).
// app.js registers renderNav + renderStaticI18n + switchPage here.
const _callbacks = []

// ── Public API ──────────────────────────────────────────────────────────────

/** Register a callback to run whenever the active language changes. */
export function onLangChange(fn) {
  _callbacks.push(fn)
}

/** The currently active language code ('hu' or 'en'). */
export function getLang() {
  return _lang
}

/**
 * Translate a key with optional {param} substitution.
 * Falls back to EN, then to the raw key (with a dev-mode console.warn).
 *
 * Brand tokens ({brand}, {bot}, {agentId}) are merged in from window._brandTokens
 * so initSidebarBrand() can keep publishing them on window without needing to
 * call a setter here. Explicit params always win.
 */
export function t(key, params = {}) {
  const str =
    window._i18n?.[_lang]?.[key] ??
    window._i18n?.['en']?.[key] ??
    key
  if (str === key && localStorage.getItem('marveen.dev') === '1') {
    console.warn('[i18n] missing key:', key)
  }
  const vals = { ...window._brandTokens, ...params }
  return str.replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? vals[k] : `{${k}}`))
}

/**
 * Switch the active language, persist to localStorage, and fire all
 * onLangChange callbacks (renderNav, renderStaticI18n, switchPage).
 */
export function setLang(lang) {
  if (!VALID.has(lang)) return
  _applyLang(lang)
  localStorage.setItem(LS_KEY, lang)
  _fire()
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _applyLang(lang) {
  _lang = VALID.has(lang) ? lang : 'hu'
  // Keep window._lang in sync for legacy direct reads (removed in a future step).
  window._lang = _lang
}

function _fire() {
  for (const fn of _callbacks) fn()
}

// ── Initialisation ───────────────────────────────────────────────────────────

// Ensure window._brandTokens exists so t() can merge it safely before
// initSidebarBrand() fills in the real values from /api/marveen.
window._brandTokens = window._brandTokens || { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' }

// Seed language from localStorage immediately (synchronous).
_applyLang(localStorage.getItem(LS_KEY) || 'hu')

// Fetch server default (DASHBOARD_LANG) after the Bearer-injecting fetch wrapper
// is installed. queueMicrotask defers until after the full classic script
// evaluates, which is when window.fetch is the wrapped version.
queueMicrotask(() => {
  fetch('/api/settings')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || localStorage.getItem(LS_KEY)) return
      const entry = (data.settings || []).find(s => s.key === 'DASHBOARD_LANG')
      if (!entry || !VALID.has(entry.value) || entry.value === _lang) return
      // Apply WITHOUT persisting to localStorage (server default must not win
      // over a user's explicit choice stored there).
      _applyLang(entry.value)
      _fire()
    })
    .catch(() => {})
})

// Compatibility aliases on window so any code that calls window.t() or
// window.setLang() (e.g. browser devtools, legacy inline scripts) still works.
// All internal app.js code uses the named imports instead.
window.t = t
window.setLang = setLang
