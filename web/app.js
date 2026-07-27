// ES module imports (issue #3 modularization). app.js is type="module".
import { showToast } from './modules/toast.js'
import { t, setLang, getLang, onLangChange } from './modules/i18n.js'
import { registerPage, registerAlias, switchPage, boot, renderNav, renderStaticI18n } from './modules/app-core.js'
import { loadKanban, startKanbanRefresh, stopKanbanRefresh, initKanban, kanbanState } from './modules/kanban.js'
import { wireKanbanColumnDnD, wireKanbanCardTouchDnD } from './modules/kanban-dnd.js'
import {
  initAgents, loadAgents, startAgentsBusyPoll, stopAgentsBusyPoll, openMarveenDetail,
  setAgentsView, getAgentsActiveView, setAgentsActiveView,
  getFederatedPeerStatus, setFederatedPeerStatus, federatedAgentEntries,
  avatarBust, agentApiName, populateAvatarGrid, loadAvailableModels,
} from './modules/agents.js'
import { initSchedules, loadSchedules, loadScheduleAgents, openEditSchedule, getScheduleCron } from './modules/schedules.js'
import { initMemories, loadMemAgents, loadMemStats, loadMemories } from './modules/memories.js'
import { initConnectors, loadConnectors, loadVaultPage } from './modules/connectors.js'
import { initSkills, loadSkills, loadGlobalSkills, clearSkillModalScope } from './modules/skills.js'
import { loadMessagesPage, getChatSelectedAgent, setChatSelectedAgent } from './modules/messages.js'
import { initSettings, loadSettings, isSettingsDirty } from './modules/settings.js'
import { initTokenUsage, loadTokenUsage } from './modules/token-usage.js'
import { startActivityPoll, stopActivityPoll, loadActivity, loadOverview, initActivity } from './modules/overview.js'
import { loadFederationPage, initFederation } from './modules/federation.js'
import { loadIdeasPage, initIdeas } from './modules/ideas.js'
import { openTerminalModal, openConversationModal, initAgentModals } from './modules/agent-modals.js'
import { loadStatus, loadCosts, initStatusCosts } from './modules/status-costs.js'
import { loadDocs, loadResearch } from './modules/docs-research.js'
import { loadRecallPage, loadBgTasksPage, initRecallBgTasks } from './modules/recall-bgtasks.js'

// avatarBust() is imported from ./modules/agents.js (avatar epoch owned there).

// t(), setLang(), getLang(), onLangChange() are imported from web/modules/i18n.js

// === Modal helpers ===
// Global open/close for ALL overlay modals in this app (agents, skills,
// schedule, memory, connectors). Injected into agents.js via initAgents so the
// agents module does not re-define them.
function openModal(overlay) {
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}
function closeModal(overlay) {
  overlay.classList.remove('active')
  document.body.style.overflow = ''
  // Skill modal is used by two distinct callers (Agent detail + Skills
  // page). Reset the scope on every close path so the next opener cannot
  // inherit a stale 'global' flag from an earlier Skills-page open.
  if (overlay && overlay.id === 'skillModalOverlay') clearSkillModalScope()
}


// === Dashboard auth bootstrap ===
// The server prints an URL like http://127.0.0.1:3420/?token=XXX on startup.
// On first visit we pluck the token out of the URL, store it in localStorage,
// strip it from the visible URL, and then inject it into every /api/* fetch
// as a Bearer header so the server lets us through.

// The main (channels) agent's real id. The backend /api/marveen route returns
// the configured MAIN_AGENT_ID (NOT the literal "marveen") in window._marveen;
// use this everywhere an agent id is sent to /api/agents/... or compared to a
// fleet name, so the dashboard works on non-"marveen" installs. Falls back to
// "marveen" only before /api/marveen has resolved (or on a legacy backend).
function mainAgentId() {
  return window._marveen?.agentId || 'marveen'
}

(() => {
  const TOKEN_KEY = 'marveen-dashboard-token'
  const urlParams = new URLSearchParams(window.location.search)
  const urlToken = urlParams.get('token')
  // Keep the token in memory for the whole session in addition to localStorage.
  // Some iOS/Safari privacy modes purge or block localStorage (especially over
  // plain http / non-primary origins); an in-memory copy keeps the session
  // authenticated even when the persisted copy is unavailable.
  let sessionToken = urlToken || ''
  if (urlToken) {
    try { localStorage.setItem(TOKEN_KEY, urlToken) } catch { /* storage blocked */ }
    urlParams.delete('token')
    const clean = window.location.pathname + (urlParams.toString() ? '?' + urlParams : '') + window.location.hash
    window.history.replaceState({}, '', clean)
  } else {
    try { sessionToken = localStorage.getItem(TOKEN_KEY) || '' } catch { /* storage blocked */ }
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input))
    // Only attach the token to same-origin API calls. Relative paths always
    // resolve to same-origin; absolute URLs must match the current origin.
    const isSameOriginApi =
      url.startsWith('/api/') ||
      (url.startsWith(window.location.origin + '/api/'))
    if (isSameOriginApi) {
      let token = sessionToken
      if (!token) { try { token = localStorage.getItem(TOKEN_KEY) } catch { token = '' } }
      if (token) {
        init = init || {}
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
        headers.set('Authorization', 'Bearer ' + token)
        init.headers = headers
      }
    }
    const res = await originalFetch(input, init)
    if (res.status === 401 && isSameOriginApi) {
      // Token missing, wrong, or revoked. Wipe and prompt once per page load.
      // Keep a URL-provided session token so a transient 401 does not lock out
      // a session whose localStorage copy was purged.
      try { localStorage.removeItem(TOKEN_KEY) } catch { /* storage blocked */ }
      if (!urlToken) sessionToken = ''
      if (!window.__marveenAuthPrompted) {
        window.__marveenAuthPrompted = true
        handleAuthFailure()
      }
    }
    return res
  }

  // On a 401, ask the public status probe whether a username+password login is
  // available on this instance. If so, show the login overlay; otherwise fall
  // back to the existing token flows (PWA paste field or the console-URL alert).
  async function handleAuthFailure() {
    let status = null
    try {
      const r = await originalFetch('/api/auth/status')
      if (r.ok) status = await r.json()
    } catch { /* offline or probe failed -- fall through to token flows */ }
    if (status && status.login_available) {
      showLoginOverlay()
      return
    }
    // An installed (home-screen) PWA has its own localStorage, separate from
    // Safari's, and the manifest start_url has no ?token=, so the very first
    // standalone launch is token-less and 401s. There is no address bar to paste
    // a ?token= URL into either. Offer an in-app paste field that writes the
    // token to the app's own storage, then reload.
    const isStandalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    if (isStandalone) {
      showStandaloneTokenPrompt(TOKEN_KEY)
    } else {
      alert(
        'Dashboard authentication failed. Check the server log for the access URL ' +
        '(look for "Dashboard access URL" with ?token=...), then reopen it in your browser.'
      )
    }
  }

  // Full-screen username+password login overlay. Posts to /api/auth/login; on
  // success the browser has the mv_session cookie and we reload authenticated.
  function showLoginOverlay() {
    if (document.getElementById('mv-login-overlay')) return
    const tr = (k, fallback) => (typeof window.t === 'function' ? window.t(k) : fallback) || fallback
    const overlay = document.createElement('div')
    overlay.id = 'mv-login-overlay'
    overlay.className = 'mv-auth-overlay'
    overlay.innerHTML =
      '<form class="mv-auth-card" id="mv-login-form">' +
        '<h2>' + tr('auth.login.title', 'Sign in') + '</h2>' +
        '<p class="mv-auth-desc">' + tr('auth.login.desc', 'Enter your dashboard username and password.') + '</p>' +
        '<input id="mv-login-user" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="' + tr('auth.login.username', 'Username') + '">' +
        '<input id="mv-login-pass" type="password" autocomplete="current-password" placeholder="' + tr('auth.login.password', 'Password') + '">' +
        '<button type="submit" id="mv-login-submit">' + tr('auth.login.submit', 'Sign in') + '</button>' +
        '<div class="mv-auth-err" id="mv-login-err"></div>' +
      '</form>'
    document.body.appendChild(overlay)
    const form = overlay.querySelector('#mv-login-form')
    const userEl = overlay.querySelector('#mv-login-user')
    const passEl = overlay.querySelector('#mv-login-pass')
    const errEl = overlay.querySelector('#mv-login-err')
    const submitEl = overlay.querySelector('#mv-login-submit')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      errEl.textContent = ''
      const username = (userEl.value || '').trim()
      const password = passEl.value || ''
      if (!username || !password) { errEl.textContent = tr('auth.login.err_empty', 'Enter a username and password.'); return }
      submitEl.disabled = true
      try {
        const r = await originalFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        if (r.ok) { window.location.reload(); return }
        if (r.status === 429) {
          let retry = 0
          try { retry = (await r.json()).retry_after_s || 0 } catch { /* ignore */ }
          errEl.textContent = tr('auth.login.err_throttled', 'Too many attempts. Try again later.') + (retry ? ' (' + retry + 's)' : '')
        } else {
          errEl.textContent = tr('auth.login.err_invalid', 'Invalid credentials.')
        }
      } catch {
        errEl.textContent = tr('auth.login.err_network', 'Network error.')
      } finally {
        submitEl.disabled = false
      }
    })
    setTimeout(() => userEl.focus(), 50)
  }

  // Full-screen, one-time token paste for installed PWAs (see the 401 handler).
  // The user pastes the access token (the value after ?token= in the server's
  // startup URL, or from the dashboard Settings / mobile-login QR); it is saved
  // to this app instance's localStorage and the page reloads authenticated.
  function showStandaloneTokenPrompt(tokenKey) {
    if (document.getElementById('mv-token-overlay')) return
    // Lang files are not yet loaded here; use a local inline lookup so EN mode works.
    const _lang = localStorage.getItem('marveen.lang') || 'hu'
    const _pwa = {
      hu: {
        title: 'Hozzáférés szükséges',
        desc: 'A home-screen app saját tárhelye még üres. Illeszd be a dashboard access tokent (a szerver indítási URL-jében a ?token= utáni rész, vagy a Beállítások / mobil-login QR), és elmentődik ehhez az apphoz.',
        btn: 'Mentés és újratöltés',
        empty_token: 'Üres token.'
      },
      en: {
        title: 'Access Required',
        desc: "The home-screen app's own storage is empty. Paste the dashboard access token (the part after ?token= in the server startup URL, or from Settings / mobile-login QR), and it will be saved for this app.",
        btn: 'Save & Reload',
        empty_token: 'Empty token.'
      }
    }
    const _p = _pwa[_lang] || _pwa.hu
    const overlay = document.createElement('div')
    overlay.id = 'mv-token-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1a1917;color:#faf9f5;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:system-ui,-apple-system,sans-serif'
    overlay.innerHTML =
      '<div style="max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px">' +
        '<h2 style="margin:0;font-size:18px;text-align:center">' + _p.title + '</h2>' +
        '<p style="margin:0;font-size:14px;opacity:0.8;line-height:1.5;text-align:center">' +
          _p.desc + '</p>' +
        '<textarea id="mv-token-input" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
          'style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #555;' +
          'background:#0f0e0d;color:#faf9f5;font-size:14px;font-family:monospace" placeholder="token..."></textarea>' +
        '<button id="mv-token-save" style="padding:12px;border:0;border-radius:8px;background:#10b981;' +
          'color:#fff;font-size:15px;font-weight:600">' + _p.btn + '</button>' +
        '<div id="mv-token-err" style="color:#f87171;font-size:13px;min-height:16px;text-align:center"></div>' +
      '</div>'
    document.body.appendChild(overlay)
    const input = overlay.querySelector('#mv-token-input')
    const errEl = overlay.querySelector('#mv-token-err')
    const submit = () => {
      const raw = (input.value || '').trim()
      if (!raw) { errEl.textContent = _p.empty_token; return }
      // Accept either a bare token or the whole startup URL (the user often
      // pastes the full https://host/?token=... link). Pull just the token out.
      let token = raw
      if (raw.includes('token=')) {
        let extracted = null
        try { extracted = new URL(raw).searchParams.get('token') } catch { /* not a full URL */ }
        if (!extracted) {
          // covers ?token=, &token=, and the hash form (/#...?token=...)
          const m = raw.match(/[?&#]token=([^&#\s]+)/)
          if (m) extracted = m[1]
        }
        if (extracted) { try { token = decodeURIComponent(extracted) } catch { token = extracted } }
      }
      token = token.trim()
      if (!token) { errEl.textContent = _p.empty_token; return }
      localStorage.setItem(tokenKey, token)
      window.location.reload()
    }
    overlay.querySelector('#mv-token-save').addEventListener('click', submit)
    setTimeout(() => input.focus(), 50)
  }
})()

// === Theme ===
const html = document.documentElement
const themeToggle = document.getElementById('themeToggle')
const savedTheme = localStorage.getItem('cc-theme')
if (savedTheme) {
  html.setAttribute('data-theme', savedTheme)
} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  html.setAttribute('data-theme', 'dark')
}
themeToggle.addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  html.setAttribute('data-theme', next)
  localStorage.setItem('cc-theme', next)
})

// === Language toggle ===
;(() => {
  const btn = document.getElementById('langToggle')
  if (!btn) return
  function syncLangBtn() {
    btn.textContent = getLang().toUpperCase()
  }
  syncLangBtn()
  btn.addEventListener('click', () => {
    setLang(getLang() === 'hu' ? 'en' : 'hu')
  })
  // Keep button in sync when language changes from any source (DASHBOARD_LANG, etc.).
  // onLangChange fires after setLang() and after the async DASHBOARD_LANG update.
  onLangChange(syncLangBtn)
})()

// === Page switching ===
// switchPage, registerPage, registerAlias are imported from web/modules/app-core.js.
// Page lifecycle hooks are registered at the bottom of this file, just before boot().

// ============================================================
// startActivityPoll, stopActivityPoll, loadActivity, loadOverview, initActivity imported from ./modules/overview.js

// Wire DnD (kanban-dnd.js) + modal helpers + ideas callback into the kanban module.
initKanban({ openModal, closeModal, wireColumn: wireKanbanColumnDnD, wireCardTouch: wireKanbanCardTouchDnD, loadIdeasPage })

// Wire modal helpers + DI callbacks into the agents module.
initAgents({
  openModal, closeModal, loadSkills,
  openTerminalModal, openConversationModal,
  setChatSelectedAgent,
})

// Wire modal helpers into the schedules module.
initSchedules({ openModal, closeModal })
initMemories({ openModal, closeModal })
initConnectors({ openModal, closeModal })
initSkills({ openModal, closeModal })
initSettings({ wireBranchDriftBanner })
// Wire branch-drift banner dismiss at startup (DOMContentLoaded moved to module eval in settings.js)
wireBranchDriftBanner()
initTokenUsage()
initActivity({ openTerminalModal })
initFederation({ openModal, closeModal })
initIdeas({ openModal, closeModal })
initAgentModals({ openModal, closeModal, loadAgents })
initStatusCosts()
initRecallBgTasks()

// === Helpers ===
function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  // textContent->innerHTML escapes & < > but NOT quotes. Encode quotes too so
  // the result is safe in ATTRIBUTE contexts as well as text nodes -- several
  // renderers interpolate escapeHtml() output into data-*/title/value="..."
  // attributes, where a surviving " would allow an attribute breakout.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeAttr(s) {
  return escapeHtml(String(s)).replace(/"/g, '&quot;')
}

// ============================================================
// === Költöztetés (Migration) ===
// ============================================================

let migrateFindings = []

async function loadMigrateAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('migrateAgent')
    sel.innerHTML = ''
    for (const a of agents) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.label || a.name
      sel.appendChild(opt)
    }
  } catch {}
}

// Step 1: Scan
document.getElementById('migrateScanBtn').addEventListener('click', async () => {
  const path = document.getElementById('migratePath').value.trim()
  if (!path) { document.getElementById('migratePath').focus(); return }

  const btn = document.getElementById('migrateScanBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/migrate/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: path }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')

    migrateFindings = data.findings
    renderMigrateFindings(data)

    document.getElementById('migrateStep1').hidden = true
    document.getElementById('migrateStep2').hidden = false
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

function renderMigrateFindings(data) {
  const findingsEl = document.getElementById('migrateFindings')
  const summaryEl = document.getElementById('migrateSummary')

  const typeIcons = {
    'personality': '\uD83C\uDFAD',
    'profile': '\uD83D\uDC64',
    'memory': '\uD83E\uDDE0',
    'memory-hot': '\uD83D\uDD25',
    'memory-warm': '\uD83C\uDF21\uFE0F',
    'memory-cold': '\u2744\uFE0F',
    'heartbeat': '\uD83D\uDC93',
    'config': '\u2699\uFE0F',
    'daily-log': '\uD83D\uDCCB',
    'schedule': '\u23F0',
  }
  const typeLabels = {
    'personality': () => t('migrate.type.personality'),
    'profile': () => t('migrate.type.profile'),
    'memory': () => t('migrate.type.memory'),
    'memory-hot': () => t('migrate.type.memory_hot'),
    'memory-warm': () => t('migrate.type.memory_warm'),
    'memory-cold': () => t('migrate.type.memory_cold'),
    'heartbeat': () => t('migrate.type.heartbeat'),
    'config': () => t('migrate.type.config'),
    'daily-log': () => t('migrate.type.daily_log'),
    'schedule': () => t('migrate.type.schedule'),
  }

  findingsEl.innerHTML = ''
  for (const f of data.findings) {
    const div = document.createElement('div')
    div.className = 'migrate-finding'
    const sizeKB = Math.round(f.size / 1024 * 10) / 10
    div.innerHTML = `
      <span class="migrate-finding-icon">${typeIcons[f.type] || '\uD83D\uDCC4'}</span>
      <div class="migrate-finding-info">
        <div class="migrate-finding-name">${escapeHtml(f.name)}</div>
        <div class="migrate-finding-type">${(typeof typeLabels[f.type] === 'function' ? typeLabels[f.type]() : typeLabels[f.type]) || f.type}</div>
      </div>
      <span class="migrate-finding-size">${sizeKB} KB</span>
    `
    findingsEl.appendChild(div)
  }

  if (data.findings.length === 0) {
    findingsEl.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">${t('migrate.empty')}</div>`
  }

  const s = data.summary
  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-value">${s.total}</div><div class="stat-label">${t('migrate.stat.total')}</div></div>
    <div class="stat-card"><div class="stat-value">${s.memory}</div><div class="stat-label">${t('migrate.stat.memory')}</div></div>
    <div class="stat-card"><div class="stat-value">${s.personality + s.profile}</div><div class="stat-label">${t('migrate.stat.profile')}</div></div>
    <div class="stat-card"><div class="stat-value">${s.config + s.heartbeat}</div><div class="stat-label">${t('migrate.stat.config')}</div></div>
  `
}

// Back button
document.getElementById('migrateBackBtn').addEventListener('click', () => {
  document.getElementById('migrateStep1').hidden = false
  document.getElementById('migrateStep2').hidden = true
})

// Step 2: Run migration
document.getElementById('migrateRunBtn').addEventListener('click', async () => {
  const agentId = document.getElementById('migrateAgent').value
  const btn = document.getElementById('migrateRunBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/migrate/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findings: migrateFindings, agentId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')

    // Show results
    document.getElementById('migrateStep2').hidden = true
    document.getElementById('migrateStep3').hidden = false

    const resultEl = document.getElementById('migrateResult')
    resultEl.innerHTML = `
      <h4>${t('migrate.result.title')}</h4>
      <div class="migrate-result-stats">
        <div class="migrate-result-stat"><div class="migrate-result-stat-value">${data.imported}</div><div class="migrate-result-stat-label">${t('migrate.result.imported')}</div></div>
        <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#dc3c3c">${data.stats.hot}</div><div class="migrate-result-stat-label">Hot</div></div>
        <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#d97757">${data.stats.warm}</div><div class="migrate-result-stat-label">Warm</div></div>
        <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#6a9bcc">${data.stats.cold}</div><div class="migrate-result-stat-label">Cold</div></div>
        <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#9a8a30">${data.stats.shared}</div><div class="migrate-result-stat-label">Shared</div></div>
      </div>
      ${data.details ? '<div class="migrate-result-details">' + data.details.map(d => escapeHtml(d)).join('<br>') + '</div>' : ''}
    `
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// New migration
document.getElementById('migrateNewBtn').addEventListener('click', () => {
  document.getElementById('migrateStep1').hidden = false
  document.getElementById('migrateStep2').hidden = true
  document.getElementById('migrateStep3').hidden = true
})

// ============================================================
// === Fleet Migration ===
// ============================================================

// Holds the last successfully parsed fleet JSON text (for apply after dry-run)
let fleetLastBody = null

document.getElementById('fleetExportBtn').addEventListener('click', async () => {
  const btn = document.getElementById('fleetExportBtn')
  const password = document.getElementById('fleetExportPassword').value.trim()

  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const headers = {}
    if (password) headers['X-Vault-Password'] = password

    const res = await fetch('/api/fleet/export', { headers })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || t('fleet.export.error'))
      return
    }

    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') || ''
    const nameMatch = cd.match(/filename="?([^";\s]+)"?/)
    const filename = nameMatch ? nameMatch[1] : `fleet-export-${new Date().toISOString().slice(0, 10)}.json`

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)

    showToast(t('fleet.export.success'))
  } catch (err) {
    showToast(`${t('fleet.export.error')}: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('fleetDryRunBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('fleetImportFile')
  if (!fileInput.files.length) {
    showToast(t('fleet.import.no_file'))
    return
  }

  const btn = document.getElementById('fleetDryRunBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  const applyBtn = document.getElementById('fleetApplyBtn')
  applyBtn.disabled = true
  fleetLastBody = null

  const resultEl = document.getElementById('fleetDryRunResult')
  resultEl.hidden = true
  resultEl.innerHTML = ''

  try {
    const text = await fileInput.files[0].text()
    // Validate JSON client-side first
    try { JSON.parse(text) } catch { showToast(t('fleet.import.invalid_json')); return }

    const password = document.getElementById('fleetImportPassword').value.trim()
    const headers = { 'Content-Type': 'application/json' }
    if (password) headers['X-Vault-Password'] = password

    const res = await fetch('/api/fleet/import', { method: 'POST', headers, body: text })
    const data = await res.json()

    const wc = data.wouldCreate || {}
    const hasErrors = data.errors && data.errors.length > 0
    const hasWarnings = data.warnings && data.warnings.length > 0

    resultEl.className = `fleet-dry-run-result ${hasErrors ? 'has-errors' : 'ok'}`
    resultEl.hidden = false

    const agentNames = Array.isArray(wc.agents) ? wc.agents : []
    const agentLabel = agentNames.length
      ? `${agentNames.length} (${agentNames.join(', ')})`
      : '0'

    resultEl.innerHTML = `
      <div class="fleet-dry-run-title">${hasErrors ? '❌ ' + t('fleet.import.dryrun_errors') : '✅ ' + t('fleet.import.dryrun_ok')}</div>
      ${!hasErrors ? `
      <div class="fleet-dry-run-grid">
        <div class="fleet-dry-run-stat">
          <div class="fleet-dry-run-stat-value">${wc.mainAgent ? '✓' : '—'}</div>
          <div class="fleet-dry-run-stat-label">${t('fleet.stat.main_agent')}</div>
        </div>
        <div class="fleet-dry-run-stat">
          <div class="fleet-dry-run-stat-value">${agentNames.length}</div>
          <div class="fleet-dry-run-stat-label">${t('fleet.stat.agents')}</div>
        </div>
        <div class="fleet-dry-run-stat">
          <div class="fleet-dry-run-stat-value">${wc.memories ?? 0}</div>
          <div class="fleet-dry-run-stat-label">${t('fleet.stat.memories')}</div>
        </div>
        <div class="fleet-dry-run-stat">
          <div class="fleet-dry-run-stat-value">${wc.kanbanCards ?? 0}</div>
          <div class="fleet-dry-run-stat-label">${t('fleet.stat.kanban')}</div>
        </div>
        <div class="fleet-dry-run-stat">
          <div class="fleet-dry-run-stat-value">${wc.globalSkills ?? 0}</div>
          <div class="fleet-dry-run-stat-label">${t('fleet.stat.skills')}</div>
        </div>
        <div class="fleet-dry-run-stat">
          <div class="fleet-dry-run-stat-value">${wc.scheduledTasks ?? 0}</div>
          <div class="fleet-dry-run-stat-label">${t('fleet.stat.tasks')}</div>
        </div>
      </div>
      ${agentNames.length ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${t('fleet.stat.agent_names')}: ${escapeHtml(agentNames.join(', '))}</div>` : ''}
      ` : ''}
      ${hasErrors ? `<div class="fleet-dry-run-errors">${data.errors.map(e => escapeHtml(e)).join('<br>')}</div>` : ''}
      ${hasWarnings ? `<div class="fleet-dry-run-warnings">⚠️ ${data.warnings.map(w => escapeHtml(w)).join('<br>')}</div>` : ''}
    `

    if (!hasErrors) {
      fleetLastBody = text
      applyBtn.disabled = false
    }
  } catch (err) {
    showToast(`${t('fleet.import.error')}: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('fleetApplyBtn').addEventListener('click', async () => {
  if (!fleetLastBody) return

  if (!confirm(t('fleet.import.apply_confirm'))) return

  const btn = document.getElementById('fleetApplyBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  const resultEl = document.getElementById('fleetDryRunResult')

  try {
    const password = document.getElementById('fleetImportPassword').value.trim()
    const headers = { 'Content-Type': 'application/json' }
    if (password) headers['X-Vault-Password'] = password

    const res = await fetch('/api/fleet/import?apply=true', { method: 'POST', headers, body: fleetLastBody })
    const data = await res.json()

    if (!res.ok) throw new Error(data.error || t('fleet.import.error'))

    const imp = data.imported || {}
    const agentNames = Array.isArray(imp.agents) ? imp.agents : []

    resultEl.className = 'fleet-apply-result'
    resultEl.hidden = false
    resultEl.innerHTML = `
      <div class="fleet-apply-result-title">✅ ${t('fleet.import.apply_success')}</div>
      <div>
        ${imp.mainAgent ? `<div>${t('fleet.stat.main_agent')}: ✓</div>` : ''}
        ${agentNames.length ? `<div>${t('fleet.stat.agents')}: ${escapeHtml(agentNames.join(', '))}</div>` : ''}
        <div>${t('fleet.stat.memories')}: ${imp.memories ?? 0}</div>
        <div>${t('fleet.stat.kanban')}: ${imp.kanbanCards ?? 0}</div>
        <div>${t('fleet.stat.skills')}: ${imp.globalSkills ?? 0}</div>
        <div>${t('fleet.stat.tasks')}: ${imp.scheduledTasks ?? 0}</div>
      </div>
    `

    fleetLastBody = null
    btn.disabled = true
  } catch (err) {
    showToast(`${t('fleet.import.error')}: ${err.message}`)
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  } finally {
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// loadOverview, formatRelative, fmtTokensShort moved to web/modules/overview.js (S-13a)

// Brand mark + product-brand chrome: pull the configured brand from
// /api/marveen and apply it to the dashboard chrome (tab title, mobile topbar,
// sidebar name, updates subtitle). brandName is the product/system name and is
// distinct from the main agent's display name; the backend defaults brandName to
// BOT_NAME, so a brand-unaware install keeps showing the agent name. If the
// field is absent (legacy backend) the existing HTML default text is kept.
async function initSidebarBrand() {
  try {
    const img = document.createElement('img')
    img.src = '/api/marveen/avatar' + avatarBust()
    img.onload = () => {
      const mark = document.getElementById('sidebarBrandMark')
      if (mark) { mark.textContent = ''; mark.appendChild(img) }
    }
    const res = await fetch('/api/marveen')
    if (res.ok) {
      const m = await res.json()
      const brand = m.brandName || m.name
      // Publish the brand tokens so every t() call ({brand}/{bot}/{agentId})
      // renders the configured names, then re-apply the static i18n so any
      // label painted before this fetch resolved picks up the real brand.
      window._brandTokens = {
        brand: brand || 'Marveen',
        bot: m.name || brand || 'Marveen',
        agentId: m.agentId || 'marveen',
      }
      renderStaticI18n()
      if (brand) {
        document.title = brand
        const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]')
        if (appleTitle) appleTitle.setAttribute('content', brand)
        const topbar = document.getElementById('mobileTopbarTitle')
        if (topbar) topbar.textContent = brand
        const name = document.getElementById('sidebarBrandName')
        if (name) name.textContent = brand
        const subtitle = document.getElementById('updatesSubtitle')
        if (subtitle) subtitle.textContent = `${brand} ` + t('overview.updates_subtitle')
      }
    }
  } catch {}
}
initSidebarBrand()

// In an installed (standalone) PWA, lock the zoom: iOS otherwise auto-zooms when
// a small-text input is focused and allows stray pinch-zoom, neither of which
// suits an app-like control panel. Left untouched in a normal browser tab so
// page zoom / accessibility still work there.
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
  const vp = document.querySelector('meta[name="viewport"]')
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover')
}

// === Updates page ===
function escapeHtmlUpdates(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderUpdatesBadge(status) {
  const badge = document.getElementById('updatesBadge')
  if (!badge) return
  // Version-centric: show the number of NEW VERSIONS, not raw commits. Fall back
  // to the behind count only in the rare pre-release state (unreleased commits
  // but no new version tag yet).
  const versionCount = status && Array.isArray(status.releases)
    ? status.releases.filter((r) => r.version).length : 0
  const count = versionCount > 0 ? versionCount : ((status && status.behind) || 0)
  if (count > 0) {
    badge.textContent = String(count)
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

// === Branch-drift warning ===
// Installs that landed on a non-main branch (e.g. a branchless clone before
// the --branch main pin) keep receiving unreleased code from update.sh, which
// pulls the tracked branch. Two surfaces, both non-blocking: a dismissible
// top banner (dismissal persists per browser AND per branch, so a later switch
// to yet another branch re-warns) and a permanent notice on the Updates page.
// Dev machines follow develop on purpose; one dismissal silences the banner
// for them while the Updates-page notice stays as the quiet ground truth.
const BRANCH_DRIFT_DISMISS_PREFIX = 'marveen.branch-drift-dismissed.'
const BRANCH_HEAL_COMMAND = 'git checkout main && bash update.sh'

function branchDriftDismissed(branch) {
  try { return localStorage.getItem(BRANCH_DRIFT_DISMISS_PREFIX + branch) === '1' } catch { return false }
}

function updateBranchDriftUI(status) {
  const banner = document.getElementById('branchDriftBanner')
  if (!banner) return
  const branch = status && status.branch
  const drifted = !!branch && branch !== 'main'
  if (!drifted || branchDriftDismissed(branch)) {
    banner.hidden = true
    return
  }
  const textEl = document.getElementById('branchDriftBannerText')
  if (textEl) {
    textEl.innerHTML =
      `${t('branch_drift.banner.text', { branch: `<strong>${escapeHtmlUpdates(branch)}</strong>` })} ` +
      `<code>${BRANCH_HEAL_COMMAND}</code>`
  }
  banner.hidden = false
}

function wireBranchDriftBanner() {
  const dismiss = document.getElementById('branchDriftDismiss')
  if (!dismiss) return
  dismiss.addEventListener('click', () => {
    const banner = document.getElementById('branchDriftBanner')
    const branch = (window._updatesStatus && window._updatesStatus.branch) || ''
    try { if (branch) localStorage.setItem(BRANCH_DRIFT_DISMISS_PREFIX + branch, '1') } catch { /* storage blocked */ }
    if (banner) banner.hidden = true
  })
}

function renderBranchNotice(status) {
  const el = document.getElementById('updatesBranchNotice')
  if (!el) return
  const branch = status && status.branch
  if (!branch) { el.hidden = true; return }
  if (branch === 'main') {
    el.className = 'updates-branch-notice ok'
    el.innerHTML = `${t('branch_drift.notice.on_main')} (<code>main</code>)`
  } else {
    el.className = 'updates-branch-notice warn'
    el.innerHTML =
      `${t('branch_drift.notice.off_main', { branch: `<code>${escapeHtmlUpdates(branch)}</code>` })}<br>` +
      `${t('branch_drift.notice.heal')} <code>${BRANCH_HEAL_COMMAND}</code>`
  }
  el.hidden = false
}

async function pollUpdatesBadge() {
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) return
    const data = await res.json()
    window._updatesStatus = data
    renderUpdatesBadge(data)
    updateBranchDriftUI(data)
  } catch {}
}

async function loadUpdates() {
  const summary = document.getElementById('updatesSummary')
  const list = document.getElementById('updatesCommitList')
  const applyBtn = document.getElementById('updatesApplyBtn')
  summary.textContent = t('updates.checking')
  summary.className = 'updates-summary'
  list.innerHTML = ''
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    window._updatesStatus = data
    renderUpdatesBadge(data)
    updateBranchDriftUI(data)
    renderBranchNotice(data)
    const cur = (data.current || '').slice(0, 7) || '–'
    const lat = (data.latest || '').slice(0, 7) || '–'
    if (data.error) {
      summary.className = 'updates-summary error'
      summary.innerHTML = `<strong>${t('updates.check_failed')}:</strong> ${escapeHtmlUpdates(data.error)}<br>${t('updates.current_label')} <code>${cur}</code>`
      applyBtn.hidden = true
    } else if (data.behind === 0) {
      summary.className = 'updates-summary up-to-date'
      summary.innerHTML = `<strong>${t('updates.up_to_date_html')}</strong> (<code>${cur}</code>). ${t('updates.no_changes')}`
      applyBtn.hidden = true
    } else {
      summary.className = 'updates-summary behind'
      const versions = (data.releases || []).filter((r) => r.version)
      if (versions.length > 0) {
        // Version-centric: "N uj verzio elerheto (v1.21.0)".
        summary.innerHTML = `<strong>${t('updates.versions_available', { n: versions.length })}</strong> <code>${escapeHtmlUpdates(versions[0].version)}</code>`
      } else {
        // Pre-release: unreleased commits but no new version tag yet.
        summary.innerHTML = `<strong>${t('updates.changes_available')}</strong> ${t('updates.available_on', { remote: `<code>${escapeHtmlUpdates(data.remote)}</code>` })}`
      }
      applyBtn.hidden = false
    }
    const commitCard = (c) => `
        <div class="updates-commit">
          <div class="updates-commit-head">
            <span>${escapeHtmlUpdates(c.short)} · ${escapeHtmlUpdates(c.author)}</span>
            <span>${escapeHtmlUpdates((c.date || '').slice(0, 10))}</span>
          </div>
          <div class="updates-commit-msg">${escapeHtmlUpdates(c.message)}</div>
        </div>`
    if (data.releases && data.releases.length) {
      // Version-centric: the human-language summary per version is the primary
      // content; the raw commit list (SHAs, conventional-commit prefixes, author
      // names) is tucked behind a collapsed "details" so it is never the first
      // thing the operator sees.
      list.innerHTML = data.releases.map((rel) => {
        const isUpcoming = !rel.version
        const label = isUpcoming ? t('updates.group.upcoming') : escapeHtmlUpdates(rel.version)
        const human = rel.summary
          ? escapeHtmlUpdates(rel.summary)
          : (isUpcoming ? t('updates.upcoming_note') : '')
        return `
        <div class="updates-version">
          <div class="updates-version-tag">${label}</div>
          ${human ? `<div class="updates-version-summary">${human}</div>` : ''}
          <details class="updates-version-details">
            <summary>${t('updates.details', { n: rel.commits.length })}</summary>
            <div class="updates-commit-list">${rel.commits.map(commitCard).join('')}</div>
          </details>
        </div>`
      }).join('')
    } else if (data.commits && data.commits.length) {
      list.innerHTML = data.commits.map(commitCard).join('')
    } else if (data.behind === 0) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('updates.no_changes')}</p>`
    }
  } catch (err) {
    summary.className = 'updates-summary error'
    summary.textContent = 'Hiba: ' + (err.message || err)
    applyBtn.hidden = true
  }
  renderDiagnoseOffer()
}

// Post-rollback diagnosis offer (PR-D). Reads /api/updates/status: if the last
// update failed/rolled-back and this host can run a Claude agent, offer the
// opt-in fixer; if it cannot (AVX), show a manual-intervention note instead.
async function renderDiagnoseOffer() {
  const box = document.getElementById('updatesDiagnose')
  if (!box) return
  let data
  try { data = await (await fetch('/api/updates/status')).json() } catch { box.hidden = true; return }
  if (data.needsHuman) {
    box.hidden = false
    box.className = 'updates-diagnose needs-human'
    box.innerHTML = `<strong>${escapeHtmlUpdates(t('updates.diagnose.title'))}</strong><p>${escapeHtmlUpdates(t('updates.diagnose.needs_human'))}</p>`
    return
  }
  if (!data.canDiagnose) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.className = 'updates-diagnose'
  box.innerHTML = `<strong>${escapeHtmlUpdates(t('updates.diagnose.title'))}</strong>`
    + `<p>${escapeHtmlUpdates(t('updates.diagnose.body'))}</p>`
    + `<button class="btn-secondary btn-compact" id="updatesDiagnoseBtn">${escapeHtmlUpdates(t('updates.diagnose.btn'))}</button>`
  document.getElementById('updatesDiagnoseBtn').addEventListener('click', runDiagnose)
}

async function runDiagnose() {
  if (!confirm(t('updates.diagnose.consent'))) return
  const btn = document.getElementById('updatesDiagnoseBtn')
  if (btn) btn.disabled = true
  try {
    const res = await fetch('/api/updates/diagnose', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (btn) btn.disabled = false
      showToast(t('updates.diagnose.failed', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(data.already ? t('updates.diagnose.already') : t('updates.diagnose.started'))
    if (btn) { btn.hidden = true }
  } catch (err) {
    if (btn) btn.disabled = false
    showToast(t('updates.diagnose.failed', { msg: err.message || err }))
  }
}

document.getElementById('updatesCheckBtn').addEventListener('click', async () => {
  const btn = document.getElementById('updatesCheckBtn')
  btn.disabled = true
  try { await fetch('/api/updates/check', { method: 'POST' }) } catch {}
  await loadUpdates()
  btn.disabled = false
})

async function runUpdate(autoStash) {
  const btn = document.getElementById('updatesApplyBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false
  const resetBtn = () => {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
  try {
    const res = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStash: autoStash === true }),
    })
    // Parse the body regardless of status so preflight reasons
    // (not-on-main / dirty-tree / detached-head returned as 409 by
    // the backend) land in the toast instead of a bare "HTTP 409".
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      resetBtn()
      // dirty-tree without autoStash: offer the auto-stash retry inline.
      if (data.reason === 'dirty-tree' && !autoStash) {
        if (confirm(t('updates.confirm.stash'))) {
          await runUpdate(true)
        }
        return
      }
      showToast(t('updates.toast.not_started', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(t('updates.toast.applying'))
    // Poll the real outcome instead of a blind timed reload. update.sh (and its
    // detached finalizer) write store/update.last-result on exit, so we surface
    // success / rolled-back / failed rather than a false "done" that reloads
    // into an unchanged (or dead) dashboard.
    await pollUpdateOutcome(resetBtn)
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', {msg: err.message || err}))
  }
}

// Poll /api/updates/status until the run finishes (pidfile gone AND a fresh
// result is present), then show the true outcome. Reload only on success.
async function pollUpdateOutcome(resetBtn) {
  const startedAt = Date.now()
  const deadline = startedAt + 5 * 60_000   // hard cap: 5 min
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    let data
    try {
      const res = await fetch('/api/updates/status')
      data = await res.json()
    } catch {
      // Dashboard is mid-restart (expected): keep polling.
      continue
    }
    const result = data && data.result
    const fresh = result && typeof result.ts === 'number' && result.ts * 1000 >= startedAt - 5000
    if (data && !data.running && fresh) {
      const st = result.status
      if (st === 'success') {
        showToast(t('updates.toast.success', { old: result.old || '', new: result.new || '' }))
        setTimeout(() => window.location.reload(), 2000)
        return
      }
      if (st === 'rolled-back') {
        if (resetBtn) resetBtn()
        showToast(t('updates.toast.rolled_back', { old: result.old || '', msg: result.message || '' }))
        renderDiagnoseOffer()
        return
      }
      // failed
      if (resetBtn) resetBtn()
      showToast(t('updates.toast.failed', { phase: result.phase || '?', msg: result.message || ('code ' + result.code) }))
      renderDiagnoseOffer()
      return
    }
  }
  if (resetBtn) resetBtn()
  showToast(t('updates.toast.status_timeout'))
}

document.getElementById('updatesApplyBtn').addEventListener('click', async () => {
  if (!confirm(t('updates.confirm.apply'))) return
  await runUpdate(false)
})

// Poll the badge on startup and every 5 min so the nav link reflects
// the cached status even on tabs other than the Updates page.
pollUpdatesBadge()
setInterval(pollUpdatesBadge, 5 * 60_000)

// === First-run onboarding wizard ===
// Full-screen overlay shown when /api/onboarding/status reports the install
// still needs setup (pre-install-now / configure-later flow). Steps 2-3 reuse
// the existing channel-setup + pairing backend endpoints.
async function fetchOnboardingStatus() {
  try { return await (await fetch('/api/onboarding/status')).json() } catch { return null }
}
function onboardingCurrentStep(s) {
  if (!s.identityConfirmed) return 1
  if (!s.claudeAuthPresent || !s.agentsRunning) return 2
  if (!s.channelConfigured) return 3
  if (!s.paired) return 4
  return 0
}
// Operator can dismiss the wizard (skip/close). A false positive must never
// lock the dashboard, so the choice persists across reloads; normal UI still
// covers any real setup that remains.
const ONBOARDING_DISMISS_KEY = 'mvOnboardingDismissed'
function onboardingDismissed() {
  try { return localStorage.getItem(ONBOARDING_DISMISS_KEY) === '1' } catch { return false }
}
function dismissOnboarding() {
  try { localStorage.setItem(ONBOARDING_DISMISS_KEY, '1') } catch { /* private mode */ }
  const overlay = document.getElementById('onboardingOverlay')
  if (overlay) { overlay.classList.remove('active'); overlay.hidden = true }
  document.body.style.overflow = ''
}
async function initOnboarding() {
  if (onboardingDismissed()) return
  const s = await fetchOnboardingStatus()
  if (!s || !s.needsOnboarding) return
  renderOnboarding(s)
}
async function refreshOnboarding() {
  const s = await fetchOnboardingStatus()
  if (s) renderOnboarding(s)
}
function renderOnboarding(s) {
  if (onboardingDismissed()) return
  const overlay = document.getElementById('onboardingOverlay')
  if (!overlay) return
  const step = onboardingCurrentStep(s)
  if (step === 0) { overlay.classList.remove('active'); overlay.hidden = true; document.body.style.overflow = ''; return }
  overlay.hidden = false
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
  document.querySelectorAll('#onboardingSteps .onboarding-step').forEach((el) => {
    const n = Number(el.dataset.ostep)
    el.classList.toggle('active', n === step)
    el.classList.toggle('done', n < step)
  })
  const body = document.getElementById('onboardingBody')
  if (step === 1) body.innerHTML = onbIdentityHtml(s)
  else if (step === 2) body.innerHTML = onbStep1Html(s)
  else if (step === 3) body.innerHTML = onbStep2Html()
  else body.innerHTML = onbStep3Html()
  wireOnboarding(step)
}
function onbMsg(text, isErr) {
  const el = document.getElementById('onbMsg')
  if (el) { el.textContent = text; el.className = 'onb-msg' + (isErr ? ' err' : ' ok') }
}
function onbIdentityHtml(s) {
  return `<p>${escapeHtml(t('onboarding.identity.desc'))}</p>`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.identity.agent_label'))}</label>`
    + `<input id="onbAgentName" type="text" class="onb-input" maxlength="40" value="${escapeHtml(s.currentAgentName || '')}" autocomplete="off">`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.identity.owner_label'))}</label>`
    + `<input id="onbOwnerName" type="text" class="onb-input" maxlength="60" value="${escapeHtml(s.currentOwnerName || '')}" autocomplete="off">`
    + `<div class="onb-hint">${escapeHtml(t('onboarding.identity.hint'))}</div>`
    + `<button class="btn-primary btn-compact" id="onbIdentityBtn">${escapeHtml(t('onboarding.identity.save_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function onbStep1Html(s) {
  return `<p>${escapeHtml(t('onboarding.step1.desc'))}</p>`
    + (s.claudeAuthPresent
      ? `<p class="onb-ok-line">${escapeHtml(t('onboarding.step1.auth_done'))}</p>`
      : `<label class="form-label-sm">${escapeHtml(t('onboarding.step1.token_label'))}</label>`
        + `<input id="onbToken" type="password" class="onb-input" placeholder="sk-ant-oat01-..." autocomplete="off">`
        + `<div class="onb-hint">${escapeHtml(t('onboarding.step1.token_hint'))}</div>`
        + `<button class="btn-primary btn-compact" id="onbAuthBtn">${escapeHtml(t('onboarding.step1.save_btn'))}</button>`)
    + (s.claudeAuthPresent && !s.agentsRunning
      ? `<button class="btn-primary btn-compact" id="onbLaunchBtn">${escapeHtml(t('onboarding.step1.launch_btn'))}</button>`
      : '')
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function onbStep2Html() {
  return `<p>${escapeHtml(t('onboarding.step2.desc'))}</p>`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.step2.token_label'))}</label>`
    + `<input id="onbBotToken" type="password" class="onb-input" placeholder="123456:ABC..." autocomplete="off">`
    + `<div class="onb-hint">${escapeHtml(t('onboarding.step2.token_hint'))}</div>`
    + `<button class="btn-primary btn-compact" id="onbBotBtn">${escapeHtml(t('onboarding.step2.save_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function onbStep3Html() {
  return `<p>${escapeHtml(t('onboarding.step3.desc'))}</p>`
    + `<ol class="onb-list"><li>${escapeHtml(t('onboarding.step3.li1'))}</li><li>${escapeHtml(t('onboarding.step3.li2'))}</li></ol>`
    + `<div id="onbPending" class="onb-pending"></div>`
    + `<button class="btn-secondary btn-compact" id="onbRefreshBtn">${escapeHtml(t('onboarding.step3.refresh_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function wireOnboarding(step) {
  if (step === 1) {
    const idBtn = document.getElementById('onbIdentityBtn')
    if (idBtn) idBtn.addEventListener('click', async () => {
      const agentName = (document.getElementById('onbAgentName').value || '').trim()
      const ownerName = (document.getElementById('onbOwnerName').value || '').trim()
      if (!agentName || !ownerName) { onbMsg(t('onboarding.identity.empty'), true); return }
      idBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch('/api/onboarding/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentName, ownerName }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { idBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.identity.saved'))
        await refreshOnboarding()
      } catch (e) { idBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
    return
  }
  if (step === 2) {
    const authBtn = document.getElementById('onbAuthBtn')
    if (authBtn) authBtn.addEventListener('click', async () => {
      const token = (document.getElementById('onbToken').value || '').trim()
      if (!token) { onbMsg(t('onboarding.step1.token_empty'), true); return }
      authBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch('/api/onboarding/claude-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { authBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(d.verified ? t('onboarding.step1.saved_verified') : t('onboarding.step1.saved_unverified'))
        await refreshOnboarding()
      } catch (e) { authBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
    const launchBtn = document.getElementById('onbLaunchBtn')
    if (launchBtn) launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true; onbMsg(t('onboarding.step1.launching'))
      try {
        const res = await fetch('/api/onboarding/launch', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { launchBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.step1.launched'))
        setTimeout(refreshOnboarding, 2500)
      } catch (e) { launchBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
  } else if (step === 3) {
    const botBtn = document.getElementById('onbBotBtn')
    if (botBtn) botBtn.addEventListener('click', async () => {
      const botToken = (document.getElementById('onbBotToken').value || '').trim()
      if (!botToken) { onbMsg(t('onboarding.step2.token_empty'), true); return }
      botBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(mainAgentId())}/channels/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botToken }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { botBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.step2.saved'))
        setTimeout(refreshOnboarding, 2000)
      } catch (e) { botBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
  } else if (step === 4) {
    const refreshBtn = document.getElementById('onbRefreshBtn')
    const loadPending = async () => {
      try {
        const p = await (await fetch(`/api/agents/${encodeURIComponent(mainAgentId())}/channels/telegram/pending`)).json()
        // Backend contract: [{code, senderId, chatId, createdAt, expiresAt}].
        // `code` is the approve key (the same code the bot sent the user) --
        // POSTing anything else gets a 400 and the pairing never completes.
        const now = Date.now()
        const list = (Array.isArray(p) ? p : (p.pending || [])).filter((x) => x && x.code && (!x.expiresAt || x.expiresAt > now))
        const box = document.getElementById('onbPending')
        if (!box) return
        if (!list.length) { box.innerHTML = `<span class="onb-hint">${escapeHtml(t('onboarding.step3.no_pending'))}</span>`; return }
        box.innerHTML = list.map((x) => {
          const code = escapeHtml(String(x.code))
          const label = escapeHtml(String(x.senderId || x.chatId || '?')) + ' · ' + code
          return `<div class="onb-pending-row"><span>${label}</span><button class="btn-primary btn-compact onb-approve" data-code="${code}">${escapeHtml(t('onboarding.step3.approve_btn'))}</button></div>`
        }).join('')
        box.querySelectorAll('.onb-approve').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true
          try {
            const res = await fetch(`/api/agents/${encodeURIComponent(mainAgentId())}/channels/telegram/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: b.dataset.code }) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) { b.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
            onbMsg(t('onboarding.step3.approved'))
            setTimeout(refreshOnboarding, 1500)
          } catch (e) { b.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
        }))
      } catch { /* ignore */ }
    }
    if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshOnboarding() })
    loadPending()
  }
}

// === Init ===
populateAvatarGrid()
loadMemAgents()
loadOverview()
loadAvailableModels()
{
  const onbClose = document.getElementById('onboardingClose')
  if (onbClose) onbClose.addEventListener('click', dismissOnboarding)
}
initOnboarding()

// "DeepSeek API kulcs hozzáadása" link az agent edit panel-en --
// a Vault page-re visz, ahol a felhasználó egy DEEPSEEK_API_KEY
// secret-et tud felvenni, és visszatérve frissítjük a model listát.
document.getElementById('deepseekConfigLink')?.addEventListener('click', (e) => {
  e.preventDefault()
  location.hash = 'vault'
})

// === Sudo modal for managed-settings.json (Slack setup pre-flight) ===
function showSudoModal(sudoCommand) {
  let overlay = document.getElementById('sudoModalOverlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'sudoModalOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:560px;width:90%'
  card.innerHTML = `
    <h3 style="margin:0 0 12px">${t('channel.sudo_modal.title')}</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px">${t('channel.sudo_modal.desc')}</p>
    <div style="position:relative">
      <pre id="sudoCmdPre" style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(sudoCommand)}</pre>
      <button id="sudoCopyBtn" style="position:absolute;top:6px;right:6px;padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer">${t('common.copy')}</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button id="sudoCancelBtn" class="btn btn-secondary" style="padding:6px 16px;font-size:13px">${t('channel.sudo_modal.cancel')}</button>
      <button id="sudoDoneBtn" class="btn btn-primary" style="padding:6px 16px;font-size:13px">${t('channel.sudo_modal.retry')}</button>
    </div>
  `
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  document.getElementById('sudoCopyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(sudoCommand).then(() => {
      document.getElementById('sudoCopyBtn').textContent = t('common.copied')
      setTimeout(() => { document.getElementById('sudoCopyBtn').textContent = t('common.copy') }, 1500)
    })
  })
  document.getElementById('sudoCancelBtn').addEventListener('click', () => overlay.remove())
  document.getElementById('sudoDoneBtn').addEventListener('click', () => {
    overlay.remove()
    document.getElementById('chConnectBtn').click()
  })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

// === Clipboard fallback (non-secure context / legacy browser) ===
function fallbackCopyToClipboard(text, btn) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    const ok = document.execCommand('copy')
    if (ok) {
      btn.textContent = t('common.copied')
      setTimeout(() => { btn.textContent = t('common.copy') }, 1500)
    } else {
      showToast(t('common.toast.copy_failed'))
    }
  } catch {
    showToast(t('common.toast.copy_failed'))
  }
  document.body.removeChild(ta)
}

// === Slack App manifest modal ===
function showSlackManifestModal(manifest, instructions) {
  let overlay = document.getElementById('slackManifestOverlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'slackManifestOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:640px;width:95%;max-height:85vh;overflow-y:auto'

  const stepsHtml = instructions.map((s, i) => `<li style="margin-bottom:6px">${escapeHtml(s)}</li>`).join('')

  card.innerHTML = `
    <h3 style="margin:0 0 16px">${t('channel.slack_manifest.title')}</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">${t('channel.slack_manifest.desc')}</p>
    <div style="position:relative;margin-bottom:16px">
      <pre id="slackManifestPre" style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow-y:auto">${escapeHtml(manifest)}</pre>
      <button id="slackManifestCopyBtn" style="position:absolute;top:6px;right:6px;padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer">${t('common.copy')}</button>
    </div>
    <h4 style="margin:0 0 8px;font-size:14px">${t('channel.slack_manifest.steps_title')}</h4>
    <ol style="font-size:13px;padding-left:20px;margin:0 0 16px">${stepsHtml}</ol>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="slackManifestCloseBtn" class="btn btn-secondary" style="padding:6px 16px;font-size:13px">${t('common.btn.close')}</button>
      <a href="https://api.slack.com/apps" target="_blank" rel="noopener" class="btn btn-primary" style="padding:6px 16px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:4px">
        ${t('channel.slack_manifest.open_btn')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
    </div>
  `
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  document.getElementById('slackManifestCopyBtn').addEventListener('click', () => {
    const copyBtn = document.getElementById('slackManifestCopyBtn')
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifest).then(() => {
        copyBtn.textContent = t('common.copied')
        setTimeout(() => { copyBtn.textContent = t('common.copy') }, 1500)
      }).catch(() => {
        fallbackCopyToClipboard(manifest, copyBtn)
      })
    } else {
      fallbackCopyToClipboard(manifest, copyBtn)
    }
  })
  document.getElementById('slackManifestCloseBtn').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

document.getElementById('chSlackManifestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chSlackManifestBtn')
  btn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channels/slack/manifest`)
    if (!res.ok) throw new Error()
    const data = await res.json()
    showSlackManifestModal(data.manifest, data.instructions)
  } catch {
    showToast(t('channel.toast.manifest_failed'))
  } finally {
    btn.disabled = false
  }
})

// ============================================================
// === Approvals ===
// ============================================================

const APPROVALS_PAGE_LIMIT = 50

let _approvalsCountdownInterval = null
const _approvalsState = { status: '', agent: '', category: '', offset: 0 }

document.getElementById('refreshApprovalsBtn').addEventListener('click', loadApprovalsPage)
document.getElementById('approvalsFilterStatus').addEventListener('change', (e) => {
  _approvalsState.status = e.target.value
  _approvalsState.offset = 0
  _renderApprovalsTable()
})
document.getElementById('approvalsFilterAgent').addEventListener('input', (e) => {
  _approvalsState.agent = e.target.value.trim()
  _approvalsState.offset = 0
  _renderApprovalsTable()
})
document.getElementById('approvalsFilterCategory').addEventListener('input', (e) => {
  _approvalsState.category = e.target.value.trim()
  _approvalsState.offset = 0
  _renderApprovalsTable()
})

let _approvalsAll = []

async function loadApprovalsPage() {
  const tbody = document.getElementById('approvalsTbody')
  const statsEl = document.getElementById('approvalsStats')
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:24px;text-align:center">${t('approvals.loading')}</td></tr>`
  statsEl.innerHTML = ''
  if (_approvalsCountdownInterval) { clearInterval(_approvalsCountdownInterval); _approvalsCountdownInterval = null }

  try {
    const res = await fetch('/api/approvals?limit=500')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    _approvalsAll = await res.json()
    _renderApprovalsStats()
    _renderApprovalsTable()
    _approvalsCountdownInterval = setInterval(_updateCountdowns, 1000)
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--danger);padding:24px;text-align:center">${t('approvals.error')}</td></tr>`
  }
}

function _renderApprovalsStats() {
  const counts = { pending: 0, approved: 0, rejected: 0, timeout: 0 }
  for (const a of _approvalsAll) counts[a.status] = (counts[a.status] || 0) + 1
  const statsEl = document.getElementById('approvalsStats')
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-value" style="color:var(--warning)">${counts.pending}</div><div class="stat-label">${t('approvals.stat.pending')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--success)">${counts.approved}</div><div class="stat-label">${t('approvals.stat.approved')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--danger)">${counts.rejected}</div><div class="stat-label">${t('approvals.stat.rejected')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--text-muted)">${counts.timeout}</div><div class="stat-label">${t('approvals.stat.timeout')}</div></div>
  `

  // Sidebar badge: show pending count, hidden when zero
  const badge = document.getElementById('approvalsPendingBadge')
  if (badge) {
    badge.textContent = counts.pending
    badge.hidden = counts.pending === 0
  }

  // Pending notice banner above stat cards
  const banner = document.getElementById('approvalsPendingBanner')
  if (banner) {
    if (counts.pending === 0) {
      banner.hidden = true
    } else {
      const pendingRows = _approvalsAll.filter(a => a.status === 'pending')
      const oldest = pendingRows.reduce((min, a) => a.requested_at < min.requested_at ? a : min, pendingRows[0])
      const ageMin = Math.round((Date.now() / 1000 - oldest.requested_at) / 60)
      const timeoutMin = oldest.timeout_at ? Math.max(0, Math.round((oldest.timeout_at - Date.now() / 1000) / 60)) : null
      const timeoutPart = timeoutMin !== null ? ` ${t('approvals.banner.timeout', { n: timeoutMin })}` : ''
      banner.hidden = false
      banner.textContent = `${t('approvals.banner.notice', { n: counts.pending, age: ageMin, agent: oldest.agent_id, category: oldest.category })}${timeoutPart}`
    }
  }
}

function _filterApprovals() {
  const { status, agent, category } = _approvalsState
  return _approvalsAll.filter(a => {
    if (status && a.status !== status) return false
    if (agent && !a.agent_id.includes(agent)) return false
    if (category && !a.category.includes(category)) return false
    return true
  })
}

function _renderApprovalsTable() {
  const filtered = _filterApprovals()
  const { offset } = _approvalsState
  const page = filtered.slice(offset, offset + APPROVALS_PAGE_LIMIT)
  const tbody = document.getElementById('approvalsTbody')

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:24px;text-align:center">${t('approvals.empty')}</td></tr>`
    _renderApprovalsPagination(filtered.length)
    return
  }

  tbody.innerHTML = page.map(a => {
    const isPending = a.status === 'pending'
    const rowStyle = isPending ? 'background:color-mix(in srgb, var(--warning) 8%, transparent)' : ''
    const time = a.requested_at ? new Date(a.requested_at * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }) : '-'
    const badge = _approvalBadge(a.status)
    const countdown = isPending && a.timeout_at ? `<span class="approvals-countdown" data-timeout="${a.timeout_at}" id="cd-${a.id}"></span>` : (a.timeout_at ? '-' : '')
    const actions = isPending
      ? `<div style="display:flex;gap:4px">
           <button class="btn-primary btn-compact approvals-decide" data-id="${escapeAttr(a.id)}" data-decision="approved" style="font-size:11px">${t('approvals.btn.approve')}</button>
           <button class="btn-danger btn-compact approvals-decide" data-id="${escapeAttr(a.id)}" data-decision="rejected" style="font-size:11px">${t('approvals.btn.reject')}</button>
         </div>`
      : (() => {
          const resolvedBy = escapeHtml(a.resolved_by || '')
          if (!a.resolved_at) return `<span style="font-size:12px;color:var(--text-muted)">${resolvedBy}</span>`
          const resolvedDate = new Date(a.resolved_at * 1000)
          const requestedDate = a.requested_at ? new Date(a.requested_at * 1000) : null
          const sameDay = requestedDate && resolvedDate.toDateString() === requestedDate.toDateString()
          const resolvedStr = resolvedDate.toLocaleString('hu-HU', sameDay ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' })
          return `<span style="font-size:12px;color:var(--text-muted)">${resolvedBy}<br><span style="font-size:11px;opacity:0.7">${escapeHtml(resolvedStr)}</span></span>`
        })()
    return `<tr style="${rowStyle}">
      <td style="white-space:nowrap;font-size:12px">${escapeHtml(time)}</td>
      <td><code style="font-size:12px">${escapeHtml(a.agent_id)}</code></td>
      <td style="font-size:12px">${escapeHtml(a.category)}</td>
      <td style="max-width:280px;font-size:12px" title="${escapeAttr(a.action_description)}">${escapeHtml(a.action_description.length > 80 ? a.action_description.slice(0, 80) + '...' : a.action_description)}</td>
      <td>${badge}</td>
      <td style="font-size:12px;white-space:nowrap">${countdown}</td>
      <td>${actions}</td>
    </tr>`
  }).join('')

  _updateCountdowns()
  _renderApprovalsPagination(filtered.length)

  tbody.querySelectorAll('.approvals-decide').forEach(btn => {
    btn.addEventListener('click', () => _resolveApproval(btn.dataset.id, btn.dataset.decision))
  })
}

function _approvalBadge(status) {
  const colors = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)', timeout: 'var(--text-muted)' }
  const color = colors[status] || 'var(--text-muted)'
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:color-mix(in srgb,${color} 15%,transparent);color:${color}">${t('approvals.status.' + status) || status}</span>`
}

function _updateCountdowns() {
  const now = Math.floor(Date.now() / 1000)
  document.querySelectorAll('.approvals-countdown[data-timeout]').forEach(el => {
    const timeout = parseInt(el.dataset.timeout, 10)
    const diff = timeout - now
    if (diff <= 0) {
      el.textContent = t('approvals.countdown.expired')
      el.style.color = 'var(--danger)'
    } else {
      const h = Math.floor(diff / 3600)
      const m = Math.floor((diff % 3600) / 60)
      const s = diff % 60
      el.textContent = h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
      el.style.color = diff < 300 ? 'var(--danger)' : 'var(--text-muted)'
    }
  })
}

function _renderApprovalsPagination(total) {
  const pager = document.getElementById('approvalsPagination')
  if (total <= APPROVALS_PAGE_LIMIT) { pager.innerHTML = ''; return }
  const { offset } = _approvalsState
  const hasPrev = offset > 0
  const hasNext = offset + APPROVALS_PAGE_LIMIT < total
  pager.innerHTML = `
    <button class="btn-secondary btn-compact" ${hasPrev ? '' : 'disabled'} id="approvalsPrev">&#8592; Előző</button>
    <span style="font-size:12px;color:var(--text-muted)">${offset + 1}-${Math.min(offset + APPROVALS_PAGE_LIMIT, total)} / ${total}</span>
    <button class="btn-secondary btn-compact" ${hasNext ? '' : 'disabled'} id="approvalsNext">Következő &#8594;</button>
  `
  pager.querySelector('#approvalsPrev')?.addEventListener('click', () => {
    _approvalsState.offset = Math.max(0, offset - APPROVALS_PAGE_LIMIT)
    _renderApprovalsTable()
  })
  pager.querySelector('#approvalsNext')?.addEventListener('click', () => {
    _approvalsState.offset = offset + APPROVALS_PAGE_LIMIT
    _renderApprovalsTable()
  })
}

async function _resolveApproval(id, decision) {
  try {
    const res = await fetch(`/api/approvals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: decision, resolved_by: 'dashboard' }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(t('approvals.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    showToast(t(decision === 'approved' ? 'approvals.toast.approved' : 'approvals.toast.rejected'))
    // Update in-place to avoid full reload flicker
    const idx = _approvalsAll.findIndex(a => a.id === id)
    if (idx !== -1) _approvalsAll[idx] = data
    _renderApprovalsStats()
    _renderApprovalsTable()
  } catch (err) {
    showToast(t('approvals.toast.error', { msg: String(err.message || err) }))
  }
}


// === connectors.hu install banner ===
;(function () {
  const DISMISSED_KEY = 'cxhu_banner_dismissed'
  const banner = document.getElementById('cxhuBanner')
  const closeBtn = document.getElementById('cxhuBannerClose')
  if (!banner || !closeBtn) return
  if (localStorage.getItem(DISMISSED_KEY) === '1') { banner.hidden = true; return }

  // dismiss with animation
  closeBtn.addEventListener('click', () => {
    banner.style.transition = 'opacity 0.2s ease, max-height 0.3s ease'
    banner.style.overflow = 'hidden'
    banner.style.opacity = '0'
    banner.style.maxHeight = banner.offsetHeight + 'px'
    requestAnimationFrame(() => { banner.style.maxHeight = '0' })
    setTimeout(() => { banner.hidden = true }, 300)
    localStorage.setItem(DISMISSED_KEY, '1')
  })

  // --- state machine ---
  const states = ['Loading','Done','Install','Installing','Token','Configuring','Error']
  function showState(name) {
    states.forEach(s => {
      const el = document.getElementById('cxhuState' + s)
      if (el) el.hidden = (s !== name)
    })
  }

  let lastError = null

  async function checkStatus() {
    showState('Loading')
    try {
      const res = await fetch('/api/connectors-hu/status')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (data.installed && data.configured) {
        showState('Done')
      } else if (data.installed) {
        showState('Token')
      } else {
        showState('Install')
      }
    } catch (e) {
      showError(e.message || t('status.error.fetch'), checkStatus)
    }
  }

  function showError(msg, retryFn) {
    document.getElementById('cxhuErrorMsg').textContent = msg
    showState('Error')
    const retryBtn = document.getElementById('cxhuRetryBtn')
    retryBtn.onclick = retryFn || checkStatus
  }

  // Telepítés gomb
  const installBtn = document.getElementById('cxhuInstallBtn')
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      showState('Installing')
      try {
        const res = await fetch('/api/connectors-hu/install', { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || t('connectors.error.install'))
        showState('Token')
      } catch (e) {
        showError(e.message, () => { showState('Install') })
      }
    })
  }

  // Mentés és szinkron gomb
  const configureBtn = document.getElementById('cxhuConfigureBtn')
  if (configureBtn) {
    configureBtn.addEventListener('click', async () => {
      const token = (document.getElementById('cxhuTokenInput') || {}).value || ''
      if (!token.trim()) {
        document.getElementById('cxhuTokenInput').focus()
        return
      }
      showState('Configuring')
      try {
        const res = await fetch('/api/connectors-hu/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.trim() }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || t('connectors.error.configure'))
        showState('Done')
      } catch (e) {
        showError(e.message, () => { showState('Token') })
      }
    })
  }

  // Enter key a token inputban
  const tokenInput = document.getElementById('cxhuTokenInput')
  if (tokenInput) {
    tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') configureBtn && configureBtn.click() })
  }

  checkStatus()
})()

// loadFederationPage, initFederation imported from ./modules/federation.js (S-13b)
// ── Page registration + boot ──────────────────────────────────────────────────
// Alias: '#team' hash -> 'agents' page, tree view. Must be registered before boot()
// so the alias is available when routeFromHash() resolves the initial URL.
registerAlias('team', 'agents', () => setAgentsActiveView('tree'))

registerPage('overview',  { enter: loadOverview })
registerPage('kanban',    { enter: () => { window._initGanttViewSwitcher?.(); loadKanban(); startKanbanRefresh() }, leave: stopKanbanRefresh })
registerPage('activity',  { enter: startActivityPoll, leave: stopActivityPoll })
registerPage('agents',    { enter: () => { loadAgents().then(() => setAgentsView(getAgentsActiveView() || 'grid')); startAgentsBusyPoll() }, leave: stopAgentsBusyPoll })
registerPage('memories',  { enter: () => { loadMemAgents(); loadMemStats(); loadMemories() } })
registerPage('tasks',     { enter: loadSchedules })
registerPage('skills',    { enter: loadGlobalSkills })
registerPage('connectors',{ enter: loadConnectors })
registerPage('migrate',   { enter: loadMigrateAgents })
registerPage('docs',      { enter: loadDocs })
registerPage('research',  { enter: loadResearch })
registerPage('status',    { enter: loadStatus })
registerPage('recall',    { enter: loadRecallPage })
registerPage('bgTasks',   { enter: loadBgTasksPage })
registerPage('vault',     { enter: loadVaultPage })
registerPage('approvals', { enter: loadApprovalsPage })
registerPage('settings',  {
  enter: loadSettings,
  // Abort navigation away from settings if there are unsaved changes.
  leave: () => !isSettingsDirty() || window.confirm(t('settings.unsaved_warning')) || false,
})
registerPage('updates',   { enter: loadUpdates })
registerPage('messages',  { enter: loadMessagesPage })
registerPage('tokenUsage',{ enter: loadTokenUsage })
registerPage('costs',     { enter: loadCosts })
registerPage('ideas',     { enter: loadIdeasPage })
registerPage('archived',  { enter: () => loadArchivedPage() })
registerPage('naplo',     { enter: () => loadNaplo() })
registerPage('federation',{ enter: loadFederationPage })

// Boot: wires up DOM (nav clicks, sidebar, hashchange listener), translates nav/static
// elements, and performs the initial URL-hash route. Must run after DOM is ready.
document.addEventListener('DOMContentLoaded', boot, { once: true })
if (document.readyState !== 'loading') boot();


// === Mobile login (QR of the ?token= bootstrap URL) ===
// The desktop is already authenticated, so the token lives in localStorage.
// We render it as a QR purely client-side and show it in a modal; the phone
// scans it and stores the token locally. The token never travels through chat.
(function setupMobileLogin() {
  const btn = document.getElementById('mobileLoginBtn')
  const overlay = document.getElementById('mobileLoginOverlay')
  if (!btn || !overlay) return
  const qrBox = document.getElementById('mobileLoginQr')
  const closeBtn = document.getElementById('mobileLoginClose')

  async function render() {
    const token = localStorage.getItem('marveen-dashboard-token')
    if (!token) {
      qrBox.innerHTML = `<p class="muted">${t('mobile_login.no_token')}</p>`
      return
    }
    if (typeof qrcode !== 'function') {
      qrBox.innerHTML = `<p class="muted">${t('mobile_login.cdn_error')}</p>`
      return
    }
    // The QR must encode a URL the phone can reach. If the desktop opened the
    // dashboard on localhost/127.0.0.1, window.location.origin would put
    // "localhost" in the QR and the phone would hit its OWN localhost. In that
    // case ask the server for its LAN IP and build the QR from that. If the
    // dashboard is already open on a LAN IP or a tunnel host, the origin works
    // as-is.
    let base = window.location.origin
    const host = window.location.hostname
    if (host === 'localhost' || host === '127.0.0.1') {
      qrBox.innerHTML = `<p class="muted">${t('mobile_login.generating')}</p>`
      try {
        const r = await fetch('/api/network-info', { headers: { 'Authorization': 'Bearer ' + token } })
        const info = r.ok ? await r.json() : {}
        if (info.lan_ip) {
          base = 'http://' + info.lan_ip + ':' + (info.port || window.location.port || '3420')
        } else {
          qrBox.innerHTML = `<p class="mobile-login-warn">${t('mobile_login.localhost_warn')}</p>`
          return
        }
      } catch (e) {
        qrBox.innerHTML = `<p class="mobile-login-warn">${t('mobile_login.lan_error')}</p>`
        return
      }
    }
    const url = base + '/?token=' + token
    try {
      const qr = qrcode(0, 'M') // typeNumber 0 = auto-fit, ECC level M
      qr.addData(url)
      qr.make()
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true })
    } catch (e) {
      qrBox.innerHTML = `<p class="muted">${t('mobile_login.qr_error', { msg: escapeHtml(String(e && e.message || e)) })}</p>`
    }
  }

  btn.addEventListener('click', () => { render(); openModal(overlay) })
  if (closeBtn) closeBtn.addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })
})()

// === Archivalt kartyak ===
;(() => {
  let archivedInit = false

  const STATUS_LABELS = {
    planned:     () => t('kanban.status.planned'),
    in_progress: () => t('kanban.status.in_progress'),
    waiting:     () => t('kanban.status.waiting'),
    done:        () => t('kanban.status.done')
  }
  const STATUS_COLORS = { planned: '#6b7280', in_progress: '#3b82f6', waiting: '#f59e0b', done: '#10b981' }
  const PRIORITY_LABELS = {
    low:    () => t('kanban.priority.low'),
    normal: () => t('kanban.priority.normal'),
    high:   () => t('kanban.priority.high'),
    urgent: () => t('kanban.priority.urgent')
  }
  const PRIORITY_COLORS = { low: '#9ca3af', normal: '#6b7280', high: '#f59e0b', urgent: '#ef4444' }

  function fmtDate(unix) {
    if (!unix) return ''
    return new Date(unix * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
  }

  // Render an archived card with the same visual language as the live board:
  // project pill + #seq title + colored rounded priority/label chips, wrapped in
  // the .kanban-card frame. The whole card opens a read-only detail modal on
  // click; the restore button stops propagation so it doesn't also open it.
  function renderArchivedCard(card) {
    const prioColor = PRIORITY_COLORS[card.priority] || '#6b7280'
    const prioLabel = PRIORITY_LABELS[card.priority]?.() ?? card.priority
    const seqHtml = card.seq != null
      ? `<span class="kanban-card-seq" style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-right:5px">#${card.seq}</span>`
      : ''
    const projectHtml = card.project
      ? `<span class="kanban-card-project">${esc(card.project)}</span>`
      : ''
    let labelsHtml = ''
    if (Array.isArray(card.labels) && card.labels.length > 0) {
      const pills = card.labels
        .map(l => `<span class="kanban-card-label-pill" style="--label-color:${esc(l.color)}">#${esc(l.name)}</span>`)
        .join('')
      labelsHtml = `<div class="kanban-card-labels">${pills}</div>`
    }
    const prioPill = `<span class="archived-prio-pill" style="--prio-color:${prioColor}">${prioLabel}</span>`
    return `<div class="kanban-card archived-card" data-id="${esc(card.id)}" data-priority="${esc(card.priority)}">
      ${projectHtml}
      <div class="kanban-card-title">${seqHtml}${esc(card.title)}</div>
      <div class="kanban-card-footer">${prioPill}</div>
      ${labelsHtml}
      <div class="archived-card-foot">
        <span class="archived-date">${t('archived.label.archived_at', {date: fmtDate(card.archived_at)})}</span>
        <button class="btn-secondary btn-compact archived-restore-btn" data-id="${esc(card.id)}" title="${t('archived.btn.restore_to_board')}" style="white-space:nowrap;flex-shrink:0;">${t('archived.btn.restore')}</button>
      </div>
    </div>`
  }

  // Read-only detail modal for an archived card: meta grid, labels, description,
  // comments -- no editing affordances. Restore button mirrors the card button.
  async function showArchivedDetail(card) {
    const seqPrefix = card.seq != null ? `#${card.seq} ` : ''
    document.getElementById('archivedDetailTitle').textContent = `${seqPrefix}${card.title}`
    const meta = document.getElementById('archivedDetailMeta')
    const idLabel = (card.seq != null ? `#${card.seq} · ` : '') + card.id
    meta.innerHTML = `
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.id')}</span><span class="meta-value" style="font-family:monospace">${esc(idLabel)}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.status')}</span><span class="meta-value">${STATUS_LABELS[card.status]?.() ?? card.status}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.assignee')}</span><span class="meta-value">${card.assignee ? esc(card.assignee) : t('kanban.meta.none')}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.priority')}</span><span class="meta-value">${PRIORITY_LABELS[card.priority]?.() ?? card.priority}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.project')}</span><span class="meta-value">${card.project ? esc(card.project) : t('kanban.meta.none')}</span></div>
      <div class="meta-item"><span class="meta-label">${t('archived.meta.archived_at')}</span><span class="meta-value">${fmtDate(card.archived_at)}</span></div>
    `
    const labelsWrap = document.getElementById('archivedDetailLabelsWrap')
    const labelsBox = document.getElementById('archivedDetailLabels')
    if (Array.isArray(card.labels) && card.labels.length > 0) {
      labelsBox.innerHTML = card.labels
        .map(l => `<span class="kanban-card-label-pill" style="--label-color:${esc(l.color)}">#${esc(l.name)}</span>`)
        .join('')
      labelsWrap.style.display = ''
    } else {
      labelsWrap.style.display = 'none'
    }
    document.getElementById('archivedDetailDesc').textContent = card.description || ''

    const commentsWrap = document.getElementById('archivedDetailCommentsWrap')
    const commentsBox = document.getElementById('archivedDetailComments')
    commentsBox.innerHTML = ''
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
      const comments = res.ok ? await res.json() : []
      if (Array.isArray(comments) && comments.length > 0) {
        for (const c of comments) {
          const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
          const div = document.createElement('div')
          div.className = 'comment-item'
          div.innerHTML = `<div><span class="comment-author">${esc(c.author)}</span><span class="comment-date">${date}</span></div><div class="comment-body">${esc(c.content)}</div>`
          commentsBox.appendChild(div)
        }
        commentsWrap.style.display = ''
      } else {
        commentsWrap.style.display = 'none'
      }
    } catch { commentsWrap.style.display = 'none' }

    const restoreBtn = document.getElementById('archivedDetailRestoreBtn')
    restoreBtn.disabled = false
    restoreBtn.textContent = t('archived.btn.restore_to_board')
    restoreBtn.onclick = async () => {
      restoreBtn.disabled = true
      restoreBtn.textContent = t('archived.btn.restoring')
      try {
        const resp = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/unarchive`, { method: 'POST' })
        if (resp.ok) {
          closeModal(document.getElementById('archivedDetailOverlay'))
          doArchivedSearch()
        } else {
          restoreBtn.disabled = false
          restoreBtn.textContent = t('archived.btn.restore_to_board')
          showToast(t('archived.restore_error'))
        }
      } catch {
        restoreBtn.disabled = false
        restoreBtn.textContent = t('archived.btn.restore_to_board')
      }
    }
    openModal(document.getElementById('archivedDetailOverlay'))
  }

  async function populateArchivedProjects() {
    try {
      const r = await fetch('/api/kanban-projects')
      if (!r.ok) return
      const projects = await r.json()
      const sel = document.getElementById('archivedProject')
      const cur = sel.value
      sel.innerHTML = '<option value="">' + t('archived.filter.all_projects') + '</option>'
      for (const p of projects) {
        const opt = document.createElement('option')
        opt.value = p
        opt.textContent = p
        if (p === cur) opt.selected = true
        sel.appendChild(opt)
      }
    } catch { /* best-effort */ }
  }

  async function doArchivedSearch() {
    const list = document.getElementById('archivedList')
    const summary = document.getElementById('archivedSummary')
    list.className = ''
    list.innerHTML = '<p class="naplo-empty">' + t('common.loading') + '</p>'
    summary.textContent = ''

    const params = new URLSearchParams()
    const q = document.getElementById('archivedQ').value.trim()
    const project = document.getElementById('archivedProject').value
    const from = document.getElementById('archivedFrom').value
    const to = document.getElementById('archivedTo').value
    if (q) params.set('q', q)
    if (project) params.set('project', project)
    if (from) params.set('from', Math.floor(new Date(from).getTime() / 1000))
    if (to) params.set('to', Math.floor(new Date(to + 'T23:59:59').getTime() / 1000))

    try {
      const r = await fetch('/api/kanban/archived?' + params.toString())
      if (!r.ok) { list.innerHTML = '<p class="naplo-empty error">' + t('archived.error.http', {status: r.status}) + '</p>'; return }
      const data = await r.json()
      const cards = data.cards || []
      summary.textContent = t('archived.summary', {count: cards.length, limit: data.limit})
      if (cards.length === 0) { list.innerHTML = '<p class="naplo-empty">' + t('archived.empty') + '</p>'; return }
      list.className = 'archived-grid'
      list.innerHTML = cards.map(renderArchivedCard).join('')
      const byId = new Map(cards.map(c => [c.id, c]))
      // Whole card opens the read-only detail; restore button acts on its own.
      list.querySelectorAll('.archived-card').forEach(el => {
        el.addEventListener('click', () => {
          const card = byId.get(el.dataset.id)
          if (card) showArchivedDetail(card)
        })
      })
      list.querySelectorAll('.archived-restore-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation()
          const id = btn.dataset.id
          btn.disabled = true
          btn.textContent = '...'
          try {
            const resp = await fetch(`/api/kanban/${id}/unarchive`, { method: 'POST' })
            if (resp.ok) {
              const cardEl = btn.closest('.archived-card')
              if (cardEl) cardEl.style.opacity = '0.4'
              btn.textContent = t('archived.btn.restored')
            } else {
              btn.disabled = false
              btn.textContent = t('archived.btn.restore')
              showToast(t('archived.restore_error'))
            }
          } catch {
            btn.disabled = false
            btn.textContent = t('archived.btn.restore')
          }
        })
      })
    } catch (err) {
      list.innerHTML = '<p class="naplo-empty error">' + t('common.error_network', {msg: err.message}) + '</p>'
    }
  }

  function loadArchivedPage() {
    if (!archivedInit) {
      archivedInit = true
      document.getElementById('archivedSearchBtn').addEventListener('click', doArchivedSearch)
      document.getElementById('archivedRefreshBtn').addEventListener('click', doArchivedSearch)
      document.getElementById('archivedQ').addEventListener('keydown', e => { if (e.key === 'Enter') doArchivedSearch() })
      const adOverlay = document.getElementById('archivedDetailOverlay')
      document.getElementById('archivedDetailClose').addEventListener('click', () => closeModal(adOverlay))
      adOverlay.addEventListener('click', e => { if (e.target === adOverlay) closeModal(adOverlay) })
    }
    populateArchivedProjects()
    doArchivedSearch()
  }

  window.loadArchivedPage = loadArchivedPage
})()

// === Naplo (Audit Timeline) ===
;(() => {
  let naploInitialized = false
  let naploActiveSource = ''

  const SOURCE_LABELS = { config: () => t('naplo.source.config'), idea: () => t('naplo.source.idea'), store: () => t('naplo.source.store'), diary: () => t('naplo.source.diary') }
  const SOURCE_COLORS = { config: '#3b82f6', idea: '#10b981', store: '#f59e0b', diary: '#8b5cf6' }
  const DIARY_ENTRY_LABELS = { log: () => t('naplo.diary.log_badge'), memory: () => t('naplo.diary.memory_badge') }
  const DIARY_ENTRY_COLORS = { log: '#6b7280', memory: '#a78bfa' }

  function fmtTs(unix) {
    return new Date(unix * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
  }

  function renderEntry(e) {
    const sourceColor = SOURCE_COLORS[e.source] || '#6b7280'
    const sourceLabelRaw = SOURCE_LABELS[e.source]; const sourceLabel = sourceLabelRaw ? (typeof sourceLabelRaw === 'function' ? sourceLabelRaw() : sourceLabelRaw) : e.source
    const badge = `<span class="naplo-badge" style="background:${sourceColor}">${sourceLabel}</span>`
    const ts = `<span class="naplo-ts">${fmtTs(e.created_at)}</span>`
    let detail = ''
    if (e.source === 'config') {
      const oldV = e.old_value != null ? `<code>${esc(e.old_value)}</code>` : '<em>nincs</em>'
      const newV = e.new_value != null ? `<code>${esc(e.new_value)}</code>` : '<em>nincs</em>'
      detail = `<strong>${esc(e.key)}</strong> ${oldV} &rarr; ${newV} <span class="naplo-actor">${esc(e.actor || '')}</span>`
    } else if (e.source === 'idea') {
      const from = e.from_status ? `<code>${esc(e.from_status)}</code> &rarr; ` : ''
      detail = `<strong>${esc(e.idea_id)}</strong> ${from}<code>${esc(e.to_status)}</code>`
      if (e.note) detail += ` <span class="naplo-note">${esc(e.note)}</span>`
      if (e.actor) detail += ` <span class="naplo-actor">${esc(e.actor)}</span>`
    } else if (e.source === 'store') {
      const sizeStr = e.file_size != null ? ` (${(e.file_size / 1024).toFixed(1)} KB)` : ''
      const agentStr = e.agent ? ` <span class="naplo-actor">${esc(e.agent)}</span>` : ''
      const sens = e.is_sensitive ? ` <span class="naplo-sensitive">${t('naplo.entry.sensitive')}</span>` : ''
      detail = `<code>${esc(e.rel_path)}</code> <span class="naplo-event-type">${esc(e.event_type)}</span>${sizeStr}${agentStr}${sens}`
    } else if (e.source === 'diary') {
      const entryColor = DIARY_ENTRY_COLORS[e.entry_type] || '#6b7280'
      const entryLabelRaw = DIARY_ENTRY_LABELS[e.entry_type]; const entryLabel = entryLabelRaw ? (typeof entryLabelRaw === 'function' ? entryLabelRaw() : entryLabelRaw) : e.entry_type
      const entryBadge = `<span class="naplo-badge" style="background:${entryColor};font-size:10px">${entryLabel}</span>`
      const agentStr = e.agent_id ? ` <span class="naplo-actor">${esc(e.agent_id)}</span>` : ''
      let contentSnippet = esc(e.content || '').replace(/\n/g, ' ').slice(0, 200)
      if ((e.content || '').length > 200) contentSnippet += '…'
      const keywordsStr = e.keywords ? `<div class="naplo-note" style="margin-top:2px">Kulcsszavak: ${esc(e.keywords)}</div>` : ''
      const catStr = e.category ? ` <span class="naplo-event-type">${esc(e.category)}</span>` : ''
      detail = `${entryBadge}${catStr}${agentStr}<div class="naplo-diary-content">${contentSnippet}</div>${keywordsStr}`
    }
    return `<div class="naplo-entry"><div class="naplo-entry-meta">${ts}${badge}</div><div class="naplo-entry-detail">${detail}</div></div>`
  }

  async function doNaplo() {
    const timeline = document.getElementById('naplo-timeline')
    const summary = document.getElementById('naplo-summary')
    timeline.innerHTML = `<p class="naplo-empty">${t('naplo.loading')}</p>`
    summary.textContent = ''

    const params = new URLSearchParams()
    if (naploActiveSource) params.set('source', naploActiveSource)
    const from = document.getElementById('naplo-from').value
    const to = document.getElementById('naplo-to').value
    const q = document.getElementById('naplo-q').value.trim()
    const agentEl = document.getElementById('naplo-agent')
    const agentVal = agentEl ? agentEl.value.trim() : ''
    if (from) params.set('from', Math.floor(new Date(from).getTime() / 1000))
    if (to)   params.set('to', Math.floor(new Date(to + 'T23:59:59').getTime() / 1000))
    if (q)    params.set('q', q)
    if (agentVal) params.set('agent', agentVal)
    params.set('limit', '200')

    try {
      const res = await fetch('/api/audit-log?' + params.toString())
      if (!res.ok) { timeline.innerHTML = `<p class="naplo-empty error">Hiba: ${res.status}</p>`; return }
      const data = await res.json()
      const entries = data.entries || []
      summary.textContent = t('naplo.summary', { n: entries.length })
      if (entries.length === 0) { timeline.innerHTML = `<p class="naplo-empty">${t('naplo.empty')}</p>`; return }
      timeline.innerHTML = entries.map(renderEntry).join('')
    } catch (err) {
      timeline.innerHTML = `<p class="naplo-empty error">${t('naplo.error', { msg: err.message })}</p>`
    }
  }

  function loadNaplo() {
    if (!naploInitialized) {
      naploInitialized = true
      document.querySelectorAll('#naplo-source-tabs .naplo-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#naplo-source-tabs .naplo-tab').forEach((b) => b.classList.remove('active'))
          btn.classList.add('active')
          naploActiveSource = btn.dataset.source
          const agentFilter = document.getElementById('naplo-agent-wrap')
          if (agentFilter) agentFilter.style.display = naploActiveSource === 'diary' ? '' : 'none'
          doNaplo()
        })
      })
      document.getElementById('naplo-search-btn').addEventListener('click', doNaplo)
      document.getElementById('naplo-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doNaplo() })
      document.getElementById('naplo-refresh-btn').addEventListener('click', doNaplo)
    }
    doNaplo()
  }

  window.loadNaplo = loadNaplo
})()

// === Kanban Gantt / timeline view ===
;(function () {
  // --- State ---
  let ganttPeriod = 'week'  // 'week' | 'month' | 'quarter'
  let ganttPeriodOffset = 0  // periods stepped from the current one (0 = current, -1 = prev, +1 = next)
  let ganttOverdueOnly = false
  let _initialized = false

  // --- Color map by status (vars from theme) ---
  const STATUS_COLOR = {
    planned:     { bg: 'var(--accent)',  border: 'var(--accent)' },
    in_progress: { bg: '#4f8ef7',        border: '#3a7be0' },
    waiting:     { bg: '#e8a838',        border: '#c88c20' },
    done:        { bg: '#3dbf79',        border: '#28a560' },
  }

  // Period window: returns { rangeStart: Date, rangeEnd: Date } (midnight boundaries)
  function periodWindow() {
    const now = new Date()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    if (ganttPeriod === 'week') {
      // Mon..Sun of current week, shifted by ganttPeriodOffset weeks
      const dow = (start.getDay() + 6) % 7  // Mon=0
      start.setDate(start.getDate() - dow + ganttPeriodOffset * 7)
      end.setTime(start.getTime())
      end.setDate(start.getDate() + 7)
    } else if (ganttPeriod === 'month') {
      start.setDate(1)
      start.setMonth(start.getMonth() + ganttPeriodOffset)
      end.setFullYear(start.getFullYear(), start.getMonth() + 1, 1)
    } else {  // quarter
      const qStart = Math.floor(start.getMonth() / 3) * 3 + ganttPeriodOffset * 3
      start.setMonth(qStart, 1)
      end.setFullYear(start.getFullYear(), start.getMonth() + 3, 1)
    }
    return { rangeStart: start, rangeEnd: end }
  }

  // Format date as short label (e.g. "jún 15" / "Jun 15")
  function fmtDateShort(d) {
    return d.toLocaleDateString(typeof _lang !== 'undefined' && _lang === 'en' ? 'en-US' : 'hu-HU', { month: 'short', day: 'numeric' })
  }

  // Return header tick labels for the visible range
  function buildHeaderTicks(rangeStart, rangeEnd) {
    const ticks = []
    const totalMs = rangeEnd - rangeStart
    // Aim for ~5-8 ticks; snap to day boundaries
    let stepDays = 1
    if (ganttPeriod === 'month') stepDays = 7
    else if (ganttPeriod === 'quarter') stepDays = 14
    const cur = new Date(rangeStart)
    while (cur < rangeEnd) {
      ticks.push({
        date: new Date(cur),
        pct: (cur - rangeStart) / totalMs * 100,
      })
      cur.setDate(cur.getDate() + stepDays)
    }
    return ticks
  }

  // Group visible cards by project (or 'Nincs projekt' for null)
  function groupCardsByProject(cards) {
    const map = new Map()
    for (const c of cards) {
      const key = c.project || t('kanban.gantt.no_project')
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(c)
    }
    return map
  }

  // Build and inject the Gantt DOM into #kanbanGanttView
  function renderGantt() {
    const container = document.getElementById('kanbanGanttView')
    if (!container) return
    container.innerHTML = ''

    const { rangeStart, rangeEnd } = periodWindow()
    const totalMs = rangeEnd - rangeStart
    const nowMs = Date.now()
    const todayPct = Math.max(0, Math.min(100, (nowMs - rangeStart) / totalMs * 100))

    // Filter: cards that have a due_date
    let cards = (Array.isArray(kanbanState.cards) ? kanbanState.cards : []).filter(c => c.due_date)

    if (ganttOverdueOnly) {
      // Keep cards that are overdue OR due within 7 days
      const cutoff = (nowMs + 7 * 86400000) / 1000
      cards = cards.filter(c => c.due_date <= cutoff / 1 && c.status !== 'done')
    }

    // Exclude cards whose entire bar lies outside the window
    cards = cards.filter(c => {
      const barStart = c.created_at ? c.created_at * 1000 : rangeStart.getTime()
      const barEnd   = c.due_date * 1000
      return barEnd >= rangeStart && barStart <= rangeEnd
    })

    if (cards.length === 0) {
      container.innerHTML = `<p style="color:var(--muted);padding:24px 0;text-align:center;">${t('kanban.gantt.no_cards')}</p>`
      return
    }

    const grouped = groupCardsByProject(cards)

    // --- Outer layout ---
    const wrap = document.createElement('div')
    wrap.className = 'gantt-wrap'
    wrap.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;'

    // --- Header row: left label + tick strip ---
    const headerRow = document.createElement('div')
    headerRow.style.cssText = 'display:flex;border-bottom:1px solid var(--border);margin-bottom:4px;'

    const headerLabel = document.createElement('div')
    headerLabel.style.cssText = 'width:220px;min-width:220px;font-size:12px;color:var(--muted);padding:4px 8px;border-right:1px solid var(--border);'
    headerLabel.textContent = t('kanban.gantt.col_label')
    headerRow.appendChild(headerLabel)

    const headerTrack = document.createElement('div')
    headerTrack.style.cssText = 'flex:1;position:relative;height:28px;overflow:hidden;'
    const ticks = buildHeaderTicks(rangeStart, rangeEnd)
    for (const tick of ticks) {
      const el = document.createElement('div')
      el.style.cssText = `position:absolute;left:${tick.pct.toFixed(2)}%;transform:translateX(-50%);font-size:11px;color:var(--muted);top:6px;white-space:nowrap;`
      el.textContent = fmtDateShort(tick.date)
      headerTrack.appendChild(el)
    }
    // Today marker in header
    if (todayPct >= 0 && todayPct <= 100) {
      const todayHead = document.createElement('div')
      todayHead.style.cssText = `position:absolute;left:${todayPct.toFixed(2)}%;top:0;bottom:0;width:2px;background:var(--danger,#e05252);opacity:0.6;`
      headerTrack.appendChild(todayHead)
    }
    headerRow.appendChild(headerTrack)
    wrap.appendChild(headerRow)

    // --- Body rows ---
    const body = document.createElement('div')
    body.style.cssText = 'overflow-y:auto;max-height:70vh;'

    for (const [project, projCards] of grouped) {
      // Group header
      const groupHeader = document.createElement('div')
      groupHeader.style.cssText = 'display:flex;align-items:center;background:var(--bg2,var(--sidebar-bg));border-bottom:1px solid var(--border);'
      const ghLabel = document.createElement('div')
      ghLabel.style.cssText = 'width:220px;min-width:220px;font-size:12px;font-weight:600;color:var(--fg);padding:5px 8px;border-right:1px solid var(--border);'
      ghLabel.textContent = `${project} (${projCards.length})`
      groupHeader.appendChild(ghLabel)
      const ghStripe = document.createElement('div')
      ghStripe.style.cssText = 'flex:1;height:26px;background:var(--bg2,var(--sidebar-bg));'
      groupHeader.appendChild(ghStripe)
      body.appendChild(groupHeader)

      // Card rows
      for (const card of projCards) {
        const barStartMs = card.created_at ? card.created_at * 1000 : rangeStart.getTime()
        const barEndMs   = card.due_date * 1000
        const isOverdue  = card.status !== 'done' && barEndMs < nowMs

        // Clamp to window
        const clampedStart = Math.max(barStartMs, rangeStart.getTime())
        const clampedEnd   = Math.min(barEndMs,   rangeEnd.getTime())
        const leftPct  = (clampedStart - rangeStart) / totalMs * 100
        const widthPct = Math.max(0.5, (clampedEnd - clampedStart) / totalMs * 100)

        const col = isOverdue ? { bg: 'var(--danger,#e05252)', border: '#b83030' }
                              : (STATUS_COLOR[card.status] || STATUS_COLOR.planned)

        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;border-bottom:1px solid var(--border);min-height:32px;'

        const rowLabel = document.createElement('div')
        rowLabel.style.cssText = 'width:220px;min-width:220px;font-size:12px;color:var(--fg);padding:4px 8px;border-right:1px solid var(--border);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;'
        rowLabel.title = card.title
        // Show the running display number (#N, card.seq) like the board, not the hex id.
        const seqLabel = card.seq != null ? `#${card.seq}` : `#${card.id}`
        rowLabel.textContent = `${seqLabel} ${card.title}`
        rowLabel.addEventListener('click', () => { if (typeof openCardDetail === 'function') openCardDetail(card.id) })

        const rowTrack = document.createElement('div')
        rowTrack.style.cssText = 'flex:1;position:relative;height:32px;overflow:hidden;'

        // Today line (in each row)
        if (todayPct >= 0 && todayPct <= 100) {
          const tl = document.createElement('div')
          tl.style.cssText = `position:absolute;left:${todayPct.toFixed(2)}%;top:0;bottom:0;width:2px;background:var(--danger,#e05252);z-index:1;pointer-events:none;`
          rowTrack.appendChild(tl)
        }

        const bar = document.createElement('div')
        bar.style.cssText = [
          `position:absolute`,
          `left:${leftPct.toFixed(2)}%`,
          `width:${widthPct.toFixed(2)}%`,
          `top:5px`,
          `bottom:5px`,
          `background:${col.bg}`,
          `border:1px solid ${col.border}`,
          `border-radius:4px`,
          `overflow:hidden`,
          `white-space:nowrap`,
          `font-size:11px`,
          `color:#fff`,
          `display:flex`,
          `align-items:center`,
          `padding:0 6px`,
          `box-sizing:border-box`,
          `cursor:pointer`,
          `z-index:2`,
          isOverdue ? 'background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.12) 0px,rgba(0,0,0,.12) 4px,transparent 4px,transparent 8px)' : '',
        ].filter(Boolean).join(';')
        bar.title = `${seqLabel} ${card.title}\n${fmtDateShort(new Date(barStartMs))} - ${fmtDateShort(new Date(barEndMs))}`
        bar.textContent = `${seqLabel} ${card.title}`
        bar.addEventListener('click', () => { if (typeof openCardDetail === 'function') openCardDetail(card.id) })
        rowTrack.appendChild(bar)
        row.appendChild(rowLabel)
        row.appendChild(rowTrack)
        body.appendChild(row)
      }
    }

    wrap.appendChild(body)

    // --- Legend ---
    const legend = document.createElement('div')
    legend.style.cssText = 'display:flex;align-items:center;gap:16px;margin-top:10px;font-size:12px;flex-wrap:wrap;'
    const legendItems = [
      { key: 'planned',     color: STATUS_COLOR.planned.bg },
      { key: 'in_progress', color: STATUS_COLOR.in_progress.bg },
      { key: 'waiting',     color: STATUS_COLOR.waiting.bg },
      { key: 'done',        color: STATUS_COLOR.done.bg },
      { key: 'overdue',     color: 'var(--danger,#e05252)' },
    ]
    for (const item of legendItems) {
      const dot = document.createElement('span')
      dot.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${item.color};vertical-align:middle;margin-right:4px;"></span>${t('kanban.gantt.legend.' + item.key)}`
      legend.appendChild(dot)
    }
    const todayLegend = document.createElement('span')
    todayLegend.style.cssText = 'margin-left:auto;color:var(--muted);'
    todayLegend.innerHTML = `<span style="display:inline-block;width:12px;height:2px;background:var(--danger,#e05252);vertical-align:middle;margin-right:4px;"></span>${t('kanban.gantt.legend.today')}`
    legend.appendChild(todayLegend)
    wrap.appendChild(legend)

    container.appendChild(wrap)

    // --- Period stepper (below the timeline): step back/forward by one period unit ---
    const nav = document.createElement('div')
    nav.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;'
    const prevBtn = document.createElement('button')
    prevBtn.className = 'view-btn'
    prevBtn.style.cssText = 'width:auto;padding:0 14px;'
    prevBtn.textContent = '‹ ' + t('kanban.gantt.nav_prev')
    prevBtn.addEventListener('click', () => { ganttPeriodOffset--; renderGantt() })
    const rangeLbl = document.createElement('span')
    rangeLbl.style.cssText = 'font-size:12px;color:var(--muted);min-width:130px;text-align:center;'
    rangeLbl.textContent = `${fmtDateShort(rangeStart)} - ${fmtDateShort(new Date(rangeEnd.getTime() - 1))}`
    const nextBtn = document.createElement('button')
    nextBtn.className = 'view-btn'
    nextBtn.style.cssText = 'width:auto;padding:0 14px;'
    nextBtn.textContent = t('kanban.gantt.nav_next') + ' ›'
    nextBtn.addEventListener('click', () => { ganttPeriodOffset++; renderGantt() })
    nav.append(prevBtn, rangeLbl, nextBtn)
    container.appendChild(nav)
  }

  // --- View switcher init (called once after DOM ready) ---
  function initGanttViewSwitcher() {
    if (_initialized) return
    _initialized = true

    const boardBtn  = document.getElementById('kanbanViewBoard')
    const ganttBtn  = document.getElementById('kanbanViewGantt')
    const boardFilters = document.getElementById('kanbanBoardFilters')
    const ganttFilters = document.getElementById('kanbanGanttFilters')
    const boardEls  = [document.getElementById('kanbanBoard'), document.getElementById('kanbanSwimlaneBoard')]
    const ganttEl   = document.getElementById('kanbanGanttView')

    function activateBoard() {
      boardBtn.classList.add('active')
      ganttBtn.classList.remove('active')
      boardFilters.style.display = 'flex'
      ganttFilters.style.display = 'none'
      boardEls.forEach(el => { if (el) el.style.removeProperty('display') })
      ganttEl.style.display = 'none'
    }

    function activateGantt() {
      ganttBtn.classList.add('active')
      boardBtn.classList.remove('active')
      ganttFilters.style.display = 'flex'
      boardFilters.style.display = 'none'
      boardEls.forEach(el => { if (el) el.style.display = 'none' })
      ganttEl.style.display = 'block'
      renderGantt()
    }

    boardBtn.addEventListener('click', activateBoard)
    ganttBtn.addEventListener('click', activateGantt)

    // Period buttons
    document.querySelectorAll('#kanbanGanttFilters [data-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        ganttPeriod = btn.dataset.period
        ganttPeriodOffset = 0  // recenter on the current period when switching granularity
        document.querySelectorAll('#kanbanGanttFilters [data-period]').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        renderGantt()
      })
    })

    // Overdue toggle
    const overdueChk = document.getElementById('ganttOverdueOnly')
    if (overdueChk) {
      overdueChk.addEventListener('change', () => {
        ganttOverdueOnly = overdueChk.checked
        renderGantt()
      })
    }

    // Re-render whenever loadKanban() completes (fires window._onKanbanRefresh).
    // The old window.renderKanban hook was broken since S-1 made app.js a module
    // (function declarations in modules are NOT on window).
    window._onKanbanRefresh = () => {
      if (ganttEl.style.display !== 'none') renderGantt()
    }
  }

  window._initGanttViewSwitcher = initGanttViewSwitcher
  window.renderGantt = renderGantt
})()
