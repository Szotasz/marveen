// === i18n runtime ===
// Priority: localStorage['marveen.lang'] > DASHBOARD_LANG (server default, read
// from /api/settings on init) > 'hu' (hardcoded fallback).
// Rick's spec (kanban card 209696a9): t(key,params), window._i18n={hu,en},
// window._lang; {name} interpolation; EN-fallback then key; dev-mode warning.
;(() => {
  const LS_KEY = 'marveen.lang'
  const VALID = new Set(['hu', 'en'])

  window.t = function t(key, params = {}) {
    const lang = window._lang || 'hu'
    const str =
      window._i18n?.[lang]?.[key] ??
      window._i18n?.['en']?.[key] ??
      key
    if (str === key && localStorage.getItem('marveen.dev') === '1') {
      console.warn('[i18n] missing key:', key)
    }
    return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`))
  }

  function applyLang(lang) {
    window._lang = VALID.has(lang) ? lang : 'hu'
  }

  // Initialise from localStorage; server default fetched async below.
  applyLang(localStorage.getItem(LS_KEY) || 'hu')

  // Fetch server default (DASHBOARD_LANG) and apply only if localStorage not set.
  fetch('/api/settings')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || localStorage.getItem(LS_KEY)) return
      const entry = (data.settings || []).find(s => s.key === 'DASHBOARD_LANG')
      if (entry && VALID.has(entry.value)) applyLang(entry.value)
    })
    .catch(() => {})

  window.setLang = function setLang(lang) {
    if (!VALID.has(lang)) return
    window._lang = lang
    localStorage.setItem(LS_KEY, lang)
    renderNav()
    // Static elements (kanban column titles, hints, empty states) are otherwise
    // only translated at DOMContentLoaded -- re-apply them on every switch so the
    // currently-open page updates live, not just after a manual reload.
    if (typeof renderStaticI18n === 'function') renderStaticI18n()
    // Re-render the active page by re-triggering the switchPage handler.
    const activeLink = document.querySelector('.sb-link.active[data-page]')
    if (activeLink) {
      const pageId = activeLink.dataset.page
      if (typeof switchPage === 'function') switchPage(pageId)
    }
  }
})()

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
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken)
    urlParams.delete('token')
    const clean = window.location.pathname + (urlParams.toString() ? '?' + urlParams : '') + window.location.hash
    window.history.replaceState({}, '', clean)
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
      const token = localStorage.getItem(TOKEN_KEY)
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
      localStorage.removeItem(TOKEN_KEY)
      if (!window.__marveenAuthPrompted) {
        window.__marveenAuthPrompted = true
        // An installed (home-screen) PWA has its own localStorage, separate from
        // Safari's, and the manifest start_url has no ?token=, so the very first
        // standalone launch is token-less and 401s. There is no address bar to
        // paste a ?token= URL into either. Offer an in-app paste field that
        // writes the token to the app's own storage, then reload.
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
    }
    return res
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
    btn.textContent = (window._lang || 'hu').toUpperCase()
  }
  syncLangBtn()
  btn.addEventListener('click', () => {
    const next = (window._lang || 'hu') === 'hu' ? 'en' : 'hu'
    window.setLang(next)
    syncLangBtn()
  })
  // Keep button in sync when setLang is called from elsewhere (e.g. /api/settings async load).
  const _origSetLang = window.setLang
  window.setLang = function setLang(lang) {
    _origSetLang(lang)
    syncLangBtn()
  }
})()

// === Page switching ===
const navLinks = document.querySelectorAll('.sb-link[data-page], .nav-link[data-page]')
const pages = document.querySelectorAll('.page')

function confirmSettingsLeave() {
  if (settingsDirty.size === 0) return true
  return window.confirm(t('settings.unsaved_warning'))
}

function switchPage(pageId) {
  // Guard unsaved settings before leaving the settings page
  if (!document.getElementById('settingsPage').hidden && pageId !== 'settings' && !confirmSettingsLeave()) return
  pages.forEach((p) => (p.hidden = p.id !== pageId + 'Page'))
  navLinks.forEach((l) => l.classList.toggle('active', l.dataset.page === pageId))
  // Kanban needs full-width layout (overrides main's max-width: 1200px)
  document.querySelector('main').classList.toggle('kanban-active', pageId === 'kanban')
  // Activity page runs a live poll; stop it whenever we navigate away.
  if (pageId !== 'activity') stopActivityPoll()
  if (pageId === 'activity') startActivityPoll()
  // Kanban auto-refresh: start on enter, stop on leave.
  if (pageId !== 'kanban') stopKanbanRefresh()
  if (pageId === 'overview') loadOverview()
  if (pageId === 'kanban') { loadKanban(); startKanbanRefresh() }
  if (pageId === 'tasks') loadSchedules()
  if (pageId === 'agents') loadAgents()
  if (pageId === 'memories') { loadMemAgents(); loadMemStats(); loadMemories() }
  if (pageId === 'skills') loadGlobalSkills()
  if (pageId === 'connectors') loadConnectors()
  if (pageId === 'migrate') loadMigrateAgents()
  if (pageId === 'docs') loadDocs()
  if (pageId === 'status') loadStatus()
  if (pageId === 'recall') loadRecallPage()
  if (pageId === 'bgTasks') loadBgTasksPage()
  if (pageId === 'vault') loadVaultPage()
  if (pageId === 'autonomy') loadAutonomy()
  if (pageId === 'settings') loadSettings()
  if (pageId === 'updates') loadUpdates()
  if (pageId === 'team') { loadTeamGraph() }
  if (pageId === 'messages') loadMessagesPage()
  if (pageId === 'tokenUsage') loadTokenUsage()
  if (pageId === 'ideas') loadIdeasPage()
  if (pageId === 'archived') loadArchivedPage()
  if (pageId === 'naplo') loadNaplo()
}

// Mobile off-canvas sidebar toggle. No-op visual effect on desktop (the
// hamburger/backdrop are display:none there); on narrow screens it slides the
// sidebar in over a backdrop.
const sidebarEl = document.querySelector('.sidebar')
const sidebarBackdrop = document.getElementById('sidebarBackdrop')
const mobileMenuBtn = document.getElementById('mobileMenuBtn')
function setSidebarOpen(open) {
  if (sidebarEl) sidebarEl.classList.toggle('open', open)
  if (sidebarBackdrop) sidebarBackdrop.classList.toggle('open', open)
  if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
}
if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => setSidebarOpen(!sidebarEl.classList.contains('open')))
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false))

navLinks.forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault()
    const pageId = link.dataset.page
    // Same hash won't fire 'hashchange', so re-render manually; otherwise let the
    // hashchange listener drive switchPage so the URL stays the single source of truth.
    if (location.hash.slice(1) === pageId) switchPage(pageId)
    else location.hash = pageId
    setSidebarOpen(false) // close the drawer after navigating on mobile
  })
})


// ============================================================
// === i18n nav + static element rendering ===
// ============================================================

// Map: data-page value -> nav i18n key.
const NAV_I18N = {
  overview: 'nav.overview', kanban: 'nav.kanban', archived: 'nav.archived',
  agents: 'nav.agents', activity: 'nav.activity', team: 'nav.team',
  messages: 'nav.messages', tasks: 'nav.tasks', memories: 'nav.memories',
  recall: 'nav.recall', naplo: 'nav.recall', bgTasks: 'nav.bgTasks',
  skills: 'nav.skills', connectors: 'nav.connectors', migrate: 'nav.migrate',
  docs: 'nav.docs', status: 'nav.status', autonomy: 'nav.autonomy',
  settings: 'nav.settings', vault: 'nav.vault', tokenUsage: 'nav.tokenUsage',
  ideas: 'nav.ideas', updates: 'nav.updates',
}

function renderNav() {
  document.querySelectorAll('.sb-link[data-page] .sb-label').forEach((span) => {
    const page = span.closest('[data-page]')?.dataset?.page
    if (page && NAV_I18N[page]) span.textContent = t(NAV_I18N[page])
  })
}

// Map: element ID -> i18n key, for static HTML elements not handled by page render fns.
const STATIC_I18N_MAP = {
  // Kanban column headers
  'countPlanned':   null,  // dynamic count, skip
  // Overview
  'overviewTeamMeta': 'overview.card.team_meta',
  // Docs
  'docsContent': null,  // rendered by JS
}

// Simpler approach: update known static text nodes directly by selector.
// Page id -> { title key, subtitle key (or null) }
const PAGE_HEADER_I18N = {
  agentsPage:     { title: 'agents.page_title',     sub: 'agents.page_subtitle' },
  activityPage:   { title: 'activity.page_title',   sub: 'activity.page_subtitle' },
  tasksPage:      { title: 'tasks.page_title',       sub: 'tasks.page_subtitle' },
  skillsPage:     { title: 'skills.page_title',      sub: 'skills.page_subtitle' },
  memoriesPage:   { title: 'memories.page_title',    sub: 'memories.page_subtitle' },
  recallPage:     { title: 'recall.page_title',      sub: 'recall.page_subtitle' },
  bgTasksPage:    { title: 'bgTasks.page_title',     sub: 'bgTasks.page_subtitle' },
  connectorsPage: { title: 'connectors.page_title',  sub: 'connectors.page_subtitle' },
  migratePage:    { title: 'migrate.page_title',     sub: 'migrate.page_subtitle' },
  docsPage:       { title: 'docs.page_title',        sub: 'docs.page_subtitle' },
  statusPage:     { title: 'status.page_title',      sub: 'status.page_subtitle' },
  teamPage:       { title: 'team.page_title',        sub: 'team.page_subtitle' },
  messagesPage:   { title: 'messages.page_title',    sub: 'messages.page_subtitle' },
  autonomyPage:   { title: 'autonomy.page_title',    sub: 'autonomy.page_subtitle' },
  settingsPage:   { title: 'settings.page_title',    sub: 'settings.page_subtitle' },
  ideasPage:      { title: 'ideas.page_title',       sub: 'ideas.page_subtitle' },
  vaultPage:      { title: 'vault.page_title',       sub: 'vault.page_subtitle' },
  tokenUsagePage: { title: 'tokenUsage.page_title',  sub: 'tokenUsage.page_subtitle' },
  updatesPage:    { title: 'updates.page_title',     sub: null },
  naploPage:      { title: 'naplo.page_title',       sub: 'naplo.page_subtitle' },
}

function renderStaticI18n() {
  // Page headers + subtitles
  for (const [pageId, keys] of Object.entries(PAGE_HEADER_I18N)) {
    const pageEl = document.getElementById(pageId)
    if (!pageEl) continue
    const h1 = pageEl.querySelector('.page-header h1')
    if (h1 && keys.title) h1.textContent = t(keys.title)
    const sub = pageEl.querySelector('.page-header .subtitle')
    if (sub && keys.sub) sub.textContent = t(keys.sub)
  }
  // Kanban column titles
  const colTitles = document.querySelectorAll('.kanban-col-title')
  const statusKeys = ['kanban.col.planned', 'kanban.col.in_progress', 'kanban.col.waiting', 'kanban.col.done']
  const statuses = ['planned', 'in_progress', 'waiting', 'done']
  colTitles.forEach((el) => {
    const status = el.closest('[data-status]')?.dataset?.status
    if (status) {
      const idx = statuses.indexOf(status)
      if (idx !== -1) el.textContent = t(statusKeys[idx])
    }
  })
  // Docs hints
  const docsHint = document.getElementById('docsContent')
  if (docsHint && docsHint.querySelector('p.muted')) {
    docsHint.querySelector('p.muted').textContent = t('docs.select_hint')
  }
  // Messages empty state
  const chatEmpty = document.querySelector('.chat-thread-empty p')
  if (chatEmpty) chatEmpty.textContent = t('messages.select_agent')
  // Team hint
  const teamHint = document.querySelector('#teamPage > p')
  if (teamHint) teamHint.textContent = t('team.hint')

  // Overview stat labels (siblings of statAgents, statTasks, statMemories, statSkills)
  const statLabelKeys = ['overview.stat.agents', 'overview.stat.tasks', 'overview.stat.memories', 'overview.stat.skills']
  const statValueIds = ['statAgents', 'statTasks', 'statMemories', 'statSkills']
  statValueIds.forEach((id, i) => {
    const valEl = document.getElementById(id)
    if (valEl) {
      const labelEl = valEl.parentElement?.querySelector('.overview-stat-label')
      if (labelEl) labelEl.textContent = t(statLabelKeys[i])
    }
  })

  // Overview card headers
  const overviewTeamH3 = document.querySelector('#overviewPage .overview-grid .overview-card:nth-child(1) h3')
  if (overviewTeamH3) overviewTeamH3.textContent = t('overview.card.team')
  const overviewTeamMeta = document.getElementById('overviewTeamMeta')
  if (overviewTeamMeta) overviewTeamMeta.textContent = t('overview.meta.live')
  const overviewActivityH3 = document.querySelector('#overviewPage .overview-grid .overview-card:nth-child(2) h3')
  if (overviewActivityH3) overviewActivityH3.textContent = t('overview.card.activity')
  const overviewAgentH3 = document.querySelector('#overviewPage .overview-grid .overview-card:nth-child(3) h3')
  if (overviewAgentH3) overviewAgentH3.textContent = t('overview.card.agent_activity')
  const overviewAgentMeta = document.querySelector('#overviewPage .overview-grid .overview-card:nth-child(3) .overview-card-meta')
  if (overviewAgentMeta) overviewAgentMeta.textContent = t('overview.meta.messages')

  // Kanban filter labels
  const kanbanProjectLabel = document.querySelector('label[for="kanbanProjectFilter"]')
  if (kanbanProjectLabel) kanbanProjectLabel.textContent = t('kanban.filter.project_label')
  const kanbanGroupLabel = document.querySelector('label[for="kanbanGroupBy"]')
  if (kanbanGroupLabel) kanbanGroupLabel.textContent = t('kanban.filter.group_label')

  // Kanban project filter "Mind" option (first option)
  const kanbanProjectFilter = document.getElementById('kanbanProjectFilter')
  if (kanbanProjectFilter?.options[0]) kanbanProjectFilter.options[0].text = t('kanban.filter.all_projects')

  // Kanban group-by options
  const kanbanGroupBy = document.getElementById('kanbanGroupBy')
  if (kanbanGroupBy) {
    const opts = kanbanGroupBy.options
    if (opts[0]) opts[0].text = t('kanban.filter.group_none')
    if (opts[1]) opts[1].text = t('kanban.filter.group_assignee')
    if (opts[2]) opts[2].text = t('kanban.filter.group_priority')
  }

  // Generic data-i18n sweep for static HTML elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const val = t(el.dataset.i18n)
    if (el.children.length === 0) {
      el.textContent = val
    } else {
      const nodes = [...el.childNodes]
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].nodeType === 3 && nodes[i].textContent.trim()) {
          nodes[i].textContent = ' ' + val
          break
        }
      }
    }
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  })
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel))
  })
  // Elements whose translation contains inline markup (strong/code/a): set innerHTML.
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml)
  })
}

// Initial render on page load.
document.addEventListener('DOMContentLoaded', () => {
  renderNav()
  renderStaticI18n()
}, { once: true })
// Fallback if DOMContentLoaded already fired (scripts deferred).
if (document.readyState !== 'loading') {
  renderNav()
  renderStaticI18n()
}

// ============================================================
// === Activity (live agent status) ===
// ============================================================

let activityTimer = null

const ACTIVITY_STATE_META = {
  working: { label: () => t('activity.state.working'), cls: 'act-working', tip: 'Élő állapot (a tmux pane tartalmából, 3 másodpercenként): éppen dolgozik / gondolkodik.' },
  idle: { label: () => t('activity.state.idle'), cls: 'act-idle', tip: 'Élő állapot (3 másodpercenként): fut, de épp nem csinál semmit.' },
  unknown: { label: () => t('activity.state.unknown'), cls: 'act-unknown', tip: 'Élő állapot: nem sikerült megállapítani a session pane tartalmából.' },
  error: { label: () => t('activity.state.error'), cls: 'act-error', tip: 'Élő állapot: hiba látszik az ágens session paneljén.' },
  stopped: { label: () => t('activity.state.stopped'), cls: 'act-stopped', tip: 'Élő állapot: az ágens session nem fut.' },
}

// === Kanban auto-refresh ===
let kanbanRefreshTimer = null

function startKanbanRefresh() {
  if (kanbanRefreshTimer) clearInterval(kanbanRefreshTimer)
  kanbanRefreshTimer = setInterval(loadKanban, 30000)
}

function stopKanbanRefresh() {
  if (kanbanRefreshTimer) {
    clearInterval(kanbanRefreshTimer)
    kanbanRefreshTimer = null
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopKanbanRefresh()
  } else if (!document.getElementById('kanbanPage').hidden) {
    loadKanban()
    startKanbanRefresh()
  }
})

function startActivityPoll() {
  loadActivity()
  if (activityTimer) clearInterval(activityTimer)
  activityTimer = setInterval(loadActivity, 3000)
}

function stopActivityPoll() {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
}

async function loadActivity() {
  try {
    const res = await fetch('/api/agents/activity')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const entries = await res.json()
    renderActivity(entries)
    const upd = document.getElementById('activityUpdated')
    if (upd) upd.textContent = t('activity.updated', { time: new Date().toLocaleTimeString('hu-HU') })
  } catch (e) {
    const list = document.getElementById('activityList')
    if (list) list.innerHTML = '<p class="activity-empty">' + t('activity.error_load') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
  }
}

function renderActivity(entries) {
  const list = document.getElementById('activityList')
  if (!list) return
  if (!Array.isArray(entries) || entries.length === 0) {
    list.innerHTML = '<p class="activity-empty">' + t('activity.empty') + '</p>'
    return
  }
  list.innerHTML = entries.map((a) => {
    const metaRaw = ACTIVITY_STATE_META[a.state] || ACTIVITY_STATE_META.unknown
    const meta = { ...metaRaw, label: typeof metaRaw.label === 'function' ? metaRaw.label() : metaRaw.label }
    const tail = (a.tail || []).map((l) => escapeHtml(l)).join('\n')
    const mainBadge = a.isMain ? '<span class="act-main-badge">' + t('activity.badge.main') + '</span>' : ''
    const canOpen = !!a.running
    const termIcon = canOpen
      ? '<svg class="act-term-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="' + t('activity.tooltip.terminal') + '"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
      : ''
    return (
      '<div class="activity-card ' + meta.cls + (canOpen ? ' act-clickable' : '') + '" data-agent="' + escapeHtml(a.name) + '">' +
        '<div class="activity-card-head">' +
          '<span class="activity-name">' + escapeHtml(a.name) + mainBadge + '</span>' +
          '<span style="display:flex;align-items:center;gap:8px">' +
            termIcon +
            '<span class="activity-badge ' + meta.cls + '" title="' + escapeHtml(meta.tip || '') + '">' + meta.label + '</span>' +
          '</span>' +
        '</div>' +
        (tail
          ? '<pre class="activity-tail">' + tail + '</pre>'
          : '<p class="activity-tail-empty">' + (a.running ? 'nincs friss kimenet' : 'a session nem fut') + '</p>') +
      '</div>'
    )
  }).join('')
}

// Event delegation: clicking a running activity-card opens the terminal modal
;(() => {
  const actList = document.getElementById('activityList')
  if (actList) {
    actList.addEventListener('click', (e) => {
      const card = e.target.closest('.activity-card.act-clickable[data-agent]')
      if (card) openTerminalModal(card.dataset.agent)
    })
  }
})()


// ============================================================
// === Kanban ===
// ============================================================

let kanbanCards = []
let kanbanAssignees = []
let kanbanProjects = []
// Label registry (id/name/color), independent of which cards currently carry
// which labels -- card.labels (embedded by GET /api/kanban) holds that link.
let kanbanAllLabels = []
// Active label-filter ids -- the quick-filter chip row AND the per-card
// footer label pills both toggle this same set (two entry points, one
// filter dimension). OR-combined within itself (any active label matches),
// AND-combined with the existing project/assignee filters. Persisted in
// localStorage alongside the swimlane groupBy choice.
let kanbanLabelFilter = new Set()
let kanbanProjectFilter = ''
// Assignee filter for the kanban board. '' = show all. Set via the
// assignee dropdown / "Csak Gábor" toggle injected by setupAssigneeFilter().
// Matched case-insensitively against card.assignee so a casing mismatch
// (e.g. card "gorcsevivan" vs list "GorcsevIvan") still filters correctly.
let kanbanAssigneeFilter = ''
// Swimlane grouping: 'none' (flat board, default) | 'assignee' | 'priority'.
// The initial value is pulled from window._marveen.kanbanSwimlanes.defaultGroup
// the first time loadKanban() runs (see kanbanGroupByInitialized below), then
// fully user-controlled via the toolbar dropdown.
let kanbanGroupBy = 'none'
let kanbanGroupByInitialized = false
// Which swimlane keys (assignee name or priority value) are collapsed. Lives
// for the page session only -- intentionally not persisted across reloads.
const kanbanCollapsedLanes = new Set()

const cardModalOverlay = document.getElementById('cardModalOverlay')
const cardDetailOverlay = document.getElementById('cardDetailOverlay')
const breakdownOverlay = document.getElementById('breakdownOverlay')
let breakdownCardId = null
let breakdownSubtasks = []
// Breakdown modal is shared between kanban-card breakdown and idea promote.
let breakdownMode = 'kanban' // 'kanban' | 'idea'
let breakdownIdeaId = null
const columns = document.querySelectorAll('.kanban-col-body')

// Modal wiring
document.getElementById('cardModalClose').addEventListener('click', () => closeModal(cardModalOverlay))
document.getElementById('cardDetailClose').addEventListener('click', () => closeModal(cardDetailOverlay))
cardModalOverlay.addEventListener('click', (e) => { if (e.target === cardModalOverlay) closeModal(cardModalOverlay) })
cardDetailOverlay.addEventListener('click', (e) => { if (e.target === cardDetailOverlay) closeModal(cardDetailOverlay) })

// Add card buttons per column
document.querySelectorAll('.kanban-add-btn').forEach((btn) => {
  btn.addEventListener('click', () => openNewCardModal(btn.dataset.status))
})

async function loadKanban() {
  try {
    // Always refresh the marveen config so values changed on the Settings page
    // (e.g. WIP limits) show up on the board on the next Kanban open, without a
    // hard reload. The full /api/marveen payload includes kanbanAging, kanbanWip,
    // kanbanSwimlanes and kanbanLabels, so the labels (from the labels feature)
    // stay populated too. Also covers opening the Kanban page first, before the
    // Agents page populated window._marveen.
    try {
      const mr = await fetch('/api/marveen')
      if (mr.ok) window._marveen = { ...(window._marveen || {}), ...(await mr.json()) }
    } catch { /* ignore -- aging/WIP/swimlanes/labels just won't render until _marveen loads */ }
    if (!kanbanGroupByInitialized) {
      kanbanGroupByInitialized = true
      // A user's own past choice (saved to localStorage) wins over the
      // server-configured default, so switching the grouping sticks across
      // page reloads instead of resetting every time.
      const stored = localStorage.getItem('marveen.kanbanGroupBy')
      const defaultGroup = window._marveen?.kanbanSwimlanes?.defaultGroup
      const initialGroup = (stored === 'assignee' || stored === 'priority' || stored === 'none')
        ? stored
        : (defaultGroup === 'assignee' || defaultGroup === 'priority' ? defaultGroup : 'none')
      if (initialGroup !== 'none') {
        kanbanGroupBy = initialGroup
        const sel = document.getElementById('kanbanGroupBy')
        if (sel) sel.value = initialGroup
      }
      // Active label-filter selection, restored the same way as the groupBy
      // choice -- a fresh page load should not lose the filters set up.
      try {
        const storedLabels = JSON.parse(localStorage.getItem('marveen.kanbanLabelFilter') || '[]')
        if (Array.isArray(storedLabels)) kanbanLabelFilter = new Set(storedLabels)
      } catch { /* ignore malformed storage */ }
    }
    const [cardsRes, assigneesRes, projectsRes, labelsRes] = await Promise.all([
      fetch('/api/kanban'),
      fetch('/api/kanban/assignees'),
      fetch('/api/kanban-projects'),
      fetch('/api/kanban/labels'),
    ])
    kanbanCards = await cardsRes.json()
    kanbanAssignees = await assigneesRes.json()
    kanbanProjects = await projectsRes.json()
    kanbanAllLabels = await labelsRes.json()
    populateProjectFilter()
    populateProjectSuggestions()
    setupAssigneeFilter()
    renderKanban()
  } catch (err) {
    console.error('Kanban betöltés hiba:', err)
  }
}

document.getElementById('kanbanGroupBy').addEventListener('change', (e) => {
  kanbanGroupBy = e.target.value
  localStorage.setItem('marveen.kanbanGroupBy', kanbanGroupBy)
  renderKanban()
})

function populateProjectFilter() {
  const sel = document.getElementById('kanbanProjectFilter')
  const prev = sel.value
  sel.innerHTML = '<option value="">Mind</option>'
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p
    if (p === prev) opt.selected = true
    sel.appendChild(opt)
  }
  if (prev && !kanbanProjects.includes(prev)) kanbanProjectFilter = ''
}

function populateProjectSuggestions() {
  const dl = document.getElementById('projectSuggestions')
  if (!dl) return
  dl.innerHTML = ''
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    dl.appendChild(opt)
  }
}

document.getElementById('kanbanProjectFilter').addEventListener('change', (e) => {
  kanbanProjectFilter = e.target.value
  renderKanban()
})

// The kanban "owner" is the assignee whose type is 'owner' -- the person the
// board is primarily run for, on any deployment. Identified by type, never by
// a hard-coded display name, so the quick "show what's on me" view is generic.
// Returns null when no owner-type assignee exists (then the quick button is
// hidden and only the general per-assignee dropdown is shown).
function ownerAssigneeName() {
  const owner = kanbanAssignees.find((a) => a.type === 'owner')
  return owner ? owner.name : null
}

// Reflect the active state of the owner quick-toggle button (hidden when there
// is no owner-type assignee).
function syncOwnerFilterBtn() {
  const btn = document.getElementById('kanbanOwnerBtn')
  if (!btn) return
  const owner = ownerAssigneeName()
  if (!owner) { btn.style.display = 'none'; return }
  btn.style.display = ''
  const on = !!kanbanAssigneeFilter && kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
  btn.style.background = on ? 'var(--accent)' : 'var(--bg)'
  btn.style.color = on ? '#081a2d' : 'var(--fg)'
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
}

// Inject the assignee filter (per-assignee dropdown + an owner "Rám vár" quick
// toggle) into the kanban toolbar. Built in JS rather than as static markup so
// the toolbar stays self-contained. Idempotent: the controls are created once;
// later calls only refresh the <option>s from the current assignee list.
function setupAssigneeFilter() {
  const projectSel = document.getElementById('kanbanProjectFilter')
  if (!projectSel) return
  const toolbar = projectSel.parentElement
  let sel = document.getElementById('kanbanAssigneeFilter')
  if (!sel) {
    const label = document.createElement('label')
    label.setAttribute('for', 'kanbanAssigneeFilter')
    label.textContent = t('kanban.filter.assignee_label')
    label.style.cssText = 'font-size:13px;color:var(--muted);white-space:nowrap;margin-left:8px;'

    sel = document.createElement('select')
    sel.id = 'kanbanAssigneeFilter'
    sel.style.cssText = 'font-size:13px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);min-width:140px;'
    sel.addEventListener('change', (e) => {
      kanbanAssigneeFilter = e.target.value
      syncOwnerFilterBtn()
      renderKanban()
    })

    const ownerBtn = document.createElement('button')
    ownerBtn.id = 'kanbanOwnerBtn'
    ownerBtn.type = 'button'
    ownerBtn.textContent = t('kanban.filter.owner_btn')
    ownerBtn.title = t('kanban.owner_filter')
    ownerBtn.style.cssText = 'font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer;'
    ownerBtn.addEventListener('click', () => {
      const owner = ownerAssigneeName()
      if (!owner) return
      const on = kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
      kanbanAssigneeFilter = on ? '' : owner
      // Keep the dropdown in sync (only selectable if the owner is a known assignee).
      sel.value = kanbanAssignees.some((a) => a.name === kanbanAssigneeFilter) ? kanbanAssigneeFilter : ''
      syncOwnerFilterBtn()
      renderKanban()
    })

    toolbar.appendChild(label)
    toolbar.appendChild(sel)
    toolbar.appendChild(ownerBtn)
  }

  // (Re)populate options from the current assignee list, preserving selection.
  const prev = kanbanAssigneeFilter
  sel.innerHTML = '<option value="">Mind</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    // Show the persona displayName (id as fallback), matching #216; the
    // option value / filter key stays the agent id.
    opt.textContent = a.displayName || a.name
    if (a.name === prev) opt.selected = true
    sel.appendChild(opt)
  }
  // syncOwnerFilterBtn shows/hides the owner quick-button based on whether an
  // owner-type assignee exists in the freshly loaded list.
  syncOwnerFilterBtn()
}

// Project + assignee + label filters, independent of the priority quick-filter
// Project + assignee filters only -- the baseline the label quick-filter
// chip counts are computed against, independent of which labels are
// currently active, so a chip's count stays meaningful whether it's the one
// being toggled or not.
function kanbanCardMatchesBaseFilters(card) {
  if (kanbanProjectFilter && (card.project || '') !== kanbanProjectFilter) return false
  const assigneeFilter = kanbanAssigneeFilter.toLowerCase()
  if (assigneeFilter && String(card.assignee || '').trim().toLowerCase() !== assigneeFilter) return false
  return true
}

// The label-filter dimension itself: a card matches when no label filter is
// active, or when it carries at least one of the active labels (OR within
// the dimension).
function kanbanCardMatchesLabelFilter(card) {
  if (kanbanLabelFilter.size === 0) return true
  const cardLabelIds = (card.labels || []).map((l) => l.id)
  return cardLabelIds.some((id) => kanbanLabelFilter.has(id))
}

// Shared by both the header quick-filter chips and the per-card footer label
// pills -- one filter dimension, two entry points into the same toggle.
function toggleKanbanLabelFilter(labelId) {
  if (kanbanLabelFilter.has(labelId)) kanbanLabelFilter.delete(labelId)
  else kanbanLabelFilter.add(labelId)
  persistKanbanFilters()
  renderKanban()
}

function clearKanbanQuickFilters() {
  kanbanLabelFilter.clear()
  persistKanbanFilters()
  renderKanban()
}

function persistKanbanFilters() {
  localStorage.setItem('marveen.kanbanLabelFilter', JSON.stringify([...kanbanLabelFilter]))
}

// Quick-filter chip row: one chip per defined label (not per priority), tinted
// with that label's own colour. Clicking toggles the same kanbanLabelFilter
// set the footer pills use.
function renderKanbanQuickFilters() {
  const row = document.getElementById('kanbanQuickFilters')
  if (!row) return
  row.innerHTML = ''
  for (const label of kanbanAllLabels) {
    const count = kanbanCards.filter((c) =>
      kanbanCardMatchesBaseFilters(c) && (c.labels || []).some((l) => l.id === label.id)
    ).length
    const active = kanbanLabelFilter.has(label.id)
    const chip = document.createElement('span')
    chip.className = 'kanban-quick-filter-chip' + (active ? ' active' : '')
    chip.dataset.labelId = label.id
    chip.style.setProperty('--chip-color', label.color)
    chip.innerHTML = `#${escapeHtml(label.name)} <span class="kanban-quick-filter-count">${count}</span>${active ? '<span class="kanban-quick-filter-clear">&times;</span>' : ''}`
    chip.addEventListener('click', () => toggleKanbanLabelFilter(label.id))
    row.appendChild(chip)
  }
  if (kanbanLabelFilter.size > 0) {
    const clearAll = document.createElement('button')
    clearAll.className = 'kanban-quick-filter-clear-all'
    clearAll.textContent = t('kanban.filter.clear')
    clearAll.addEventListener('click', clearKanbanQuickFilters)
    row.appendChild(clearAll)
  }
}

function renderKanban() {
  const cardById = new Map(kanbanCards.map(c => [c.id, c]))

  renderKanbanQuickFilters()

  // Determine which top-level cards are visible under current filters.
  const visibleCardIds = new Set()
  for (const card of kanbanCards) {
    if (!kanbanCardMatchesBaseFilters(card)) continue
    if (!kanbanCardMatchesLabelFilter(card)) continue
    visibleCardIds.add(card.id)
  }

  // A subtask is "embedded" when its parent is visible AND both share the same
  // column. Embedded subtasks are hidden as standalone cards and rendered
  // inside the parent card instead. Filter state of the subtask itself is
  // intentionally ignored so it always shows under its visible parent.
  const embeddedSubtaskIds = new Set()
  for (const card of kanbanCards) {
    if (!card.parent_id) continue
    const parent = cardById.get(card.parent_id)
    if (!parent || !visibleCardIds.has(parent.id)) continue
    if (parent.status === card.status) embeddedSubtaskIds.add(card.id)
  }

  const grouped = { planned: [], in_progress: [], waiting: [], done: [] }
  for (const card of kanbanCards) {
    if (embeddedSubtaskIds.has(card.id)) continue
    if (!visibleCardIds.has(card.id)) continue
    if (grouped[card.status]) grouped[card.status].push(card)
  }

  // Update counts (embedded subtasks don't count as separate cards)
  document.getElementById('countPlanned').textContent = grouped.planned.length
  document.getElementById('countInProgress').textContent = grouped.in_progress.length
  document.getElementById('countWaiting').textContent = grouped.waiting.length
  document.getElementById('countDone').textContent = grouped.done.length

  const flatBoard = document.getElementById('kanbanBoard')
  const swimlaneBoard = document.getElementById('kanbanSwimlaneBoard')

  if (kanbanGroupBy === 'none') {
    swimlaneBoard.hidden = true
    flatBoard.hidden = false
    for (const [status, cards] of Object.entries(grouped)) {
      const col = document.querySelector(`#kanbanBoard .kanban-col-body[data-status="${status}"]`)
      col.innerHTML = ''
      cards.sort((a, b) => a.sort_order - b.sort_order)

      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        col.appendChild(createCardEl(card, embeddedChildren))
      }
    }
    // Badge: only count subtasks that are in a different column (not embedded here)
    updateSubtaskBadges(embeddedSubtaskIds)
    // WIP limit badges (count/limit + colour) on the flat board too -- previously
    // only the swimlane view updated these, so a configured limit never showed
    // on the default flat board.
    updateWipBadges(grouped)
  } else {
    flatBoard.hidden = true
    swimlaneBoard.hidden = false
    renderSwimlaneBoard(grouped, embeddedSubtaskIds)
  }
}

const KANBAN_STATUS_DEFS = [
  { status: 'planned', title: () => t('kanban.col.planned') },
  { status: 'in_progress', title: () => t('kanban.col.in_progress') },
  { status: 'waiting', title: () => t('kanban.col.waiting') },
  { status: 'done', title: () => t('kanban.col.done') },
]
const KANBAN_PRIORITY_LABELS = { urgent: () => t('kanban.priority.urgent'), high: () => t('kanban.priority.high'), normal: () => t('kanban.priority.normal'), low: () => t('kanban.priority.low') }
const KANBAN_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

// Which swimlane a card belongs to under the current grouping. Returns a
// stable string key: the matched assignee's canonical name, '__unassigned__'
// for cards with no/unmatched assignee, or the priority value.
function kanbanSwimlaneKeyFor(card) {
  if (kanbanGroupBy === 'priority') return card.priority || 'normal'
  const raw = card.assignee ? String(card.assignee).trim() : ''
  if (!raw) return '__unassigned__'
  const match = kanbanAssignees.find(a => a.name.toLowerCase() === raw.toLowerCase())
  return match ? match.name : raw
}

// Display metadata (label + avatar styling) for a swimlane key.
function kanbanSwimlaneMeta(key) {
  if (kanbanGroupBy === 'priority') {
    const _rawPL = KANBAN_PRIORITY_LABELS[key]; const label = _rawPL ? (typeof _rawPL === 'function' ? _rawPL() : _rawPL) : key
    return { label, avatarClass: `priority-${key}`, avatarChar: '' }
  }
  if (key === '__unassigned__') return { label: t('kanban.unassigned'), avatarClass: 'unknown', avatarChar: '?' }
  const match = kanbanAssignees.find(a => a.name === key)
  const label = match ? (match.displayName || match.name) : key
  return { label, avatarClass: match ? match.type : 'unknown', avatarChar: (label[0] || '?').toUpperCase() }
}

function renderSwimlaneBoard(grouped, embeddedSubtaskIds) {
  const board = document.getElementById('kanbanSwimlaneBoard')
  board.innerHTML = ''

  const presentKeys = new Set()
  for (const cards of Object.values(grouped)) {
    for (const c of cards) presentKeys.add(kanbanSwimlaneKeyFor(c))
  }

  const canonicalOrder = kanbanGroupBy === 'priority'
    ? KANBAN_PRIORITY_ORDER
    : [...kanbanAssignees.map(a => a.name), '__unassigned__']
  const orderedKeys = canonicalOrder.filter(k => presentKeys.has(k))
  const leftoverKeys = [...presentKeys].filter(k => !orderedKeys.includes(k)).sort((a, b) => a.localeCompare(b))
  const keys = [...orderedKeys, ...leftoverKeys]

  const separatorColor = window._marveen?.kanbanSwimlanes?.separatorColor

  for (const key of keys) {
    const meta = kanbanSwimlaneMeta(key)
    const collapsed = kanbanCollapsedLanes.has(key)

    const laneCardsByStatus = {}
    let totalCount = 0
    for (const def of KANBAN_STATUS_DEFS) {
      const cards = grouped[def.status].filter(c => kanbanSwimlaneKeyFor(c) === key)
      laneCardsByStatus[def.status] = cards
      totalCount += cards.length
    }

    const lane = document.createElement('div')
    lane.className = 'kanban-swimlane' + (collapsed ? ' collapsed' : '')
    lane.dataset.group = key
    if (separatorColor) lane.style.borderBottomColor = separatorColor

    const header = document.createElement('div')
    header.className = 'kanban-swimlane-header'
    header.innerHTML = `
      <span class="kanban-swimlane-avatar ${meta.avatarClass}">${escapeHtml(meta.avatarChar)}</span>
      <span class="kanban-swimlane-name">${escapeHtml(meta.label)}</span>
      <span class="kanban-swimlane-count">${totalCount}</span>
      <button class="kanban-swimlane-toggle" type="button" aria-expanded="${!collapsed}" title="${collapsed ? t('kanban.swimlane.expand') : t('kanban.swimlane.collapse')}">${collapsed ? '▶' : '▼'}</button>
    `
    header.querySelector('.kanban-swimlane-toggle').addEventListener('click', (e) => {
      e.stopPropagation()
      if (kanbanCollapsedLanes.has(key)) kanbanCollapsedLanes.delete(key)
      else kanbanCollapsedLanes.add(key)
      renderKanban()
    })
    lane.appendChild(header)

    const body = document.createElement('div')
    body.className = 'kanban-swimlane-body'
    for (const def of KANBAN_STATUS_DEFS) {
      const col = document.createElement('div')
      col.className = 'kanban-swimlane-col'

      const colHeader = document.createElement('div')
      colHeader.className = 'kanban-swimlane-col-header'
      colHeader.textContent = typeof def.title === 'function' ? def.title() : def.title

      const colBody = document.createElement('div')
      colBody.className = 'kanban-col-body kanban-swimlane-col-body'
      colBody.dataset.status = def.status

      const cards = laneCardsByStatus[def.status].sort((a, b) => a.sort_order - b.sort_order)
      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        colBody.appendChild(createCardEl(card, embeddedChildren))
      }
      wireKanbanColumnDnD(colBody)

      col.appendChild(colHeader)
      col.appendChild(colBody)
      body.appendChild(col)
    }
    lane.appendChild(body)
    board.appendChild(lane)
  }

  updateSubtaskBadges(embeddedSubtaskIds)

  // WIP limit badges: update column-header count spans with "count/limit" when configured
  updateWipBadges(grouped)
}

// Map column status keys to their count-span IDs
const WIP_COUNT_IDS = {
  planned: 'countPlanned',
  in_progress: 'countInProgress',
  waiting: 'countWaiting',
  done: 'countDone',
}

function updateWipBadges(grouped) {
  const cfg = window._marveen?.kanbanWip
  for (const [status, cards] of Object.entries(grouped)) {
    const el = document.getElementById(WIP_COUNT_IDS[status])
    if (!el) continue
    const limit = cfg?.limits?.[status] || 0
    if (!limit) {
      // No limit configured: restore plain count and clear WIP styling
      el.textContent = cards.length
      delete el.dataset.wip
      el.style.color = ''
      el.style.borderColor = ''
      continue
    }
    const count = cards.length
    el.textContent = `${count}/${limit}`
    let state, color
    if (count > limit) {
      state = 'over'; color = cfg.overColor
    } else if (count === limit) {
      state = 'full'; color = cfg.fullColor
    } else if ((count / limit) * 100 >= cfg.warnPct) {
      state = 'warn'; color = cfg.warnColor
    } else {
      state = 'ok'; color = cfg.okColor
    }
    el.dataset.wip = state
    el.style.color = color
    el.style.borderColor = color
  }
}

function updateSubtaskBadges(embeddedSubtaskIds) {
  for (const el of document.querySelectorAll('.kanban-card[data-id]')) {
    const id = el.dataset.id
    const badge = el.querySelector('.kanban-subtask-badge')
    if (!badge) continue
    const nonEmbedded = kanbanCards.filter(c => c.parent_id === id && !embeddedSubtaskIds.has(c.id))
    if (nonEmbedded.length > 0) {
      badge.textContent = `${nonEmbedded.length} subtask`
      badge.style.display = ''
      badge.onclick = (e) => {
        e.stopPropagation()
        const card = kanbanCards.find(c => c.id === id)
        if (card) showCardDetail(card)
      }
    } else {
      badge.style.display = 'none'
    }
  }
}

function createCardEl(card, embeddedChildren = []) {
  const el = document.createElement('div')
  el.className = 'kanban-card'
  el.dataset.id = card.id
  el.dataset.priority = card.priority
  el.draggable = true

  // Assignee chip. Match the card's assignee against the known list
  // case-insensitively (a card stored as "gorcsevivan" must still match the
  // list entry "GorcsevIvan"). When the assignee is set but not in the list
  // at all, still render a fallback chip with the raw name + a neutral dot,
  // so a card never silently loses its assignee chip on a name mismatch.
  const rawAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawAssignee.toLowerCase())
    : null
  // Display the persona displayName (falling back to the id) per #216, while
  // keeping the robust match above and the raw-name fallback chip below.
  const assigneeLabel = assignee ? (assignee.displayName || assignee.name) : ''
  const assigneeHtml = assignee
    ? `<span class="kanban-card-assignee"><span class="assignee-dot ${assignee.type}">${escapeHtml(assigneeLabel[0])}</span>${escapeHtml(assigneeLabel)}</span>`
    : rawAssignee
      ? `<span class="kanban-card-assignee"><span class="assignee-dot unknown">${escapeHtml(rawAssignee[0])}</span>${escapeHtml(rawAssignee)}</span>`
      : ''

  let dueHtml = ''
  if (card.due_date) {
    const d = new Date(card.due_date * 1000)
    const now = new Date()
    const overdue = d < now && card.status !== 'done'
    const label = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
    dueHtml = `<span class="kanban-card-due ${overdue ? 'overdue' : ''}">${label}</span>`
  }

  const projectHtml = card.project
    ? `<span class="kanban-card-project">${escapeHtml(card.project)}</span>`
    : ''

  // Label footer pills: at most 3 shown + a "+N" overflow indicator. Each pill
  // (except the overflow one) toggles that label into the active label-filter
  // when clicked, mirroring the priority quick-filter chips above the board.
  let labelsHtml = ''
  if (Array.isArray(card.labels) && card.labels.length > 0) {
    const shown = card.labels.slice(0, 3)
    const overflow = card.labels.length - shown.length
    const pills = shown.map((l) =>
      `<span class="kanban-card-label-pill" data-label-id="${escapeHtml(l.id)}" style="--label-color:${escapeHtml(l.color)}" title="${t('kanban.label.filter_tooltip', { name: escapeHtml(l.name) })}">#${escapeHtml(l.name)}</span>`
    ).join('')
    const overflowHtml = overflow > 0
      ? `<span class="kanban-card-label-pill kanban-card-label-overflow" title="${t('kanban.label.overflow_tooltip', { n: overflow })}">+${overflow}</span>`
      : ''
    labelsHtml = `<div class="kanban-card-labels">${pills}${overflowHtml}</div>`
  }

  const seqHtml = card.seq != null
    ? `<span class="kanban-card-seq" style="font-family:monospace;font-size:11px;color:var(--muted);margin-right:5px">#${card.seq}</span>`
    : ''

  // Card aging: left stripe + top-right badge based on hours since last update.
  // Skipped for done cards. Config thresholds and colours come from window._marveen.kanbanAging.
  let agingBadgeHtml = ''
  const agingCfg = window._marveen?.kanbanAging
  if (agingCfg && card.updated_at && card.status !== 'done') {
    const hoursOld = (Date.now() / 1000 - card.updated_at) / 3600
    let agingLevel = null
    let agingColor = null
    if (hoursOld >= agingCfg.criticalH) {
      agingLevel = 'critical'; agingColor = agingCfg.criticalColor
    } else if (hoursOld >= agingCfg.cautionH) {
      agingLevel = 'caution'; agingColor = agingCfg.cautionColor
    } else if (hoursOld >= agingCfg.warnH) {
      agingLevel = 'warn'; agingColor = agingCfg.warnColor
    }
    if (agingLevel) {
      const days = Math.floor(hoursOld / 24)
      const ageLabel = days >= 1 ? `${days}d` : `${Math.floor(hoursOld)}h`
      const exact = new Date(card.updated_at * 1000).toLocaleString('hu-HU')
      agingBadgeHtml = `<span class="kanban-card-aging-badge kanban-card-aging-${agingLevel}" style="color:${agingColor}" title="${t('kanban.aging.tooltip', { exact })}">⏳ ${ageLabel}</span>`
      el.dataset.aging = agingLevel
      el.style.setProperty('--card-aging-color', agingColor)
    }
  }

  // Embedded subtasks: rendered as mini-cards below a divider when the subtask
  // shares the same column as this parent card.
  let embeddedHtml = ''
  if (embeddedChildren.length > 0) {
    const items = embeddedChildren.map(c => {
      const rawCa = c.assignee ? String(c.assignee).trim() : ''
      const ca = rawCa ? kanbanAssignees.find(a => a.name.toLowerCase() === rawCa.toLowerCase()) : null
      const caLabel = ca ? (ca.displayName || ca.name) : rawCa
      const caHtml = caLabel ? `<span class="kanban-embedded-assignee">${escapeHtml(caLabel)}</span>` : ''
      const cSeq = c.seq != null ? `<span class="kanban-embedded-seq">#${c.seq}</span> ` : ''
      return `<div class="kanban-embedded-subtask" data-id="${escapeHtml(c.id)}">${cSeq}${escapeHtml(c.title)}${caHtml}</div>`
    }).join('')
    embeddedHtml = `<div class="kanban-embedded-subtasks">${items}</div>`
  }

  el.innerHTML = `
    ${projectHtml}
    <div class="kanban-card-title">${seqHtml}${escapeHtml(card.title)}</div>
    <div class="kanban-card-footer">${assigneeHtml}${dueHtml}</div>
    ${labelsHtml}
    <div class="kanban-card-actions">
      <button class="card-breakdown-btn" title="${t('kanban.btn.breakdown')}" aria-label="${t('kanban.btn.breakdown')}">⚡</button>
    </div>
    ${agingBadgeHtml}
    <div class="kanban-subtask-badge" style="display:none"></div>
    ${embeddedHtml}
  `

  // "AI szétbont" gomb – ne nyissa meg a detail modalt
  el.querySelector('.card-breakdown-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    triggerBreakdown(card)
  })

  // Label pills -> toggle that label into the active filter (don't open detail)
  el.querySelectorAll('.kanban-card-label-pill[data-label-id]').forEach((pillEl) => {
    pillEl.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleKanbanLabelFilter(pillEl.dataset.labelId)
    })
  })

  // Click on embedded subtask -> open that subtask's detail (don't bubble to parent)
  el.querySelectorAll('.kanban-embedded-subtask').forEach(subEl => {
    subEl.addEventListener('click', (e) => {
      e.stopPropagation()
      const child = kanbanCards.find(c => c.id === subEl.dataset.id)
      if (child) showCardDetail(child)
    })
  })

  // Drag events
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging')
    e.dataTransfer.setData('text/plain', card.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragend', () => el.classList.remove('dragging'))

  // Click -> detail
  el.addEventListener('click', () => showCardDetail(card))

  return el
}

// === Drag & Drop ===
// Wires the drag/drop handlers for one column-body element. Used for the
// 4 static flat-board columns at load time, and again for every swimlane
// column-body created dynamically in renderSwimlaneBoard (those elements
// don't exist yet when this module first runs).
function wireKanbanColumnDnD(col) {
  col.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    col.classList.add('drag-over')

    // Insert indicator position
    const afterEl = getDragAfterElement(col, e.clientY)
    const dragging = document.querySelector('.kanban-card.dragging')
    if (!dragging) return
    if (afterEl) {
      col.insertBefore(dragging, afterEl)
    } else {
      col.appendChild(dragging)
    }
  })

  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over')
  })

  col.addEventListener('drop', async (e) => {
    e.preventDefault()
    col.classList.remove('drag-over')
    const cardId = e.dataTransfer.getData('text/plain')
    const newStatus = col.dataset.status

    // Calculate sort_order based on position
    const cards = [...col.querySelectorAll('.kanban-card')]
    const idx = cards.findIndex((c) => c.dataset.id === cardId)
    let sortOrder = idx

    try {
      await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, sort_order: sortOrder }),
      })
      loadKanban()
    } catch {
      showToast(t('kanban.toast.move_error'))
    }
  })
}
columns.forEach(wireKanbanColumnDnD)

function getDragAfterElement(col, y) {
  const els = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
  let closest = null
  let closestOffset = Number.NEGATIVE_INFINITY

  for (const el of els) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset
      closest = el
    }
  }
  return closest
}

// === New card modal ===
function openNewCardModal(status) {
  document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_new')
  document.getElementById('cardTitle').value = ''
  document.getElementById('cardDesc').value = ''
  document.getElementById('cardPriority').value = 'normal'
  document.getElementById('cardProject').value = ''
  document.getElementById('cardDue').value = ''
  document.getElementById('cardEditId').value = ''
  document.getElementById('cardEditStatus').value = status || 'planned'
  populateAssigneeSelect('cardAssignee')
  populateProjectSuggestions()
  openModal(cardModalOverlay)
  setTimeout(() => document.getElementById('cardTitle').focus(), 200)
}

function populateAssigneeSelect(selectId, selected) {
  const sel = document.getElementById(selectId)
  sel.innerHTML = '<option value="">-- Nincs --</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    opt.textContent = a.displayName || a.name
    if (selected && a.name === selected) opt.selected = true
    sel.appendChild(opt)
  }
}

// Save card (create or update)
document.getElementById('saveCardBtn').addEventListener('click', async () => {
  const title = document.getElementById('cardTitle').value.trim()
  if (!title) { document.getElementById('cardTitle').focus(); return }

  const data = {
    title,
    description: document.getElementById('cardDesc').value.trim() || null,
    assignee: document.getElementById('cardAssignee').value || null,
    priority: document.getElementById('cardPriority').value,
    project: document.getElementById('cardProject').value.trim() || null,
    due_date: document.getElementById('cardDue').value
      ? Math.floor(new Date(document.getElementById('cardDue').value).getTime() / 1000)
      : null,
  }

  const editId = document.getElementById('cardEditId').value

  try {
    if (editId) {
      const res = await fetch(`/api/kanban/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_updated'))
    } else {
      data.status = document.getElementById('cardEditStatus').value
      const res = await fetch('/api/kanban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_created'))
    }
    closeModal(cardModalOverlay)
    loadKanban()
  } catch (err) {
    showToast(t('kanban.toast.save_error_msg', { msg: err.message }))
  }
})

// === Card labels (in the detail modal) ===
// Always re-fetches the card's own labels via the dedicated endpoint instead
// of trusting card.labels -- callers that pass a card object sourced from
// /api/kanban/:id/children (subtask list) don't have labels embedded, only
// the bulk board listing (/api/kanban) does.
async function renderCardLabelsSection(card) {
  const listEl = document.getElementById('cardLabelList')
  const addSelect = document.getElementById('cardLabelAdd')
  const newBtn = document.getElementById('cardLabelNewBtn')
  const newForm = document.getElementById('cardLabelNewForm')
  const newNameInput = document.getElementById('cardLabelNewName')
  const newColorsEl = document.getElementById('cardLabelNewColors')
  const newSaveBtn = document.getElementById('cardLabelNewSaveBtn')

  let attached = []
  try {
    attached = await (await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`)).json()
  } catch { /* leave empty -- pill list just stays blank */ }

  listEl.innerHTML = ''
  for (const label of attached) {
    const pill = document.createElement('span')
    pill.className = 'label-pill'
    pill.style.setProperty('--label-color', label.color)
    pill.innerHTML = `#${escapeHtml(label.name)} <button class="label-pill-remove" title="${t('kanban.label.remove_btn')}" aria-label="${t('kanban.label.remove_btn')}">&times;</button>`
    pill.querySelector('.label-pill-remove').addEventListener('click', async () => {
      try {
        await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels/${encodeURIComponent(label.id)}`, { method: 'DELETE' })
        renderCardLabelsSection(card)
        loadKanban()
      } catch { showToast(t('kanban.toast.label_remove_error')) }
    })
    listEl.appendChild(pill)
  }

  const attachedIds = new Set(attached.map((l) => l.id))
  addSelect.innerHTML = `<option value="">-- ${t('kanban.label.add_placeholder')} --</option>`
  for (const label of kanbanAllLabels) {
    if (attachedIds.has(label.id)) continue
    const opt = document.createElement('option')
    opt.value = label.id
    opt.textContent = label.name
    addSelect.appendChild(opt)
  }
  addSelect.onchange = async () => {
    const labelId = addSelect.value
    if (!labelId) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId }),
      })
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_add_error')) }
  }

  newForm.style.display = 'none'
  newBtn.onclick = () => {
    newForm.style.display = newForm.style.display === 'none' ? '' : 'none'
    newNameInput.value = ''
  }

  const palette = window._marveen?.kanbanLabels?.colors || ['#64748b']
  newColorsEl.innerHTML = ''
  let selectedColor = palette[0]
  palette.forEach((color, i) => {
    const sw = document.createElement('span')
    sw.className = 'label-color-swatch' + (i === 0 ? ' selected' : '')
    sw.style.background = color
    sw.addEventListener('click', () => {
      selectedColor = color
      newColorsEl.querySelectorAll('.label-color-swatch').forEach((s) => s.classList.remove('selected'))
      sw.classList.add('selected')
    })
    newColorsEl.appendChild(sw)
  })

  newSaveBtn.onclick = async () => {
    const name = newNameInput.value.trim()
    if (!name) { newNameInput.focus(); return }
    try {
      const r = await fetch('/api/kanban/labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: selectedColor }),
      })
      if (!r.ok) { showToast(t('kanban.toast.label_create_error')); return }
      const newLabel = await r.json()
      kanbanAllLabels.push(newLabel)
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId: newLabel.id }),
      })
      newForm.style.display = 'none'
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_create_error')) }
  }
}

// === Card detail ===
async function showCardDetail(card) {
  // Running number (#N) in the title bar, plus the stable hex id in the meta.
  const seqPrefix = card.seq != null ? `#${card.seq} ` : ''
  document.getElementById('cardDetailTitle').textContent = `${seqPrefix}${card.title}`

  // Case-insensitive match; fall back to the raw stored name so a casing
  // mismatch (or an unregistered assignee) shows the actual name, not "nincs".
  const rawDetailAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawDetailAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawDetailAssignee.toLowerCase())
    : null
  const assigneeDisplay = assignee ? (assignee.displayName || assignee.name) : (rawDetailAssignee || '-- nincs --')
  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const statusLabels = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), waiting: t('kanban.status.waiting'), done: t('kanban.status.done') }

  const meta = document.getElementById('cardDetailMeta')
  const idLabel = (card.seq != null ? `#${card.seq} · ` : '') + card.id
  meta.innerHTML = `
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.id')}</span>
      <span class="meta-value" style="font-family:monospace" title="${t('kanban.meta.id_tooltip')}">${escapeHtml(idLabel)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.status')}</span>
      <span class="meta-value">${statusLabels[card.status] || card.status}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.assignee')}</span>
      <span class="meta-value meta-value-editable" id="metaAssigneeValue" data-card-id="${card.id}" title="${t('kanban.meta.edit_tooltip')}">${escapeHtml(assigneeDisplay)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.priority')}</span>
      <span class="meta-value">${priorityLabels[card.priority]}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.project')}</span>
      <span class="meta-value">${card.project ? escapeHtml(card.project) : t('kanban.meta.none')}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.deadline')}</span>
      <span class="meta-value">${card.due_date ? new Date(card.due_date * 1000).toLocaleDateString(_lang === 'en' ? 'en-US' : 'hu-HU') : t('kanban.meta.none')}</span>
    </div>
  `

  // Inline edit for assignee on detail view
  const assigneeValueEl = document.getElementById('metaAssigneeValue')
  assigneeValueEl.addEventListener('click', () => {
    if (assigneeValueEl.querySelector('select')) return
    const current = card.assignee || ''
    const sel = document.createElement('select')
    sel.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:inherit'
    sel.innerHTML = '<option value="">-- Nincs --</option>'
    for (const a of kanbanAssignees) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.displayName || a.name
      if (a.name === current) opt.selected = true
      sel.appendChild(opt)
    }
    assigneeValueEl.innerHTML = ''
    assigneeValueEl.appendChild(sel)
    sel.focus()
    const save = async () => {
      const newVal = sel.value || null
      if (newVal === current || (newVal === null && !current)) {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        return
      }
      try {
        const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...card, assignee: newVal }),
        })
        if (!r.ok) throw new Error('PUT failed')
        card.assignee = newVal
        assigneeValueEl.textContent = newVal ? newVal : '-- nincs --'
        showToast(t('kanban.toast.assignee_updated'))
        loadKanban && loadKanban()
      } catch {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        showToast(t('kanban.toast.save_error'))
      }
    }
    sel.addEventListener('change', save)
    sel.addEventListener('blur', () => {
      if (assigneeValueEl.querySelector('select')) {
        assigneeValueEl.textContent = card.assignee ? card.assignee : '-- nincs --'
      }
    })
  })

  document.getElementById('cardDetailDesc').textContent = card.description || ''

  renderCardLabelsSection(card)

  // #115: Parent meta row — dropdown replaces the old read-only display; shown only when editable
  const parentMetaItem = document.getElementById('parentMetaItem')
  const parentSelect = document.getElementById('parentSelect')
  const canModifyParent = card.status === 'planned' || card.status === 'waiting'
  if (card.parent_id && canModifyParent) {
    // Build the parent-select dropdown: null option + all top-level non-done tasks
    parentSelect.innerHTML = `<option value="">${t('kanban.parent.empty')}</option>`
    const availableParents = kanbanCards.filter(c =>
      !c.parent_id && c.id !== card.id && !c.archived_at &&
      (c.status === 'planned' || c.status === 'in_progress' || c.status === 'waiting')
    )
    for (const p of availableParents) {
      const opt = document.createElement('option')
      opt.value = p.id
      const fullLabel = (p.seq != null ? `#${p.seq} ` : '') + p.title
      opt.title = fullLabel
      opt.textContent = fullLabel.length > 33 ? fullLabel.slice(0, 32) + '…' : fullLabel
      if (p.id === card.parent_id) opt.selected = true
      parentSelect.appendChild(opt)
    }
    parentSelect.onchange = async () => {
      const newParentId = parentSelect.value || null
      const label = newParentId ? t('kanban.toast.parent_updated') : t('kanban.toast.parent_unset')
      const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...card, parent_id: newParentId }),
      })
      if (r.ok) { card.parent_id = newParentId; showToast(label); loadKanban(); showCardDetail(card) }
      else showToast(t('kanban.toast.save_error'))
    }
    parentMetaItem.style.display = ''
  } else {
    parentMetaItem.style.display = 'none'
  }

  // Load comments
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
    const comments = await res.json()
    const list = document.getElementById('commentsList')
    list.innerHTML = ''
    for (const c of comments) {
      const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
      const div = document.createElement('div')
      div.className = 'comment-item'
      div.innerHTML = `
        <div><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-date">${date}</span></div>
        <div class="comment-body">${escapeHtml(c.content)}</div>
      `
      list.appendChild(div)
    }
  } catch { /* ignore */ }

  // Author select for new comment. Default to the bot assignee resolved by
  // type (never a hard-coded display name -- BOT_NAME differs per deployment),
  // falling back to the first assignee. The old literal 'Marveen' never matched
  // on non-Marveen installs, so the select stayed on "-- Nincs --" and the
  // comment submit silently no-opped (addCommentBtn returns when !author).
  // (Resolution of the #254/#241 overlap: keep #241's type-resolved default
  // over #254's hard-coded "Gábor" -- same deployment-agnostic reasoning.)
  const defaultCommentAuthor =
    (kanbanAssignees.find((a) => a.type === 'owner') || kanbanAssignees[0] || {}).name || ''
  populateAssigneeSelect('commentAuthor', defaultCommentAuthor)

  // Add comment
  document.getElementById('addCommentBtn').onclick = async () => {
    const content = document.getElementById('commentContent').value.trim()
    const author = document.getElementById('commentAuthor').value
    if (!content) { document.getElementById('commentContent').focus(); return }
    if (!author) { showToast(t('kanban.toast.comment_no_author')); return }
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, content }),
      })
      // Without this check an HTTP error (e.g. 400) still cleared the textarea
      // and "refreshed", so the comment looked sent but was never saved.
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { msg = (await res.json()).error || msg } catch {}
        showToast(t('kanban.toast.comment_failed', { msg }))
        return
      }
      document.getElementById('commentContent').value = ''
      showCardDetail(card) // refresh
    } catch {
      showToast(t('kanban.toast.comment_error'))
    }
  }

  // Edit button
  document.getElementById('cardEditBtn').onclick = () => {
    closeModal(cardDetailOverlay)
    document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_edit')
    document.getElementById('cardTitle').value = card.title
    document.getElementById('cardDesc').value = card.description || ''
    document.getElementById('cardPriority').value = card.priority
    document.getElementById('cardProject').value = card.project || ''
    document.getElementById('cardDue').value = card.due_date
      ? new Date(card.due_date * 1000).toISOString().split('T')[0]
      : ''
    document.getElementById('cardEditId').value = card.id
    document.getElementById('cardEditStatus').value = card.status
    populateAssigneeSelect('cardAssignee', card.assignee)
    populateProjectSuggestions()
    openModal(cardModalOverlay)
  }

  // Archive
  document.getElementById('cardArchiveBtn').onclick = async () => {
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/archive`, { method: 'POST' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_archived'))
      loadKanban()
    } catch {
      showToast(t('kanban.toast.archive_error'))
    }
  }

  // Delete
  document.getElementById('cardDeleteBtn').onclick = async () => {
    if (!confirm(t('kanban.confirm.delete'))) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_deleted'))
      loadKanban()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Load children (subtasks) — only top-level tasks have children (no subtask of subtask)
  try {
    const childRes = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/children`)
    const children = await childRes.json()
    const section = document.getElementById('cardChildrenSection')
    const list = document.getElementById('cardChildrenList')
    const addSubtaskSection = document.getElementById('cardAddSubtaskSection')
    const isTask = !card.parent_id

    // #113: Show add-subtask form only for top-level tasks that are not done
    if (isTask && card.status !== 'done') {
      addSubtaskSection.style.display = ''
      const titleInput = document.getElementById('newSubtaskTitle')
      titleInput.value = ''
      document.getElementById('addSubtaskBtn').onclick = async () => {
        const title = titleInput.value.trim()
        if (!title) { titleInput.focus(); return }
        try {
          const r = await fetch('/api/kanban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, parent_id: card.id, status: card.status, priority: card.priority, project: card.project || null, assignee: null }),
          })
          if (!r.ok) { showToast(t('kanban.toast.subtask_error')); return }
          showToast(t('kanban.toast.subtask_created'))
          loadKanban()
          showCardDetail(card)
        } catch { showToast(t('kanban.toast.subtask_error')) }
      }
    } else {
      addSubtaskSection.style.display = 'none'
    }

    const statusLabelsShort = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), waiting: t('kanban.status.waiting_short'), done: t('kanban.status.done') }
    if (children.length > 0 || isTask) {
      section.style.display = ''
      list.innerHTML = ''
      // #114: Delete button per subtask — only shown when the parent card is not done
      const canDeleteChild = card.status !== 'done'
      for (const ch of children) {
        const div = document.createElement('div')
        div.className = 'comment-item'
        div.style.cssText = 'cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:8px'
        const info = document.createElement('div')
        info.style.flex = '1'
        info.innerHTML = `<div><strong>${escapeHtml(ch.title)}</strong> <span style="color:var(--text-muted)">[${statusLabelsShort[ch.status] || ch.status}]</span></div>
          <div style="font-size:0.85em;color:var(--text-muted)">${ch.assignee ? escapeHtml(ch.assignee) : ''}${ch.description ? ' -- ' + escapeHtml(ch.description).slice(0, 80) : ''}</div>`
        info.onclick = () => { closeModal(cardDetailOverlay); showCardDetail(ch) }
        div.appendChild(info)
        if (canDeleteChild) {
          const delBtn = document.createElement('button')
          delBtn.className = 'btn-danger btn-compact'
          delBtn.style.flexShrink = '0'
          delBtn.textContent = t('kanban.modal.delete_btn')
          delBtn.onclick = async (e) => {
            e.stopPropagation()
            if (!confirm(t('kanban.confirm.delete_subtask', { title: ch.title }))) return
            try {
              const r = await fetch(`/api/kanban/${encodeURIComponent(ch.id)}`, { method: 'DELETE' })
              if (!r.ok) { showToast(t('common.error_delete')); return }
              showToast(t('kanban.toast.subtask_deleted'))
              loadKanban()
              showCardDetail(card)
            } catch { showToast(t('common.error_delete')) }
          }
          div.appendChild(delBtn)
        }
        list.appendChild(div)
      }
    } else {
      section.style.display = 'none'
    }
  } catch {
    document.getElementById('cardChildrenSection').style.display = 'none'
    document.getElementById('cardAddSubtaskSection').style.display = 'none'
  }

  // Breakdown button
  document.getElementById('cardBreakdownBtn').onclick = async () => {
    const btn = document.getElementById('cardBreakdownBtn')
    btn.disabled = true
    btn.textContent = t('kanban.breakdown.generating')
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); btn.disabled = false; btn.textContent = 'Breakdown'; return }
      breakdownMode = 'kanban'
      breakdownCardId = card.id
      breakdownSubtasks = data.subtasks
      showBreakdownModal(data.subtasks, card)
      const dodSec = document.getElementById('breakdownDoDSection')
      if (dodSec) dodSec.style.display = 'none'
    } catch (err) {
      showToast('Breakdown hiba')
    } finally {
      btn.disabled = false
      btn.textContent = 'Breakdown'
    }
  }

  openModal(cardDetailOverlay)
}

async function triggerBreakdown(card) {
  const btn = document.querySelector(`.kanban-card[data-id="${card.id}"] .card-breakdown-btn`)
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Breakdown hiba'); return }
    breakdownMode = 'kanban'
    breakdownCardId = card.id
    breakdownSubtasks = data.subtasks
    showBreakdownModal(data.subtasks, card)
  } catch {
    showToast('Breakdown hiba')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡' }
  }
}

function showBreakdownModal(subtasks, parentCard) {
  document.getElementById('breakdownProvider').textContent = t('kanban.breakdown.parent_label', { title: escapeHtml(parentCard.title) })
  const list = document.getElementById('breakdownList')
  list.innerHTML = ''

  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const assigneeOptions = kanbanAssignees
    .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.displayName || a.name)}</option>`)
    .join('')

  subtasks.forEach((st, i) => {
    const div = document.createElement('div')
    div.className = 'comment-item breakdown-subtask-item'
    div.dataset.idx = i
    div.style.borderLeft = '3px solid var(--accent)'
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px">
        <label style="font-size:0.8em; color:var(--text-muted); white-space:nowrap">${i + 1}.</label>
        <input type="text" class="breakdown-title-input" value="${escapeHtml(st.title)}"
          style="flex:1; padding:5px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.9em">
        <label style="font-size:0.8em; white-space:nowrap">
          <input type="checkbox" class="breakdown-check" data-idx="${i}" checked> Bele
        </label>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <select class="breakdown-assignee-select" style="padding:4px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.85em">
          <option value="">-- nincs --</option>
          ${assigneeOptions}
        </select>
        <span class="priority-badge priority-${st.priority}">${priorityLabels[st.priority] || st.priority}</span>
      </div>
    `
    // Set assignee select value after insert
    const sel = div.querySelector('.breakdown-assignee-select')
    if (st.assignee) sel.value = st.assignee
    list.appendChild(div)
  })
  openModal(breakdownOverlay)
}

document.getElementById('breakdownAcceptBtn').addEventListener('click', async () => {
  const items = document.querySelectorAll('.breakdown-subtask-item')
  const accepted = []
  items.forEach((item) => {
    const idx = parseInt(item.dataset.idx, 10)
    const checked = item.querySelector('.breakdown-check')?.checked
    if (!checked) return
    const title = item.querySelector('.breakdown-title-input')?.value.trim() || breakdownSubtasks[idx]?.title
    const assignee = item.querySelector('.breakdown-assignee-select')?.value || breakdownSubtasks[idx]?.assignee
    const priority = breakdownSubtasks[idx]?.priority || 'normal'
    const description = breakdownSubtasks[idx]?.description || ''
    accepted.push({ title, assignee, priority, description })
  })
  if (accepted.length === 0) { showToast(t('kanban.breakdown.select_one')); return }
  try {
    if (breakdownMode === 'idea') {
      const successCriteria = document.getElementById('breakdownSuccessCriteria')?.value.trim() || undefined
      const res = await fetch(`/api/ideas/${encodeURIComponent(breakdownIdeaId)}/promote-breakdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: accepted, success_criteria: successCriteria }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); return }
      closeModal(breakdownOverlay)
      showToast(t('kanban.breakdown.promoted', { count: data.child_count }))
      loadIdeasPage()
      return
    }
    const res = await fetch(`/api/kanban/${encodeURIComponent(breakdownCardId)}/breakdown/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtasks: accepted }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Hiba'); return }
    closeModal(breakdownOverlay)
    closeModal(cardDetailOverlay)
    showToast(t('kanban.breakdown.created_count', { count: data.created.length }))
    loadKanban()
  } catch {
    showToast(t('common.error_save'))
  }
})

document.getElementById('breakdownRejectBtn').addEventListener('click', () => {
  closeModal(breakdownOverlay)
  showToast(t('kanban.toast.breakdown_rejected'))
})

document.getElementById('breakdownClose').addEventListener('click', () => closeModal(breakdownOverlay))

// === Elements: Agents ===
const agentsGrid = document.getElementById('agentsGrid')
const addBtn = document.getElementById('addAgentBtn')
const agentWizardOverlay = document.getElementById('agentWizardOverlay')
const agentDetailOverlay = document.getElementById('agentDetailOverlay')
const skillModalOverlay = document.getElementById('skillModalOverlay')
const agentName = document.getElementById('agentName')
const agentDesc = document.getElementById('agentDesc')
const agentModel = document.getElementById('agentModel')
const toast = document.getElementById('toast')

const AVATARS = [
  '01_robot.png', '02_wizard_girl.png', '03_knight.png', '04_ninja.png',
  '05_pirate.png', '06_scientist_girl.png', '07_astronaut.png', '08_viking.png',
  '09_cowgirl.png', '10_detective.png', '11_chef.png', '12_witch.png',
  '13_samurai.png', '14_fairy_girl.png', '15_firefighter.png', '16_punk_girl.png',
  '17_explorer.png', '18_dj.png', '19_princess.png', '20_alien.png'
]

let selectedAvatar = null
let selectedAvatarFile = null // custom upload chosen in the create wizard (deferred until the agent exists)
let agents = []
let currentAgent = null
// API-safe agent id for the currently open detail modal. Sub-agents key off
// their name; the main agent's detail object carries name:'marveen' for legacy
// UI checks but its real agent-dir id is agentId (MAIN_AGENT_ID, e.g.
// 'gorcsevivan') -- the /api/agents/<id>/skills endpoints need that real id.
function agentApiName() {
  return currentAgent ? (currentAgent.agentId || currentAgent.name) : ''
}
let wizardStep = 1
let generatedClaudeMd = ''
let generatedSoulMd = ''
let wizardCreatedName = ''

// === Modal helpers ===
function openModal(overlay) {
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}
function closeModal(overlay) {
  overlay.classList.remove('active')
  document.body.style.overflow = ''
  // Skill modal is used by two distinct callers (Agent detail + Skills
  // page). Reset the scope on every close path -- explicit button,
  // click-outside, Esc, programmatic -- so the next opener cannot
  // inherit a stale 'global' flag from an earlier Skills-page open.
  if (overlay && overlay.id === 'skillModalOverlay') skillModalScope = null
}

// Wizard open
addBtn.addEventListener('click', () => {
  resetWizard()
  openModal(agentWizardOverlay)
  setTimeout(() => agentName.focus(), 200)
})

// Close buttons
document.getElementById('wizardClose').addEventListener('click', () => closeModal(agentWizardOverlay))
document.getElementById('agentDetailClose').addEventListener('click', () => closeModal(agentDetailOverlay))
document.getElementById('skillModalClose').addEventListener('click', () => closeModal(skillModalOverlay))

// Click-outside-to-close
agentWizardOverlay.addEventListener('click', (e) => { if (e.target === agentWizardOverlay) closeModal(agentWizardOverlay) })
agentDetailOverlay.addEventListener('click', (e) => { if (e.target === agentDetailOverlay) closeModal(agentDetailOverlay) })
skillModalOverlay.addEventListener('click', (e) => { if (e.target === skillModalOverlay) closeModal(skillModalOverlay) })

// Close all modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((o) => closeModal(o))
  }
})

// === Avatar Gallery ===
function populateAvatarGrid() {
  const grid = document.getElementById('avatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', () => {
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      selectedAvatar = avatar
      // Gallery pick and custom upload are mutually exclusive.
      selectedAvatarFile = null
      resetCreateAvatarUpload()
    })
    grid.appendChild(item)
  }
}

// === Wizard logic ===
let cachedProfiles = null
async function loadProfiles() {
  if (cachedProfiles) return cachedProfiles
  try {
    const res = await fetch('/api/profiles')
    if (res.ok) cachedProfiles = await res.json()
  } catch {}
  return cachedProfiles || []
}

function populateProfileSelect(selectEl, descEl, selected) {
  loadProfiles().then((profiles) => {
    selectEl.innerHTML = ''
    for (const p of profiles) {
      const opt = document.createElement('option')
      opt.value = p.id
      const tag = p.permissionMode === 'strict' ? ` (${t('agents.strict_mode')})` : ''
      opt.textContent = `${p.label}${tag}`
      if (p.id === selected) opt.selected = true
      selectEl.appendChild(opt)
    }
    const updateDesc = () => {
      const p = profiles.find(x => x.id === selectEl.value)
      descEl.textContent = p ? p.description : ''
    }
    selectEl.onchange = updateDesc
    updateDesc()
  })
}

function resetWizard() {
  wizardStep = 1
  agentName.value = ''
  agentDesc.value = ''
  agentModel.value = 'inherit'
  loadAvailableModels()
  selectedAvatar = null
  selectedAvatarFile = null
  document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
  resetCreateAvatarUpload()
  generatedClaudeMd = ''
  generatedSoulMd = ''
  wizardCreatedName = ''
  document.getElementById('wizardClaudeMd').value = ''
  document.getElementById('wizardSoulMd').value = ''
  populateProfileSelect(
    document.getElementById('agentProfile'),
    document.getElementById('agentProfileDesc'),
    'default',
  )
  updateWizardUI()
}

function updateWizardUI() {
  // Steps indicator
  document.querySelectorAll('#wizardSteps .wizard-step').forEach((s) => {
    const step = parseInt(s.dataset.step)
    s.classList.toggle('active', step === wizardStep)
    s.classList.toggle('done', step < wizardStep)
  })
  // Panels
  document.getElementById('wizardStep1').hidden = wizardStep !== 1
  document.getElementById('wizardStep2').hidden = wizardStep !== 2
  document.getElementById('wizardStep3').hidden = wizardStep !== 3
}

// Step 1 -> Step 2 (generate)
document.getElementById('wizardNextBtn').addEventListener('click', async () => {
  const name = agentName.value.trim()
  const desc = agentDesc.value.trim()
  if (!name) { agentName.focus(); return }
  if (!desc) { agentDesc.focus(); return }

  wizardStep = 2
  updateWizardUI()

  const statusEl = document.getElementById('wizardGenStatus')
  statusEl.textContent = t('agents.claude_md_generating')

  try {
    // Create agent via API (returns generated content)
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: desc,
        model: agentModel.value,
        profile: document.getElementById('agentProfile').value,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    const result = await res.json()
    // Backend sanitizes the name (lowercase ASCII, NFD-stripped accents).
    // Use the sanitized form for every follow-up request so accented input
    // like "étrendíró" still resolves to the real agent dir "etrendiro".
    const createdName = result.name || name
    wizardCreatedName = createdName
    statusEl.textContent = t('agents.soul_md_generating')

    // Fetch full agent details to get generated content
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(createdName)}`)
    if (detailRes.ok) {
      const detail = await detailRes.json()
      generatedClaudeMd = detail.claudeMd || detail.content || ''
      generatedSoulMd = detail.soulMd || ''
    }

    statusEl.textContent = t('kanban.breakdown.running')

    // Apply the chosen avatar. Custom upload wins over a gallery pick; both go
    // to the same endpoint (FormData for a file, JSON for a gallery name).
    if (selectedAvatarFile) {
      const form = new FormData()
      form.append('avatar', selectedAvatarFile, selectedAvatarFile.name)
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        body: form,
      })
    } else if (selectedAvatar) {
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ galleryAvatar: selectedAvatar }),
      })
    }

    // Auto-advance to step 3
    setTimeout(() => {
      wizardStep = 3
      document.getElementById('wizardClaudeMd').value = generatedClaudeMd
      document.getElementById('wizardSoulMd').value = generatedSoulMd
      updateWizardUI()
    }, 600)
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    wizardStep = 1
    updateWizardUI()
  }
})

// Step 3 -> back to step 1
document.getElementById('wizardBackBtn').addEventListener('click', () => {
  wizardStep = 1
  updateWizardUI()
})

// Step 3 -> Create (finalize with edits)
document.getElementById('wizardCreateBtn').addEventListener('click', async () => {
  // Use the backend-sanitized name stored in wizardCreatedName, not the raw
  // input field -- accents in the input would miss the real agent dir.
  const name = wizardCreatedName || agentName.value.trim()
  const claudeMd = document.getElementById('wizardClaudeMd').value
  const soulMd = document.getElementById('wizardSoulMd').value
  const createBtn = document.getElementById('wizardCreateBtn')

  createBtn.disabled = true
  createBtn.querySelector('.btn-text').hidden = true
  createBtn.querySelector('.btn-loading').hidden = false

  try {
    // Update with edited content
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd, soulMd }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    closeModal(agentWizardOverlay)
    showToast('Ugynok letrehozva. Kosd be a csatornat a parosatashoz.')
    await loadAgents()
    // Drop the operator straight into the Telegram tab of the new agent so
    // the pairing step is in front of them -- easy to miss otherwise.
    try {
      await openAgentDetail(name)
      switchAgentTab('channel')
    } catch { /* detail open failed, list refresh already happened */ }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    createBtn.disabled = false
    createBtn.querySelector('.btn-text').hidden = false
    createBtn.querySelector('.btn-loading').hidden = true
  }
})

// === Toast ===
function showToast(msg, duration = 3000) {
  toast.textContent = msg
  toast.classList.add('visible')
  setTimeout(() => toast.classList.remove('visible'), duration)
}

// === Agents API ===
async function loadAgents() {
  try {
    const [agentsRes, marveenRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/marveen'),
    ])
    agents = await agentsRes.json()
    if (marveenRes.ok) {
      window._marveen = await marveenRes.json()
      // A backend CHANNEL_PROVIDER-éhez igazitsuk a kliens-default-ot,
      // hogy ne 'telegram' jelenjen meg amikor a backend discord-on van.
      if (window._marveen?.channelProvider) {
        currentChannelProvider = window._marveen.channelProvider
        const sel = document.getElementById('chProviderSelect')
        if (sel) sel.value = currentChannelProvider
        if (typeof updateProviderUI === 'function') updateProviderUI()
      }
    }
    renderAgents()
  } catch (err) {
    console.error('Betöltés hiba:', err)
  }
}

// Format a context-token count for display (e.g. 699884 -> "≈700k token").
function formatContextTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '-'
  if (n < 1000) return `${n} token`
  const k = n / 1000
  return `≈${k < 10 ? k.toFixed(1) : Math.round(k)}k token`
}

// Populate the auto-restart controls + context display from an agent payload.
// Works for sub-agents (agent.name) and the main session (agent.autoRestartId).
function setupAutoRestartUI(agent) {
  const ctxEl = document.getElementById('agentDetailContext')
  if (ctxEl) ctxEl.textContent = formatContextTokens(agent && agent.contextTokens)

  const ar = (agent && agent.autoRestart) || { enabled: false, mode: 'continue', dailyTime: null, intervalHours: null }
  const enabled = document.getElementById('arEnabled')
  const mode = document.getElementById('arMode')
  const schedKind = document.getElementById('arSchedKind')
  const dailyWrap = document.getElementById('arDailyWrap')
  const dailyTime = document.getElementById('arDailyTime')
  const intervalWrap = document.getElementById('arIntervalWrap')
  const intervalHours = document.getElementById('arIntervalHours')
  if (!enabled || !mode || !schedKind) return

  enabled.checked = ar.enabled === true
  mode.value = ar.mode === 'fresh' ? 'fresh' : 'continue'
  if (ar.intervalHours) {
    schedKind.value = 'interval'
    intervalHours.value = ar.intervalHours
  } else {
    schedKind.value = 'daily'
    if (ar.dailyTime) dailyTime.value = ar.dailyTime
  }
  const syncSched = () => {
    const isInterval = schedKind.value === 'interval'
    intervalWrap.hidden = !isInterval
    dailyWrap.hidden = isInterval
  }
  syncSched()
  // Attach the show/hide listener once.
  if (schedKind.dataset.wired !== '1') {
    schedKind.addEventListener('change', syncSched)
    schedKind.dataset.wired = '1'
  }
}

async function openMarveenDetail() {
  const m = window._marveen
  if (!m) return

  // Reuse the agent detail modal for Marveen
  currentAgent = { ...m, name: mainAgentId(), claudeMd: '', soulMd: '', mcpJson: '', skills: [] }
  setupAutoRestartUI(currentAgent)

  const displayName = m.name || 'Marveen'
  document.getElementById('agentDetailTitle').textContent = displayName
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar gradient-1'
  avatar.innerHTML = `<img src="/api/marveen/avatar?t=${Date.now()}" alt="${escapeHtml(displayName)}">`
  document.getElementById('agentDetailName').textContent = displayName
  document.getElementById('agentDetailDesc').textContent = m.description || ''
  document.getElementById('agentDetailModel').textContent = m.model || '-'
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot connected"></span>${t('agents.channel.connected')}</span>`
  // Populate the Skills tab for the main agent too: the endpoint returns the
  // global ~/.claude/skills under its real id (agentId), which every agent
  // inherits. Previously this was hard-set to '-' and loadSkills was never
  // called, so the main agent's Skills tab always looked empty.
  loadSkills(agentApiName())

  // Process control for Marveen - always running, no start/stop
  document.getElementById('processDot').className = 'process-dot running'
  document.getElementById('processLabel').textContent = t('agents.status.running')
  document.getElementById('processUptime').textContent = `tmux: ${m.tmuxSession || '-'}`
  document.getElementById('agentStartBtn').hidden = true
  document.getElementById('agentStopBtn').hidden = true
  // Sync the settings tab model select with Marveen's actual model so it
  // doesn't carry over the previously opened sub-agent's selection.
  const marveenModelSelect = document.getElementById('editAgentModel')
  if (marveenModelSelect) marveenModelSelect.value = m.activeModel || m.model || ''
  // Surface the "channels restart" button -- destructive, but mobile-safe
  // when the Telegram plugin wedges and you're away from a terminal.
  document.getElementById('marveenRestartBtn').hidden = false

  // Settings tab - load real CLAUDE.md / SOUL.md / .mcp.json (read-only).
  // Editing the main agent's identity files via the dashboard is intentionally
  // not allowed: a leaked dashboard token would otherwise let a remote user
  // rewrite the live agent's instructions. Edit via filesystem or by asking
  // Marveen on Telegram instead.
  let mFull = m
  try {
    const claudeRes = await fetch('/api/marveen')
    if (claudeRes.ok) {
      mFull = await claudeRes.json()
      document.getElementById('editClaudeMd').value = mFull.claudeMd || ''
      document.getElementById('editSoulMd').value = mFull.soulMd || ''
      document.getElementById('editMcpJson').value = mFull.mcpJson || ''
    }
  } catch {}
  applyMarveenReadonlyMode(true)

  // Telegram tab -- without this the tab stays in the default "not connected"
  // view even though the bot is running and receiving messages.
  updateChannelTab({
    name: mainAgentId(),
    hasTelegram: mFull.hasTelegram !== undefined ? mFull.hasTelegram : true,
    hasDiscord: mFull.hasDiscord,
    hasSlack: mFull.hasSlack,
    telegramBotUsername: mFull.telegramBotUsername,
    running: true,
  })

  // Delete button - hide for Marveen
  document.getElementById('deleteAgentBtn').style.display = 'none'

  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  openModal(agentDetailOverlay)
}

function applyMarveenReadonlyMode(readOnly) {
  const textareaIds = ['editClaudeMd', 'editSoulMd', 'editMcpJson']
  // saveModelBtn stays VISIBLE but disabled for Marveen, so the settings tab
  // doesn't look like the row is missing -- the other save buttons (tied to
  // readonly textareas) are hidden because the textareas are also hidden by
  // the readonly note flow.
  const hideButtonIds = ['saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'saveAuthModeBtn']
  const disableButtonIds = ['saveModelBtn']
  for (const id of textareaIds) {
    const el = document.getElementById(id)
    if (!el) continue
    if (readOnly) el.setAttribute('readonly', 'readonly')
    else el.removeAttribute('readonly')
  }
  const modelSelect = document.getElementById('editAgentModel')
  if (modelSelect) modelSelect.disabled = readOnly
  for (const id of hideButtonIds) {
    const btn = document.getElementById(id)
    if (btn) btn.hidden = readOnly
  }
  for (const id of disableButtonIds) {
    const btn = document.getElementById(id)
    if (btn) { btn.hidden = false; btn.disabled = readOnly }
  }
  const authModeGroup = document.getElementById('authModeGroup')
  if (authModeGroup) authModeGroup.hidden = readOnly
  const note = document.getElementById('marveenReadonlyNote')
  if (note) note.hidden = !readOnly
}


function getAvatarGradient(name) {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return 'gradient-' + ((hash % 3) + 1)
}

// Tooltip text for the "Fut" / "Leállva" footer indicator (process state).
function processTip(isRunning) {
  return isRunning
    ? t('agents.running_tip')
    : t('agents.stopped_tip')
}

// Tooltip text for the "Online" / "Offline" footer indicator (channel state).
function channelTip(isConnected) {
  return isConnected
    ? t('agents.online_tip')
    : t('agents.offline_tip')
}

// Build the copy-paste tmux attach command for an agent live session. A local
// agent session runs on the orchestrator host (a direct `tmux attach`); a remote
// agent session runs on its configured remoteHost, reached over ssh. Only
// meaningful for running agents.
function tmuxAttachCommand(agent) {
  const session = agent.session || ('agent-' + agent.name)
  const direct = 'tmux attach -t ' + session
  const remoteHost = agent.remoteHost || null
  return remoteHost ? 'ssh ' + remoteHost + " -t '" + direct + "'" : direct
}

// Append a single "copy tmux attach command" button to a running agent card.
// Clicks copy to clipboard and never bubble to the card open-detail handler.
function attachTmuxCopyButtons(card, agent) {
  const cmd = tmuxAttachCommand(agent)
  const row = document.createElement('div')
  row.className = 'agent-tmux-cmds'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tmux-copy-btn'
  btn.setAttribute('aria-label', t('agents.tmux_copy_aria'))
  btn.title = cmd
  btn.innerHTML = '<span class="tmux-copy-ico">⧉</span>tmux'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(cmd).then(() => {
      const orig = btn.innerHTML
      btn.classList.add('copied')
      btn.innerHTML = '<span class="tmux-copy-ico">✓</span>' + t('agents.tmux_copied')
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied') }, 1400)
    }).catch(() => showToast(t('agents.tmux_copy_failed')))
  })
  row.appendChild(btn)
  card.appendChild(row)
}

function renderAgents() {
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((el) => el.remove())

  // Marveen card (always first)
  if (window._marveen) {
    const m = window._marveen
    const displayName = m.name || 'Marveen'
    // The model is no longer hardcoded: /api/marveen reports the configured
    // model (readActiveModelFromProjectDir). Mirror the sub-agent card, which
    // uses the model value as both the badge label and class. Fall back to
    // 'opus' only before /api/marveen has resolved (or on a legacy backend).
    const mainModelLabel = m.model || 'opus'
    const mainModelClass = m.model || 'opus'
    const mCard = document.createElement('div')
    mCard.className = 'agent-card marveen-card'
    mCard.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar gradient-1"><img src="/api/marveen/avatar?t=${Date.now()}" alt="${escapeHtml(displayName)}"></div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(displayName)} <span class="marveen-badge">${t('agents.main_badge')}</span></div>
          <div class="agent-desc">${escapeHtml(m.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(mainModelClass)}">${escapeHtml(mainModelLabel)}</span>
        <span class="process-indicator" title="${t('agents.marveen_process_tip')}"><span class="process-dot running"></span>${t('agents.status.running')}</span>
        <span class="tg-status" title="${t('agents.marveen_channel_tip')}"><span class="tg-dot connected"></span>${t('agents.status.online')}</span>
      </div>
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact agent-conversation-btn" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn-secondary btn-compact agent-terminal-btn" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    mCard.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openTerminalModal(mainAgentId())
    })
    mCard.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openConversationModal(mainAgentId(), t('agents.marveen_boss'))
    })
    mCard.addEventListener('click', () => openMarveenDetail())
    agentsGrid.insertBefore(mCard, addBtn)
  }

  for (const agent of agents) {
    // agent.name is the sanitized id (API/filesystem); displayName keeps the
    // original accented/cased input the user typed.
    const label = agent.displayName || agent.name
    const card = document.createElement('div')
    card.className = 'agent-card'
    card.dataset.name = agent.name
    const initial = label.charAt(0).toUpperCase()
    const gradientClass = getAvatarGradient(agent.name)
    const avatarHtml = (agent.hasImage || agent.hasAvatar)
      ? `<img src="/api/agents/${encodeURIComponent(agent.name)}/avatar?t=${Date.now()}" alt="${escapeHtml(label)}">`
      : initial

    const modelClass = agent.model && agent.model !== 'inherit' ? agent.model : ''
    const modelLabel = agent.model || 'inherit'
    const chConnected = agentIsConnected(agent)
    const chDotClass = chConnected ? 'connected' : 'disconnected'
    const chLabel = chConnected ? t('agents.status.online') : t('agents.status.offline')
    const isRunning = agent.running || false
    const runDotClass = isRunning ? 'running' : 'stopped'
    const runLabel = isRunning ? t('agents.status.running') : t('agents.status.stopped')

    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${avatarHtml}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(label)}</div>
          <div class="agent-desc">${escapeHtml(agent.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(modelClass)}">${escapeHtml(modelLabel)}</span>
        <span class="process-indicator" title="${escapeHtml(processTip(isRunning))}"><span class="process-dot ${runDotClass}"></span>${runLabel}</span>
        <span class="tg-status" title="${escapeHtml(channelTip(chConnected))}"><span class="tg-dot ${chDotClass}"></span>${chLabel}</span>
      </div>
      ${agent.needsReauth ? `
        <div class="agent-reauth-banner">
          <span class="agent-reauth-reason">${escapeHtml(agent.reauthReason || t('agents.reauth.reason'))}</span>
          <button class="btn-danger btn-compact agent-login-btn" data-phase="start">${t('agents.btn.login')}</button>
        </div>` : ''}
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact agent-conversation-btn" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn-secondary btn-compact agent-terminal-btn" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    // Login button handler (start → confirm flow)
    card.querySelectorAll('.agent-login-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); handleAgentLogin(agent.name, btn) })
    })
    // Terminal button
    card.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openTerminalModal(agent.name)
    })
    // Conversation (readable transcript) button
    card.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openConversationModal(agent.name, label)
    })
    card.addEventListener('click', () => openAgentDetail(agent.name))
    // Only running agents have a live session to look at, so only they get the
    // copy-the-tmux-command buttons.
    if (isRunning) attachTmuxCopyButtons(card, agent)
    agentsGrid.insertBefore(card, addBtn)
  }
}

// === Agent Detail ===
async function openAgentDetail(agentName) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    if (!res.ok) throw new Error('Not found')
    currentAgent = await res.json()
  } catch (err) {
    showToast(t('agents.toast.load_failed'))
    return
  }

  const detailLabel = currentAgent.displayName || currentAgent.name

  // Title
  document.getElementById('agentDetailTitle').textContent = detailLabel

  // Overview tab
  const initial = detailLabel.charAt(0).toUpperCase()
  const gradientClass = getAvatarGradient(currentAgent.name)
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar ' + gradientClass
  avatar.innerHTML = (currentAgent.hasImage || currentAgent.hasAvatar)
    ? `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar" alt="${escapeHtml(detailLabel)}">`
    : initial
  document.getElementById('agentDetailName').textContent = detailLabel
  document.getElementById('agentDetailDesc').textContent = currentAgent.description || ''
  document.getElementById('agentDetailModel').textContent = currentAgent.activeModel || currentAgent.model || 'inherit'
  document.getElementById('agentDetailModelRestarting').hidden = true

  const chConnected = agentIsConnected(currentAgent)
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot ${chConnected ? 'connected' : 'disconnected'}"></span>${chConnected ? t('agents.channel.connected') : t('agents.channel.disconnected')}</span>`

  // Settings tab - load Ollama + DeepSeek models then set value
  loadAvailableModels()
  loadOllamaModels().then(() => {
    document.getElementById('editAgentModel').value = currentAgent.activeModel || currentAgent.model || 'claude-opus-4-8[1m]'
  })
  populateProfileSelect(
    document.getElementById('editAgentProfile'),
    document.getElementById('editAgentProfileDesc'),
    currentAgent.securityProfile || 'default',
  )
  renderTeamEditor(currentAgent, agents)
  updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
  loadVoiceConfig(currentAgent.name)
  document.getElementById('editClaudeMd').value = currentAgent.claudeMd || currentAgent.content || ''
  document.getElementById('editSoulMd').value = currentAgent.soulMd || ''
  document.getElementById('editMcpJson').value = currentAgent.mcpJson || ''

  // Auto-restart settings + live context size
  setupAutoRestartUI(currentAgent)

  // Telegram tab
  updateChannelTab(currentAgent)

  // Skills tab
  await loadSkills(currentAgent.name)

  // Process control
  updateProcessControl(currentAgent)

  // Channels restart button is Marveen-only -- hide on normal agents.
  document.getElementById('marveenRestartBtn').hidden = true

  // Restore editable Settings (Marveen detail flips this to read-only).
  applyMarveenReadonlyMode(false)

  // Delete button (restore visibility for normal agents)
  document.getElementById('deleteAgentBtn').style.display = ''
  document.getElementById('deleteAgentBtn').onclick = async () => {
    if (!confirm(t('agents.confirm.delete', { name: currentAgent.name }))) return
    try {
      await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, { method: 'DELETE' })
      closeModal(agentDetailOverlay)
      showToast(t('agents.toast.deleted'))
      loadAgents()
    } catch (err) {
      showToast(t('common.error_delete'))
    }
  }

  // Reset to first tab, hide avatar gallery
  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  openModal(agentDetailOverlay)
}

// === Detail avatar gallery ===
function populateDetailAvatarGrid() {
  const grid = document.getElementById('detailAvatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', async () => {
      if (!currentAgent) return
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ galleryAvatar: avatar }),
        })
        if (!res.ok) throw new Error()
        showToast(t('agents.toast.avatar_updated'))
        // Update the detail avatar display
        document.getElementById('agentDetailAvatar').innerHTML = `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar?t=${Date.now()}" alt="">`
        document.getElementById('detailAvatarGallery').hidden = true
        loadAgents()
      } catch {
        showToast(t('agents.toast.avatar_error'))
      }
    })
    grid.appendChild(item)
  }
}

document.getElementById('avatarChangeBtn').addEventListener('click', () => {
  const gallery = document.getElementById('detailAvatarGallery')
  gallery.hidden = !gallery.hidden
  if (!gallery.hidden) {
    const isMarveen = currentAgent && currentAgent.role === 'main'
    const avatarEndpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`

    const grid = document.getElementById('detailAvatarGrid')
    grid.innerHTML = ''
    for (const avatar of AVATARS) {
      const item = document.createElement('div')
      item.className = 'avatar-grid-item'
      item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
      item.addEventListener('click', async () => {
        try {
          const res = await fetch(avatarEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ galleryAvatar: avatar }),
          })
          if (!res.ok) throw new Error()
          showToast(t('agents.toast.avatar_updated'))
          const imgUrl = isMarveen ? `/api/marveen/avatar?t=${Date.now()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar?t=${Date.now()}`
          document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
          gallery.hidden = true
          loadAgents()
        } catch {
          showToast(t('agents.toast.avatar_error'))
        }
      })
      grid.appendChild(item)
    }
  }
})

// === Avatar file upload ===
;(() => {
  const zone = document.getElementById('avatarUploadZone')
  const fileInput = document.getElementById('avatarFileInput')
  const content = document.getElementById('avatarUploadContent')
  const preview = document.getElementById('avatarUploadPreview')
  const previewImg = document.getElementById('avatarPreviewImg')
  const clearBtn = document.getElementById('avatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    resetAvatarUpload()
  })

  function resetAvatarUpload() {
    fileInput.value = ''
    content.hidden = false
    preview.hidden = true
  }

  async function handleAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
    await uploadAvatarFile(file)
  }

  async function uploadAvatarFile(file) {
    if (!currentAgent) return
    const isMarveen = currentAgent.role === 'main'
    const endpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`
    const form = new FormData()
    form.append('avatar', file, file.name)
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      showToast(t('agents.toast.avatar_uploaded'))
      const imgUrl = isMarveen ? `/api/marveen/avatar?t=${Date.now()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar?t=${Date.now()}`
      document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
      document.getElementById('detailAvatarGallery').hidden = true
      resetAvatarUpload()
      loadAgents()
    } catch {
      showToast(t('common.error_save'))
      resetAvatarUpload()
    }
  }
})()

// === Create-wizard avatar upload ===
// Mirrors the detail-modal uploader, but the agent does not exist yet, so the
// file is held in `selectedAvatarFile` and POSTed after creation (see the
// wizard create flow). Hoisted so populateAvatarGrid()/resetWizard() can reset.
function resetCreateAvatarUpload() {
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  if (!fileInput || !content || !preview) return
  fileInput.value = ''
  content.hidden = false
  preview.hidden = true
}
;(() => {
  const zone = document.getElementById('createAvatarUploadZone')
  if (!zone) return
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  const previewImg = document.getElementById('createAvatarPreviewImg')
  const clearBtn = document.getElementById('createAvatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleCreateAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleCreateAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    selectedAvatarFile = null
    resetCreateAvatarUpload()
  })

  function handleCreateAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    // Custom upload and gallery pick are mutually exclusive.
    selectedAvatar = null
    document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
    selectedAvatarFile = file
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
  }
})()

// === Process control ===
function updateProcessControl(agent) {
  const running = agent.running || false
  const dot = document.getElementById('processDot')
  const label = document.getElementById('processLabel')
  const uptime = document.getElementById('processUptime')
  const startBtn = document.getElementById('agentStartBtn')
  const stopBtn = document.getElementById('agentStopBtn')

  dot.className = 'process-dot ' + (running ? 'running' : 'stopped')
  label.textContent = running ? t('agents.status.running') : t('agents.status.stopped')
  startBtn.hidden = running
  stopBtn.hidden = !running

  if (running && agent.session) {
    uptime.textContent = `tmux: ${agent.session}`
  } else {
    uptime.textContent = ''
  }
}

document.getElementById('marveenRestartBtn').addEventListener('click', async () => {
  if (!confirm(t('agents.confirm.hard_restart'))) return
  const btn = document.getElementById('marveenRestartBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/marveen/restart', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || t('agents.toast.restart_failed'))
    }
    showToast(t('agents.toast.marveen_restarted'))
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
  }
})

document.getElementById('agentStartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('agentStartBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/start`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('agents.toast.start_failed'))
    }
    showToast(t('agents.toast.started'))
    // Refresh
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('agentStopBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  if (!confirm(t('agents.confirm.stop'))) return

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/stop`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('agents.toast.stop_failed'))
    }
    showToast(t('agents.toast.stopped'))
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
})

// === Tab switching ===
document.getElementById('agentTabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn')
  if (!btn) return
  switchAgentTab(btn.dataset.tab)
})

let currentChannelProvider = 'telegram'
// Az induláskor a backend CHANNEL_PROVIDER-jét lekérjük, és a dropdown +
// state default-ot ahhoz igazitjuk -- igy ha a backend discord-on van,
// a UI nem hardcode-olt 'telegram'-mal indul barmelyik oldalra is navigal a user.
;(async function initChannelProviderDefault() {
  try {
    const res = await fetch('/api/marveen')
    if (!res.ok) return
    const data = await res.json()
    if (!data.channelProvider || data.channelProvider === currentChannelProvider) return
    currentChannelProvider = data.channelProvider
    const sel = document.getElementById('chProviderSelect')
    if (sel) sel.value = currentChannelProvider
    if (typeof updateProviderUI === 'function') updateProviderUI()
  } catch { /* ignore -- a kepernyo default-on marad */ }
})()
let channelAutoPollTimer = null
function startChannelAutoPoll() {
  if (channelAutoPollTimer) return
  channelAutoPollTimer = setInterval(() => {
    if (!currentAgent) return
    if (document.getElementById('tabChannel').hidden) return
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }, 4000)
}
function stopChannelAutoPoll() {
  if (channelAutoPollTimer) { clearInterval(channelAutoPollTimer); channelAutoPollTimer = null }
}

function channelApiBase() {
  return `/api/agents/${encodeURIComponent(currentAgent.name)}/channels/${currentChannelProvider}`
}

function switchAgentTab(tab) {
  document.querySelectorAll('#agentTabNav .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  document.getElementById('tabOverview').hidden = tab !== 'overview'
  document.getElementById('tabSettings').hidden = tab !== 'settings'
  document.getElementById('tabChannel').hidden = tab !== 'channel'
  document.getElementById('tabSkills').hidden = tab !== 'skills'
  document.getElementById('tabTeam').hidden = tab !== 'team'
  if (tab === 'channel') startChannelAutoPoll()
  else stopChannelAutoPoll()
}

// === Settings save buttons ===
async function loadOllamaModels() {
  const group = document.getElementById('ollamaModelGroup')
  if (!group) return
  group.innerHTML = ''
  try {
    const res = await fetch('/api/ollama/models')
    const models = await res.json()
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.name
      opt.textContent = `${m.name} (${m.size})`
      group.appendChild(opt)
    }
  } catch { /* Ollama not available */ }
}

// Populates the DeepSeek optgroups in both the wizard and the agent edit
// panel. Backend gates the list behind a vault entry, so an empty array
// here means the operator has not configured an API key yet -- in that
// case we hide the optgroup and surface a hint pointing to the Vault page.
async function loadAvailableModels() {
  try {
    const res = await fetch('/api/models/available')
    if (!res.ok) return
    const data = await res.json()
    const deepseekModels = Array.isArray(data.deepseek) ? data.deepseek : []
    const editGroup = document.getElementById('deepseekModelGroup')
    const wizardGroup = document.getElementById('agentModelDeepseekGroup')
    const hint = document.getElementById('deepseekHint')
    for (const group of [editGroup, wizardGroup]) {
      if (!group) continue
      group.innerHTML = ''
      if (deepseekModels.length === 0) {
        group.style.display = 'none'
        continue
      }
      group.style.display = ''
      for (const m of deepseekModels) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.label
        group.appendChild(opt)
      }
    }
    if (hint) hint.style.display = deepseekModels.length === 0 ? 'block' : 'none'
  } catch { /* dashboard not available */ }
}

let modelRestartPollTimer = null
let modelRestartPollName = null

function stopModelRestartPolling() {
  if (modelRestartPollTimer) { clearInterval(modelRestartPollTimer); modelRestartPollTimer = null }
  modelRestartPollName = null
}

function startModelRestartPolling(name, expectedModel, triggeredAt) {
  stopModelRestartPolling()
  modelRestartPollName = name
  const badge = document.getElementById('agentDetailModelRestarting')
  const display = document.getElementById('agentDetailModel')
  const processLabel = document.getElementById('processLabel')
  const processDot = document.getElementById('processDot')
  const deadline = Date.now() + 60000
  modelRestartPollTimer = setInterval(async () => {
    if (modelRestartPollName !== name || !currentAgent || currentAgent.name !== name) {
      stopModelRestartPolling(); return
    }
    if (Date.now() > deadline) {
      stopModelRestartPolling()
      badge.hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.toast.restart_state_error'))
      return
    }
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(name)}`)
      if (!r.ok) return
      const data = await r.json()
      // The new tmux session's creation timestamp is the reliable "restart
      // complete" signal. Claude Code writes the "model" field into the
      // session jsonl only when it answers a message, so activeModel may
      // stay null/old until the agent receives its first prompt -- waiting
      // for that match would time out on idle agents. The configured model
      // is what the agent was just started with via --model.
      const restarted = data.runningSince && data.runningSince >= triggeredAt
      if (restarted) {
        const displayModel = data.activeModel || data.model
        if (currentAgent && currentAgent.name === name) {
          currentAgent.activeModel = data.activeModel
          currentAgent.runningSince = data.runningSince
          currentAgent.model = data.model
          currentAgent.running = !!data.running
          currentAgent.session = data.session
          display.textContent = displayModel
        }
        badge.hidden = true
        processDot.className = 'process-dot running'
        processLabel.textContent = t('agents.status.running')
        stopModelRestartPolling()
        const liveMatched = data.activeModel === expectedModel
        showToast(liveMatched
          ? t('agents.model.toast_active', { model: displayModel })
          : t('agents.model.toast_restarted', { model: displayModel }))
      }
    } catch { /* network blip, keep polling */ }
  }, 2000)
}

document.getElementById('saveModelBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const newModel = document.getElementById('editAgentModel').value
  const name = currentAgent.name
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel }),
    })
    if (!res.ok) throw new Error()
    currentAgent.model = newModel
    const triggeredAt = Math.floor(Date.now() / 1000)
    document.getElementById('agentDetailModelRestarting').hidden = false
    document.getElementById('processLabel').textContent = t('agents.process_label')
    document.getElementById('processDot').className = 'process-dot restarting'
    showToast(t('agents.toast.model_save_restart'))
    loadAgents()
    const restartRes = await fetch(`/api/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' })
    if (!restartRes.ok) {
      document.getElementById('agentDetailModelRestarting').hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.restart_failed'))
      return
    }
    startModelRestartPolling(name, newModel, triggeredAt)
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('modelSuggestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const resultDiv = document.getElementById('modelSuggestionResult')
  resultDiv.style.display = 'block'
  resultDiv.textContent = t('agents.model.analyzing')
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const entry = results.find(r => r.agent === currentAgent.name)
    if (!entry) {
      resultDiv.textContent = t('agents.model.no_data')
      return
    }
    resultDiv.style.color = entry.changeAdvised ? 'var(--warning, #e6a817)' : 'var(--success)'
    resultDiv.style.whiteSpace = 'pre-wrap'
    resultDiv.style.fontFamily = 'monospace'
    resultDiv.style.fontSize = '12px'
    resultDiv.textContent = entry.reason
  } catch { resultDiv.textContent = t('agents.model.error') }
})

document.getElementById('analyzeAllModelsBtn').addEventListener('click', async () => {
  const panel = document.getElementById('agentsModelAnalysis')
  panel.style.display = 'block'
  panel.innerHTML = '<p style="color:var(--text-muted);font-size:13px">' + t('agents.model.analyzing_all') + '</p>'
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const changes = results.filter(r => r.changeAdvised)
    const ok = results.filter(r => !r.changeAdvised)
    let html = '<div style="font-size:13px;padding:12px 14px;background:var(--surface-hover);border-radius:8px;border:1px solid var(--border)">'
    html += `<p style="margin:0 0 8px;font-weight:600">${t('agents.model.title', { n: results.length })}</p>`
    if (changes.length === 0) {
      html += '<p style="color:var(--success);margin:0">' + t('agents.model.all_ok') + '</p>'
    } else {
      html += `<p style="color:var(--warning, #e6a817);margin:0 0 8px">${t('agents.model.changes_n', { n: changes.length })}</p>`
      html += '<ul style="margin:0 0 10px;padding-left:18px">'
      for (const r of changes) {
        const safeReason = r.reason.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        html += `<li style="margin-bottom:6px"><strong>${r.agent}</strong>: ${r.currentModel} &rarr; ${r.suggestedModel}`
        html += ` <details style="display:inline-block;vertical-align:top;margin-left:4px"><summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">${t('agents.model.details')}</summary>`
        html += `<pre style="white-space:pre-wrap;font-size:11px;margin:4px 0 0;background:var(--surface);padding:6px 8px;border-radius:4px;color:var(--text-muted)">${safeReason}</pre></details></li>`
      }
      html += '</ul>'
      if (ok.length > 0) {
        html += `<p style="color:var(--text-muted);margin:0;font-size:12px">${t('agents.model.ok_agents', { list: ok.map(r => r.agent).join(', ') })}</p>`
      }
      html += `<button class="btn-secondary btn-compact" id="createModelChangeCardsBtn" style="margin-top:10px">${t('agents.model.create_cards_btn')}</button>`
    }
    html += '</div>'
    panel.innerHTML = html
    const createBtn = document.getElementById('createModelChangeCardsBtn')
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        if (!confirm(t('agents.model.cards_confirm', { n: changes.length }))) return
        createBtn.disabled = true
        createBtn.textContent = t('agents.model.creating_cards')
        let created = 0
        for (const r of changes) {
          try {
            await fetch('/api/kanban', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: t('agents.model.card_title', { agent: r.agent }),
                description: t('agents.model.card_desc', { current: r.currentModel, suggested: r.suggestedModel, reason: r.reason }),
                assignee: 'marveen',
                priority: 'normal',
                status: 'planned',
              }),
            })
            created++
          } catch { /* skip failed card */ }
        }
        showToast(t('agents.model.cards_created', { n: created }))
        createBtn.textContent = t('agents.model.cards_created', { n: created })
      })
    }
  } catch { panel.innerHTML = '<p style="color:var(--error);font-size:13px">' + t('agents.model.error') + '</p>' }
})

document.getElementById('saveAutoRestartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  // Auto-restart applies to the main session too, so (unlike model/profile) we
  // do NOT skip role === 'main'. The store key is autoRestartId for the main
  // session, the sanitized name for sub-agents.
  const id = currentAgent.autoRestartId || currentAgent.name
  const schedKind = document.getElementById('arSchedKind').value
  const cfg = {
    enabled: document.getElementById('arEnabled').checked,
    mode: document.getElementById('arMode').value === 'fresh' ? 'fresh' : 'continue',
    dailyTime: schedKind === 'daily' ? document.getElementById('arDailyTime').value : null,
    intervalHours: schedKind === 'interval' ? Number(document.getElementById('arIntervalHours').value) : null,
    handoff: false,
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/auto-restart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    if (currentAgent) currentAgent.autoRestart = body.autoRestart
    showToast(t('agents.toast.auto_restart_saved'))
  } catch { showToast(t('common.error_save')) }
})

// ---- voice config UI -------------------------------------------------------

async function loadVoiceConfig(agentName) {
  const voiceModelSel = document.getElementById('editAgentVoiceModel')
  if (!voiceModelSel) return
  const banner = document.getElementById('voiceNotInstalledBanner')
  const controls = document.getElementById('voiceInstalledControls')
  try {
    // Check toolkit installation first
    const statusR = await fetch('/api/voice/status')
    if (!statusR.ok) return
    const status = await statusR.json()

    if (!status.installed) {
      if (banner) banner.hidden = false
      if (controls) controls.hidden = true
      return
    }
    if (banner) banner.hidden = true
    if (controls) controls.hidden = false

    const r = await fetch(`/api/agents/${encodeURIComponent(agentName)}/voice-config`)
    if (!r.ok) return
    const cfg = await r.json()
    voiceModelSel.innerHTML = (cfg.availableVoices || []).map(v =>
      `<option value="${v}"${v === cfg.voiceModel ? ' selected' : ''}>${v}</option>`
    ).join('')
    const modeInput = document.querySelector(`input[name="voiceResponseMode"][value="${cfg.responseMode || 'text'}"]`)
    if (modeInput) modeInput.checked = true
  } catch { /* silent */ }
}

let _voiceInstallPollTimer = null

document.getElementById('voiceInstallBtn').addEventListener('click', async () => {
  const btn = document.getElementById('voiceInstallBtn')
  const sudoHint = document.getElementById('voiceInstallSudoHint')
  const progress = document.getElementById('voiceInstallProgress')

  if (sudoHint) sudoHint.hidden = true
  btn.disabled = true
  btn.textContent = 'Indítás...'

  try {
    const r = await fetch('/api/voice/install', { method: 'POST' })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()

    if (data.needsSudo) {
      // Show sudo command -- user must run it then click again
      if (sudoHint) {
        sudoHint.hidden = false
        sudoHint.innerHTML = 'A rendszercsomagok telepítéséhez futtasd terminálon:<br><code style="display:block;margin-top:4px;word-break:break-all">' + escapeHtml(data.sudoCommand) + '</code><br>Ezután kattints újra a Telepítés gombra.'
      }
      btn.disabled = false
      btn.textContent = 'Telepítés'
      return
    }

    if (data.alreadyInstalled) {
      if (currentAgent) loadVoiceConfig(currentAgent.name)
      return
    }

    // Install started -- poll /api/voice/status until installed=true.
    // Max 4 minutes (80 × 3s); on timeout show a hint and re-enable the button
    // so the user can retry (the only failure signal from a fire-and-forget spawn).
    if (progress) progress.hidden = false
    btn.textContent = 'Telepítés...'
    clearInterval(_voiceInstallPollTimer)
    let _voiceInstallPollCount = 0
    const VOICE_INSTALL_MAX_POLLS = 80 // 80 × 3s = 4 min
    _voiceInstallPollTimer = setInterval(async () => {
      _voiceInstallPollCount++
      try {
        const sr = await fetch('/api/voice/status')
        const s = await sr.json()
        if (s.installed) {
          clearInterval(_voiceInstallPollTimer)
          _voiceInstallPollTimer = null
          if (progress) progress.hidden = true
          if (currentAgent) loadVoiceConfig(currentAgent.name)
          return
        }
      } catch { /* keep polling */ }
      if (_voiceInstallPollCount >= VOICE_INSTALL_MAX_POLLS) {
        clearInterval(_voiceInstallPollTimer)
        _voiceInstallPollTimer = null
        if (progress) progress.hidden = true
        if (sudoHint) {
          sudoHint.hidden = false
          sudoHint.textContent = 'A telepítés tovább tart vagy elakadt. Ellenőrizd a dashboard logjait, majd próbáld újra.'
        }
        btn.disabled = false
        btn.textContent = 'Újrapróbálás'
      }
    }, 3000)
  } catch {
    btn.disabled = false
    btn.textContent = 'Telepítés'
    showToast('Hiba a telepítés során')
  }
})

document.getElementById('saveVoiceConfigBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const modeEl = document.querySelector('input[name="voiceResponseMode"]:checked')
  const modelEl = document.getElementById('editAgentVoiceModel')
  if (!modeEl || !modelEl) return
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/voice-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseMode: modeEl.value, voiceModel: modelEl.value }),
    })
    if (!r.ok) throw new Error()
    showToast('Hangbeállítás mentve')
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const profile = document.getElementById('editAgentProfile').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/security`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    showToast(body.requiresRestart ? t('agents.toast.profile_saved_restart') : t('agents.toast.profile_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.profile_error')) }
})

// === Auth Mode ===
function selectAuthModeCard(mode) {
  document.querySelectorAll('.auth-mode-card').forEach(c => {
    const isSelected = c.dataset.mode === mode
    c.classList.toggle('selected', isSelected)
    c.querySelector('input[type="radio"]').checked = isSelected
  })
  document.getElementById('authModeSharedSection').hidden = mode !== 'shared'
  document.getElementById('authModeApiKeySection').hidden = mode !== 'api'
  document.getElementById('authModeOwnTeamSection').hidden = mode !== 'own_team'
  document.getElementById('authFlowResult').hidden = true
  document.getElementById('authFlowError').hidden = true
  document.getElementById('authSharedError').hidden = true
}

function updateAuthModeUI(mode, hasApiKey) {
  selectAuthModeCard(mode)
  const keyInput = document.getElementById('editAgentApiKey')
  keyInput.value = ''
  if (mode === 'api') {
    const statusEl = document.getElementById('authModeApiKeyStatus')
    statusEl.textContent = hasApiKey ? t('agents.api_key.ok') : t('agents.api_key.missing')
    statusEl.style.color = hasApiKey ? 'var(--success)' : 'var(--warning)'
  }
}

document.querySelectorAll('.auth-mode-card').forEach(card => {
  card.addEventListener('click', () => {
    selectAuthModeCard(card.dataset.mode)
  })
})

document.getElementById('authSharedApplyBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authSharedApplyBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const errorDiv = document.getElementById('authSharedError')
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const base = `/api/agents/${encodeURIComponent(currentAgent.name)}`
    const saveRes = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode: 'shared' }),
    })
    if (!saveRes.ok) throw new Error('Save failed')
    if (currentAgent.running) {
      await fetch(`${base}/stop`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 2000))
      const startRes = await fetch(`${base}/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startRes.ok) {
        errorDiv.textContent = startData.error || t('agents.error.restart')
        errorDiv.hidden = false
        return
      }
    }
    showToast(t('agents.toast.host_oauth_restart'))
    loadAgents()
    const detailRes = await fetch(base)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
      updateProcessControl(currentAgent)
    }
  } catch {
    errorDiv.textContent = t('agents.error.apply')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowInitBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authFlowInitBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const resultDiv = document.getElementById('authFlowResult')
  const errorDiv = document.getElementById('authFlowError')
  resultDiv.hidden = true
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (data.ok && data.authUrl) {
      const urlEl = document.getElementById('authFlowUrl')
      urlEl.href = data.authUrl
      urlEl.textContent = data.authUrl
      resultDiv.hidden = false
    } else {
      errorDiv.textContent = data.error || 'Auth URL nem talalhato'
      errorDiv.hidden = false
    }
  } catch {
    errorDiv.textContent = t('agents.error.auth_network')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowCopyBtn').addEventListener('click', () => {
  const url = document.getElementById('authFlowUrl').textContent
  navigator.clipboard.writeText(url).then(() => showToast('URL masolva'))
})

document.getElementById('saveAuthModeBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const mode = document.querySelector('input[name="authMode"]:checked')?.value || 'shared'
  const payload = { authMode: mode }
  if (mode === 'api') {
    const key = document.getElementById('editAgentApiKey').value.trim()
    if (key) payload.apiKey = key
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.toast.auth_mode_saved'))
    loadAgents()
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      const updated = await detailRes.json()
      currentAgent = updated
      updateAuthModeUI(updated.authMode || 'shared', updated.hasApiKey || false)
    }
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveClaudeMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd: document.getElementById('editClaudeMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.claude_md_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveSoulMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soulMd: document.getElementById('editSoulMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.soul_md_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveMcpJsonBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpJson: document.getElementById('editMcpJson').value }),
    })
    if (!res.ok) throw new Error()
    showToast('.mcp.json mentve')
  } catch { showToast(t('common.error_save')) }
})

// === Channel tab ===
// Provider-aware "connected" check: a sub-agent record carries hasTelegram /
// hasDiscord / hasSlack flags from the backend, Marveen carries the same
// shape from /api/marveen. Falls back to hasTelegram for legacy callers.
function agentIsConnected(agent) {
  if (!agent) return false
  if (currentChannelProvider === 'discord') return !!agent.hasDiscord
  if (currentChannelProvider === 'slack') return !!agent.hasSlack
  if (currentChannelProvider === 'teams') return !!agent.hasTeams
  return !!agent.hasTelegram
}

function getProviderLabel() {
  if (currentChannelProvider === 'discord') return 'Discord'
  if (currentChannelProvider === 'slack') return 'Slack'
  if (currentChannelProvider === 'teams') return 'Microsoft Teams'
  return 'Telegram'
}

// Connected-view help text per provider. Returns innerHTML for the
// #chHowtoContent <div> -- swapped on every updateProviderUI() call so the
// "Hogyan adj hozzá több embert vagy csoportot?" panel matches the active
// channel provider.
function buildHowtoHtml() {
  if (currentChannelProvider === 'discord') return t('channel.howto.discord')
  if (currentChannelProvider === 'slack') return t('channel.howto.slack')
  if (currentChannelProvider === 'teams') return t('channel.howto.teams')
  return t('channel.howto.telegram')
}

function updateProviderUI() {
  const isTg = currentChannelProvider === 'telegram'
  const title = document.getElementById('chSetupTitle')
  const steps = document.getElementById('chSetupSteps')
  const label = document.getElementById('chTokenLabel')
  const input = document.getElementById('chTokenInput')
  const slackGroup = document.getElementById('chSlackAppTokenGroup')
  const manifestBtnGroup = document.getElementById('chSlackManifestBtnGroup')
  const smokeTestBtn = document.getElementById('chSmokeTestBtn')
  const reconnectBtn = document.getElementById('chReconnectBtn')
  const howto = document.getElementById('chHowtoContent')
  const pairingInfo = document.getElementById('chPairingInfo')
  const discordChannelGroup = document.getElementById('chDiscordChannelIdGroup')
  const tokenGroup = document.getElementById('chTokenGroup')
  // Teams config is terminal-driven (creds land in the .env via setup-azure-bot.sh),
  // not a dashboard token paste -- default the token field visible, hide it for teams.
  if (tokenGroup) tokenGroup.hidden = false

  if (isTg) {
    if (title) title.textContent = t('channel.setup.tg_title')
    if (steps) steps.innerHTML = t('channel.setup.tg_steps')
    if (label) label.textContent = 'Bot API Token'
    if (input) input.placeholder = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.tg_pairing')
  } else if (currentChannelProvider === 'discord') {
    if (title) title.textContent = t('channel.setup.discord_title')
    if (steps) steps.innerHTML = t('channel.setup.discord_steps')
    if (label) label.textContent = 'Bot Token'
    if (input) input.placeholder = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ...'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = false
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.discord_pairing')
  } else if (currentChannelProvider === 'teams') {
    if (title) title.textContent = t('channel.setup.teams_title')
    if (steps) steps.innerHTML = t('channel.setup.teams_steps')
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    // No dashboard token entry for Teams -- creds come from the terminal setup.
    if (tokenGroup) tokenGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.teams_pairing')
  } else {
    if (title) title.textContent = t('channel.setup.slack_title')
    if (steps) steps.innerHTML = t('channel.setup.slack_steps')
    if (label) label.textContent = 'Bot Token (xoxb-...)'
    if (input) input.placeholder = 'xoxb-...'
    if (slackGroup) slackGroup.hidden = false
    if (manifestBtnGroup) manifestBtnGroup.hidden = false
    if (smokeTestBtn) smokeTestBtn.hidden = false
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.slack_pairing')
  }
  if (howto) howto.innerHTML = buildHowtoHtml()
  if (reconnectBtn) {
    reconnectBtn.hidden = !(currentAgent && currentAgent.running && agentIsConnected(currentAgent))
  }
}

function updateChannelTab(agent) {
  const connected = agentIsConnected(agent)
  const running = agent.running || false
  document.getElementById('chNotConnected').hidden = connected
  document.getElementById('chConnected').hidden = !connected
  if (connected) {
    document.getElementById('chBotUsername').textContent = agent.telegramBotUsername || '@bot'
    document.getElementById('chRunNotice').hidden = running
    document.getElementById('chRunningNotice').hidden = !running
  }
  document.getElementById('chTokenInput').value = ''
  const slackInput = document.getElementById('chSlackAppToken')
  if (slackInput) slackInput.value = ''
  const discordChanInput = document.getElementById('chDiscordChannelId')
  if (discordChanInput) discordChanInput.value = ''
  updateProviderUI()
  if (connected && running) {
    refreshChannelHealth()
  } else {
    document.getElementById('chDisconnectedNotice').hidden = true
    document.getElementById('chReconnectBtn').hidden = true
  }
  if (connected) {
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }
}

async function refreshChannelHealth() {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/health`)
    if (!res.ok) return
    const data = await res.json()
    const notice = document.getElementById('chDisconnectedNotice')
    const btn = document.getElementById('chReconnectBtn')
    if (!data.healthy) {
      if (notice) notice.hidden = false
      if (btn) btn.hidden = false
    } else {
      if (notice) notice.hidden = true
      if (btn) btn.hidden = false
    }
  } catch { /* ignore */ }
}

document.getElementById('chProviderSelect').addEventListener('change', (e) => {
  currentChannelProvider = e.target.value
  updateProviderUI()
  if (currentAgent) {
    updateChannelTab(currentAgent)
  }
})

document.getElementById('chConnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const token = document.getElementById('chTokenInput').value.trim()
  if (!token) {
    document.getElementById('chTokenInput').focus()
    return
  }

  const payload = { botToken: token }
  if (currentChannelProvider === 'slack') {
    const appToken = document.getElementById('chSlackAppToken').value.trim()
    if (appToken) payload.appToken = appToken
  } else if (currentChannelProvider === 'discord') {
    const channelId = document.getElementById('chDiscordChannelId').value.trim()
    if (channelId) payload.channelId = channelId
  }

  const btn = document.getElementById('chConnectBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`${channelApiBase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      const err = await res.json()
      if (err.error === 'managed-settings-missing') {
        showSudoModal(err.sudoCommand)
        return
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Kapcsolodasi hiba')
    }
    const result = await res.json()
    showToast(`${getProviderLabel()} sikeresen csatlakoztatva!`)
    // Refresh detail
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('chTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/test`, { method: 'POST' })
    if (!res.ok) throw new Error()
    showToast('Kapcsolat rendben!')
  } catch {
    showToast(t('channel.toast.smoke_failed'))
  }
})

document.getElementById('chReconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chReconnectBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.reconnect')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/reconnect`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      showToast('Channel-MCP reconnect sikeres')
      document.getElementById('chDisconnectedNotice').hidden = true
    } else {
      showToast(data.message || 'Reconnect sikertelen', true)
    }
  } catch {
    showToast('Reconnect hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

document.getElementById('chSmokeTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chSmokeTestBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.running')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent)}/channels/slack/smoke-test`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      showToast(data.error || 'Smoke-test sikertelen', true)
      return
    }
    showSmokeTestResult(data.output || 'OK')
  } catch {
    showToast('Smoke-test hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

function showSmokeTestResult(output) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:600px">
      <h3>${t('channel.smoke_test.title')}</h3>
      <pre style="background:#1a1a2e;color:#e0e0e0;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;max-height:400px;white-space:pre-wrap">${output.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      <div style="text-align:right;margin-top:12px">
        <button class="btn-secondary" id="smokeTestCloseBtn">${t('common.btn.close')}</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.getElementById('smokeTestCloseBtn').addEventListener('click', () => overlay.remove())
}

// Pairing: refresh pending list
async function refreshPendingPairings() {
  if (!currentAgent) return
  const listEl = document.getElementById('chPendingList')
  try {
    const res = await fetch(`${channelApiBase()}/pending`)
    if (!res.ok) return
    const pending = await res.json()
    listEl.innerHTML = ''
    if (pending.length === 0) {
      listEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">${t('channel.pending.empty')}</div>`
      return
    }
    for (const p of pending) {
      const item = document.createElement('div')
      item.className = 'tg-pending-item'
      const created = new Date(p.createdAt).toLocaleString('hu-HU')
      item.innerHTML = `
        <div>
          <span class="tg-pending-code">${escapeHtml(p.code)}</span>
          <span class="tg-pending-sender">Sender: ${escapeHtml(p.senderId)}</span>
        </div>
        <button class="btn-primary btn-compact" style="padding:5px 12px; font-size:12px; margin:0" data-code="${escapeHtml(p.code)}">${t('common.btn.approve')}</button>
      `
      item.querySelector('button').addEventListener('click', async () => {
        await approvePairing(p.code)
      })
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function approvePairing(code) {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('channel.toast.approve_error'))
    }
    showToast(t('channel.toast.pairing_approved'))
    refreshPendingPairings()
    refreshAllowedList()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chRefreshPendingBtn').addEventListener('click', refreshPendingPairings)

async function refreshAllowedList() {
  if (!currentAgent) return
  const listEl = document.getElementById('chAllowedList')
  try {
    const res = await fetch(`${channelApiBase()}/allowed`)
    if (!res.ok) return
    const data = await res.json()
    const users = data.users || []
    const groups = data.groups || []
    if (users.length === 0 && groups.length === 0) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.allowed.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const id of users) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind">DM</span>
          <span class="tg-allowed-id">${escapeHtml(id)}</span>
        </div>
        <button class="btn-icon-danger" title="${t('common.btn.remove')}" data-kind="user" data-id="${escapeHtml(id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('user', id))
      listEl.appendChild(item)
    }
    for (const g of groups) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.badge.group')}</span>
          <span class="tg-allowed-id">${escapeHtml(g.id)}</span>
        </div>
        <button class="btn-icon-danger" title="${t('common.btn.remove')}" data-kind="group" data-id="${escapeHtml(g.id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('group', g.id))
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function removeAllowed(kind, id) {
  if (!currentAgent) return
  const label = kind === 'user' ? t('channel.kind.user') : t('channel.kind.group')
  if (!confirm(t('channel.confirm.remove', { label, id }))) return
  try {
    const res = await fetch(`${channelApiBase()}/allowed/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || t('channel.toast.remove_error'))
    }
    showToast(t('common.toast.removed'))
    refreshAllowedList()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chRefreshAllowedBtn').addEventListener('click', refreshAllowedList)

async function refreshInvites() {
  if (!currentAgent) return
  const listEl = document.getElementById('chInviteList')
  try {
    const res = await fetch(`${channelApiBase()}/invites`)
    if (!res.ok) return
    const items = await res.json()
    if (!items.length) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.invite.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const inv of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const expiresIn = Math.max(0, Math.floor((inv.expiresAt - Date.now()) / 60000))
      const status = inv.used
        ? `<span class="tg-allowed-kind" style="background:rgba(180,180,180,0.15); color:var(--text-muted);">${t('channel.invite.used_badge')}</span>`
        : `<span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.invite.active_badge', { min: expiresIn })}</span>`
      const linkHtml = inv.deepLink
        ? `<a href="${escapeHtml(inv.deepLink)}" target="_blank" class="tg-allowed-id" style="text-decoration:underline;">${escapeHtml(inv.deepLink)}</a>`
        : `<span class="tg-allowed-id">${t('channel.invite.no_username')}</span>`
      item.innerHTML = `
        <div class="tg-allowed-meta" style="flex-wrap:wrap; gap:6px;">
          ${status}
          ${linkHtml}
        </div>
        <div style="display:flex; gap:6px;">
          ${inv.deepLink && !inv.used ? `<button class="btn-secondary btn-compact" data-link="${escapeHtml(inv.deepLink)}" style="padding:4px 10px; font-size:11px; margin:0;">${t('common.btn.copy_btn')}</button>` : ''}
          <button class="btn-icon-danger" title="${t('channel.btn.revoke')}" data-token="${escapeHtml(inv.token)}">&times;</button>
        </div>
      `
      const copyBtn = item.querySelector('button[data-link]')
      if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
          const link = e.currentTarget.getAttribute('data-link')
          try { await navigator.clipboard.writeText(link); showToast(t('common.toast.copied')) }
          catch { showToast(t('common.toast.copy_failed')) }
        })
      }
      const revokeBtn = item.querySelector('button[data-token]')
      if (revokeBtn) {
        revokeBtn.addEventListener('click', () => revokeInviteToken(inv.token))
      }
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function generateInvite() {
  if (!currentAgent) return
  const btn = document.getElementById('chGenerateInviteBtn')
  btn.disabled = true
  btn.textContent = t('channel.btn.invite_gen')
  try {
    const res = await fetch(`${channelApiBase()}/invites`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Sikertelen')
    }
    const data = await res.json()
    if (data.deepLink) {
      try { await navigator.clipboard.writeText(data.deepLink); showToast(t('channel.toast.invite_copied')) }
      catch { showToast(t('channel.toast.invite_created')) }
    } else {
      showToast(t('channel.toast.invite_pending'))
    }
    refreshInvites()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = t('channel.btn.invite_new')
  }
}

async function revokeInviteToken(token) {
  if (!currentAgent) return
  if (!confirm(t('channel.confirm.revoke'))) return
  try {
    const res = await fetch(`${channelApiBase()}/invites/${encodeURIComponent(token)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Sikertelen')
    }
    showToast(t('channel.toast.invite_revoked'))
    refreshInvites()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chGenerateInviteBtn').addEventListener('click', generateInvite)
document.getElementById('chRefreshInvitesBtn').addEventListener('click', refreshInvites)

// --- Channel Requests (Slack channel opt-in) ---
async function refreshChannelRequests() {
  if (!currentAgent) return
  const section = document.getElementById('chRequestSection')
  const listEl = document.getElementById('chRequestList')
  const badge = document.getElementById('chRequestBadge')
  if (currentChannelProvider !== 'slack') {
    section.hidden = true
    return
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests`)
    if (!res.ok) { section.hidden = true; return }
    const items = await res.json()
    if (!items.length) {
      section.hidden = true
      badge.hidden = true
      return
    }
    section.hidden = false
    badge.hidden = false
    badge.textContent = items.length
    listEl.innerHTML = ''
    for (const req of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const name = req.channel_name ? escapeHtml(req.channel_name) : req.channel_id
      const ts = new Date(req.requested_at * 1000).toLocaleString('hu-HU')
      const userId = req.user_id ? `<span class="tg-allowed-id">user: ${escapeHtml(req.user_id)}</span>` : ''
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">#${name}</span>
          ${userId}
          <span class="tg-allowed-id" style="font-size:11px;color:var(--text-muted)">${ts}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-primary btn-compact" data-approve="${req.id}" style="padding:4px 10px;font-size:11px;margin:0">${t('common.btn.approve')}</button>
          <button class="btn-icon-danger" data-deny="${req.id}" title="${t('channel.btn.deny')}">&times;</button>
        </div>
      `
      item.dataset.reqId = req.id
      item.querySelector('[data-approve]').addEventListener('click', () => openApproveModal(req.id, req.channel_name || req.channel_id, req.user_id))
      item.querySelector('[data-deny]').addEventListener('click', () => denyChannelRequest(req.id, item))
      listEl.appendChild(item)
    }
  } catch { section.hidden = true }
}

let _approveReqId = null

function openApproveModal(id, channelName, userId) {
  _approveReqId = id
  const desc = document.getElementById('chApproveModalDesc')
  const userNote = userId ? t('channel.approve.requester', { user: escapeHtml(userId) }) : ''
  desc.textContent = t('channel.approve.desc', { channel: escapeHtml(channelName), requester: userNote })
  document.getElementById('chApproveRequireMention').checked = true
  document.getElementById('chApproveAllowFromAll').checked = false
  document.getElementById('chApproveModalOverlay').hidden = false
}

async function submitApproveModal() {
  const id = _approveReqId
  if (!id) return
  const requireMention = document.getElementById('chApproveRequireMention').checked
  const allowFromAll = document.getElementById('chApproveAllowFromAll').checked
  const confirmBtn = document.getElementById('chApproveModalConfirm')
  confirmBtn.querySelector('.btn-text').hidden = true
  confirmBtn.querySelector('.btn-loading').hidden = false
  confirmBtn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireMention, allowFromAll }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Hiba')
    document.getElementById('chApproveModalOverlay').hidden = true
    const item = document.querySelector(`[data-req-id="${id}"]`)
    if (item) item.remove()
    showToast(t('channel.toast.approved'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    confirmBtn.querySelector('.btn-text').hidden = false
    confirmBtn.querySelector('.btn-loading').hidden = true
    confirmBtn.disabled = false
  }
}

async function denyChannelRequest(id, itemEl) {
  if (itemEl?.dataset.denying) return
  if (itemEl) itemEl.dataset.denying = '1'
  if (itemEl) itemEl.remove()
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/deny`, { method: 'POST' })
    if (!res.ok) throw new Error('Hiba')
    showToast(t('channel.toast.denied'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    refreshChannelRequests()
  }
}

;(function initApproveModal() {
  function closeApproveModal() { document.getElementById('chApproveModalOverlay').hidden = true }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chApproveModalConfirm').addEventListener('click', submitApproveModal)
    document.getElementById('chApproveModalClose').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalCancel').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeApproveModal() })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('chApproveModalOverlay').hidden) closeApproveModal()
    })
  })
})()

document.getElementById('chApproveBtn').addEventListener('click', async () => {
  const code = document.getElementById('chPairCode').value.trim()
  if (!code) { document.getElementById('chPairCode').focus(); return }
  await approvePairing(code)
  document.getElementById('chPairCode').value = ''
  refreshAllowedList()
})

document.getElementById('chDisconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const provLabel = getProviderLabel()
  if (!confirm(`Biztosan levalasztod a ${provLabel} csatornat?`)) return
  try {
    await fetch(`${channelApiBase()}`, { method: 'DELETE' })
    showToast(`${provLabel} levalasztva`)
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch {
    showToast(t('channel.toast.disconnect_error'))
  }
})

// === Skills ===
async function loadSkills(agentName) {
  const listEl = document.getElementById('skillList')
  const emptyEl = document.getElementById('skillEmpty')
  listEl.innerHTML = ''

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/skills`)
    if (!res.ok) throw new Error()
    const skills = await res.json()

    emptyEl.hidden = skills.length > 0
    document.getElementById('agentDetailSkillCount').textContent = skills.length

    for (const skill of skills) {
      const item = document.createElement('div')
      item.className = 'skill-item'
      // Inherited global skills (~/.claude/skills) are shared across every
      // agent, so they get a badge and no per-agent delete button -- only the
      // agent's own local skills are deletable from this view.
      const isGlobal = skill.source === 'global'
      const badge = isGlobal
        ? `<span class="skill-item-badge" title="${t('skills.badge.global')}">${t('skills.badge.global')}</span>`
        : ''
      const deletable = skill.deletable !== false
      item.innerHTML = `
        <div class="skill-item-info">
          <div class="skill-item-name">${escapeHtml(skill.name)}${badge}</div>
          ${skill.description ? `<div class="skill-item-desc">${escapeHtml(skill.description)}</div>` : ''}
        </div>
        <div class="skill-item-actions">
          ${deletable ? `<button class="btn-icon btn-icon-danger" title="${t('skills.btn.delete')}">${trashIcon()}</button>` : ''}
        </div>
      `
      const delBtn = item.querySelector('.btn-icon-danger')
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm(t('skills.confirm.delete', { name: skill.name }))) return
          try {
            await fetch(`/api/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' })
            showToast(t('skills.toast.deleted'))
            loadSkills(agentName)
          } catch {
            showToast(t('common.error_delete'))
          }
        })
      }
      listEl.appendChild(item)
    }
  } catch {
    emptyEl.hidden = false
    document.getElementById('agentDetailSkillCount').textContent = '0'
  }
}

// Add skill button
document.getElementById('addSkillBtn').addEventListener('click', () => {
  skillModalScope = null  // per-agent flow keyed off currentAgent
  document.getElementById('skillName').value = ''
  document.getElementById('skillDescription').value = ''
  skillFile = null
  document.getElementById('skillFileName').textContent = ''
  // Reset to create tab
  document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.skillTab === 'create'))
  document.getElementById('skillTabCreate').hidden = false
  document.getElementById('skillTabImport').hidden = true
  openModal(skillModalOverlay)
  setTimeout(() => document.getElementById('skillName').focus(), 200)
})

// Skill modal tab switching
document.querySelectorAll('.skill-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
    document.getElementById('skillTabCreate').hidden = btn.dataset.skillTab !== 'create'
    document.getElementById('skillTabImport').hidden = btn.dataset.skillTab !== 'import'
  })
})

// File upload area
const skillFileArea = document.getElementById('skillFileArea')
const skillFileInput = document.getElementById('skillFileInput')
let skillFile = null

skillFileArea.addEventListener('click', () => skillFileInput.click())
skillFileArea.addEventListener('dragover', (e) => { e.preventDefault(); skillFileArea.style.borderColor = 'var(--accent)' })
skillFileArea.addEventListener('dragleave', () => { skillFileArea.style.borderColor = '' })
skillFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  skillFileArea.style.borderColor = ''
  const file = e.dataTransfer.files[0]
  if (file) { skillFile = file; document.getElementById('skillFileName').textContent = file.name }
})
skillFileInput.addEventListener('change', () => {
  const file = skillFileInput.files[0]
  if (file) { skillFile = file; document.getElementById('skillFileName').textContent = file.name }
})

// Create skill
document.getElementById('saveSkillBtn').addEventListener('click', async () => {
  const isGlobal = skillModalScope === 'global'
  if (!isGlobal && !currentAgent) return
  const name = document.getElementById('skillName').value.trim()
  if (!name) { document.getElementById('skillName').focus(); return }

  const btn = document.getElementById('saveSkillBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const url = isGlobal
      ? '/api/skills'
      : `/api/agents/${encodeURIComponent(agentApiName())}/skills`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: document.getElementById('skillDescription').value.trim(),
      }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    closeModal(skillModalOverlay)
    showToast(t('skills.toast.added'))
    if (isGlobal) {
      loadGlobalSkills()
    } else {
      loadSkills(agentApiName())
    }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// Import skill
document.getElementById('importSkillBtn').addEventListener('click', async () => {
  const isGlobal = skillModalScope === 'global'
  if (!skillFile) { showToast(t('skills.toast.select_file')); return }
  if (!isGlobal && !currentAgent) { showToast(t('skills.toast.select_file')); return }

  const btn = document.getElementById('importSkillBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const formData = new FormData()
    formData.append('file', skillFile)
    const url = isGlobal
      ? '/api/skills/import'
      : `/api/agents/${encodeURIComponent(agentApiName())}/skills/import`
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Import hiba')
    }
    const result = await res.json()
    closeModal(skillModalOverlay)
    const importedList = Array.isArray(result.imported) ? result.imported : []
    showToast(t('skills.toast.imported', { list: importedList.join(', ') }))
    skillFile = null
    document.getElementById('skillFileName').textContent = ''
    if (isGlobal) {
      loadGlobalSkills()
    } else {
      loadSkills(agentApiName())
    }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// ============================================================
// === Schedules ===
// ============================================================

const scheduleList = document.getElementById('scheduleList')
const scheduleEmpty = document.getElementById('scheduleEmpty')
const scheduleModalOverlay = document.getElementById('scheduleModalOverlay')
const scheduleFrequency = document.getElementById('scheduleFrequency')
const scheduleTimeGroup = document.getElementById('scheduleTimeGroup')
const customScheduleGroup = document.getElementById('customScheduleGroup')
const saveScheduleBtn = document.getElementById('saveScheduleBtn')

let schedules = []
let scheduleAgents = []
let currentScheduleView = 'list'

// Modal wiring
document.getElementById('addScheduleBtn').addEventListener('click', () => {
  resetScheduleForm()
  document.getElementById('scheduleModalTitle').textContent = t('tasks.modal.new_title')
  document.getElementById('scheduleName').disabled = false
  openModal(scheduleModalOverlay)
  loadScheduleAgents().then(() => {
    setTimeout(() => document.getElementById('scheduleName').focus(), 200)
  })
})
document.getElementById('scheduleModalClose').addEventListener('click', () => closeModal(scheduleModalOverlay))
scheduleModalOverlay.addEventListener('click', (e) => { if (e.target === scheduleModalOverlay) closeModal(scheduleModalOverlay) })

// Frequency change handler
// Type toggle (task vs heartbeat)
document.getElementById('scheduleType').addEventListener('change', () => {
  const isHeartbeat = document.getElementById('scheduleType').value === 'heartbeat'
  document.getElementById('heartbeatTemplateGroup').hidden = !isHeartbeat
  if (isHeartbeat && !document.getElementById('schedulePrompt').value.trim()) {
    // Set default heartbeat schedule to every 15 min
    scheduleFrequency.value = 'custom'
    document.getElementById('scheduleCustomCron').value = '*/15 * * * *'
    customScheduleGroup.hidden = false
    scheduleTimeGroup.hidden = true
  }
})

// Heartbeat templates
const HEARTBEAT_TEMPLATES = {
  calendar: {
    desc: () => t('tasks.heartbeat.tpl.calendar'),
    prompt: 'Ellenorizd a naptaramat (list-events a mai napra). Ha van meeting 1 oran belul, szolj Telegramon es 10 perccel a meeting elott is emlekeztetess. Ha nincs kozelgo esemeny, ne irj semmit.',
    schedule: '*/15 * * * *',
  },
  email: {
    desc: () => t('tasks.heartbeat.tpl.email'),
    prompt: 'Ellenorizd az emailjeimet (search_emails newer_than:1h). Ha surgos vagy fontos levelet talalsz (pl. ugyfeltol, fonokotol, fizetessel kapcsolatos), szolj Telegramon. Ha csak promo/newsletter, ne irj semmit.',
    schedule: '*/30 * * * *',
  },
  kanban: {
    desc: () => t('tasks.heartbeat.tpl.kanban'),
    prompt: 'Ellenorizd a kanban tablat (curl -s http://localhost:3420/api/kanban). Ha van olyan kartya aminek ma jar le a hatrideje vagy urgent prioritasu es meg nincs done, szolj Telegramon. Ha minden rendben, ne irj semmit.',
    schedule: '0 */2 * * *',
  },
  full: {
    desc: () => t('tasks.heartbeat.tpl.full'),
    prompt: 'Ellenorizd: 1) Naptar - van-e meeting 1 oran belul? 2) Email - jott-e surgos level az elmult oraban? 3) Kanban - van-e mai hataridovel kartya? Ha BARMIT talalsz ami fontos, szolj Telegramon tomoren. Ha minden csendes, ne irj semmit.',
    schedule: '*/15 * * * *',
  },
}

document.getElementById('heartbeatTemplate').addEventListener('change', () => {
  const tpl = HEARTBEAT_TEMPLATES[document.getElementById('heartbeatTemplate').value]
  if (!tpl) return
  document.getElementById('scheduleDesc').value = typeof tpl.desc === 'function' ? tpl.desc() : tpl.desc
  document.getElementById('schedulePrompt').value = tpl.prompt
  document.getElementById('scheduleCustomCron').value = tpl.schedule
  scheduleFrequency.value = 'custom'
  customScheduleGroup.hidden = false
  scheduleTimeGroup.hidden = true
})

scheduleFrequency.addEventListener('change', () => {
  const freq = scheduleFrequency.value
  const needsTime = ['daily', 'weekdays', 'weekly-mon', 'weekly-fri'].includes(freq)
  const isCustom = freq === 'custom'
  scheduleTimeGroup.hidden = !needsTime
  customScheduleGroup.hidden = !isCustom
  if (isCustom) document.getElementById('scheduleCustomCron').focus()
})

// View toggle buttons
document.querySelectorAll('.view-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn[data-view]').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentScheduleView = btn.dataset.view
    document.getElementById('scheduleListView').hidden = currentScheduleView !== 'list'
    document.getElementById('scheduleTimelineView').hidden = currentScheduleView !== 'timeline'
    document.getElementById('scheduleWeekView').hidden = currentScheduleView !== 'week'
    if (currentScheduleView === 'timeline') renderTimeline(schedules)
    if (currentScheduleView === 'week') renderWeekView(schedules)
  })
})

function resetScheduleForm() {
  document.getElementById('scheduleName').value = ''
  document.getElementById('scheduleDesc').value = ''
  document.getElementById('schedulePrompt').value = ''
  document.getElementById('scheduleSkipIfBusy').checked = false
  document.getElementById('scheduleForceSend').checked = false
  document.getElementById('scheduleTargetSession').value = ''
  scheduleFrequency.value = 'daily'
  document.getElementById('scheduleTime').value = '09:00'
  document.getElementById('scheduleCustomCron').value = ''
  customScheduleGroup.hidden = true
  scheduleTimeGroup.hidden = false
  document.getElementById('expandQuestions').hidden = true
  document.getElementById('expandStatus').textContent = ''
  expandAnswers = []
  document.getElementById('scheduleEditName').value = ''
  document.getElementById('scheduleType').value = 'task'
  document.getElementById('heartbeatTemplateGroup').hidden = true
  document.getElementById('heartbeatTemplate').value = ''
  saveScheduleBtn.disabled = false
  saveScheduleBtn.querySelector('.btn-text').hidden = false
  saveScheduleBtn.querySelector('.btn-loading').hidden = true
}

function getScheduleCron() {
  const freq = scheduleFrequency.value
  if (freq === 'custom') return document.getElementById('scheduleCustomCron').value.trim()

  const time = document.getElementById('scheduleTime').value || '09:00'
  const [h, m] = time.split(':').map(Number)

  switch (freq) {
    case 'daily': return `${m} ${h} * * *`
    case 'weekdays': return `${m} ${h} * * 1-5`
    case 'weekly-mon': return `${m} ${h} * * 1`
    case 'weekly-fri': return `${m} ${h} * * 5`
    case 'hourly': return `0 * * * *`
    case 'every2h': return `0 */2 * * *`
    case 'every4h': return `0 */4 * * *`
    case 'every30m': return `*/30 * * * *`
    default: return `${m} ${h} * * *`
  }
}

function parseCronToForm(cron) {
  const parts = cron.split(' ')
  if (parts.length < 5) { scheduleFrequency.value = 'custom'; customScheduleGroup.hidden = false; document.getElementById('scheduleCustomCron').value = cron; return }
  const [minute, hour, dom, month, dow] = parts

  // Interval patterns
  if (minute === '*/30' && hour === '*') { scheduleFrequency.value = 'every30m'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }
  if (minute === '0' && hour === '*') { scheduleFrequency.value = 'hourly'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }
  if (minute === '0' && hour === '*/2') { scheduleFrequency.value = 'every2h'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }
  if (minute === '0' && hour === '*/4') { scheduleFrequency.value = 'every4h'; scheduleTimeGroup.hidden = true; customScheduleGroup.hidden = true; return }

  // Time-based patterns
  const h = parseInt(hour); const m = parseInt(minute)
  if (!isNaN(h) && !isNaN(m)) {
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    document.getElementById('scheduleTime').value = timeStr
    scheduleTimeGroup.hidden = false
    customScheduleGroup.hidden = true

    if (dow === '1-5') { scheduleFrequency.value = 'weekdays'; return }
    if (dow === '1') { scheduleFrequency.value = 'weekly-mon'; return }
    if (dow === '5') { scheduleFrequency.value = 'weekly-fri'; return }
    if (dow === '*' && dom === '*') { scheduleFrequency.value = 'daily'; return }
  }

  // Fallback to custom
  scheduleFrequency.value = 'custom'
  customScheduleGroup.hidden = false
  scheduleTimeGroup.hidden = true
  document.getElementById('scheduleCustomCron').value = cron
}

function describeCron(cron) {
  const parts = cron.split(' ')
  if (parts.length < 5) return cron
  const [minute, hour, dom, month, dow] = parts

  // Interval patterns
  if (minute.startsWith('*/')) return t('tasks.cron.every_n_min', { n: minute.split('/')[1] })
  if (hour.startsWith('*/')) return t('tasks.cron.every_n_hour', { n: hour.split('/')[1] })
  if (minute === '0' && hour === '*') return t('tasks.cron.every_hour')

  // Time-based
  const h = parseInt(hour); const m = parseInt(minute)
  if (!isNaN(h) && !isNaN(m)) {
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    if (dow === '1-5') return t('tasks.cron.weekdays', { time: timeStr })
    if (dow === '0,6' || dow === '6,0') return t('tasks.cron.weekends', { time: timeStr })
    if (t(`tasks.cron.dow.${dow}`) !== `tasks.cron.dow.${dow}`) return `${t(`tasks.cron.dow.${dow}`)} ${timeStr}`
    if (dow === '*' && dom === '*') return t('tasks.cron.daily', { time: timeStr })
    if (dom !== '*') return t('tasks.cron.monthly', { dom, time: timeStr })
  }

  return cron
}

function cronToHours(cron) {
  const parts = cron.split(' ')
  if (parts.length < 5) return []
  const hour = parts[1]

  if (hour === '*') return Array.from({length: 24}, (_, i) => i)
  if (hour.includes('/')) {
    const step = parseInt(hour.split('/')[1])
    if (isNaN(step) || step <= 0) return []
    return Array.from({length: 24}, (_, i) => i).filter(h => h % step === 0)
  }
  if (hour.includes(',')) return hour.split(',').map(Number).filter(n => !isNaN(n))
  if (hour.includes('-')) {
    const [start, end] = hour.split('-').map(Number)
    if (isNaN(start) || isNaN(end)) return []
    return Array.from({length: end - start + 1}, (_, i) => start + i)
  }
  const h = parseInt(hour)
  return isNaN(h) ? [] : [h]
}

function cronToMinute(cron) {
  const parts = cron.split(' ')
  if (parts.length < 1) return 0
  const m = parseInt(parts[0])
  return isNaN(m) ? 0 : m
}

async function loadScheduleAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    scheduleAgents = await res.json()
    const sel = document.getElementById('scheduleAgent')
    sel.innerHTML = ''
    for (const a of scheduleAgents) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.label || a.name
      sel.appendChild(opt)
    }
  } catch (err) {
    console.error('Ügynök lista hiba:', err)
  }
}

async function loadSchedules() {
  try {
    const [schedulesRes] = await Promise.all([
      fetch('/api/schedules'),
      loadScheduleAgents(),
    ])
    schedules = await schedulesRes.json()
    renderScheduleList(schedules)
    if (currentScheduleView === 'timeline') renderTimeline(schedules)
    loadPendingRetries()
  } catch (err) {
    console.error('Ütemezés betöltés hiba:', err)
  }
}

async function loadPendingRetries() {
  const container = document.getElementById('pendingRetriesSection')
  if (!container) return
  try {
    const res = await fetch('/api/schedules/pending')
    if (!res.ok) { container.hidden = true; return }
    const rows = await res.json()
    renderPendingRetries(container, Array.isArray(rows) ? rows : [])
  } catch (err) {
    console.error('Pending retry betöltés hiba:', err)
    container.hidden = true
  }
}

function formatPendingAge(ms) {
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return t('common.time.less_than_min')
  if (mins < 60) return t('common.time.minutes', { n: mins })
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins ? t('common.time.hours_mins', { h: hours, m: remMins }) : t('common.time.hours', { h: hours })
}

function renderPendingRetries(container, rows) {
  if (!rows.length) {
    container.hidden = true
    container.innerHTML = ''
    return
  }
  container.hidden = false
  const items = rows.map(r => `
    <div class="pending-retry-row" data-id="${r.id}">
      <div class="pending-retry-info">
        <div class="pending-retry-title">
          ${escapeHtml(r.taskName)}
          <span class="badge badge-paused">${escapeHtml(r.agentName)}</span>
          ${r.alertSentAt
            ? `<span class="badge badge-heartbeat" title="${t('tasks.heartbeat.alert_badge_sent')}">⚠️ ${t('tasks.heartbeat.alert_sent')}</span>`
            : r.alertDue
              ? `<span class="badge badge-heartbeat" title="${t('tasks.heartbeat.alert_badge_pending')}">⏳ ${t('tasks.heartbeat.alert_pending')}</span>`
              : ''}
        </div>
        <div class="pending-retry-meta">
          <span>${t('tasks.retries.meta', { age: formatPendingAge(r.ageMs), n: r.attemptCount })}</span>
          ${r.lastReason ? `<span>ok: ${escapeHtml(r.lastReason)}</span>` : ''}
        </div>
      </div>
      <button class="btn-icon btn-icon-danger" data-action="cancel-pending" title="${t('common.btn.remove')}">
        ${trashIcon()}
      </button>
    </div>
  `).join('')
  container.innerHTML = `
    <div class="pending-retries-banner">
      <div class="pending-retries-header">
        <span class="pending-retries-title">${t('tasks.retries.title', { n: rows.length })}</span>
        <span class="pending-retries-hint">${t('tasks.retries.hint')}</span>
      </div>
      <div class="pending-retries-list">${items}</div>
    </div>
  `
  container.querySelectorAll('[data-action="cancel-pending"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const row = e.currentTarget.closest('.pending-retry-row')
      const id = row?.dataset.id
      if (!id) return
      if (!confirm(t('tasks.confirm.cancel_pending'))) return
      try {
        const res = await fetch(`/api/schedules/pending/${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('cancel failed')
        loadPendingRetries()
      } catch (err) {
        console.error('Pending retry cancel hiba:', err)
      }
    })
  })
}

// Classify a cron expression into a cadence bucket for grouping the list.
function cronCadence(cron) {
  const p = (cron || '').trim().split(/\s+/)
  if (p.length < 5) return { order: 5, label: t('tasks.cadence.other') }
  const [min, hour, , mon, dow] = p
  const dom = p[2]
  if (mon !== '*' || dom !== '*') return { order: 3, label: t('tasks.cadence.monthly') }
  if (dow !== '*' && dow !== '1-5') return { order: 2, label: t('tasks.cadence.weekly') }
  const multiDaily = /[\/,\-]/.test(min) || /[\/,\-]/.test(hour)
  if (multiDaily) return { order: 0, label: t('tasks.cadence.sub_hourly') }
  return { order: 1, label: t('tasks.cadence.daily') }
}
const CADENCE_ICON = { 0: '⚡', 1: '☀️', 2: '📅', 3: '🗓️', 5: '•' }

function makeScheduleRow(task) {
    const row = document.createElement('div')
    row.className = 'schedule-row'
    const agent = scheduleAgents.find(a => a.name === task.agent) || { name: task.agent || mainAgentId(), avatar: '/api/marveen/avatar', label: task.agent || mainAgentId() }

    row.innerHTML = `
      <div class="schedule-agent-avatar">
        <img src="${agent.avatar}?t=${Date.now()}" alt="" onerror="this.style.display='none'">
      </div>
      <div class="schedule-info">
        <div class="schedule-title">
          ${escapeHtml(task.description || task.name)}
          ${task.type === 'heartbeat' ? '<span class="badge badge-heartbeat">💓 heartbeat</span>' : ''}
          <span class="badge ${task.enabled ? 'badge-active' : 'badge-paused'}">${task.enabled ? t('tasks.status.active') : t('tasks.status.paused')}</span>
        </div>
        <div class="schedule-meta">
          <span class="schedule-cron">${escapeHtml(task.schedule)}</span>
          <span>${describeCron(task.schedule)}</span>
          <span class="schedule-agent-name">${escapeHtml(agent.label || agent.name)}</span>
        </div>
      </div>
      <div class="schedule-actions">
        <button class="btn-icon" data-action="run" title="${t('tasks.btn.run_now')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        </button>
        <button class="btn-icon" data-action="toggle" title="${task.enabled ? t('tasks.btn.toggle_pause') : t('tasks.btn.toggle_resume')}">
          ${task.enabled ? pauseIcon() : playIcon()}
        </button>
        <button class="btn-icon" data-action="history" title="${t('tasks.btn.history')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        </button>
        <button class="btn-icon btn-icon-danger" data-action="delete" title="${t('tasks.btn.delete')}">
          ${trashIcon()}
        </button>
      </div>
    `

    // Row click -> edit (but not action buttons)
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-icon')) return
      openEditSchedule(task)
    })

    // Action buttons
    row.querySelector('[data-action="run"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        const r = await fetch(`/api/schedules/${encodeURIComponent(task.name)}/run`, { method: 'POST' })
        const data = await r.json().catch(() => ({}))
        if (r.ok) showToast(t('tasks.toast.run_started') + (data.result ? ': ' + data.result : ''))
        else showToast('Hiba: ' + (data.error || r.status))
        loadSchedules()
      } catch { showToast(t('tasks.toast.run_error')) }
    })

    row.querySelector('[data-action="toggle"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await fetch(`/api/schedules/${encodeURIComponent(task.name)}/toggle`, { method: 'POST' })
        showToast(task.enabled ? t('tasks.toast.toggled_paused') : t('tasks.toast.toggled_resumed'))
        loadSchedules()
      } catch { showToast(t('common.error')) }
    })

    row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(t('tasks.confirm.task_delete'))) return
      try {
        await fetch(`/api/schedules/${encodeURIComponent(task.name)}`, { method: 'DELETE' })
        showToast(t('tasks.toast.deleted'))
        loadSchedules()
      } catch { showToast(t('common.error_delete')) }
    })

    row.querySelector('[data-action="history"]').addEventListener('click', async (e) => {
      e.stopPropagation()
      openScheduleRunHistory(task.name)
    })

    return row
}

function renderScheduleList(tasks) {
  scheduleList.innerHTML = ''
  scheduleEmpty.hidden = tasks.length > 0
  const groups = new Map()
  for (const task of tasks) {
    const c = cronCadence(task.schedule)
    if (!groups.has(c.order)) groups.set(c.order, { label: c.label, tasks: [] })
    groups.get(c.order).tasks.push(task)
  }
  for (const o of [0, 1, 2, 3, 5]) {
    const g = groups.get(o)
    if (!g) continue
    const header = document.createElement('div')
    header.className = 'schedule-section'
    header.innerHTML = `<span class="schedule-section-icon">${CADENCE_ICON[o] || ''}</span><span class="schedule-section-label">${escapeHtml(g.label)}</span><span class="schedule-section-count">${g.tasks.length}</span>`
    scheduleList.appendChild(header)
    for (const task of g.tasks) scheduleList.appendChild(makeScheduleRow(task))
  }
}

const scheduleRunHistoryOverlay = document.getElementById('scheduleRunHistoryOverlay')
document.getElementById('scheduleRunHistoryClose').addEventListener('click', () => closeModal(scheduleRunHistoryOverlay))
scheduleRunHistoryOverlay.addEventListener('click', (e) => { if (e.target === scheduleRunHistoryOverlay) closeModal(scheduleRunHistoryOverlay) })

const RUN_STATUS_LABEL = {
  fired: () => t('tasks.run_status.fired'),
  error: () => t('tasks.run_status.error'),
  skipped: () => t('tasks.run_status.skipped'),
}
const RUN_STATUS_CLASS = {
  fired: 'badge-active',
  error: 'badge-danger',
  skipped: 'badge-paused',
}

async function openScheduleRunHistory(taskName) {
  document.getElementById('scheduleRunHistoryTitle').textContent = t('tasks.history.title', { name: taskName })
  const body = document.getElementById('scheduleRunHistoryBody')
  body.innerHTML = '<p>' + t('common.loading') + '</p>'
  openModal(scheduleRunHistoryOverlay)
  try {
    const r = await fetch(`/api/schedules/${encodeURIComponent(taskName)}/runs`)
    const runs = await r.json()
    if (!Array.isArray(runs) || runs.length === 0) {
      body.innerHTML = '<p class="hint">' + t('tasks.history.empty') + '</p>'
      return
    }
    const rows = runs.map(run => {
      const d = new Date(run.ts)
      const date = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
      const time = d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      const labelRaw = RUN_STATUS_LABEL[run.status]
      const label = labelRaw ? (typeof labelRaw === 'function' ? labelRaw() : labelRaw) : run.status
      const cls = RUN_STATUS_CLASS[run.status] || 'badge-paused'
      const tokens = run.tokens_est !== null ? `~${run.tokens_est.toLocaleString()}` : '-'
      return `<tr>
        <td style="white-space:nowrap">${date} ${time}</td>
        <td><span class="badge ${cls}">${escapeHtml(label)}</span></td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${tokens}</td>
      </tr>`
    }).join('')
    body.innerHTML = `<table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">${t('tasks.history.time')}</th>
        <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">${t('tasks.history.status')}</th>
        <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">${t('tasks.history.tokens')}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    body.querySelectorAll('tbody tr').forEach(tr => {
      tr.querySelectorAll('td').forEach(td => { td.style.padding = '5px 8px'; td.style.borderBottom = '1px solid var(--border-light, #eee)' })
    })
  } catch { body.innerHTML = '<p class="hint">' + t('tasks.history.error') + '</p>' }
}

function renderTimeline(tasks) {
  const hoursEl = document.getElementById('timelineHours')
  const bodyEl = document.getElementById('timelineBody')
  hoursEl.innerHTML = ''
  bodyEl.innerHTML = ''

  // Build hour labels
  for (let h = 0; h < 24; h++) {
    const hourDiv = document.createElement('div')
    hourDiv.className = 'timeline-hour'
    hourDiv.textContent = h.toString().padStart(2, '0')
    hoursEl.appendChild(hourDiv)
  }

  // Group tasks by agent
  const agentTasks = {}
  for (const task of tasks) {
    const agentName = task.agent || mainAgentId()
    if (!agentTasks[agentName]) agentTasks[agentName] = []
    agentTasks[agentName].push(task)
  }

  // If no tasks, show empty state
  if (Object.keys(agentTasks).length === 0) {
    bodyEl.innerHTML = `<div class="schedule-empty" style="padding:40px;text-align:center;color:var(--text-muted)">${t('tasks.schedule_empty')}</div>`
    return
  }

  for (const [agentName, agTasks] of Object.entries(agentTasks)) {
    const agent = scheduleAgents.find(a => a.name === agentName) || { name: agentName, avatar: '/api/marveen/avatar', label: agentName }

    const row = document.createElement('div')
    row.className = 'timeline-row'

    // Agent label
    row.innerHTML = `
      <div class="timeline-agent">
        <div class="timeline-agent-avatar">
          <img src="${agent.avatar}?t=${Date.now()}" alt="" onerror="this.style.display='none'">
        </div>
        <span class="timeline-agent-name">${escapeHtml(agent.label || agent.name)}</span>
      </div>
      <div class="timeline-track"></div>
    `

    const track = row.querySelector('.timeline-track')

    // Place markers for each task
    for (const task of agTasks) {
      const hours = cronToHours(task.schedule)
      const minute = cronToMinute(task.schedule)

      for (const h of hours) {
        const pct = ((h * 60 + minute) / (24 * 60)) * 100
        const marker = document.createElement('div')
        marker.className = 'timeline-marker' + (task.enabled ? '' : ' disabled')
        marker.style.left = `calc(${pct}% - 16px)`
        marker.innerHTML = `
          <img src="${agent.avatar}?t=${Date.now()}" alt="" onerror="this.style.display='none'">
          <div class="timeline-marker-tooltip">${escapeHtml(task.description || task.name)} - ${h.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}</div>
        `
        marker.addEventListener('click', () => openEditSchedule(task))
        track.appendChild(marker)
      }
    }

    // "Now" indicator
    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const nowPct = (nowMinutes / (24 * 60)) * 100
    const nowLine = document.createElement('div')
    nowLine.className = 'timeline-now'
    nowLine.style.left = `${nowPct}%`
    track.appendChild(nowLine)

    bodyEl.appendChild(row)
  }
}

function cronMatchesDay(cron, dayOfWeek) {
  // dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat
  const parts = cron.split(' ')
  if (parts.length < 5) return false
  const dow = parts[4]
  if (dow === '*') return true
  if (dow.includes(',')) return dow.split(',').map(Number).includes(dayOfWeek)
  if (dow.includes('-')) {
    const [start, end] = dow.split('-').map(Number)
    return dayOfWeek >= start && dayOfWeek <= end
  }
  return parseInt(dow) === dayOfWeek || (dayOfWeek === 0 && dow === '7')
}

function renderWeekView(data) {
  const grid = document.getElementById('weekGrid')
  grid.innerHTML = ''

  const locale = _lang === 'en' ? 'en-US' : 'hu-HU'
  const dayNums = [1, 2, 3, 4, 5, 6, 0]
  // Jan 6 2025 = Mon; offset by dayNums index to get each weekday
  const dayNames = dayNums.map(dow => new Date(2025, 0, 6 + (dow === 0 ? 6 : dow - 1)).toLocaleDateString(locale, { weekday: 'narrow' }))
  const dayNamesFull = dayNums.map(dow => new Date(2025, 0, 6 + (dow === 0 ? 6 : dow - 1)).toLocaleDateString(locale, { weekday: 'long' }))

  const today = new Date()
  const todayDow = today.getDay()

  function expandDay(targetCol) {
    grid.querySelectorAll('.week-day').forEach(d => d.classList.remove('week-day-expanded'))
    targetCol.classList.add('week-day-expanded')
  }

  for (let i = 0; i < 7; i++) {
    const dayDow = dayNums[i]
    const isToday = dayDow === todayDow
    const dayCol = document.createElement('div')
    dayCol.className = 'week-day' + (isToday ? ' week-day-today week-day-expanded' : '')

    const header = document.createElement('div')
    header.className = 'week-day-header'
    header.textContent = dayCol.classList.contains('week-day-expanded') ? dayNamesFull[i] : dayNames[i]
    header.dataset.short = dayNames[i]
    header.dataset.full = dayNamesFull[i]
    dayCol.appendChild(header)

    const tasksForDay = data.filter(t => t.enabled && cronMatchesDay(t.schedule, dayDow))

    // Collapsed count badge
    const countDiv = document.createElement('div')
    countDiv.className = 'week-day-count'
    countDiv.innerHTML = `<span class="week-day-count-num">${tasksForDay.length}</span>`
    dayCol.appendChild(countDiv)

    // Expanded task list (positioned by time)
    const tasksDiv = document.createElement('div')
    tasksDiv.className = 'week-day-tasks'

    if (tasksForDay.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'week-day-empty'
      empty.textContent = 'Nincs feladat'
      dayCol.appendChild(empty)
    }

    // Add hour grid lines (6:00 - 22:00)
    for (let hr = 6; hr <= 22; hr += 2) {
      const pct = (hr / 24) * 100
      const line = document.createElement('div')
      line.className = 'week-hour-line'
      line.style.top = `${pct}%`
      tasksDiv.appendChild(line)
      const label = document.createElement('div')
      label.className = 'week-hour-label'
      label.style.top = `${pct}%`
      label.textContent = `${String(hr).padStart(2,'0')}:00`
      tasksDiv.appendChild(label)
    }

    // Group tasks by same time slot for side-by-side layout
    const timeSlots = {}
    for (const task of tasksForDay) {
      const parts = task.schedule.split(' ')
      const h = parseInt(parts[1]); const m = parseInt(parts[0])
      const key = `${h}:${m}`
      if (!timeSlots[key]) timeSlots[key] = []
      timeSlots[key].push(task)
    }

    for (const [key, tasks] of Object.entries(timeSlots)) {
      const [h, m] = key.split(':').map(Number)
      const topPct = ((h * 60 + m) / (24 * 60)) * 100
      const timeLabel = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
      const count = tasks.length

      tasks.forEach((task, idx) => {
        const agent = scheduleAgents.find(a => a.name === task.agent) || { name: task.agent || mainAgentId(), avatar: '/api/marveen/avatar' }

        const card = document.createElement('div')
        card.className = 'week-task-card'
        card.style.top = `${topPct}%`

        // Side by side: divide available width (after 32px label margin)
        const availableStart = 32 // px from left for hour labels
        const gap = 4
        if (count > 1) {
          card.style.left = `calc(${availableStart}px + ${idx} * ((100% - ${availableStart + 8}px) / ${count}) + ${idx * gap}px)`
          card.style.width = `calc((100% - ${availableStart + 8 + (count - 1) * gap}px) / ${count})`
        } else {
          card.style.left = `${availableStart}px`
          card.style.right = '8px'
        }

        card.innerHTML = `
          <div class="week-task-avatar"><img src="${agent.avatar}?t=${Date.now()}" alt=""></div>
          <div class="week-task-info">
            <div class="week-task-time">${timeLabel}</div>
            <div class="week-task-name">${escapeHtml(task.description || task.name)}</div>
          </div>
        `
        card.addEventListener('click', (e) => { e.stopPropagation(); openEditSchedule(task) })
        tasksDiv.appendChild(card)
      })
    }

    dayCol.appendChild(tasksDiv)

    // Click to expand
    dayCol.addEventListener('click', () => {
      if (!dayCol.classList.contains('week-day-expanded')) {
        expandDay(dayCol)
        // Update headers
        grid.querySelectorAll('.week-day-header').forEach(hdr => {
          hdr.textContent = hdr.closest('.week-day-expanded') ? hdr.dataset.full : hdr.dataset.short
        })
      }
    })

    grid.appendChild(dayCol)
  }
}

function openEditSchedule(task) {
  loadScheduleAgents().then(() => {
    resetScheduleForm()
    document.getElementById('scheduleModalTitle').textContent = t('tasks.modal.edit_title')
    document.getElementById('scheduleName').value = task.name
    document.getElementById('scheduleName').disabled = true
    document.getElementById('scheduleDesc').value = task.description || ''
    document.getElementById('schedulePrompt').value = task.prompt || ''
    document.getElementById('scheduleEditName').value = task.name
    document.getElementById('scheduleSkipIfBusy').checked = !!task.skipIfBusy
    document.getElementById('scheduleForceSend').checked = !!task.forceSend
    document.getElementById('scheduleTargetSession').value = task.targetSession || ''

    // Set type (heartbeat or task; custom types fall back to task)
    const typeEl = document.getElementById('scheduleType')
    typeEl.value = (task.type === 'heartbeat') ? 'heartbeat' : 'task'
    document.getElementById('heartbeatTemplateGroup').hidden = typeEl.value !== 'heartbeat'

    // Set agent
    const agentSel = document.getElementById('scheduleAgent')
    if (agentSel.querySelector(`option[value="${task.agent}"]`)) {
      agentSel.value = task.agent
    }

    // Parse cron back to frequency + time
    parseCronToForm(task.schedule)

    openModal(scheduleModalOverlay)
  })
}

// Save schedule (create or update)
// === Prompt expand ===
let expandAnswers = []

document.getElementById('expandPromptBtn').addEventListener('click', async () => {
  const prompt = document.getElementById('schedulePrompt').value.trim()
  if (!prompt) { document.getElementById('schedulePrompt').focus(); return }

  const statusEl = document.getElementById('expandStatus')
  const questionsEl = document.getElementById('expandQuestions')
  const btn = document.getElementById('expandPromptBtn')

  btn.disabled = true
  statusEl.textContent = t('tasks.expand.generating')
  expandAnswers = []

  try {
    const agent = document.getElementById('scheduleAgent').value
    const res = await fetch('/api/schedules/expand-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, agent }),
    })
    if (!res.ok) throw new Error()
    const questions = await res.json()

    questionsEl.innerHTML = ''
    questionsEl.hidden = false
    statusEl.textContent = ''

    for (const q of questions) {
      const qDiv = document.createElement('div')
      qDiv.className = 'expand-question'

      const qText = document.createElement('div')
      qText.className = 'expand-question-text'
      qText.textContent = q.question
      qDiv.appendChild(qText)

      const optionsDiv = document.createElement('div')
      optionsDiv.className = 'expand-options'
      for (const opt of q.options) {
        const optBtn = document.createElement('button')
        optBtn.type = 'button'
        optBtn.className = 'expand-option'
        optBtn.textContent = opt
        optBtn.addEventListener('click', () => {
          optionsDiv.querySelectorAll('.expand-option').forEach(o => o.classList.remove('selected'))
          optBtn.classList.add('selected')
          // Store answer
          const existing = expandAnswers.find(a => a.question === q.question)
          if (existing) existing.answer = opt
          else expandAnswers.push({ question: q.question, answer: opt })
        })
        optionsDiv.appendChild(optBtn)
      }
      qDiv.appendChild(optionsDiv)
      questionsEl.appendChild(qDiv)
    }

    // Apply button
    const applyRow = document.createElement('div')
    applyRow.className = 'expand-apply-row'
    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'btn-primary btn-compact'
    applyBtn.innerHTML = `<span class="btn-text">${t('tasks.expand.apply_btn')}</span><span class="btn-loading" hidden><span class="spinner"></span></span>`
    applyBtn.addEventListener('click', async () => {
      if (expandAnswers.length === 0) { showToast(t('tasks.expand.need_answer')); return }
      applyBtn.disabled = true
      applyBtn.querySelector('.btn-text').hidden = true
      applyBtn.querySelector('.btn-loading').hidden = false
      try {
        const res2 = await fetch('/api/schedules/expand-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, answers: expandAnswers }),
        })
        if (!res2.ok) throw new Error()
        const { prompt: expanded } = await res2.json()
        document.getElementById('schedulePrompt').value = expanded
        questionsEl.hidden = true
        showToast(t('tasks.expand.done'))
      } catch {
        showToast(t('tasks.expand.error'))
      } finally {
        applyBtn.disabled = false
        applyBtn.querySelector('.btn-text').hidden = false
        applyBtn.querySelector('.btn-loading').hidden = true
      }
    })
    applyRow.appendChild(applyBtn)
    questionsEl.appendChild(applyRow)
  } catch {
    statusEl.textContent = t('kanban.breakdown.error')
  } finally {
    btn.disabled = false
  }
})

saveScheduleBtn.addEventListener('click', async () => {
  const editName = document.getElementById('scheduleEditName').value
  const name = document.getElementById('scheduleName').value.trim()
  const description = document.getElementById('scheduleDesc').value.trim()
  const prompt = document.getElementById('schedulePrompt').value.trim()
  const schedule = getScheduleCron()
  const agent = document.getElementById('scheduleAgent').value
  const type = document.getElementById('scheduleType').value
  // Advanced options -- the backend already persists these; expose them here.
  const skipIfBusy = document.getElementById('scheduleSkipIfBusy').checked
  const forceSend = document.getElementById('scheduleForceSend').checked
  const targetSession = document.getElementById('scheduleTargetSession').value.trim()
  const advanced = { skipIfBusy, forceSend }
  if (targetSession) advanced.targetSession = targetSession

  if (!name) { document.getElementById('scheduleName').focus(); return }
  if (!prompt) { document.getElementById('schedulePrompt').focus(); return }
  if (!schedule) { showToast(t('tasks.toast.select_schedule')); return }

  saveScheduleBtn.disabled = true
  saveScheduleBtn.querySelector('.btn-text').hidden = true
  saveScheduleBtn.querySelector('.btn-loading').hidden = false

  try {
    if (editName) {
      // Update
      const res = await fetch(`/api/schedules/${encodeURIComponent(editName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, prompt, schedule, agent, type, ...advanced }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Hiba')
      }
      showToast(t('tasks.toast.updated'))
    } else {
      // Create
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, prompt, schedule, agent, type, ...advanced }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Ismeretlen hiba')
      }
      showToast(t('tasks.toast.created'))
    }
    closeModal(scheduleModalOverlay)
    loadSchedules()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    saveScheduleBtn.disabled = false
    saveScheduleBtn.querySelector('.btn-text').hidden = false
    saveScheduleBtn.querySelector('.btn-loading').hidden = true
  }
})

// ============================================================
// === Memories (Tier System + Daily Log) ===
// ============================================================

const memList = document.getElementById('memList')
const memEmpty = document.getElementById('memEmpty')
const memStats = document.getElementById('memStats')
const memSearchInput = document.getElementById('memSearchInput')
const memModalOverlay = document.getElementById('memModalOverlay')

let memSearchTimer = null
let currentMemTier = 'hot'
let currentLogDate = new Date().toISOString().split('T')[0]
let logDates = []

const tierLabels = { hot: '\u{1F525} Hot', warm: '\u{1F321}\uFE0F Warm', cold: '\u2744\uFE0F Cold', shared: '\u{1F517} Shared' }
const tierColors = { hot: '#dc3c3c', warm: '#d97757', cold: '#6a9bcc', shared: '#9a8a30' }

// Populate agent dropdowns from API
async function loadMemAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('memAgentFilter')
    const memSel = document.getElementById('memAgent')
    sel.innerHTML = `<option value="">${t('memories.agent_all')}</option>`
    memSel.innerHTML = ''
    for (const a of agents) {
      sel.innerHTML += `<option value="${a.name}">${a.label}</option>`
      memSel.innerHTML += `<option value="${a.name}">${a.label}</option>`
    }
  } catch {}
}

// Agent filter change
document.getElementById('memAgentFilter').addEventListener('change', () => {
  if (currentMemTier === 'graph') {
    loadMemoryGraph()
  } else if (currentMemTier === 'log') {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Search with debounce
memSearchInput.addEventListener('input', () => {
  clearTimeout(memSearchTimer)
  memSearchTimer = setTimeout(loadMemories, 300)
})

// Enter to search immediately
memSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(memSearchTimer)
    loadMemories()
  }
})

// Tab switching
document.getElementById('memTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.mem-tab')
  if (!tab) return
  document.querySelectorAll('.mem-tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  currentMemTier = tab.dataset.tier

  const isLog = currentMemTier === 'log'
  const isGraph = currentMemTier === 'graph'
  document.getElementById('memTierView').hidden = isLog || isGraph
  document.getElementById('memLogView').hidden = !isLog
  document.getElementById('memGraphView').hidden = !isGraph

  if (isGraph) {
    loadMemoryGraph()
  } else if (isLog) {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Add memory button
document.getElementById('memAddBtn').addEventListener('click', () => {
  document.getElementById('memModalTitle').textContent = t('memories.modal.title_new')
  document.getElementById('memContent').value = ''
  document.getElementById('memTier').value = (currentMemTier === 'log' || currentMemTier === 'graph') ? 'warm' : currentMemTier
  document.getElementById('memKeywords').value = ''
  document.getElementById('memEditId').value = ''
  openModal(memModalOverlay)
  setTimeout(() => document.getElementById('memContent').focus(), 200)
})

// Close memory modal
document.getElementById('memModalClose').addEventListener('click', () => closeModal(memModalOverlay))
memModalOverlay.addEventListener('click', (e) => { if (e.target === memModalOverlay) closeModal(memModalOverlay) })

// Save memory (create or edit)
document.getElementById('saveMemBtn').addEventListener('click', async () => {
  const content = document.getElementById('memContent').value.trim()
  if (!content) { document.getElementById('memContent').focus(); return }

  const editId = document.getElementById('memEditId').value
  const tier = document.getElementById('memTier').value
  const agentId = document.getElementById('memAgent').value
  const keywords = document.getElementById('memKeywords').value.trim()

  try {
    if (editId) {
      await fetch(`/api/memories/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, tier, agent_id: agentId, keywords }),
      })
      showToast(t('memories.toast.updated'))
    } else {
      await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, content, tier, keywords }),
      })
      showToast(t('memories.toast.created'))
    }
    closeModal(memModalOverlay)
    loadMemories()
    loadMemStats()
  } catch {
    showToast(t('common.error_save'))
  }
})

async function loadMemStats() {
  try {
    const res = await fetch('/api/memories/stats')
    const stats = await res.json()
    const embCount = stats.withEmbedding || 0
    const embPct = stats.total > 0 ? Math.round(embCount / stats.total * 100) : 0
    memStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">${t('memories.stat.total')}</div></div>
      ${Object.entries(stats.byTier || {}).map(([tier, count]) =>
        `<div class="stat-card"><div class="stat-value" style="color:${tierColors[tier] || 'var(--accent)'}">${count}</div><div class="stat-label">${tierLabels[tier] || tier}</div></div>`
      ).join('')}
      <div class="stat-card"><div class="stat-value">${embCount}</div><div class="stat-label">${t('memories.stat.vectors_pct', { pct: embPct })}</div></div>
      <button class="btn-secondary btn-compact" id="memBackfillBtn" style="margin-left:auto;font-size:11px;padding:6px 12px;align-self:center">${t('memories.stat.vectors_btn')}</button>
    `
    document.getElementById('memBackfillBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('memBackfillBtn')
      if (btn) { btn.textContent = t('memories.stat.vectors_gen'); btn.disabled = true }
      try {
        const r = await fetch('/api/memories/backfill', { method: 'POST' })
        const data = await r.json()
        showToast(t('memories.toast.vector_count', { count: data.count }))
        loadMemStats()
      } catch { showToast(t('memories.toast.vector_error')) }
    })
  } catch (err) {
    console.error('Stats hiba:', err)
  }
}

async function loadMemories() {
  if (currentMemTier === 'log' || currentMemTier === 'graph') return
  const q = memSearchInput.value.trim()
  const agent = document.getElementById('memAgentFilter').value
  const searchMode = document.getElementById('memSearchMode')?.value || 'hybrid'
  const params = new URLSearchParams()
  if (q) {
    params.set('q', q)
    params.set('mode', searchMode)
  }
  if (agent) params.set('agent', agent)
  if (currentMemTier) params.set('tier', currentMemTier)
  params.set('limit', '50')

  try {
    const res = await fetch(`/api/memories?${params}`)
    const memories = await res.json()
    renderMemories(memories)
  } catch (err) {
    console.error('Memória betöltés hiba:', err)
  }
}

function renderMemories(memories) {
  memList.innerHTML = ''
  memEmpty.hidden = memories.length > 0

  for (const mem of memories) {
    const item = document.createElement('div')
    item.className = 'mem-item'

    const tier = mem.tier || mem.category || 'warm'
    const tierBadge = tierLabels[tier] || tier
    const badgeClass = 'badge-' + tier
    const shortContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '...' : mem.content
    const agentLabel = mem.agent_id || mainAgentId()

    // Build keywords HTML
    let keywordsHtml = ''
    if (mem.keywords) {
      const kws = typeof mem.keywords === 'string' ? mem.keywords.split(',').map(k => k.trim()).filter(Boolean) : mem.keywords
      if (kws.length > 0) {
        keywordsHtml = `<div class="mem-keywords">${kws.map(k => `<span class="mem-keyword-tag">${escapeHtml(k)}</span>`).join('')}</div>`
      }
    }

    item.innerHTML = `
      <div class="mem-item-header">
        <span class="badge ${badgeClass}">${tierBadge}</span>
        <span class="mem-agent-badge">${escapeHtml(agentLabel)}</span>
        <span class="mem-date">${escapeHtml(mem.created_label || '')}</span>
        ${typeof mem.salience === 'number' ? `<span class="mem-salience" title="Relevancia ertek">S: ${mem.salience.toFixed(2)}</span>` : ''}
      </div>
      <div class="mem-content-short">${escapeHtml(shortContent)}</div>
      <div class="mem-content-full">${escapeHtml(mem.content)}</div>
      ${keywordsHtml}
      <div class="mem-item-footer">
        <button class="btn-secondary" data-edit-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">${t('common.btn.edit')}</button>
        <button class="btn-danger" data-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">${t('common.btn.delete')}</button>
      </div>
    `

    // Toggle expand
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-danger') || e.target.closest('.btn-secondary')) return
      item.classList.toggle('expanded')
    })

    // Edit
    const editBtn = item.querySelector('[data-edit-memid]')
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      document.getElementById('memModalTitle').textContent = t('memories.modal.title_edit')
      document.getElementById('memContent').value = mem.content
      document.getElementById('memTier').value = tier
      document.getElementById('memKeywords').value = mem.keywords || ''
      document.getElementById('memEditId').value = mem.id
      if (mem.agent_id) document.getElementById('memAgent').value = mem.agent_id
      openModal(memModalOverlay)
    })

    // Delete
    const delBtn = item.querySelector('.btn-danger')
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Biztosan torlod ezt az emleket?')) return
      try {
        await fetch(`/api/memories/${mem.id}`, { method: 'DELETE' })
        showToast(t('memories.toast.deleted'))
        loadMemories()
        loadMemStats()
      } catch {
        showToast(t('common.error_delete'))
      }
    })

    memList.appendChild(item)
  }
}

// === Memory Graph (Force-directed, Obsidian-style) ===

let graphNodes = []
let graphEdges = []
let graphSim = null
let graphCanvas = null
let graphCtx = null
let graphDragging = null
let graphHover = null
let graphSelectedNode = null
let graphSearchQuery = ''

// Zoom & pan state
let graphZoom = 1
let graphPanX = 0
let graphPanY = 0
let graphPanning = false
let graphPanStartX = 0
let graphPanStartY = 0
let graphZoomIndicatorTimer = null

// Edge animation
let graphAnimFrame = 0

const GRAPH_TIER_COLORS = {
  hot: '#dc3c3c',
  warm: '#d97757',
  cold: '#6a9bcc',
  shared: '#b0a040',
}

const GRAPH_TIER_BG = {
  hot: 'rgba(220, 60, 60, 0.06)',
  warm: 'rgba(217, 119, 87, 0.06)',
  cold: 'rgba(106, 155, 204, 0.06)',
  shared: 'rgba(176, 160, 64, 0.06)',
}

function screenToWorld(sx, sy) {
  return { x: (sx - graphPanX) / graphZoom, y: (sy - graphPanY) / graphZoom }
}

function worldToScreen(wx, wy) {
  return { x: wx * graphZoom + graphPanX, y: wy * graphZoom + graphPanY }
}

async function loadMemoryGraph() {
  const agent = document.getElementById('memAgentFilter').value
  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  params.set('limit', '200')

  try {
    const res = await fetch(`/api/memories?${params}`)
    const memories = await res.json()

    const emptyEl = document.getElementById('graphEmpty')
    if (!memories || memories.length === 0) {
      emptyEl.hidden = false
      document.getElementById('memGraphCanvas').hidden = true
      return
    }
    emptyEl.hidden = true
    document.getElementById('memGraphCanvas').hidden = false

    // Reset zoom/pan on new data load
    graphZoom = 1
    graphPanX = 0
    graphPanY = 0
    graphSelectedNode = null
    hideGraphPanel()

    buildGraph(memories)
    startGraphSimulation()
  } catch (err) {
    console.error('Gráf betöltés hiba:', err)
  }
}

function buildGraph(memories) {
  graphNodes = []
  graphEdges = []

  const canvas = document.getElementById('memGraphCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  graphCanvas = canvas
  graphCtx = canvas.getContext('2d')
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const w = rect.width
  const h = rect.height

  // Create nodes from memories
  for (const mem of memories) {
    const keywords = (mem.keywords || '').split(',').map(k => k.trim()).filter(Boolean)
    const label = mem.content.slice(0, 25).replace(/\n/g, ' ') + (mem.content.length > 25 ? '...' : '')
    graphNodes.push({
      id: mem.id,
      x: w / 2 + (Math.random() - 0.5) * w * 0.6,
      y: h / 2 + (Math.random() - 0.5) * h * 0.6,
      vx: 0,
      vy: 0,
      radius: 6,
      connectionCount: 0,
      label: label,
      tier: mem.tier || mem.category || 'warm',
      agent: mem.agent_id || mainAgentId(),
      keywords: keywords,
      mem: mem,
      searchMatch: true,
    })
  }

  // Create edges based on shared keywords
  for (let i = 0; i < graphNodes.length; i++) {
    for (let j = i + 1; j < graphNodes.length; j++) {
      const a = graphNodes[i]
      const b = graphNodes[j]
      const shared = a.keywords.filter(k => b.keywords.includes(k))
      if (shared.length > 0) {
        graphEdges.push({ source: i, target: j, strength: shared.length })
        a.connectionCount += shared.length
        b.connectionCount += shared.length
      }
      // Also connect same-agent same-tier with low probability
      if (a.agent === b.agent && a.tier === b.tier && Math.random() < 0.3) {
        graphEdges.push({ source: i, target: j, strength: 0.5 })
        a.connectionCount += 0.5
        b.connectionCount += 0.5
      }
    }
  }

  // Set node radius based on connection count
  for (const node of graphNodes) {
    node.radius = 5 + Math.min(Math.sqrt(node.connectionCount) * 2.5, 14)
  }

  // Ensure controls hint and zoom indicator exist
  const graphView = document.getElementById('memGraphView')
  if (!graphView.querySelector('.graph-controls-hint')) {
    const hint = document.createElement('div')
    hint.className = 'graph-controls-hint'
    hint.innerHTML = 'Scroll: zoom | Drag: move nodes<br>Click: details | Dbl-click: edit'
    graphView.appendChild(hint)
  }
  if (!graphView.querySelector('.graph-zoom-indicator')) {
    const zi = document.createElement('div')
    zi.className = 'graph-zoom-indicator'
    zi.id = 'graphZoomIndicator'
    graphView.appendChild(zi)
  }
}

function simulateGraphStep(damping) {
  const w = graphCanvas.width / (window.devicePixelRatio || 1)
  const h = graphCanvas.height / (window.devicePixelRatio || 1)
  const nodes = graphNodes

  const tierCenters = {}
  for (const node of nodes) {
    if (!tierCenters[node.tier]) tierCenters[node.tier] = { x: 0, y: 0, count: 0 }
    tierCenters[node.tier].x += node.x
    tierCenters[node.tier].y += node.y
    tierCenters[node.tier].count++
  }
  for (const tier of Object.keys(tierCenters)) {
    tierCenters[tier].x /= tierCenters[tier].count
    tierCenters[tier].y /= tierCenters[tier].count
  }
  for (const node of nodes) {
    const tc = tierCenters[node.tier]
    if (tc) {
      node.vx += (tc.x - node.x) * 0.0005
      node.vy += (tc.y - node.y) * 0.0005
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[j].x - nodes[i].x
      let dy = nodes[j].y - nodes[i].y
      let dist = Math.sqrt(dx * dx + dy * dy) || 1
      let force = 800 / (dist * dist)
      let fx = (dx / dist) * force
      let fy = (dy / dist) * force
      nodes[i].vx -= fx
      nodes[i].vy -= fy
      nodes[j].vx += fx
      nodes[j].vy += fy
    }
  }

  for (const edge of graphEdges) {
    const a = nodes[edge.source]
    const b = nodes[edge.target]
    let dx = b.x - a.x
    let dy = b.y - a.y
    let dist = Math.sqrt(dx * dx + dy * dy) || 1
    let force = (dist - 80) * 0.005 * edge.strength
    let fx = (dx / dist) * force
    let fy = (dy / dist) * force
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  for (const node of nodes) {
    node.vx += (w / 2 - node.x) * 0.001
    node.vy += (h / 2 - node.y) * 0.001
  }

  const maxV = 6
  for (const node of nodes) {
    if (node === graphDragging) continue
    node.vx *= damping
    node.vy *= damping
    if (node.vx > maxV) node.vx = maxV; else if (node.vx < -maxV) node.vx = -maxV
    if (node.vy > maxV) node.vy = maxV; else if (node.vy < -maxV) node.vy = -maxV
    node.x += node.vx
    node.y += node.vy
    node.x = Math.max(-200, Math.min(w + 200, node.x))
    node.y = Math.max(-200, Math.min(h + 200, node.y))
  }
}

function startGraphSimulation() {
  if (graphSim) cancelAnimationFrame(graphSim)

  for (const node of graphNodes) {
    node.vx = 0
    node.vy = 0
  }

  const preSettleIterations = Math.min(250, 40 + graphNodes.length * 2)
  for (let i = 0; i < preSettleIterations; i++) {
    simulateGraphStep(0.88)
  }

  let frame = 0
  const maxFrames = 60

  function tick() {
    if (frame > maxFrames) {
      renderGraph()
      return
    }
    frame++
    graphAnimFrame = frame
    simulateGraphStep(0.94 + (frame / maxFrames) * 0.05)
    renderGraph()
    graphSim = requestAnimationFrame(tick)
  }

  tick()
}

function renderGraph() {
  const ctx = graphCtx
  const dpr = window.devicePixelRatio || 1
  const w = graphCanvas.width / dpr
  const h = graphCanvas.height / dpr

  ctx.clearRect(0, 0, w, h)

  const cs = getComputedStyle(document.documentElement)
  const borderColor = cs.getPropertyValue('--border').trim() || '#d1cfc5'
  const textColor = cs.getPropertyValue('--text').trim() || '#141413'
  const textMuted = cs.getPropertyValue('--text-muted').trim() || '#87867f'
  const bgCard = cs.getPropertyValue('--bg-card').trim() || '#fff'
  const bgColor = cs.getPropertyValue('--bg').trim() || '#faf9f5'
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'

  // === Dot grid background (drawn in screen space) ===
  const gridSize = 20
  const dotColor = borderColor
  ctx.fillStyle = dotColor
  ctx.globalAlpha = isDark ? 0.2 : 0.3
  const offsetX = ((graphPanX % (gridSize * graphZoom)) + gridSize * graphZoom) % (gridSize * graphZoom)
  const offsetY = ((graphPanY % (gridSize * graphZoom)) + gridSize * graphZoom) % (gridSize * graphZoom)
  const scaledGrid = gridSize * graphZoom
  if (scaledGrid > 4) {
    for (let x = offsetX; x < w; x += scaledGrid) {
      for (let y = offsetY; y < h; y += scaledGrid) {
        ctx.beginPath()
        ctx.arc(x, y, Math.max(0.5, graphZoom * 0.6), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1

  // === Apply zoom/pan transform ===
  ctx.save()
  ctx.translate(graphPanX, graphPanY)
  ctx.scale(graphZoom, graphZoom)

  const hasSearch = graphSearchQuery.length > 0

  // === Tier cluster backgrounds ===
  const tierGroups = {}
  for (const node of graphNodes) {
    if (!tierGroups[node.tier]) tierGroups[node.tier] = []
    tierGroups[node.tier].push(node)
  }
  for (const [tier, nodes] of Object.entries(tierGroups)) {
    if (nodes.length < 2) continue
    let cx = 0, cy = 0
    for (const n of nodes) { cx += n.x; cy += n.y }
    cx /= nodes.length
    cy /= nodes.length
    let maxDist = 0
    for (const n of nodes) {
      const d = Math.sqrt((n.x - cx) ** 2 + (n.y - cy) ** 2)
      if (d > maxDist) maxDist = d
    }
    const radius = maxDist + 60
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    const bgTier = GRAPH_TIER_BG[tier] || 'rgba(128,128,128,0.04)'
    grad.addColorStop(0, bgTier)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.globalAlpha = hasSearch ? 0.3 : 0.8
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // Build set of connected node indices for hovered/selected node
  const connectedToActive = new Set()
  const activeNode = graphHover || graphSelectedNode
  if (activeNode) {
    const activeIdx = graphNodes.indexOf(activeNode)
    for (const edge of graphEdges) {
      if (edge.source === activeIdx) connectedToActive.add(edge.target)
      if (edge.target === activeIdx) connectedToActive.add(edge.source)
    }
  }

  // === Draw edges (bezier curves with pulsing) ===
  const time = Date.now() * 0.001
  for (const edge of graphEdges) {
    const a = graphNodes[edge.source]
    const b = graphNodes[edge.target]

    const isActiveEdge = activeNode && (a === activeNode || b === activeNode)
    const searchFaded = hasSearch && (!a.searchMatch || !b.searchMatch)

    // Edge thickness based on connection strength
    const baseWidth = 0.5 + Math.min(edge.strength * 0.6, 2.5)

    // Subtle pulse/breathe animation
    const pulse = 0.85 + 0.15 * Math.sin(time * 1.5 + edge.source * 0.3 + edge.target * 0.7)

    ctx.lineWidth = isActiveEdge ? baseWidth * 1.8 : baseWidth * pulse
    ctx.strokeStyle = isActiveEdge ? GRAPH_TIER_COLORS[a === activeNode ? a.tier : b.tier] || borderColor : borderColor
    ctx.globalAlpha = searchFaded ? 0.05 : (isActiveEdge ? 0.7 : (0.15 + Math.min(edge.strength * 0.1, 0.3)) * pulse)

    // Bezier curve: midpoint offset perpendicular to the line
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const curvature = Math.min(dist * 0.15, 30)
    // Perpendicular offset
    const cpx = mx + (-dy / dist) * curvature
    const cpy = my + (dx / dist) * curvature

    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(cpx, cpy, b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // === Draw nodes ===
  const fontSize = Math.max(8, Math.min(12, 10 / graphZoom))

  for (let ni = 0; ni < graphNodes.length; ni++) {
    const node = graphNodes[ni]
    const color = GRAPH_TIER_COLORS[node.tier] || '#d97757'
    const isHover = node === graphHover
    const isSelected = node === graphSelectedNode
    const isConnected = connectedToActive.has(ni)
    const searchFaded = hasSearch && !node.searchMatch
    const searchGlow = hasSearch && node.searchMatch

    // Opacity
    let nodeAlpha = 0.85
    if (searchFaded) nodeAlpha = 0.12
    else if (searchGlow) nodeAlpha = 1
    else if (isHover || isSelected) nodeAlpha = 1
    else if (activeNode && !isConnected) nodeAlpha = 0.35

    // Glow effect for hover, selected, search match
    if ((isHover || isSelected || searchGlow) && !searchFaded) {
      ctx.shadowColor = color
      ctx.shadowBlur = isHover ? 20 : (searchGlow ? 15 : 10)
    }

    // Connected nodes get subtle highlight
    if (isConnected && !searchFaded) {
      ctx.shadowColor = color
      ctx.shadowBlur = 6
    }

    const r = isHover ? node.radius + 3 : (isSelected ? node.radius + 2 : node.radius)

    // Node fill
    ctx.fillStyle = color
    ctx.globalAlpha = nodeAlpha
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
    ctx.fill()

    // Subtle border ring for selected
    if (isSelected) {
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'

    // === Always show label (pill/badge style) ===
    if (!searchFaded || (searchFaded && nodeAlpha > 0.15)) {
      const labelText = node.label
      const labelFontSize = Math.max(7, Math.min(11, 9 / Math.max(graphZoom * 0.7, 0.5)))
      ctx.font = (isHover || isSelected) ? `600 ${labelFontSize + 1}px -apple-system, sans-serif` : `500 ${labelFontSize}px -apple-system, sans-serif`
      const textWidth = ctx.measureText(labelText).width
      const pillW = textWidth + 10
      const pillH = labelFontSize + 6
      const pillX = node.x - pillW / 2
      const pillY = node.y + r + 5

      // Dark pill background
      ctx.globalAlpha = searchFaded ? 0.08 : ((isHover || isSelected) ? 0.9 : 0.65)
      ctx.fillStyle = isDark ? 'rgba(20,20,19,0.85)' : 'rgba(30,30,28,0.8)'
      graphRoundRect(ctx, pillX, pillY, pillW, pillH, 3)
      ctx.fill()

      // White text
      ctx.fillStyle = isDark ? '#e8e7e0' : '#faf9f5'
      ctx.globalAlpha = searchFaded ? 0.1 : ((isHover || isSelected) ? 1 : 0.85)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(labelText, node.x, pillY + pillH / 2)
    }

    ctx.globalAlpha = 1
    ctx.textBaseline = 'alphabetic'
  }

  // Hover tooltip (richer than before)
  if (graphHover && !graphSelectedNode) {
    const node = graphHover
    const tLabels = { hot: 'Hot', warm: 'Warm', cold: 'Cold', shared: 'Shared' }
    const text = `${tLabels[node.tier] || node.tier} | ${node.agent}`
    const kw = node.keywords.length > 0 ? node.keywords.join(', ') : ''
    const conns = `${Math.round(node.connectionCount)} connections`

    ctx.font = 'bold 11px -apple-system, sans-serif'
    const tw = Math.max(ctx.measureText(text).width, kw ? ctx.measureText(kw).width : 0, ctx.measureText(conns).width) + 24
    const th = kw ? 64 : 48
    let tx = node.x - tw / 2
    let ty = node.y - node.radius - th - 12

    // Tooltip background
    ctx.fillStyle = isDark ? 'rgba(31,30,29,0.95)' : 'rgba(255,255,255,0.96)'
    ctx.strokeStyle = borderColor
    ctx.lineWidth = 1
    ctx.shadowColor = 'rgba(0,0,0,0.15)'
    ctx.shadowBlur = 12
    graphRoundRect(ctx, tx, ty, tw, th, 8)
    ctx.fill()
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'

    ctx.fillStyle = textColor
    ctx.font = 'bold 11px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(text, tx + 12, ty + 18)
    ctx.font = '10px -apple-system, sans-serif'
    ctx.fillStyle = textMuted
    ctx.fillText(conns, tx + 12, ty + 34)
    if (kw) {
      ctx.fillText(kw.length > 40 ? kw.slice(0, 40) + '...' : kw, tx + 12, ty + 50)
    }
  }

  ctx.restore()
}

function graphRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// === Graph detail panel ===
function showGraphPanel(node) {
  let panel = document.getElementById('graphPanel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'graphPanel'
    panel.className = 'graph-panel'
    document.getElementById('memGraphView').appendChild(panel)
  }
  const tierLabelsMap = { hot: 'Hot', warm: 'Warm', cold: 'Cold', shared: 'Shared' }
  const created = node.mem.created_label || ''
  panel.innerHTML = `
    <div class="graph-panel-header">
      <span class="badge badge-${node.tier}">${tierLabelsMap[node.tier] || node.tier}</span>
      <span class="graph-panel-agent">${escapeHtml(node.agent)}</span>
      <button class="graph-panel-close" id="graphPanelCloseBtn">&times;</button>
    </div>
    ${created ? `<div class="graph-panel-date">${escapeHtml(created)}</div>` : ''}
    <div class="graph-panel-content">${escapeHtml(node.mem.content)}</div>
    <div class="graph-panel-meta">
      ${node.keywords.length ? '<div class="graph-panel-keywords">' + node.keywords.map(k => '<span class="mem-keyword-tag">' + escapeHtml(k) + '</span>').join('') + '</div>' : ''}
    </div>
  `
  panel.hidden = false
  document.getElementById('graphPanelCloseBtn').addEventListener('click', () => {
    graphSelectedNode = null
    panel.hidden = true
    renderGraph()
  })
}

function hideGraphPanel() {
  const panel = document.getElementById('graphPanel')
  if (panel) panel.hidden = true
}

function openEditMemory(mem) {
  document.getElementById('memModalTitle').textContent = t('memories.modal.title_edit')
  document.getElementById('memAgent').value = mem.agent_id || mainAgentId()
  document.getElementById('memTier').value = mem.tier || mem.category || 'warm'
  document.getElementById('memContent').value = mem.content || ''
  document.getElementById('memKeywords').value = mem.keywords || ''
  document.getElementById('memEditId').value = mem.id
  openModal(memModalOverlay)
}

// === Graph search integration ===
function updateGraphSearch() {
  const q = memSearchInput.value.trim().toLowerCase()
  graphSearchQuery = q
  for (const node of graphNodes) {
    if (!q) {
      node.searchMatch = true
    } else {
      const content = (node.mem.content || '').toLowerCase()
      const kws = node.keywords.join(' ').toLowerCase()
      const agent = (node.agent || '').toLowerCase()
      node.searchMatch = content.includes(q) || kws.includes(q) || agent.includes(q)
    }
  }
  if (graphNodes.length > 0) renderGraph()
}

// === Zoom indicator ===
function showZoomIndicator() {
  const el = document.getElementById('graphZoomIndicator')
  if (!el) return
  el.textContent = `${Math.round(graphZoom * 100)}%`
  el.classList.add('visible')
  clearTimeout(graphZoomIndicatorTimer)
  graphZoomIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 1200)
}

// === Graph mouse interaction (with zoom/pan) ===
;(function initGraphInteraction() {
  const canvas = document.getElementById('memGraphCanvas')
  let wasDragging = false
  let wasPanning = false
  let mouseDownPos = { x: 0, y: 0 }

  // Mouse wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    // Zoom toward cursor
    const worldX = (mx - graphPanX) / graphZoom
    const worldY = (my - graphPanY) / graphZoom

    graphZoom = Math.max(0.3, Math.min(3.0, graphZoom * zoomFactor))

    graphPanX = mx - worldX * graphZoom
    graphPanY = my - worldY * graphZoom

    showZoomIndicator()
    if (graphNodes.length > 0) renderGraph()
  }, { passive: false })

  // Mouse move: hover detection + panning + dragging
  canvas.addEventListener('mousemove', (e) => {
    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    // Panning
    if (graphPanning) {
      const dx = sx - graphPanStartX
      const dy = sy - graphPanStartY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasPanning = true
      graphPanX += dx
      graphPanY += dy
      graphPanStartX = sx
      graphPanStartY = sy
      if (graphNodes.length > 0) renderGraph()
      return
    }

    // Dragging a node
    const world = screenToWorld(sx, sy)
    if (graphDragging) {
      const dx = sx - mouseDownPos.x
      const dy = sy - mouseDownPos.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDragging = true
      graphDragging.x = world.x
      graphDragging.y = world.y
      graphDragging.vx = 0
      graphDragging.vy = 0
      if (graphNodes.length > 0) renderGraph()
      return
    }

    // Hover detection in world space
    graphHover = null
    for (const node of graphNodes) {
      const ndx = world.x - node.x
      const ndy = world.y - node.y
      const hitRadius = (node.radius + 6) / Math.max(graphZoom, 0.5)
      if (ndx * ndx + ndy * ndy < hitRadius * hitRadius) {
        graphHover = node
        break
      }
    }
    canvas.style.cursor = graphHover ? 'pointer' : 'grab'
    if (graphNodes.length > 0) renderGraph()
  })

  // Mouse down: start drag on node, or start pan on empty space
  canvas.addEventListener('mousedown', (e) => {
    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    mouseDownPos = { x: sx, y: sy }
    wasDragging = false
    wasPanning = false

    if (graphHover) {
      // Drag node
      graphDragging = graphHover
      canvas.style.cursor = 'grabbing'
    } else {
      // Pan
      graphPanning = true
      graphPanStartX = sx
      graphPanStartY = sy
      canvas.style.cursor = 'grabbing'
    }
  })

  // Click: select node and show panel (only if not dragged/panned)
  canvas.addEventListener('click', (e) => {
    if (wasDragging || wasPanning) return

    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const world = screenToWorld(sx, sy)

    let clicked = null
    for (const node of graphNodes) {
      const dx = world.x - node.x
      const dy = world.y - node.y
      const hitRadius = (node.radius + 6) / Math.max(graphZoom, 0.5)
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        clicked = node
        break
      }
    }

    if (clicked) {
      graphSelectedNode = clicked
      showGraphPanel(clicked)
    } else {
      graphSelectedNode = null
      hideGraphPanel()
    }
    if (graphNodes.length > 0) renderGraph()
  })

  // Double click: open edit modal
  canvas.addEventListener('dblclick', (e) => {
    if (graphHover && graphHover.mem) {
      openEditMemory(graphHover.mem)
    }
  })

  // Mouse up: stop drag/pan
  document.addEventListener('mouseup', () => {
    if (graphDragging) {
      graphDragging = null
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = graphHover ? 'pointer' : 'grab'
    }
    if (graphPanning) {
      graphPanning = false
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = 'grab'
    }
  })

  // Search integration: listen to existing search input
  memSearchInput.addEventListener('input', () => {
    if (currentMemTier === 'graph') {
      updateGraphSearch()
    }
  })
  memSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && currentMemTier === 'graph') {
      updateGraphSearch()
    }
  })
})()

// === Daily Log ===

async function loadDailyLog() {
  // "Minden ügynök" (empty value) falls back to the first agent in the
  // filter dropdown, which is the main agent on any BOT_NAME -- avoids a
  // hardcoded "marveen" slug that would 404 on zino/haver/etc installs.
  const sel = document.getElementById('memAgentFilter')
  const agent = sel.value || (sel.options[1] ? sel.options[1].value : '')
  if (!agent) {
    renderLogEntries([])
    return
  }

  try {
    const datesRes = await fetch(`/api/daily-log/dates?agent=${agent}`)
    logDates = await datesRes.json()
  } catch {
    logDates = []
  }

  document.getElementById('logCurrentDate').textContent = formatLogDate(currentLogDate)

  try {
    const res = await fetch(`/api/daily-log?agent=${agent}&date=${currentLogDate}`)
    const entries = await res.json()
    renderLogEntries(entries)
  } catch {
    renderLogEntries([])
  }
}

function renderLogEntries(entries) {
  const el = document.getElementById('logEntries')
  const empty = document.getElementById('logEmpty')
  el.innerHTML = ''
  empty.hidden = entries.length > 0

  for (const entry of entries) {
    const time = new Date(entry.created_at * 1000).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    const div = document.createElement('div')
    div.className = 'log-entry'
    div.innerHTML = `
      <div class="log-entry-time">${time}</div>
      <div class="log-entry-content">${escapeHtml(entry.content)}</div>
    `
    el.appendChild(div)
  }
}

function formatLogDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

// Date navigation
document.getElementById('logPrevDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() - 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})
document.getElementById('logNextDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() + 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})

// === SVG icons ===
function pauseIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
}
function playIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
}
function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
}

// ============================================================
// === Connectors ===
// ============================================================

const connectorGrid = document.getElementById('connectorGrid')
const connectorStats = document.getElementById('connectorStats')
const connectorModalOverlay = document.getElementById('connectorModalOverlay')
const connectorDetailOverlay = document.getElementById('connectorDetailOverlay')
const catalogInstallOverlay = document.getElementById('catalogInstallOverlay')
let connectors = []
let catalogItems = []
let catalogFilter = 'all'
let catalogInstallTarget = null

// Connector tab switching
document.querySelectorAll('.connector-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.connector-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const tabId = tab.dataset.ctab
    document.getElementById('connectorInstalledTab').hidden = tabId !== 'installed'
    document.getElementById('connectorGalleryTab').hidden = tabId !== 'gallery'
    if (tabId === 'gallery') loadCatalog()
  })
})

// Refresh button: triggers the server-side `claude mcp list` refresh.
// Deliberately manual because every refresh spawns stdio / plugin MCPs
// for a health check and can race the live Telegram bot. Button is
// shared by both the Installed and Gallery tabs.
document.getElementById('connectorRefreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectorRefreshBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/connectors/refresh', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      showToast(t('updates.error', {msg: data.error || 'HTTP ' + res.status}))
    } else {
      showToast(t('connectors.toast.mcp_refreshed', { n: data.count || 0 }))
    }
    await loadConnectors()
    // Reload catalog only if the Gallery tab is currently active so we
    // do not fight for the catalog grid while the user is on Installed.
    if (!document.getElementById('connectorGalleryTab').hidden) {
      await loadCatalog()
    }
  } catch (err) {
    showToast(t('updates.toast.error', {msg: err.message || err}))
  } finally {
    btn.disabled = false
  }
})

// Catalog filter buttons
document.querySelectorAll('.catalog-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.catalog-filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    catalogFilter = btn.dataset.cat
    renderCatalog()
  })
})

// Catalog install modal
document.getElementById('catalogInstallClose').addEventListener('click', () => closeModal(catalogInstallOverlay))
catalogInstallOverlay.addEventListener('click', (e) => { if (e.target === catalogInstallOverlay) closeModal(catalogInstallOverlay) })

async function loadCatalog() {
  const grid = document.getElementById('catalogGrid')
  grid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('connectors.catalog_loading')}</div>`
  try {
    const res = await fetch('/api/mcp-catalog')
    catalogItems = await res.json()
    renderCatalog()
  } catch (err) {
    console.error('Catalog load error:', err)
    grid.innerHTML = `<div class="connector-loading">${t('connectors.catalog_error')}</div>`
  }
}

function renderCatalog() {
  const grid = document.getElementById('catalogGrid')
  grid.innerHTML = ''
  const filtered = catalogFilter === 'all' ? catalogItems : catalogItems.filter(i => i.category === catalogFilter)
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="connector-loading">${t('connectors.catalog_empty')}</div>`
    return
  }
  for (const item of filtered) {
    const card = document.createElement('div')
    card.className = 'catalog-card'
    const authHint = item.authType === 'oauth' && item.authNote ? `<span class="catalog-auth-hint">${escapeHtml(item.authNote)}</span>` : ''
    card.innerHTML = `
      <div class="catalog-card-header">
        <div class="catalog-card-icon">${item.icon || '?'}</div>
        <div class="catalog-card-info">
          <div class="catalog-card-name">
            ${escapeHtml(item.name)}
            <span class="catalog-card-type ${item.type}">${item.type}</span>
            ${item.infoUrl ? `<a href="${escapeHtml(item.infoUrl)}" target="_blank" rel="noopener" class="catalog-card-link" title="${t('connectors.tooltip.docs')}" onclick="event.stopPropagation()">&#x2197;</a>` : ''}
          </div>
          <div class="catalog-card-desc">${escapeHtml(item.description)}</div>
        </div>
      </div>
      <div class="catalog-card-footer">
        ${item.installed
          ? `<span class="catalog-install-btn installed" title="${item.configMatch ? t('connectors.tooltip.installed_mcp') : t('connectors.tooltip.installed_src', { src: escapeHtml(item.installedSource || '') })}">Telepítve &#10003;${item.configMatch ? ' (.mcp.json)' : item.installedSource === 'claude.ai' ? ' (claude.ai)' : item.installedSource === 'plugin' ? ' (plugin)' : ''}</span>${(item.installedSource === 'claude.ai' || item.configMatch) ? '' : `<a class="catalog-uninstall-link" data-id="${item.id}">Eltávolítás</a>`}`
          : `<button class="catalog-install-btn install" data-id="${item.id}">${t('connectors.catalog.install_btn')}</button>${authHint}`
        }
      </div>
    `
    // Install button
    const installBtn = card.querySelector('.catalog-install-btn.install')
    if (installBtn) {
      installBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        openCatalogInstall(item)
      })
    }
    // Uninstall link
    const uninstallLink = card.querySelector('.catalog-uninstall-link')
    if (uninstallLink) {
      uninstallLink.addEventListener('click', (e) => {
        e.stopPropagation()
        catalogUninstall(item)
      })
    }
    grid.appendChild(card)
  }
}

function openCatalogInstall(item) {
  catalogInstallTarget = item
  document.getElementById('catalogInstallTitle').textContent = t('connectors.catalog.install_title', { icon: item.icon, name: item.name })
  document.getElementById('catalogInstallDesc').textContent = item.description

  const envContainer = document.getElementById('catalogInstallEnvFields')
  envContainer.innerHTML = ''
  const noteEl = document.getElementById('catalogInstallNote')
  noteEl.hidden = true

  if (item.authType === 'apikey') {
    // Show env key input fields
    const envKeys = Object.keys(item.env || {})
    for (const key of envKeys) {
      const div = document.createElement('div')
      div.className = 'catalog-env-group'
      div.innerHTML = `
        <label>${escapeHtml(key)}</label>
        <input type="text" data-env-key="${escapeHtml(key)}" placeholder="${t('connectors.catalog.env_placeholder', { key: escapeHtml(key) })}">
      `
      envContainer.appendChild(div)
    }
    if (item.authNote) {
      noteEl.textContent = item.authNote
      noteEl.hidden = false
    }
  } else if (item.authType === 'oauth') {
    if (item.authNote) {
      noteEl.textContent = item.authNote
      noteEl.hidden = false
    }
  }
  // authType === 'none' -> no extra fields

  openModal(catalogInstallOverlay)
}

document.getElementById('catalogInstallBtn').addEventListener('click', async () => {
  if (!catalogInstallTarget) return
  const item = catalogInstallTarget
  const btn = document.getElementById('catalogInstallBtn')

  // Collect env values
  const envData = {}
  const envInputs = document.querySelectorAll('#catalogInstallEnvFields input[data-env-key]')
  for (const input of envInputs) {
    const key = input.dataset.envKey
    const val = input.value.trim()
    if (!val) {
      input.focus()
      showToast(t('connectors.toast.required_field', { key }))
      return
    }
    envData[key] = val
  }

  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/mcp-catalog/${encodeURIComponent(item.id)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: envData }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')
    closeModal(catalogInstallOverlay)
    showToast(data.message || t('connectors.toast.installed'))
    // Reload both views
    loadCatalog()
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

async function catalogUninstall(item) {
  if (!confirm(t('connectors.confirm.remove', { name: item.name }))) return
  try {
    const res = await fetch(`/api/mcp-catalog/${encodeURIComponent(item.id)}/uninstall`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')
    showToast(data.message || t('connectors.toast.removed'))
    loadCatalog()
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

// Modal wiring
document.getElementById('addConnectorBtn').addEventListener('click', () => {
  document.getElementById('connectorName').value = ''
  document.getElementById('connectorUrl').value = ''
  document.getElementById('connectorCmd').value = ''
  document.getElementById('connectorArgs').value = ''
  document.getElementById('connectorType').value = 'stdio'
  document.getElementById('connectorScope').value = 'user'
  document.getElementById('connectorUrlGroup').hidden = true
  document.getElementById('connectorCmdGroup').hidden = false
  document.getElementById('connectorArgsGroup').hidden = false
  document.getElementById('connectorEnvGroup').hidden = false
  document.getElementById('connectorEnvList').innerHTML = ''
  document.getElementById('connectorAssignGroup').hidden = true
  loadNewConnectorAgents()
  openModal(connectorModalOverlay)
})
document.getElementById('connectorModalClose').addEventListener('click', () => closeModal(connectorModalOverlay))
document.getElementById('connectorDetailClose').addEventListener('click', () => closeModal(connectorDetailOverlay))
connectorModalOverlay.addEventListener('click', (e) => { if (e.target === connectorModalOverlay) closeModal(connectorModalOverlay) })
connectorDetailOverlay.addEventListener('click', (e) => { if (e.target === connectorDetailOverlay) closeModal(connectorDetailOverlay) })

// Type toggle
document.getElementById('connectorType').addEventListener('change', () => {
  const isStdio = document.getElementById('connectorType').value === 'stdio'
  document.getElementById('connectorUrlGroup').hidden = isStdio
  document.getElementById('connectorCmdGroup').hidden = !isStdio
  document.getElementById('connectorArgsGroup').hidden = !isStdio
  document.getElementById('connectorEnvGroup').hidden = !isStdio
})

// Scope toggle: hide agent assignment for global scope
document.getElementById('connectorScope').addEventListener('change', () => {
  const isProject = document.getElementById('connectorScope').value === 'project'
  document.getElementById('connectorAssignGroup').hidden = !isProject
})

// Default TRUE: if we never successfully read /api/connectors/status
// (endpoint missing on older backends, network error, non-2xx response)
// the safe assumption is that the cache has not populated yet. That
// way an empty list renders as "warming" rather than the misleading
// "no connectors" the F2 round-3 fix was meant to eliminate.
let connectorCacheWarming = true
let connectorCacheError = ''

async function loadConnectors() {
  connectorGrid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('connectors.loading')}</div>`
  connectorStats.innerHTML = ''
  // Reset pessimistic state at the top of every load. Only an authoritative
  // positive signal (status endpoint reports cacheLastRefreshed > 0) flips
  // it to false, so a later status-fetch failure cannot leave a stale
  // `false` that regresses into "no connectors" again.
  connectorCacheWarming = true
  connectorCacheError = ''
  try {
    // Fetch both in parallel: the list itself and a lightweight status
    // readout that tells us whether the server-side cache has ever run.
    // Without the status, a cold-start hit on the page would render
    // "Nincsenek MCP connectorok" -- contradicting the info-box that
    // says "A lista a dashboard indulasakor toltodik be".
    const [listRes, statusRes] = await Promise.all([
      fetch('/api/connectors'),
      fetch('/api/connectors/status').catch(() => null),
    ])
    connectors = await listRes.json()
    if (statusRes && statusRes.ok) {
      const s = await statusRes.json().catch(() => ({}))
      if (s && s.cacheLastRefreshed > 0) connectorCacheWarming = false
      if (s && s.cacheError) connectorCacheError = String(s.cacheError)
    }
    renderConnectors()
    loadExternalPaths()
    loadGitHubRepos()
    loadVault()
  } catch (err) {
    console.error('Connector betöltés hiba:', err)
    connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.load_error')}</div>`
  }
}

// Built-in MCPs: features that live inside the Claude Code binary or
// app rather than as a registered MCP server. They cannot be detected
// via `claude mcp list`, so the "Aktív / Kikapcsolva" label used to
// always read "Kikapcsolva" regardless of the real state. Replace the
// misleading state badge with a "Részletek" button that opens a modal
// carrying the real enable instructions (which previously hid inside
// a `title` tooltip the user had to hover to discover).
const BUILTIN_MCPS = [
  {
    name: 'computer-use',
    label: 'Computer Use',
    desc: () => t('connectors.builtin.computer_use'),
    get detailHtml() { return t('connectors.builtin.computer_use_html') },
  },
  {
    name: 'chrome',
    label: 'Claude in Chrome',
    desc: () => t('connectors.builtin.chrome'),
    get detailHtml() { return t('connectors.builtin.chrome_html') },
  },
]

function openBuiltinDetail(item) {
  const overlay = document.getElementById('builtinDetailOverlay')
  if (!overlay) return
  document.getElementById('builtinDetailTitle').textContent = item.label
  document.getElementById('builtinDetailDesc').textContent = typeof item.desc === 'function' ? item.desc() : item.desc
  // Static strings only. Never interpolate user or server input here
  // without passing it through escapeHtml first -- detailHtml is a
  // raw HTML sink.
  document.getElementById('builtinDetailBody').innerHTML = item.detailHtml
  openModal(overlay)
  // Move focus into the dialog so keyboard users land inside the new
  // surface instead of keeping the Részletek button focused behind
  // the overlay. Same pattern the other modals in this file skip, but
  // cheap to add for accessibility.
  const closeBtn = document.getElementById('builtinDetailClose')
  if (closeBtn) setTimeout(() => closeBtn.focus(), 50)
}

// Wire close paths for the built-in detail modal once per load. Guarded
// so a future refactor that moves the script tag above the modal HTML
// (e.g. deferred <head> load) does not fire a silent null-ref here.
function wireBuiltinDetailModal() {
  const overlay = document.getElementById('builtinDetailOverlay')
  const closeBtn = document.getElementById('builtinDetailClose')
  if (!overlay || !closeBtn) return
  closeBtn.addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay)
  })
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireBuiltinDetailModal, { once: true })
} else {
  wireBuiltinDetailModal()
}

function renderConnectors() {
  // Detach panels that live inside connectorGrid before innerHTML wipes them
  const _extPathsPanel = document.getElementById('externalPathsSection')
  if (_extPathsPanel) _extPathsPanel.remove()

  // Stats
  if (connectors.length === 0 && connectorCacheWarming) {
    connectorStats.innerHTML = ''
  } else {
    const connected = connectors.filter(c => c.status === 'connected').length
    // 'configured' = declared in a .mcp.json (not health-checked, the backend
    // never spawns them). These are known-good, not broken -- surface them in a
    // positive count so file-defined servers (e.g. gmail-egov) do not look
    // un-ready just because they never went through the claude mcp list cache.
    const configured = connectors.filter(c => c.status === 'configured').length
    const needsAuth = connectors.filter(c => c.status === 'needs_auth').length
    const failed = connectors.filter(c => c.status === 'failed').length
    connectorStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${connectors.length}</div><div class="stat-label">${t('connectors.stat.total')}</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--success)">${connected}</div><div class="stat-label">${t('connectors.stat.active')}</div></div>
      ${configured ? `<div class="stat-card"><div class="stat-value" style="color:var(--info)">${configured}</div><div class="stat-label">${t('connectors.stat.configured')}</div></div>` : ''}
      ${needsAuth ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${needsAuth}</div><div class="stat-label">${t('connectors.stat.needs_auth')}</div></div>` : ''}
      ${failed ? `<div class="stat-card"><div class="stat-value" style="color:var(--danger)">${failed}</div><div class="stat-label">${t('connectors.stat.failed')}</div></div>` : ''}
    `
  }

  connectorGrid.innerHTML = ''
  const hasClaudeAiEntries = connectors.some(c => c.source === 'claude.ai')
  if (connectors.length > 0 && !connectorCacheWarming && connectorCacheError && hasClaudeAiEntries) {
    const banner = document.createElement('div')
    banner.className = 'connector-stale-banner'
    banner.innerHTML = t('connectors.stale_banner', { msg: escapeHtml(connectorCacheError) })
    connectorGrid.appendChild(banner)
  }
  if (connectors.length === 0 && !BUILTIN_MCPS.length) {
    if (connectorCacheWarming && connectorCacheError) {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.mcp_load_failed', { msg: escapeHtml(connectorCacheError) })}</div>`
    } else if (connectorCacheWarming) {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.mcp_not_loaded')}</div>`
    } else {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.no_mcps')}</div>`
    }
    return
  }

  // Group by scope
  const groups = new Map()
  for (const c of connectors) {
    const scope = c.scope || 'global'
    if (!groups.has(scope)) groups.set(scope, [])
    groups.get(scope).push(c)
  }

  const globalScopes = ['global', 'plugin']
  const agentScopes = []
  const internalProjectScopes = []
  const externalProjectScopes = []
  for (const scope of groups.keys()) {
    if (scope.startsWith('agent:')) agentScopes.push(scope)
    else if (scope.startsWith('project:external/')) externalProjectScopes.push(scope)
    else if (scope.startsWith('project:')) internalProjectScopes.push(scope)
    else if (!globalScopes.includes(scope)) globalScopes.push(scope)
  }
  agentScopes.sort()
  internalProjectScopes.sort()
  externalProjectScopes.sort()

  const sourceLabels = {
    'claude.ai': 'claude.ai',
    'plugin': 'plugin',
    'local-user': 'local (user)',
    'local-project': 'local (project)',
    'local': 'local',
    'agent': 'agent',
    'agent-project': 'project',
    'external-project': 'external',
  }

  function renderCard(c, container) {
    const card = document.createElement('div')
    card.className = 'connector-card'
    const sourceTag = c.source ? `<span class="connector-source-badge">${escapeHtml(sourceLabels[c.source] || c.source)}</span>` : ''
    const readOnly = c.source === 'claude.ai'
    if (readOnly) card.classList.add('connector-card-readonly')
    const readonlyHint = readOnly ? `<div class="connector-readonly-hint">${t('connectors.readonly_hint')}</div>` : ''
    card.innerHTML = `
      <div class="connector-status-dot ${c.status}"></div>
      <div class="connector-info">
        <div class="connector-name">${escapeHtml(c.name)} ${sourceTag}</div>
        <div class="connector-endpoint">${escapeHtml(c.endpoint || '')}</div>
        ${readonlyHint}
      </div>
      <span class="connector-type-badge ${c.type}">${c.type}</span>
    `
    if (!readOnly) card.addEventListener('click', () => openConnectorDetail(c))
    container.appendChild(card)
  }

  function renderCollapsible(label, icon, items, container) {
    const section = document.createElement('div')
    section.className = 'connector-scope-section'
    const header = document.createElement('div')
    header.className = 'connector-scope-header collapsible'
    header.innerHTML = `<span class="connector-scope-toggle">▶</span> ${icon} ${escapeHtml(label)} <span class="connector-scope-count">${items.length}</span>`
    header.addEventListener('click', () => {
      const grid = section.querySelector('.connector-scope-grid')
      const toggle = header.querySelector('.connector-scope-toggle')
      if (grid.hidden) { grid.hidden = false; toggle.textContent = '▼' }
      else { grid.hidden = true; toggle.textContent = '▶' }
    })
    section.appendChild(header)
    const grid = document.createElement('div')
    grid.className = 'connector-scope-grid'
    grid.hidden = true
    for (const c of items) renderCard(c, grid)
    section.appendChild(grid)
    container.appendChild(section)
  }

  // === Claude globális ===
  const globalHeading = document.createElement('div')
  globalHeading.className = 'connector-group-heading'
  globalHeading.textContent = t('connectors.heading.global')
  connectorGrid.appendChild(globalHeading)

  const builtinGrid = document.createElement('div')
  builtinGrid.className = 'connector-builtin-grid'
  for (const b of BUILTIN_MCPS) {
    const div = document.createElement('div')
    div.className = 'connector-builtin'
    div.innerHTML = `
      <div class="connector-status-dot unknown" title="${t('connectors.tooltip.auto_detect')}"></div>
      <div class="connector-builtin-name">${escapeHtml(b.label)}<br><span style="font-size:11px;color:var(--text-muted);font-weight:400">${escapeHtml(typeof b.desc === 'function' ? b.desc() : b.desc)}</span></div>
      <button type="button" class="connector-builtin-action btn-link" data-builtin="${escapeHtml(b.name)}">${t('connectors.builtin.details')}</button>
    `
    const btn = div.querySelector('button[data-builtin]')
    if (btn) btn.addEventListener('click', () => openBuiltinDetail(b))
    builtinGrid.appendChild(div)
  }
  connectorGrid.appendChild(builtinGrid)

  const globalGrid = document.createElement('div')
  globalGrid.className = 'connector-scope-grid'
  for (const scope of globalScopes) {
    for (const c of (groups.get(scope) || [])) renderCard(c, globalGrid)
  }
  if (globalGrid.children.length > 0) connectorGrid.appendChild(globalGrid)

  // === Ügynökök ===
  if (agentScopes.length > 0) {
    const agentHeading = document.createElement('div')
    agentHeading.className = 'connector-group-heading'
    agentHeading.textContent = t('connectors.heading.agents')
    connectorGrid.appendChild(agentHeading)

    for (const ag of agentScopes) {
      const agentName = ag.slice('agent:'.length)
      renderCollapsible(agentName, '🤖', groups.get(ag), connectorGrid)
    }
  }

  // === Projektek (belső) ===
  if (internalProjectScopes.length > 0) {
    const projectHeading = document.createElement('div')
    projectHeading.className = 'connector-group-heading'
    projectHeading.textContent = t('connectors.heading.projects')
    connectorGrid.appendChild(projectHeading)

    for (const ps of internalProjectScopes) {
      const parts = ps.slice('project:'.length).split('/')
      const projLabel = parts[parts.length - 1]
      renderCollapsible(projLabel, '📁', groups.get(ps), connectorGrid)
    }
  }

  // === Külső projektek ===
  if (externalProjectScopes.length > 0 || _extPathsPanel) {
    const extHeading = document.createElement('div')
    extHeading.className = 'connector-group-heading'
    extHeading.textContent = t('connectors.heading.external')
    connectorGrid.appendChild(extHeading)

    if (_extPathsPanel) connectorGrid.appendChild(_extPathsPanel)

    for (const ps of externalProjectScopes) {
      const projLabel = ps.slice('project:external/'.length)
      renderCollapsible(projLabel, '📂', groups.get(ps), connectorGrid)
    }
  }
}

// --- GitHub repo management ---
async function loadGitHubRepos() {
  try {
    const res = await fetch('/api/connectors/github-repos')
    const data = await res.json()
    const repos = data.repos || []
    document.getElementById('githubRepoCount').textContent = String(repos.length)
    const list = document.getElementById('githubRepoList')
    list.innerHTML = ''
    for (const r of repos) {
      const item = document.createElement('div')
      item.className = 'connector-external-item github-repo-item'
      const date = new Date(r.installedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(r.name.replace('--', '/'))}</span><span class="github-repo-date">${date}</span></div><div class="github-repo-actions"><button class="github-repo-update" title="Frissites">&#x21bb;</button><button class="github-repo-delete" title="Torles">&times;</button></div>`
      item.querySelector('.github-repo-update').addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.textContent = '...'
        try {
          const res = await fetch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`, { method: 'PATCH' })
          const data = await res.json()
          if (data.error) { alert(data.error); return }
          loadConnectors()
        } finally { btn.disabled = false; btn.innerHTML = '&#x21bb;' }
      })
      item.querySelector('.github-repo-delete').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${r.name.replace('--', '/')}?`)) return
        await fetch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`, { method: 'DELETE' })
        loadGitHubRepos()
        loadExternalPaths()
        loadConnectors()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireGitHubRepos() {
  const toggle = document.getElementById('githubReposToggle')
  const body = document.getElementById('githubReposBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('githubRepoAddBtn')
  const input = document.getElementById('githubRepoInput')
  const status = document.getElementById('githubRepoStatus')
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    addBtn.disabled = true
    addBtn.textContent = 'Telepites...'
    status.hidden = false
    status.className = 'github-repo-status loading'
    status.textContent = t('connectors.cloning')
    try {
      const res = await fetch('/api/connectors/github-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: val }),
      })
      const data = await res.json()
      if (data.error) {
        status.className = 'github-repo-status error'
        status.textContent = data.error
        return
      }
      if (data.requiredEnvVars && data.requiredEnvVars.length > 0) {
        status.className = 'github-repo-status loading'
        status.textContent = t('connectors.api_keys_needed')
        const envValues = await showEnvVarModal(data.requiredEnvVars)
        if (envValues && Object.keys(envValues).length > 0) {
          let vaultAllOk = true
          for (const [key, value] of Object.entries(envValues)) {
            const r = await fetch('/api/vault', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: `github-env-${data.repo.name}-${key}`, label: `${key} (${data.repo.name.replace('--', '/')})`, value }),
            })
            if (!r.ok) vaultAllOk = false
          }
          if (vaultAllOk) {
            status.className = 'github-repo-status success'
            status.textContent = 'Telepitve, kulcsok mentve a Vault-ba!'
          } else {
            status.className = 'github-repo-status error'
            status.textContent = 'Telepitve, de néhány kulcs mentése sikertelen. Add meg újra a Vault-ban.'
          }
          loadVault()
        } else {
          status.className = 'github-repo-status success'
          status.textContent = 'Telepitve (kulcsok kihagyva)'
        }
      } else {
        status.className = 'github-repo-status success'
        status.textContent = 'Telepitve!'
      }
      input.value = ''
      loadGitHubRepos()
      loadExternalPaths()
      loadConnectors()
      setTimeout(() => { status.hidden = true }, 4000)
    } catch (err) {
      status.className = 'github-repo-status error'
      status.textContent = 'Hiba: ' + err.message
    } finally {
      addBtn.disabled = false
      addBtn.textContent = 'Telepites'
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- Vault management ---
async function loadVault() {
  try {
    const res = await fetch('/api/vault')
    const data = await res.json()
    const secrets = data.secrets || []
    document.getElementById('vaultCount').textContent = String(secrets.length)
    const list = document.getElementById('vaultList')
    list.innerHTML = ''
    for (const s of secrets) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(s.label)}</span><span class="github-repo-date">${escapeHtml(s.id)} &middot; ${date}</span></div><button title="Torles" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:2px 6px">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${s.label}?`)) return
        const res = await fetch(`/api/vault/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        if (!res.ok) { showToast('Törlés sikertelen'); return }
        loadVault()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireVault() {
  const toggle = document.getElementById('vaultToggle')
  const body = document.getElementById('vaultBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('vaultAddBtn')
  const idInput = document.getElementById('vaultIdInput')
  const valInput = document.getElementById('vaultValueInput')
  addBtn.addEventListener('click', async () => {
    const id = idInput.value.trim()
    const val = valInput.value
    if (!id || !val) return
    const res = await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label: id, value: val }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      showToast('Mentés sikertelen: ' + (e.error || res.status))
      return
    }
    idInput.value = ''
    valInput.value = ''
    loadVault()
  })
  valInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- Env var modal for GitHub repo install ---
let _envVarResolve = null
function showEnvVarModal(envVars) {
  return new Promise((resolve) => {
    _envVarResolve = resolve
    const modal = document.getElementById('envVarModal')
    const fields = document.getElementById('envVarFields')
    fields.innerHTML = ''
    for (const v of envVars) {
      const row = document.createElement('div')
      row.className = 'env-var-row'
      row.innerHTML = `<label class="env-var-label">${escapeHtml(v)}</label><input type="password" class="input env-var-input" data-key="${escapeHtml(v)}" placeholder="Ertek...">`
      fields.appendChild(row)
    }
    modal.hidden = false
  })
}

;(function wireEnvVarModal() {
  const modal = document.getElementById('envVarModal')
  if (!modal) return
  document.getElementById('envVarModalClose').addEventListener('click', () => {
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(null); _envVarResolve = null }
  })
  document.getElementById('envVarSkipBtn').addEventListener('click', () => {
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(null); _envVarResolve = null }
  })
  document.getElementById('envVarSaveBtn').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#envVarFields .env-var-input')
    const env = {}
    for (const inp of inputs) {
      const key = inp.getAttribute('data-key')
      const val = inp.value.trim()
      if (key && val) env[key] = val
    }
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(env); _envVarResolve = null }
  })
})()

// --- Vault Page ---
let _vaultSecrets = []

let _vaultBindings = []

async function loadVaultPage() {
  try {
    const [secretsRes, bindingsRes] = await Promise.all([
      fetch('/api/vault'),
      fetch('/api/vault/bindings'),
    ])
    const secretsData = await secretsRes.json()
    const bindingsData = await bindingsRes.json()
    _vaultSecrets = secretsData.secrets || []
    _vaultBindings = bindingsData.bindings || []
    document.getElementById('vaultStatTotal').textContent = String(_vaultSecrets.length)
    document.getElementById('vaultStatBindings').textContent = String(_vaultBindings.length)
    renderVaultGrid(_vaultSecrets)
  } catch { /* ignore */ }
}

function renderVaultGrid(secrets) {
  const list = document.getElementById('vaultPageList')
  const empty = document.getElementById('vaultPageEmpty')
  list.innerHTML = ''
  if (secrets.length === 0) { empty.hidden = false; return }
  empty.hidden = true
  for (const s of secrets) {
    const card = document.createElement('div')
    card.className = 'vault-card'
    const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
    const bindingCount = _vaultBindings.filter(b => b.vaultSecretId === s.id).length
    const bindingBadge = bindingCount > 0 ? `<span class="vault-binding-badge" title="${bindingCount} kotes">${bindingCount} kotes</span>` : ''
    card.innerHTML = `<div class="vault-card-header"><div class="vault-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="vault-card-title"><div class="vault-card-id">${escapeHtml(s.id)} ${bindingBadge}</div>${s.label !== s.id ? `<div class="vault-card-label">${escapeHtml(s.label)}</div>` : ''}</div><div class="vault-card-meta">${date}</div></div><div class="vault-card-actions"><button class="btn-secondary btn-compact vault-card-reveal" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${t('vault.btn.show')}</button><button class="btn-secondary btn-compact vault-card-edit" data-id="${escapeHtml(s.id)}" data-label="${escapeHtml(s.label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${t('vault.btn.edit')}</button><button class="btn-secondary btn-compact vault-card-delete" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>${t('vault.btn.delete')}</button></div>`
    list.appendChild(card)
  }
  list.querySelectorAll('.vault-card-reveal').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-value')
      if (existing) { existing.remove(); btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${t('vault.btn.show')}`; return }
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (data.value) {
        const valEl = document.createElement('div')
        valEl.className = 'vault-card-value'
        valEl.textContent = data.value
        card.appendChild(valEl)
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> ${t('vault.btn.hide')}`
      }
    })
  })
  list.querySelectorAll('.vault-card-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const label = btn.getAttribute('data-label')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-edit-form')
      if (existing) { existing.remove(); return }
      card.querySelector('.vault-card-value')?.remove()
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!data.value) return
      const form = document.createElement('div')
      form.className = 'vault-card-edit-form'
      form.innerHTML = `<input type="password" class="input vault-edit-value" value="${escapeHtml(data.value)}" style="font-size:13px;margin-bottom:6px"><button class="btn-primary btn-compact vault-edit-save">${t('vault.btn.save')}</button> <button class="btn-secondary btn-compact vault-edit-cancel">${t('vault.btn.cancel')}</button>`
      card.appendChild(form)
      const input = form.querySelector('.vault-edit-value')
      input.focus()
      input.select()
      form.querySelector('.vault-edit-cancel').addEventListener('click', () => form.remove())
      form.querySelector('.vault-edit-save').addEventListener('click', async () => {
        const newVal = input.value
        if (!newVal) return
        const saveBtn = form.querySelector('.vault-edit-save')
        saveBtn.disabled = true
        saveBtn.textContent = '...'
        const res = await fetch('/api/vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label, value: newVal }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          showToast('Frissítés sikertelen: ' + (e.error || res.status))
          saveBtn.disabled = false
          saveBtn.textContent = 'Mentés'
          return
        }
        form.remove()
        showToast('Kulcs frissitve es szinkronizalva')
        loadVaultPage()
        loadVault()
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') form.querySelector('.vault-edit-save').click()
        if (e.key === 'Escape') form.remove()
      })
    })
  })
  list.querySelectorAll('.vault-card-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Torlod: ${id}?`)) return
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) { showToast('Törlés sikertelen'); return }
      loadVaultPage()
      loadVault()
    })
  })
}

;(function wireVaultPage() {
  const newBtn = document.getElementById('vaultPageNewBtn')
  const panel = document.getElementById('vaultAddPanel')
  const closeBtn = document.getElementById('vaultAddPanelClose')
  const addBtn = document.getElementById('vaultPageAddBtn')
  if (!newBtn || !panel) return

  newBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) document.getElementById('vaultPageIdInput').focus()
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true })

  addBtn.addEventListener('click', async () => {
    const id = document.getElementById('vaultPageIdInput').value.trim()
    const label = document.getElementById('vaultPageLabelInput').value.trim() || id
    const value = document.getElementById('vaultPageValueInput').value
    if (!id || !value) return
    addBtn.disabled = true
    await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, value }),
    })
    document.getElementById('vaultPageIdInput').value = ''
    document.getElementById('vaultPageLabelInput').value = ''
    document.getElementById('vaultPageValueInput').value = ''
    addBtn.disabled = false
    panel.hidden = true
    loadVaultPage()
    loadVault()
  })
  document.getElementById('vaultPageValueInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })

  document.getElementById('vaultSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim()
    if (!q) { renderVaultGrid(_vaultSecrets); return }
    renderVaultGrid(_vaultSecrets.filter(s => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)))
  })
})()

// --- Vault Binding modal ---
;(function wireVaultBind() {
  const bindBtn = document.getElementById('vaultBindBtn')
  const overlay = document.getElementById('vaultBindOverlay')
  const closeBtn = document.getElementById('vaultBindClose')
  const saveBtn = document.getElementById('vaultBindSaveBtn')
  const secretSelect = document.getElementById('vaultBindSecret')
  const serverSelect = document.getElementById('vaultBindServer')
  const envVarInput = document.getElementById('vaultBindEnvVar')
  const statusEl = document.getElementById('vaultBindStatus')
  if (!bindBtn || !overlay) return

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })
  closeBtn.addEventListener('click', () => { closeModal(overlay) })

  bindBtn.addEventListener('click', async () => {
    try {
      statusEl.hidden = true
      envVarInput.value = ''

      const [secretsRes, connectorsRes] = await Promise.all([
        fetch('/api/vault'),
        fetch('/api/connectors'),
      ])
      const secrets = (await secretsRes.json()).secrets || []
      const connectors = await connectorsRes.json()

      secretSelect.innerHTML = ''
      for (const s of secrets) {
        const opt = document.createElement('option')
        opt.value = s.id
        opt.textContent = s.label !== s.id ? `${s.id} (${s.label})` : s.id
        secretSelect.appendChild(opt)
      }
      if (secrets.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs vault kulcs --'
        opt.disabled = true
        secretSelect.appendChild(opt)
      }

      const mcpConnectors = connectors.filter(c => c.source !== 'plugin' && c.source !== 'claude.ai')
      serverSelect.innerHTML = ''
      for (const c of mcpConnectors) {
        const opt = document.createElement('option')
        opt.value = c.name
        opt.textContent = c.scope !== 'global' ? `${c.name} (${c.scope})` : c.name
        serverSelect.appendChild(opt)
      }
      if (mcpConnectors.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs MCP szerver --'
        opt.disabled = true
        serverSelect.appendChild(opt)
      }

      openModal(overlay)
    } catch (err) {
      console.error('Vault bind modal error:', err)
      showToast('Hiba a hozzarendeles betoltesekor: ' + err.message)
    }
  })

  saveBtn.addEventListener('click', async () => {
    const vaultSecretId = secretSelect.value
    const serverName = serverSelect.value
    const envVar = envVarInput.value.trim()
    if (!vaultSecretId || !serverName || !envVar) {
      statusEl.textContent = 'Minden mezo kitoltese kotelezo'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = t('connectors.save_btn')
    try {
      const res = await fetch('/api/vault/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultSecretId, envVar, serverName }),
      })
      const data = await res.json()
      if (data.ok) {
        statusEl.textContent = `Hozzarendelve! ${data.synced || 0} fajl frissitve.`
        statusEl.className = 'vault-bind-status success'
        statusEl.hidden = false
        loadVaultPage()
        loadVault()
        setTimeout(() => { closeModal(overlay) }, 1500)
      } else {
        statusEl.textContent = data.error || 'Hiba tortent'
        statusEl.className = 'vault-bind-status error'
        statusEl.hidden = false
      }
    } catch (err) {
      statusEl.textContent = 'Halozati hiba'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Hozzarendeles'
    }
  })
})()

// --- Vault Scan & Import ---
;(function wireVaultScan() {
  const scanBtn = document.getElementById('vaultScanBtn')
  const syncBtn = document.getElementById('vaultSyncBtn')
  const overlay = document.getElementById('vaultScanOverlay')
  const closeBtn = document.getElementById('vaultScanClose')
  const importBtn = document.getElementById('vaultScanImportBtn')
  if (!scanBtn || !overlay) return

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true
    scanBtn.textContent = 'Kereses...'
    try {
      const res = await fetch('/api/vault/scan')
      const data = await res.json()
      const findings = data.findings || []
      renderScanResults(findings)
      openModal(overlay)
    } finally {
      scanBtn.disabled = false
      scanBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan &amp; Import'
    }
  })

  closeBtn?.addEventListener('click', () => { closeModal(overlay) })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })

  syncBtn?.addEventListener('click', async () => {
    syncBtn.disabled = true
    syncBtn.textContent = 'Szinkron...'
    try {
      const res = await fetch('/api/vault/sync', { method: 'POST' })
      const data = await res.json()
      if (data.updated > 0) {
        showToast(`${data.updated} .mcp.json frissitve`)
      } else {
        showToast('Nincs szinkronizalando kotes')
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      syncBtn.disabled = false
      syncBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Szinkron'
    }
  })

  function renderScanResults(findings) {
    const results = document.getElementById('vaultScanResults')
    const empty = document.getElementById('vaultScanEmpty')
    const footer = document.getElementById('vaultScanFooter')
    results.innerHTML = ''

    const actionable = findings.filter(f => !f.alreadyInVault)
    if (actionable.length === 0) {
      empty.hidden = false
      footer.hidden = true
      if (findings.length > 0) {
        empty.textContent = `${findings.length} erzekeny ertek talalva, de mind mar a Vault-ban van.`
      }
      return
    }
    empty.hidden = true
    footer.hidden = false

    const grouped = new Map()
    for (const f of actionable) {
      const key = `${f.serverName}|${f.envVar}`
      if (!grouped.has(key)) grouped.set(key, { ...f, allTargets: [] })
      grouped.get(key).allTargets.push({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })
    }

    for (const [key, f] of grouped) {
      const row = document.createElement('div')
      row.className = 'vault-scan-row'
      row.innerHTML = `
        <label class="vault-scan-check">
          <input type="checkbox" checked data-key="${escapeHtml(key)}">
        </label>
        <div class="vault-scan-info">
          <div class="vault-scan-server">${escapeHtml(f.serverName)}</div>
          <div class="vault-scan-env">${escapeHtml(f.envVar)} = <code>${escapeHtml(f.maskedValue)}</code></div>
          <div class="vault-scan-targets">${f.allTargets.length} fajlban</div>
        </div>
        <div class="vault-scan-id">
          <input type="text" class="input vault-scan-vault-id" value="${escapeHtml(f.suggestedVaultId)}" data-key="${escapeHtml(key)}" style="font-size:12px;width:180px">
        </div>
      `
      results.appendChild(row)
    }
  }

  importBtn?.addEventListener('click', async () => {
    const results = document.getElementById('vaultScanResults')
    const rows = results.querySelectorAll('.vault-scan-row')
    const imports = []

    const scanRes = await fetch('/api/vault/scan')
    const scanData = await scanRes.json()
    const allFindings = scanData.findings || []

    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]')
      if (!cb?.checked) continue
      const key = cb.getAttribute('data-key')
      const [serverName, envVar] = key.split('|')
      const vaultIdInput = row.querySelector('.vault-scan-vault-id')
      const vaultId = vaultIdInput?.value?.trim() || key

      const matchingFindings = allFindings.filter(
        f => f.serverName === serverName && f.envVar === envVar && !f.alreadyInVault,
      )
      if (matchingFindings.length === 0) continue

      imports.push({
        serverName,
        envVar,
        vaultId,
        label: `${envVar} (${serverName})`,
        createBinding: true,
        targets: matchingFindings.map(f => ({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })),
      })
    }

    if (imports.length === 0) { showToast('Nincs kivalasztott elem'); return }

    importBtn.disabled = true
    importBtn.textContent = 'Importalas...'

    try {
      const res = await fetch('/api/vault/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imports }),
      })
      const data = await res.json()
      if (data.imported > 0) {
        showToast(`${data.imported} kulcs importalva, ${data.bound} kotes letrehozva`)
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      importBtn.disabled = false
      importBtn.textContent = 'Kivalasztottak importalasa'
    }
    closeModal(overlay)
    loadVaultPage()
    loadVault()
  })
})()

// --- External project paths management ---
async function loadExternalPaths() {
  try {
    const res = await fetch('/api/connectors/external-paths')
    const data = await res.json()
    const paths = data.paths || []
    document.getElementById('externalPathCount').textContent = String(paths.length)
    const list = document.getElementById('externalPathList')
    list.innerHTML = ''
    for (const p of paths) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      item.innerHTML = `<span>${escapeHtml(p)}</span><button title="Torles">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        await fetch('/api/connectors/external-paths', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        })
        loadExternalPaths()
        loadConnectors()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireExternalPaths() {
  const toggle = document.getElementById('externalPathsToggle')
  const body = document.getElementById('externalPathsBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('externalPathAddBtn')
  const input = document.getElementById('externalPathInput')
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    const res = await fetch('/api/connectors/external-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: val }),
    })
    const data = await res.json()
    if (data.error) { alert(data.error); return }
    input.value = ''
    loadExternalPaths()
    loadConnectors()
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

async function openConnectorDetail(connector) {
  document.getElementById('connectorDetailTitle').textContent = connector.name

  // Fetch detailed info
  try {
    const res = await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`)
    const detail = await res.json()

    const statusLabels = { connected: t('connectors.status.connected'), needs_auth: t('connectors.status.needs_auth'), failed: t('connectors.status.failed'), unknown: t('connectors.status.unknown') }
    const statusColors = { connected: 'var(--success)', needs_auth: 'var(--accent)', failed: 'var(--danger)', unknown: 'var(--text-muted)' }

    document.getElementById('connectorDetailInfo').innerHTML = `
      <div class="connector-detail-row">
        <span class="meta-label">Statusz</span>
        <span class="meta-value" style="color:${statusColors[detail.status] || ''}">${statusLabels[detail.status] || detail.status}</span>
      </div>
      <div class="connector-detail-row">
        <span class="meta-label">Hatokor</span>
        <span class="meta-value">${escapeHtml(detail.scope || '-')}</span>
      </div>
      ${detail.type ? `<div class="connector-detail-row"><span class="meta-label">Tipus</span><span class="meta-value">${escapeHtml(detail.type)}</span></div>` : ''}
      ${detail.command ? `<div class="connector-detail-row"><span class="meta-label">Parancs</span><span class="meta-value" style="font-family:monospace;font-size:12px">${escapeHtml(detail.command)} ${escapeHtml(detail.args || '')}</span></div>` : ''}
      ${Object.keys(detail.env || {}).length ? `<div class="connector-detail-row"><span class="meta-label">Env</span><span class="meta-value" style="font-family:monospace;font-size:11px">${Object.entries(detail.env).map(([k,v]) => `${k}=${v}`).join(', ')}</span></div>` : ''}
    `
  } catch {
    document.getElementById('connectorDetailInfo').innerHTML = `<p>${t('connectors.detail_error')}</p>`
  }

  try {
    const [agentsRes, connectorsRes] = await Promise.all([
      fetch('/api/schedules/agents'),
      fetch('/api/connectors'),
    ])
    const allAgents = await agentsRes.json()
    const allConnectors = await connectorsRes.json()
    const assignedAgents = new Set()
    for (const c of allConnectors) {
      if (c.name === connector.name && c.source === 'agent') {
        assignedAgents.add(c.scope.replace('agent:', ''))
      }
    }
    const mainAgent = allAgents.find(a => a.name === mainAgentId())
    const subAgents = allAgents.filter(a => a.name !== mainAgentId())

    const listEl = document.getElementById('connectorAgentList')
    listEl.innerHTML = ''
    if (mainAgent) {
      const item = document.createElement('div')
      item.className = 'connector-agent-item connector-agent-auto'
      item.innerHTML = `
        <input type="checkbox" checked disabled title="${t('connectors.tooltip.global')}">
        <label>${escapeHtml(mainAgent.label || mainAgent.name)} <span class="tag-auto">automatikus</span></label>
      `
      listEl.appendChild(item)
    }
    for (const agent of subAgents) {
      const isAssigned = assignedAgents.has(agent.name)
      const item = document.createElement('div')
      item.className = 'connector-agent-item'
      item.innerHTML = `
        <input type="checkbox" id="assign-${agent.name}" value="${agent.name}" ${isAssigned ? 'checked' : ''}>
        <label for="assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
      `
      listEl.appendChild(item)
    }
    if (subAgents.length === 0 && !mainAgent) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('connectors.no_agents')}</p>`
    }
  } catch {
    document.getElementById('connectorAgentList').innerHTML = ''
  }

  // Delete button
  document.getElementById('connectorDeleteBtn').onclick = async () => {
    if (!confirm(`Biztosan torlod: ${connector.name}?`)) return
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`, { method: 'DELETE' })
      closeModal(connectorDetailOverlay)
      showToast(t('connectors.toast.deleted'))
      loadConnectors()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Assign button
  document.getElementById('connectorAssignBtn').onclick = async () => {
    const checked = [...document.querySelectorAll('#connectorAgentList input:checked:not(:disabled)')].map(i => i.value)
    const allVisible = [...document.querySelectorAll('#connectorAgentList input:not(:disabled)')].map(i => i.value)
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checked, allAgents: allVisible }),
      })
      showToast(t('connectors.toast.assignment_updated'))
      closeModal(connectorDetailOverlay)
      loadConnectors()
    } catch {
      showToast(t('connectors.toast.assignment_error'))
    }
  }

  openModal(connectorDetailOverlay)
}

// ENV row management for new connector form
document.getElementById('connectorEnvAddBtn').addEventListener('click', () => {
  const list = document.getElementById('connectorEnvList')
  const row = document.createElement('div')
  row.className = 'connector-env-row'
  row.innerHTML = `
    <input type="text" class="input env-key" placeholder="KULCS" style="flex:1">
    <span style="color:var(--text-muted)">=</span>
    <input type="text" class="input env-val" placeholder="${t('connectors.env_val_placeholder')}" style="flex:2">
    <button type="button" class="btn-link" style="color:var(--danger);padding:2px 6px">&times;</button>
  `
  row.querySelector('button').addEventListener('click', () => row.remove())
  list.appendChild(row)
})

async function loadNewConnectorAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const list = document.getElementById('connectorNewAssignList')
    list.innerHTML = ''
    for (const agent of agents) {
      const item = document.createElement('div')
      item.className = 'connector-agent-item'
      item.innerHTML = `
        <input type="checkbox" id="new-assign-${agent.name}" value="${agent.name}">
        <label for="new-assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
      `
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

// Save new connector
document.getElementById('saveConnectorBtn').addEventListener('click', async () => {
  const name = document.getElementById('connectorName').value.trim()
  const type = document.getElementById('connectorType').value
  const scope = document.getElementById('connectorScope').value

  if (!name) { document.getElementById('connectorName').focus(); return }

  const data = { name, type, scope }
  if (type === 'http' || type === 'sse') {
    data.url = document.getElementById('connectorUrl').value.trim()
    if (!data.url) { document.getElementById('connectorUrl').focus(); return }
  } else {
    data.command = document.getElementById('connectorCmd').value.trim()
    data.args = document.getElementById('connectorArgs').value.trim()
    if (!data.command) { document.getElementById('connectorCmd').focus(); return }
    const envRows = document.querySelectorAll('#connectorEnvList .connector-env-row')
    if (envRows.length > 0) {
      const env = {}
      for (const row of envRows) {
        const k = row.querySelector('.env-key').value.trim()
        const v = row.querySelector('.env-val').value.trim()
        if (k) env[k] = v
      }
      if (Object.keys(env).length > 0) data.env = env
    }
  }

  const btn = document.getElementById('saveConnectorBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    const result = await res.json()
    const savedName = result.name || name

    const checkedAgents = Array.from(document.querySelectorAll('#connectorNewAssignList input[type=checkbox]:checked')).map(cb => cb.value)
    const allAgents = Array.from(document.querySelectorAll('#connectorNewAssignList input[type=checkbox]')).map(cb => cb.value)
    if (checkedAgents.length > 0) {
      await fetch(`/api/connectors/${encodeURIComponent(savedName)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checkedAgents, allAgents }),
      }).catch(() => {})
    }

    closeModal(connectorModalOverlay)
    if (result.nameChanged) {
      showToast(t('connectors.toast.added', { name: savedName }))
    } else {
      showToast(t('connectors.toast.created'))
    }
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// === Helpers ===
function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

// ============================================================
// === Status ===
// ============================================================

// Statuspage component status -> short label for non-operational states.
const STATUS_COMPONENT_LABELS = {
  operational: () => t('status.comp.operational'),
  degraded_performance: () => t('status.comp.degraded'),
  partial_outage: () => t('status.comp.partial_outage'),
  major_outage: () => t('status.comp.major_outage'),
  under_maintenance: () => t('status.comp.maintenance'),
}

document.getElementById('refreshStatusBtn').addEventListener('click', loadStatus)

async function loadStatus() {
  const overallEl = document.getElementById('statusOverall')
  const gridEl = document.getElementById('statusServiceGrid')
  const listEl = document.getElementById('statusIncidentList')

  overallEl.className = 'status-overall unknown'
  overallEl.textContent = t('status.loading')
  gridEl.innerHTML = ''
  listEl.innerHTML = ''

  try {
    const res = await fetch('/api/status')
    const data = await res.json()

    // Overall status
    const overallLabels = {
      operational: () => t('status.overall.operational'),
      degraded: () => t('status.overall.degraded'),
      unknown: () => t('status.overall.unknown'),
    }
    overallEl.className = `status-overall ${data.overall}`
    const overallLabelRaw = overallLabels[data.overall]
    overallEl.textContent = overallLabelRaw ? (typeof overallLabelRaw === 'function' ? overallLabelRaw() : overallLabelRaw) : data.overall

    // Services grid: real per-service status from the Statuspage components API
    // (data.components). No more inventing a service list and substring-matching
    // incident text -- if the components feed is unavailable we say so honestly
    // instead of rendering a fake all-green grid.
    const components = Array.isArray(data.components) ? data.components : []
    if (components.length === 0) {
      gridEl.innerHTML = `<div class="status-service-empty" style="color:var(--text-muted);font-size:13px">${t('status.no_components')}</div>`
    } else {
      for (const c of components) {
        const ok = c.status === 'operational'
        const div = document.createElement('div')
        div.className = 'status-service'
        div.innerHTML = `
          <div class="status-service-dot ${ok ? 'operational' : 'degraded'}"></div>
          <span class="status-service-name">${escapeHtml(c.name)}</span>
          ${ok ? '' : `<span class="status-service-state" style="margin-left:auto;font-size:11px;color:var(--text-muted)">${escapeHtml((typeof STATUS_COMPONENT_LABELS[c.status] === 'function' ? STATUS_COMPONENT_LABELS[c.status]() : STATUS_COMPONENT_LABELS[c.status]) || c.status)}</span>`}
        `
        gridEl.appendChild(div)
      }
    }

    // Incidents
    if (data.incidents.length === 0) {
      listEl.innerHTML = `<div class="status-loading">${t('status.no_incidents')}</div>`
    } else {
      for (const inc of data.incidents) {
        const statusLabels = {
          resolved: () => t('status.incident.resolved'),
          monitoring: () => t('status.incident.monitoring'),
          identified: () => t('status.incident.identified'),
          investigating: () => t('status.incident.investigating'),
        }
        const div = document.createElement('div')
        div.className = `status-incident ${inc.status}`
        const date = new Date(inc.pubDate).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
        div.innerHTML = `
          <div class="status-incident-header">
            <span class="status-incident-title">${escapeHtml(inc.title)}</span>
            <span class="status-incident-badge ${inc.status}">${(typeof statusLabels[inc.status] === 'function' ? statusLabels[inc.status]() : statusLabels[inc.status]) || inc.status}</span>
          </div>
          <div class="status-incident-desc">${escapeHtml(inc.description.slice(0, 300))}</div>
          <div class="status-incident-date">${date}</div>
        `
        listEl.appendChild(div)
      }
    }
  } catch (err) {
    overallEl.className = 'status-overall unknown'
    overallEl.textContent = 'Nem sikerult betolteni a statuszt'
  }
}

// ============================================================
// === Memory Import ===
// ============================================================

const memImportOverlay = document.getElementById('memImportOverlay')
const memImportFileInput = document.getElementById('memImportFile')
const memImportFileArea = document.getElementById('memImportFileArea')
const memImportFileNames = document.getElementById('memImportFileNames')
const memImportSaveBtn = document.getElementById('memImportSaveBtn')
const memImportProgress = document.getElementById('memImportProgress')
const memImportStatus = document.getElementById('memImportStatus')
const memImportResult = document.getElementById('memImportResult')
let memImportFiles = []

// Open import modal
document.getElementById('memImportOpenBtn').addEventListener('click', () => {
  memImportFiles = []
  memImportFileInput.value = ''
  memImportFileNames.textContent = ''
  memImportProgress.hidden = true
  memImportResult.hidden = true
  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false

  // Populate agent dropdown from existing agents
  const importAgentSel = document.getElementById('memImportAgent')
  const memAgentSel = document.getElementById('memAgent')
  importAgentSel.innerHTML = memAgentSel.innerHTML
  openModal(memImportOverlay)
})

// Close import modal
document.getElementById('memImportClose').addEventListener('click', () => closeModal(memImportOverlay))
memImportOverlay.addEventListener('click', (e) => { if (e.target === memImportOverlay) closeModal(memImportOverlay) })

// File area click -> trigger file input
memImportFileArea.addEventListener('click', () => memImportFileInput.click())

// Drag and drop
memImportFileArea.addEventListener('dragover', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = 'var(--accent)'
})
memImportFileArea.addEventListener('dragleave', () => {
  memImportFileArea.style.borderColor = ''
})
memImportFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = ''
  const files = Array.from(e.dataTransfer.files).filter(f =>
    f.name.endsWith('.md') || f.name.endsWith('.txt') || f.name.endsWith('.json')
  )
  if (files.length) {
    memImportFiles = files
    memImportFileNames.textContent = files.map(f => f.name).join(', ')
  }
})

// File input change
memImportFileInput.addEventListener('change', () => {
  memImportFiles = Array.from(memImportFileInput.files)
  memImportFileNames.textContent = memImportFiles.map(f => f.name).join(', ')
})

// Parse file into chunks (client-side)
async function parseFileToChunks(file) {
  const text = await file.text()
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'json') {
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        return data.map(item => {
          if (typeof item === 'object' && item !== null) return item.content || item.text || item.value || JSON.stringify(item)
          return String(item)
        }).filter(s => s.length > 20).map(s => s.slice(0, 2000))
      }
      return Object.entries(data).map(([k, v]) => `${k}: ${v}`).filter(s => s.length > 20).map(s => s.slice(0, 2000))
    } catch { return [text.slice(0, 2000)] }
  }

  if (ext === 'md') {
    return text.split(/\n(?=##?\s)/).map(s => s.trim()).filter(s => s.length > 20).map(s => s.slice(0, 2000))
  }

  // txt: split by paragraphs
  return text.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 20).map(s => s.slice(0, 2000))
}

// Import button click
memImportSaveBtn.addEventListener('click', async () => {
  if (!memImportFiles.length) {
    showToast(t('memories.toast.select_files'))
    return
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = true
  memImportSaveBtn.querySelector('.btn-loading').hidden = false
  memImportSaveBtn.disabled = true
  memImportProgress.hidden = false
  memImportResult.hidden = true
  memImportStatus.textContent = t('memories.import.processing')

  try {
    // Parse all files into chunks
    let allChunks = []
    for (const file of memImportFiles) {
      const chunks = await parseFileToChunks(file)
      allChunks = allChunks.concat(chunks)
    }

    if (allChunks.length === 0) {
      memImportProgress.hidden = true
      memImportSaveBtn.querySelector('.btn-text').hidden = false
      memImportSaveBtn.querySelector('.btn-loading').hidden = true
      memImportSaveBtn.disabled = false
      showToast(t('memories.toast.no_content'))
      return
    }

    memImportStatus.textContent = t('memories.import.importing', { n: allChunks.length })

    const agentId = document.getElementById('memImportAgent').value || mainAgentId()
    const resp = await fetch('/api/memories/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, chunks: allChunks }),
    })
    const data = await resp.json()

    memImportProgress.hidden = true

    if (data.ok) {
      const s = data.stats || {}
      memImportResult.hidden = false
      memImportResult.innerHTML = `
        <div style="color:var(--text-primary);font-weight:600;margin-bottom:8px">${t('memories.import.done_title')}</div>
        <div style="font-size:13px;color:var(--text-secondary)">
          ${t('memories.import.done_sub', { n: `<strong>${data.imported}</strong>` })}<br>
          Hot: ${s.hot || 0} | Warm: ${s.warm || 0} | Cold: ${s.cold || 0} | Shared: ${s.shared || 0}
        </div>
      `
      showToast(t('memories.toast.imported', { n: data.imported }))
      loadMemories()
      loadMemStats()
    } else {
      showToast('Hiba: ' + (data.error || 'Ismeretlen'))
    }
  } catch (err) {
    memImportProgress.hidden = true
    showToast(t('memories.toast.import_error'))
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false
})

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
// === Skills Page ===
// ============================================================

const skillsGrid = document.getElementById('skillsGrid')
const skillsStats = document.getElementById('skillsStats')
const skillsEmpty = document.getElementById('skillsEmpty')
const skillDetailOverlay = document.getElementById('skillDetailOverlay')

let globalSkills = []

document.getElementById('skillDetailClose').addEventListener('click', () => closeModal(skillDetailOverlay))
skillDetailOverlay.addEventListener('click', (e) => { if (e.target === skillDetailOverlay) closeModal(skillDetailOverlay) })

// Scope for the next skill create/import action. 'global' means the
// Skills page opened the modal (write to ~/.claude/skills/); any other
// value (or null) falls back to the legacy per-agent flow keyed off
// `currentAgent`. Reset on modal close so a subsequent per-agent open
// cannot inherit the global scope.
let skillModalScope = null

// Wire the Skills-page "Új skill" button to reuse the same skillModalOverlay
// the per-agent Skill list uses. The save/import handlers branch on
// skillModalScope so we don't have to duplicate the modal markup.
const skillsPageNewBtn = document.getElementById('skillsPageNewBtn')
if (skillsPageNewBtn) {
  skillsPageNewBtn.addEventListener('click', () => {
    skillModalScope = 'global'
    document.getElementById('skillName').value = ''
    document.getElementById('skillDescription').value = ''
    skillFile = null
    document.getElementById('skillFileName').textContent = ''
    document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.skillTab === 'create'))
    document.getElementById('skillTabCreate').hidden = false
    document.getElementById('skillTabImport').hidden = true
    openModal(skillModalOverlay)
    setTimeout(() => document.getElementById('skillName').focus(), 200)
  })
}

async function loadGlobalSkills() {
  skillsGrid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('skills.loading')}</div>`
  skillsStats.innerHTML = ''
  try {
    const res = await fetch('/api/skills')
    globalSkills = await res.json()
    renderGlobalSkills()
  } catch (err) {
    console.error('Skills betoltes hiba:', err)
    skillsGrid.innerHTML = `<div class="connector-loading">${t('skills.error')}</div>`
  }
}

function getSkillIcon(name) {
  if (name.includes('factory') || name.includes('creator')) return '\u{1F3ED}'
  if (name.includes('blog') || name.includes('post')) return '\u{1F4DD}'
  if (name.includes('image') || name.includes('thumbnail') || name.includes('fal')) return '\u{1F3A8}'
  if (name.includes('frontend') || name.includes('design')) return '\u{1F58C}\uFE0F'
  if (name.includes('youtube') || name.includes('video') || name.includes('seo')) return '\u{1F3AC}'
  if (name.includes('docx') || name.includes('doc')) return '\u{1F4C4}'
  if (name.includes('skool')) return '\u{1F393}'
  if (name.includes('skill')) return '\u{1F9E9}'
  return '\u2699\uFE0F'
}

function renderGlobalSkills() {
  skillsGrid.innerHTML = ''

  const withSkillMd = globalSkills.filter(s => s.description)
  const userCount = globalSkills.filter(s => s.source === 'user').length
  const pluginCount = globalSkills.filter(s => s.source === 'plugin').length

  skillsStats.innerHTML = `
    <div class="stat-card"><div class="stat-value">${globalSkills.length}</div><div class="stat-label">${t('skills.stat.total')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--info)">${userCount}</div><div class="stat-label">${t('skills.stat.user')}</div></div>
    ${pluginCount ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${pluginCount}</div><div class="stat-label">${t('skills.stat.plugin')}</div></div>` : ''}
    <div class="stat-card"><div class="stat-value" style="color:var(--success)">${withSkillMd.length}</div><div class="stat-label">${t('skills.stat.documented')}</div></div>
  `

  if (globalSkills.length === 0) {
    skillsEmpty.hidden = false
    return
  }
  skillsEmpty.hidden = true

  const sourceLabels = { user: 'user', plugin: 'plugin' }

  for (const skill of globalSkills) {
    const card = document.createElement('div')
    card.className = 'skills-card'
    const icon = getSkillIcon(skill.name)
    const sourceBadge = skill.source
      ? `<span class="connector-source-badge">${escapeHtml(sourceLabels[skill.source] || skill.source)}</span>`
      : ''

    const displayName = skill.label || skill.name
    card.innerHTML = `
      <div class="skills-card-header">
        <div class="skills-card-icon">${icon}</div>
        <div class="skills-card-info">
          <div class="skills-card-name">${escapeHtml(displayName)} ${sourceBadge}</div>
          <div class="skills-card-desc">${escapeHtml(skill.description || t('skills.no_description'))}</div>
        </div>
      </div>
    `
    card.addEventListener('click', () => openSkillDetail(skill.name, skill.label))
    skillsGrid.appendChild(card)
  }
}

async function openSkillDetail(skillName, displayLabel) {
  document.getElementById('skillDetailTitle').textContent = displayLabel || skillName

  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}`)
    if (!res.ok) throw new Error('Failed to fetch skill detail')
    const detail = await res.json()

    // Description
    const descEl = document.getElementById('skillDetailDesc')
    descEl.textContent = detail.description || t('skills.no_description')

    // Meta line: source + path. Replaces the old per-agent assignment
    // UI -- sub-agents share the caller's HOME, so the skill is already
    // available to every agent without any copy-to-agent action.
    const metaEl = document.getElementById('skillDetailMeta')
    if (metaEl) {
      const sourceLabel = detail.source === 'plugin'
        ? `plugin${detail.pluginPackage ? ' (' + escapeHtml(detail.pluginPackage) + ')' : ''}`
        : detail.source === 'user'
        ? t('skills.source.user')
        : t('skills.source.unknown')
      metaEl.innerHTML = `
        <div class="skill-detail-source">${t('skills.detail.source_label')} <strong>${sourceLabel}</strong></div>
        <div class="skill-detail-note">${t('skills.detail.auto_available')}</div>
      `
    }

    // Content
    const contentEl = document.getElementById('skillDetailContent')
    contentEl.textContent = detail.content || t('skills.content_not_found')

  } catch (err) {
    console.error('Skill detail hiba:', err)
    document.getElementById('skillDetailDesc').textContent = t('connectors.error_list')
    document.getElementById('skillDetailContent').textContent = ''
    const metaEl = document.getElementById('skillDetailMeta')
    if (metaEl) metaEl.innerHTML = ''
  }

  openModal(skillDetailOverlay)
}

// === Team page ===
async function loadTeamGraph() {
  const container = document.getElementById('teamGraph')
  if (!container) return
  container.innerHTML = '<div class="team-empty">' + t('team.loading') + '</div>'
  try {
    const res = await fetch('/api/team/graph')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    renderTeamGraph(container, data)
  } catch (err) {
    container.innerHTML = `<div class="team-empty">${t('team.error', { msg: err.message || err })}</div>`
  }
}

function renderTeamGraph(container, data) {
  const { nodes, edges, mainAgentId } = data
  container.innerHTML = ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map()
  for (const n of nodes) childrenOf.set(n.id, [])
  for (const e of edges) {
    if (childrenOf.has(e.from)) childrenOf.get(e.from).push(e.to)
  }
  const renderNode = (node) => {
    const div = document.createElement('div')
    div.className = 'team-node'
    if (node.role === 'main') div.classList.add('main')
    else if (node.role === 'leader') div.classList.add('leader')
    const roleLabel = node.role === 'main' ? t('team.role.main') : (node.role === 'leader' ? t('team.role.leader') : t('team.role.member'))
    const running = node.running ? t('team.running') : t('team.stopped')
    const avatarUrl = node.id === mainAgentId
      ? `/api/marveen/avatar?t=${Date.now()}`
      : `/api/agents/${encodeURIComponent(node.id)}/avatar?t=${Date.now()}`
    div.innerHTML = `
      <div class="team-node-avatar"><img src="${avatarUrl}" alt="${escapeHtml(node.label || node.id)}" onerror="this.style.display='none'"></div>
      <div class="team-node-name">${escapeHtml(node.label || node.id)}</div>
      <div class="team-node-meta">${escapeHtml(roleLabel)}</div>
      <div class="team-node-meta">${running}</div>
    `
    if (node.id !== mainAgentId) {
      div.addEventListener('click', () => openAgentDetail(node.id))
    }
    return div
  }
  // Render as a nested tree so each report sits directly under its own
  // manager. A flat BFS-by-row layout made a leader's reports look like they
  // belonged to whichever node happened to be above them in the row.
  const seen = new Set([mainAgentId])
  const renderSubtree = (id) => {
    const node = byId.get(id)
    if (!node) return null
    const col = document.createElement('div')
    col.className = 'team-subtree'
    col.appendChild(renderNode(node))
    const kids = (childrenOf.get(id) || []).filter(c => !seen.has(c) && byId.has(c))
    for (const c of kids) seen.add(c)
    if (kids.length) {
      const conn = document.createElement('div')
      conn.className = 'team-connector'
      col.appendChild(conn)
      const row = document.createElement('div')
      row.className = 'team-children'
      for (const c of kids) {
        const sub = renderSubtree(c)
        if (sub) row.appendChild(sub)
      }
      col.appendChild(row)
    }
    return col
  }
  // Main on top, then a row of its direct reports (each carrying its own
  // subtree beneath it).
  const mainNode = byId.get(mainAgentId)
  if (mainNode) {
    const mainRow = document.createElement('div')
    mainRow.className = 'team-level'
    mainRow.appendChild(renderNode(mainNode))
    container.appendChild(mainRow)
  }
  const directs = (childrenOf.get(mainAgentId) || []).filter(c => !seen.has(c) && byId.has(c))
  for (const c of directs) seen.add(c)
  if (directs.length) {
    const conn = document.createElement('div')
    conn.className = 'team-connector'
    container.appendChild(conn)
    const row = document.createElement('div')
    row.className = 'team-children team-roots'
    for (const c of directs) {
      const sub = renderSubtree(c)
      if (sub) row.appendChild(sub)
    }
    container.appendChild(row)
  }
  // Orphans (nodes not reachable from main, shouldn't happen with the auto
  // fallback on the backend but guard just in case) go to a trailing row.
  const orphans = nodes.filter(n => !seen.has(n.id))
  if (orphans.length) {
    const row = document.createElement('div')
    row.className = 'team-level'
    for (const n of orphans) row.appendChild(renderNode(n))
    container.appendChild(row)
  }
  if (nodes.length === 1) {
    const empty = document.createElement('div')
    empty.className = 'team-empty'
    empty.textContent = t('team.empty')
    container.appendChild(empty)
  }
}

const refreshTeamBtn = document.getElementById('refreshTeamBtn')
if (refreshTeamBtn) refreshTeamBtn.addEventListener('click', loadTeamGraph)

// === Team: inter-agent message log + compose ===
// View the /api/messages queue and let the operator send a message to an agent
// from the dashboard. Targets come from /api/schedules/agents (the same allowed
// agent list the scheduler uses) -- never a free-text target. The sender is the
// owner (resolved by type from /api/kanban/assignees), so the receiving agent
// sees a message from Gábor, not a spoofable string. /api/messages sits behind
// the dashboard bearer token + Cloudflare Access.
const MSG_STATUS_META = {
  pending: { label: () => t('messages.status.pending'), cls: 'badge-warm' },
  delivered: { label: () => t('messages.status.delivered'), cls: 'badge-active' },
  done: { label: () => t('messages.status.done'), cls: 'badge-active' },
  failed: { label: () => t('messages.status.failed'), cls: 'badge-paused' },
}
async function resolveOwnerName() {
  try {
    const res = await fetch('/api/kanban/assignees')
    if (res.ok) {
      const list = await res.json()
      const owner = Array.isArray(list) ? list.find(a => a.type === 'owner') : null
      if (owner && owner.name) return owner.name
    }
  } catch { /* fall through */ }
  return 'owner'
}

// === Messages page ===
// chatAgentHasAvatar: populated from /api/agents during loadChatAgentList
const chatAgentHasAvatar = new Map() // name -> true|false
let chatSelectedAgent = null

function chatMonogramEl(agentName, size) {
  const letter = agentName.charAt(0).toUpperCase()
  const colors = ['#d97757','#00C2A8','#818cf8','#22c55e','#f59e0b','#ec4899']
  const color = colors[agentName.split('').reduce((a,c)=>a+c.charCodeAt(0),0) % colors.length]
  return `<div class="chat-avatar chat-avatar-mono" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size*0.4)}px">${letter}</div>`
}

// Global onerror handler — avoids HTML-in-attribute escaping issues
window.chatImgError = function(img) {
  const name = img.getAttribute('data-agent-name') || img.alt || '?'
  const size = parseInt(img.width) || 32
  const letter = name.charAt(0).toUpperCase()
  const colors = ['#d97757','#00C2A8','#818cf8','#22c55e','#f59e0b','#ec4899']
  const color = colors[name.split('').reduce((a,c)=>a+c.charCodeAt(0),0) % colors.length]
  const div = document.createElement('div')
  div.className = 'chat-avatar chat-avatar-mono'
  div.style.cssText = `width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size*0.4)}px`
  div.textContent = letter
  img.replaceWith(div)
}

function chatAvatarHtml(agentName, size = 32) {
  const lower = agentName.toLowerCase()
  const hasAvatar = chatAgentHasAvatar.get(lower)
  if (!hasAvatar) return chatMonogramEl(agentName, size)
  const src = lower === mainAgentId().toLowerCase()
    ? `/api/marveen/avatar?t=${Date.now()}`
    : `/api/agents/${encodeURIComponent(lower)}/avatar?t=${Date.now()}`
  return `<img class="chat-avatar" src="${src}" width="${size}" height="${size}" alt="${escapeHtml(agentName)}" data-agent-name="${escapeHtml(agentName)}" onerror="chatImgError(this)">`
}

async function loadMessagesPage() {
  await loadChatAgentList()
}

const CHAT_SYSTEM_AGENTS = new Set(['heartbeat','telegram-coordinator','channel-coordinator'])
// The owner's own message thread is pinned to the top and labelled "<name> (te)".
// The owner display name comes from the backend (OWNER_NAME via /api/marveen ->
// window._marveen.ownerName), not a hardcoded literal, so a renamed install
// recognizes its real owner. Empty until _marveen resolves (no false match).
function chatOwnerName() { return window._marveen?.ownerName || '' }

function chatLastSeenKey(agentName) { return 'chat_last_seen_' + agentName }
function chatGetLastSeen(agentName) { return parseInt(localStorage.getItem(chatLastSeenKey(agentName)) || '0', 10) }
function chatMarkSeen(agentName, maxId) {
  if (maxId > chatGetLastSeen(agentName)) localStorage.setItem(chatLastSeenKey(agentName), String(maxId))
}
function chatIsUnread(agentName, threadInfo) {
  const owner = chatOwnerName()
  if (!owner || agentName !== owner) return false
  if (!threadInfo?.lastMsg) return false
  return threadInfo.lastMsg.id > chatGetLastSeen(agentName)
}

async function loadChatAgentList() {
  const sidebar = document.getElementById('chatAgentList')
  if (!sidebar) return
  try {
    // Load fleet agents + threads in parallel
    const [agentsRes, threadsRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/messages/threads'),
    ])
    const agentsRaw = agentsRes.ok ? await agentsRes.json() : []
    const threads = threadsRes.ok ? await threadsRes.json() : []

    // Build fleet list: API agents + marveen, minus system agents
    const fleetNames = [mainAgentId(), ...agentsRaw.map(a => a.name || a)]
      .filter(n => !CHAT_SYSTEM_AGENTS.has(n))
      .filter((n, i, arr) => arr.indexOf(n) === i)

    // Populate avatar map from API data
    chatAgentHasAvatar.clear()
    chatAgentHasAvatar.set(mainAgentId(), true)
    for (const a of agentsRaw) {
      if (a.name) chatAgentHasAvatar.set(a.name, !!a.hasAvatar)
    }

    // Build index from /api/messages/threads (per-agent, no global-window bug)
    const threadIndex = new Map() // agentName -> {lastMessage, count}
    for (const t of threads) {
      if (t.agent) threadIndex.set(t.agent, { lastMsg: t.lastMessage, count: t.count || 0 })
    }
    // Also include thread agents not in fleet (e.g. the owner's own direct msgs)
    for (const t of threads) {
      if (t.agent && !fleetNames.includes(t.agent) && !CHAT_SYSTEM_AGENTS.has(t.agent)) {
        fleetNames.push(t.agent)
      }
    }

    // Sort: owner pinned first, then agents with messages by recency, rest alphabetical
    const owner = chatOwnerName()
    const sorted = [...fleetNames].sort((a, b) => {
      if (owner && a === owner) return -1
      if (owner && b === owner) return 1
      const aHas = threadIndex.has(a), bHas = threadIndex.has(b)
      if (aHas && !bHas) return -1
      if (!aHas && bHas) return 1
      if (aHas && bHas) {
        const aTime = threadIndex.get(a).lastMsg?.created_at || 0
        const bTime = threadIndex.get(b).lastMsg?.created_at || 0
        return bTime - aTime
      }
      return a.localeCompare(b)
    })

    sidebar.innerHTML = sorted.map(name => {
      const info = threadIndex.get(name)
      const lm = info?.lastMsg
      const when = lm?.created_at ? new Date(lm.created_at * 1000).toLocaleTimeString('hu-HU', {hour:'2-digit',minute:'2-digit'}) : ''
      const preview = lm ? (lm.content || '').replace(/\n/g,' ').slice(0, 60) : t('messages.empty')
      const isSelected = name === chatSelectedAgent ? ' selected' : ''
      const dimmed = info ? '' : ' style="opacity:0.5"'
      const unread = chatIsUnread(name, info)
      const displayName = owner && name === owner ? owner + ' (te)' : name
      return `<div class="chat-agent-item${isSelected}${unread ? ' unread' : ''}" data-agent="${escapeHtml(name)}"${dimmed}>
        <div class="chat-agent-avatar">${chatAvatarHtml(name, 40)}</div>
        <div class="chat-agent-info">
          <div class="chat-agent-name">${escapeHtml(displayName)}${unread ? '<span class="chat-unread-dot"></span>' : ''}</div>
          <div class="chat-agent-preview ${unread ? 'unread-preview' : ''}">${escapeHtml(preview)}</div>
        </div>
        <div class="chat-agent-time">${when}</div>
      </div>`
    }).join('')

    sidebar.querySelectorAll('.chat-agent-item').forEach(el => {
      el.addEventListener('click', () => {
        sidebar.querySelectorAll('.chat-agent-item').forEach(x => x.classList.remove('selected'))
        el.classList.add('selected')
        chatSelectedAgent = el.dataset.agent
        loadChatThread(chatSelectedAgent)
      })
    })

    if (!chatSelectedAgent) {
      const first = sidebar.querySelector('.chat-agent-item')
      if (first) first.click()
    }
  } catch (e) {
    sidebar.innerHTML = `<div class="chat-sidebar-empty">${t('messages.sidebar_error', { msg: escapeHtml(String(e.message||e)) })}</div>`
  }
}

// Pagination state for the open thread
const chatThreadState = { agent: null, minLoadedId: null, hasMore: true, loading: false }
const CHAT_PAGE_SIZE = 10
const CHAT_LOAD_MORE = 20

async function loadChatThread(agentName) {
  const panel = document.getElementById('chatThreadPanel')
  if (!panel) return

  chatThreadState.agent = agentName
  chatThreadState.minLoadedId = null
  chatThreadState.hasMore = true
  chatThreadState.loading = false

  const owner = chatOwnerName()
  const threadDisplayName = owner && agentName === owner ? owner + ' (te)' : agentName

  panel.innerHTML = `
    <div class="chat-thread-header">
      ${chatAvatarHtml(agentName, 32)}
      <span class="chat-thread-title">${escapeHtml(threadDisplayName)}</span>
      <button class="btn-secondary btn-compact" style="margin-left:auto" onclick="loadChatThread('${escapeHtml(agentName)}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
    </div>
    <div class="chat-bubbles" id="chatBubbles"><div class="chat-loading-indicator" id="chatLoadingTop" style="display:none;text-align:center;padding:8px;font-size:11px;color:var(--text-muted)">${t('messages.loading')}</div></div>
    <div class="chat-compose">
      <div class="chat-compose-row">
        <textarea id="chatComposeText" class="chat-compose-input" rows="2" placeholder="${t('messages.placeholder', { agent: escapeHtml(agentName) })}"></textarea>
        <button class="btn-primary btn-compact chat-send-btn" id="chatSendBtn">${t('messages.send_btn')}</button>
      </div>
    </div>
  `

  document.getElementById('chatSendBtn')?.addEventListener('click', () => sendChatMessage(agentName))
  document.getElementById('chatComposeText')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChatMessage(agentName) }
  })

  // Initial load
  await fetchChatPage(agentName, null, CHAT_PAGE_SIZE, 'replace')
  // Mark thread as read (localStorage last-seen)
  const threadData = (await fetch('/api/messages/threads').then(r => r.ok ? r.json() : []).catch(() => []))
    .find(t => t.agent === agentName)
  if (threadData?.lastMessage?.id) {
    chatMarkSeen(agentName, threadData.lastMessage.id)
    // Remove unread indicator from sidebar item
    document.querySelector(`.chat-agent-item[data-agent="${CSS.escape(agentName)}"]`)?.classList.remove('unread')
    const dot = document.querySelector(`.chat-agent-item[data-agent="${CSS.escape(agentName)}"] .chat-unread-dot`)
    if (dot) dot.remove()
    const preview = document.querySelector(`.chat-agent-item[data-agent="${CSS.escape(agentName)}"] .unread-preview`)
    if (preview) preview.classList.remove('unread-preview')
  }

  // Scroll-up pagination handler
  const bubbles = document.getElementById('chatBubbles')
  if (bubbles) {
    bubbles.addEventListener('scroll', () => {
      if (bubbles.scrollTop < 80 && chatThreadState.hasMore && !chatThreadState.loading
          && chatThreadState.agent === agentName) {
        fetchChatPage(agentName, chatThreadState.minLoadedId, CHAT_LOAD_MORE, 'prepend')
      }
    })
  }
}

function buildBubbleHtml(m) {
  const isOutgoing = m.from_agent === mainAgentId()
  const senderName = isOutgoing ? mainAgentId() : m.from_agent
  const when = m.created_at ? new Date(m.created_at * 1000).toLocaleString('hu-HU', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
  const statusMetaRaw = MSG_STATUS_META[m.status] || { label: m.status || '', cls: 'badge' }
  const statusMeta = { ...statusMetaRaw, label: typeof statusMetaRaw.label === 'function' ? statusMetaRaw.label() : statusMetaRaw.label }
  return `<div class="chat-bubble-row ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${m.id}">
    ${!isOutgoing ? `<div class="chat-bubble-avatar">${chatAvatarHtml(senderName, 28)}</div>` : ''}
    <div class="chat-bubble ${isOutgoing ? 'bubble-out' : 'bubble-in'}">
      <div class="bubble-meta">
        ${!isOutgoing ? `<span class="bubble-sender">${escapeHtml(senderName)}</span>` : ''}
        <span class="bubble-id-chip">#${m.id}</span>
        <span class="badge ${statusMeta.cls}" style="font-size:10px">${escapeHtml(statusMeta.label)}</span>
      </div>
      <div class="bubble-text">${escapeHtml(m.content || '')}</div>
      <div class="bubble-time">${when}</div>
    </div>
    ${isOutgoing ? `<div class="chat-bubble-avatar">${chatAvatarHtml(mainAgentId(), 28)}</div>` : ''}
  </div>`
}

async function fetchChatPage(agentName, beforeId, limit, mode) {
  if (chatThreadState.loading) return
  chatThreadState.loading = true
  const container = document.getElementById('chatBubbles')
  const loadingIndicator = document.getElementById('chatLoadingTop')
  if (!container) { chatThreadState.loading = false; return }
  if (loadingIndicator && mode === 'prepend') loadingIndicator.style.display = 'block'
  try {
    let url = `/api/messages?agent=${encodeURIComponent(agentName)}&limit=${limit}`
    if (beforeId) url += `&before=${beforeId}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const msgs = await res.json()
    const sorted = Array.isArray(msgs) ? [...msgs].sort((a, b) => (a.created_at || 0) - (b.created_at || 0)) : []

    if (mode === 'replace') {
      if (sorted.length === 0) {
        container.innerHTML = '<p class="activity-empty">' + t('messages.empty_thread') + '</p>'
      } else {
        container.innerHTML = '<div class="chat-loading-indicator" id="chatLoadingTop" style="display:none;text-align:center;padding:8px;font-size:11px;color:var(--text-muted)">' + t('messages.loading') + '</div>'
        container.insertAdjacentHTML('beforeend', sorted.map(buildBubbleHtml).join(''))
        container.scrollTop = container.scrollHeight
      }
      if (sorted.length < limit) chatThreadState.hasMore = false
    } else { // prepend
      if (loadingIndicator) loadingIndicator.style.display = 'none'
      if (!sorted.length) { chatThreadState.hasMore = false; chatThreadState.loading = false; return }
      if (sorted.length < limit) chatThreadState.hasMore = false
      const prevHeight = container.scrollHeight
      const indicator = document.getElementById('chatLoadingTop')
      const html = sorted.map(buildBubbleHtml).join('')
      if (indicator) {
        indicator.insertAdjacentHTML('afterend', html)
      } else {
        container.insertAdjacentHTML('afterbegin', html)
      }
      // Restore scroll position so view doesn't jump
      container.scrollTop = container.scrollHeight - prevHeight
    }

    if (sorted.length > 0) {
      const minId = Math.min(...sorted.map(m => m.id))
      if (chatThreadState.minLoadedId === null || minId < chatThreadState.minLoadedId) {
        chatThreadState.minLoadedId = minId
      }
    }
  } catch (e) {
    if (loadingIndicator) loadingIndicator.style.display = 'none'
    if (mode === 'replace') {
      container.innerHTML = `<p class="activity-empty">Hiba: ${escapeHtml(String(e.message||e))}</p>`
    }
  } finally {
    chatThreadState.loading = false
  }
}

function renderChatBubbles(msgs, agentName) {
  const container = document.getElementById('chatBubbles')
  if (!container) return
  if (!msgs || msgs.length === 0) {
    container.innerHTML = '<p class="activity-empty">' + t('messages.empty_thread') + '</p>'
    return
  }
  const sorted = [...msgs].sort((a,b) => (a.created_at||0) - (b.created_at||0))
  container.innerHTML = sorted.map(buildBubbleHtml).join('')
  container.scrollTop = container.scrollHeight
}

async function sendChatMessage(toAgent) {
  const textarea = document.getElementById('chatComposeText')
  const btn = document.getElementById('chatSendBtn')
  const content = textarea?.value?.trim()
  if (!content) { textarea?.focus(); return }
  if (btn) btn.disabled = true
  try {
    const from = await resolveOwnerName()
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toAgent, content }),
    })
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Hiba') }
    if (textarea) textarea.value = ''
    showToast(t('messages.sent'))
    await loadChatThread(toAgent)
    await loadChatAgentList()
  } catch (e) {
    showToast(t('messages.error_send', { msg: e.message || e }))
  } finally {
    if (btn) btn.disabled = false
  }
}

document.getElementById('chatRefreshBtn')?.addEventListener('click', () => {
  loadChatAgentList()
  if (chatSelectedAgent) loadChatThread(chatSelectedAgent)
})

function renderTeamEditor(agent, allAgents) {
  const team = agent.team || { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] }
  document.getElementById('editTeamRole').value = team.role || 'member'
  const reportsSel = document.getElementById('editTeamReportsTo')
  reportsSel.innerHTML = ''
  const emptyOpt = document.createElement('option')
  emptyOpt.value = ''
  emptyOpt.textContent = t('team.reports_to_empty')
  reportsSel.appendChild(emptyOpt)
  for (const other of allAgents) {
    if (other.name === agent.name) continue
    const opt = document.createElement('option')
    opt.value = other.name
    opt.textContent = other.displayName || other.name
    if (team.reportsTo === other.name) opt.selected = true
    reportsSel.appendChild(opt)
  }
  const buildCheckboxList = (boxId, selected) => {
    const box = document.getElementById(boxId)
    box.innerHTML = ''
    for (const other of allAgents) {
      if (other.name === agent.name) continue
      const label = document.createElement('label')
      label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = other.name
      cb.checked = !!(selected && selected.includes(other.name))
      label.appendChild(cb)
      const span = document.createElement('span')
      span.textContent = other.displayName || other.name
      label.appendChild(span)
      box.appendChild(label)
    }
  }
  buildCheckboxList('editTeamDelegatesList', team.delegatesTo)
  buildCheckboxList('editTeamTrustFromList', team.trustFrom)
  document.getElementById('editTeamAutoDelegation').checked = !!team.autoDelegation
  // Only leaders make sense to delegate from -- hide the lists for members.
  const updateLeaderVisibility = () => {
    const isLeader = document.getElementById('editTeamRole').value === 'leader'
    document.getElementById('editTeamDelegatesGroup').style.display = isLeader ? '' : 'none'
    document.getElementById('editTeamAutoGroup').style.display = isLeader ? '' : 'none'
  }
  document.getElementById('editTeamRole').onchange = updateLeaderVisibility
  updateLeaderVisibility()
}

document.getElementById('saveTeamBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const btn = document.getElementById('saveTeamBtn')
  const role = document.getElementById('editTeamRole').value
  const reportsToRaw = document.getElementById('editTeamReportsTo').value
  const delegates = Array.from(document.querySelectorAll('#editTeamDelegatesList input[type=checkbox]:checked')).map(cb => cb.value)
  const trustFrom = Array.from(document.querySelectorAll('#editTeamTrustFromList input[type=checkbox]:checked')).map(cb => cb.value)
  const autoDelegation = document.getElementById('editTeamAutoDelegation').checked
  const originalText = btn.textContent
  btn.disabled = true
  btn.textContent = t('team.save_saving')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/team`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role,
        reportsTo: reportsToRaw || null,
        delegatesTo: role === 'leader' ? delegates : [],
        trustFrom,
        autoDelegation: role === 'leader' ? autoDelegation : false,
      }),
    })
    if (!res.ok) throw new Error()
    // The server sanitizes the team config (strips self-references and
    // unknown agent ids) and reports what it dropped in `warnings`. Surface
    // that to the operator so a mistyped name isn't silently lost.
    let warningMsg = ''
    try {
      const body = await res.json()
      const w = body && body.warnings
      if (w) {
        const parts = []
        if (Array.isArray(w.droppedSelf) && w.droppedSelf.length) {
          parts.push(`${t('team.dropped_self')}: ${w.droppedSelf.join(', ')}`)
        }
        if (Array.isArray(w.droppedUnknown) && w.droppedUnknown.length) {
          parts.push(`${t('team.dropped_unknown')}: ${w.droppedUnknown.join(', ')}`)
        }
        if (parts.length) warningMsg = parts.join(' · ')
      }
    } catch { /* body already consumed or not JSON -- OK, no warnings to show */ }
    showToast(warningMsg ? t('team.save_warning', { detail: warningMsg }) : t('team.save_ok'))
    btn.textContent = t('team.save_done')
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false }, 1800)
    loadAgents()
  } catch {
    showToast(t('team.save_error'))
    btn.textContent = originalText
    btn.disabled = false
  }
})

// === Overview page ===
function formatRelative(ts) {
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('common.time.now_abbr')
  if (min < 60) return t('common.time.min_abbr', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('common.time.hour_abbr', { h: hr })
  const day = Math.floor(hr / 24)
  return t('common.time.day_abbr', { n: day })
}

async function loadOverview() {
  try {
    const res = await fetch('/api/overview')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    // Stats
    document.getElementById('statAgents').textContent = d.agents.running
    document.getElementById('statAgentsSub').textContent = t('overview.stat.agents_sub', { n: d.agents.total })
    document.getElementById('statTasks').textContent = d.tasksToday
    const taskDiff = d.tasksToday - d.tasksYesterday
    document.getElementById('statTasksSub').textContent = taskDiff === 0 ? t('overview.stat.same_as_yesterday') : (taskDiff > 0 ? '+' + taskDiff + ' ' + t('overview.stat.change', { n: '' }).trim() : taskDiff + ' ' + t('overview.stat.change', { n: '' }).trim())
    document.getElementById('statMemories').textContent = d.memories.count.toLocaleString('hu-HU').replace(/,/g, ' ')
    document.getElementById('statMemoriesSub').textContent = `${t('overview.stat.sub.memories')} · ${d.memories.categories} category`
    document.getElementById('statSkills').textContent = d.skills.count
    document.getElementById('statSkillsSub').textContent = d.skills.today > 0 ? t('overview.stat.skills_today', { n: d.skills.today }) : ''
    // Team: reuse the hierarchy graph renderer so the overview card shows
    // exactly what the Csapat page does (avatars + reports-to tree).
    try {
      const tg = await fetch('/api/team/graph')
      if (tg.ok) {
        const graph = await tg.json()
        renderTeamGraph(document.getElementById('overviewTeamGrid'), graph)
      }
    } catch {}
    // Activity
    const act = document.getElementById('overviewActivity')
    act.innerHTML = ''
    if (!d.activity || d.activity.length === 0) {
      act.innerHTML = '<div style="color:var(--text-muted);font-size:13px">' + t('overview.no_activity') + '</div>'
    } else {
      for (const a of d.activity) {
        const icon = a.icon === 'delegate'
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3C7.5 3 4 6.5 4 11v4l-2 3h4v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2h4l-2-3v-4c0-4.5-3.5-8-8-8z"/></svg>'
        const item = document.createElement('div')
        item.className = 'overview-activity-item'
        item.innerHTML = `
          <div class="overview-activity-icon">${icon}</div>
          <div class="overview-activity-body">
            <div class="overview-activity-title">${escapeHtml(a.text)}</div>
            <div class="overview-activity-time">${formatRelative(a.at)}</div>
          </div>
        `
        act.appendChild(item)
      }
    }
  } catch (err) {
    document.getElementById('overviewActivity').innerHTML = '<div style="color:var(--text-muted);font-size:13px">' + t('overview.error', { msg: escapeHtml(String(err.message || err)) }) + '</div>'
  }
}

// Brand mark + product-brand chrome: pull the configured brand from
// /api/marveen and apply it to the dashboard chrome (tab title, mobile topbar,
// sidebar name, updates subtitle). brandName is the product/system name and is
// distinct from the main agent's display name; the backend defaults brandName to
// BOT_NAME, so a brand-unaware install keeps showing the agent name. If the
// field is absent (legacy backend) the existing HTML default text is kept.
async function initSidebarBrand() {
  try {
    const img = document.createElement('img')
    img.src = '/api/marveen/avatar?t=' + Date.now()
    img.onload = () => {
      const mark = document.getElementById('sidebarBrandMark')
      if (mark) { mark.textContent = ''; mark.appendChild(img) }
    }
    const res = await fetch('/api/marveen')
    if (res.ok) {
      const m = await res.json()
      const brand = m.brandName || m.name
      if (brand) {
        document.title = brand
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

// === Updates page ===
function escapeHtmlUpdates(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderUpdatesBadge(status) {
  const badge = document.getElementById('updatesBadge')
  if (!badge) return
  if (status && status.behind && status.behind > 0) {
    badge.textContent = String(status.behind)
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

async function pollUpdatesBadge() {
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) return
    renderUpdatesBadge(await res.json())
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
    renderUpdatesBadge(data)
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
      summary.innerHTML = `<strong>${t('updates.behind', { n: data.behind })}</strong> ${t('updates.available_on', { remote: `<code>${escapeHtmlUpdates(data.remote)}</code>` })}<br>${t('updates.current_label')} <code>${cur}</code> → ${t('updates.latest_label')} <code>${lat}</code>`
      applyBtn.hidden = false
    }
    if (data.commits && data.commits.length) {
      list.innerHTML = data.commits.map(c => `
        <div class="updates-commit">
          <div class="updates-commit-head">
            <span>${escapeHtmlUpdates(c.short)} · ${escapeHtmlUpdates(c.author)}</span>
            <span>${escapeHtmlUpdates((c.date || '').slice(0, 10))}</span>
          </div>
          <div class="updates-commit-msg">${escapeHtmlUpdates(c.message)}</div>
        </div>
      `).join('')
    } else if (data.behind === 0) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('updates.no_changes')}</p>`
    }
  } catch (err) {
    summary.className = 'updates-summary error'
    summary.textContent = 'Hiba: ' + (err.message || err)
    applyBtn.hidden = true
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
    showToast(t('updates.toast.started'))
    setTimeout(() => window.location.reload(), 30000)
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', {msg: err.message || err}))
  }
}

document.getElementById('updatesApplyBtn').addEventListener('click', async () => {
  if (!confirm(t('updates.confirm.apply'))) return
  await runUpdate(false)
})

// Poll the badge on startup and every 5 min so the nav link reflects
// the cached status even on tabs other than the Updates page.
pollUpdatesBadge()
setInterval(pollUpdatesBadge, 5 * 60_000)

// === Init ===
populateAvatarGrid()
loadMemAgents()
loadOverview()
loadAvailableModels()

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
// === Recall / Napló ===
// ============================================================

let recallInitialized = false
let recallSortDesc = true

async function loadRecallPage() {
  if (!recallInitialized) {
    recallInitialized = true
    const today = new Date().toISOString().split('T')[0]
    document.getElementById('recallDate').value = today

    try {
      // /api/schedules/agents includes the main agent (jarvis); /api/agents lists sub-agents only
      const res = await fetch('/api/schedules/agents')
      if (res.ok) {
        const agents = await res.json()
        const sel = document.getElementById('recallAgent')
        agents.forEach(a => {
          const opt = document.createElement('option')
          opt.value = a.name
          opt.textContent = a.label || a.name
          sel.appendChild(opt)
        })
      }
    } catch {}

    document.getElementById('recallBtn').addEventListener('click', doRecall)
    document.getElementById('recallExpr').addEventListener('keydown', e => { if (e.key === 'Enter') doRecall() })
    document.getElementById('recallSearch').addEventListener('keydown', e => { if (e.key === 'Enter') doRecall() })
    // Re-fetch per-agent log dates when the agent filter changes; without this
    // the date hint stayed stuck on the agent active at first page load.
    document.getElementById('recallAgent').addEventListener('change', loadRecallDates)
    // #53: sort order toggle
    document.getElementById('recallSortToggle').addEventListener('click', () => {
      recallSortDesc = !recallSortDesc
      const btn = document.getElementById('recallSortToggle')
      btn.textContent = recallSortDesc ? '↓' : '↑'
      btn.title = recallSortDesc ? t('recall.sort.tooltip.desc') : t('recall.sort.tooltip.asc')
      doRecall()
    })

    loadRecallDates()
  }
  doRecall()
}

async function loadRecallDates() {
  try {
    const agentVal = document.getElementById('recallAgent').value
    const params = agentVal ? `?agent=${encodeURIComponent(agentVal)}&limit=90` : '?limit=90'
    const res = await fetch('/api/recall/dates' + params)
    if (!res.ok) return
    const dates = await res.json()
    const dateInput = document.getElementById('recallDate')
    if (dates.length && !dateInput.value) {
      dateInput.value = dates[0]
    }
    dateInput.setAttribute('title', t('recall.date.n_days', { n: dates.length }))
  } catch {}
}

async function doRecall() {
  const dateInput = document.getElementById('recallDate').value
  const exprInput = document.getElementById('recallExpr').value.trim()
  const searchInput = document.getElementById('recallSearch').value.trim()
  const agentInput = document.getElementById('recallAgent').value

  const params = new URLSearchParams()
  if (exprInput) {
    params.set('date', exprInput)
  } else if (dateInput) {
    params.set('date', dateInput)
  }
  if (searchInput) params.set('q', searchInput)
  if (agentInput) params.set('agent', agentInput)

  const timeline = document.getElementById('recallTimeline')
  const summary = document.getElementById('recallSummary')
  timeline.innerHTML = `<p class="recall-loading">${t('recall.loading')}</p>`
  summary.innerHTML = ''

  try {
    const res = await fetch('/api/recall?' + params.toString())
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      timeline.innerHTML = `<p class="recall-error">${esc(err.error || t('recall.error'))}</p>`
      return
    }
    const data = await res.json()
    renderRecallSummary(summary, data)
    renderRecallTimeline(timeline, data)
  } catch (err) {
    timeline.innerHTML = `<p style="color:var(--danger)">${t('recall.load_error')}</p>`
  }
}

function renderRecallSummary(el, data) {
  const { dateRange, summary: s } = data
  const parts = []
  if (dateRange.from === dateRange.to) {
    parts.push(`<strong>${esc(dateRange.from)}</strong>`)
  } else if (dateRange.from && dateRange.to) {
    parts.push(`<strong>${esc(dateRange.from)}</strong> &ndash; <strong>${esc(dateRange.to)}</strong>`)
  }
  parts.push(t('recall.summary.log_count', { n: s.logCount }))
  parts.push(t('recall.summary.memory_count', { n: s.memoryCount }))
  if (s.agents.length) parts.push(`${t('recall.summary.agents')}: ${s.agents.map(esc).join(', ')}`)
  el.innerHTML = `<div class="recall-summary-row">${parts.map(p => `<span>${p}</span>`).join('')}</div>`
}

function renderRecallTimeline(el, data) {
  const { logs, memories } = data
  if (!logs.length && !memories.length) {
    el.innerHTML = `<p class="recall-empty">${t('recall.empty_period')}</p>`
    return
  }

  const items = []
  logs.forEach(l => items.push({ type: 'log', ts: l.created_at, agent: l.agent_id, date: l.date, content: l.content, label: l.created_label }))
  memories.forEach(m => items.push({ type: 'memory', ts: m.created_at, agent: m.agent_id, category: m.category, content: m.content, keywords: m.keywords, label: m.created_label }))
  // #52/#53: apply sort order (desc = newest first, default)
  items.sort((a, b) => recallSortDesc ? b.ts - a.ts : a.ts - b.ts)

  let currentDate = ''
  let html = ''
  for (const item of items) {
    const dateStr = item.date || new Date(item.ts * 1000).toISOString().split('T')[0]
    if (dateStr !== currentDate) {
      currentDate = dateStr
      html += `<div class="recall-date-header">${esc(dateStr)}</div>`
    }
    if (item.type === 'log') {
      html += `<div class="recall-item recall-log">
        <div class="recall-item-header">
          <span class="recall-item-label">${esc(item.label)}</span>
          <div class="recall-item-badges">
            <span class="recall-badge recall-badge-agent">${esc(item.agent)}</span>
          </div>
        </div>
        <div class="recall-item-content">${esc(item.content)}</div>
      </div>`
    } else {
      const cat = item.category || 'warm'
      html += `<div class="recall-item recall-memory" data-cat="${esc(cat)}">
        <div class="recall-item-header">
          <span class="recall-item-label">${esc(item.label)}</span>
          <div class="recall-item-badges">
            <span class="recall-badge recall-badge-cat" data-cat="${esc(cat)}">${esc(item.category)}</span>
            <span class="recall-badge recall-badge-agent">${esc(item.agent)}</span>
          </div>
        </div>
        <div class="recall-item-content">${esc(item.content)}</div>
        ${item.keywords ? `<div class="recall-item-keywords">Kulcsszavak: ${esc(item.keywords)}</div>` : ''}
      </div>`
    }
  }
  el.innerHTML = html
}

function esc(s) {
  if (!s) return ''
  const d = document.createElement('div')
  d.textContent = String(s)
  return d.innerHTML
}

// ============================================================
// === Background Tasks ===
// ============================================================

let bgInitialized = false
let bgRefreshTimer = null

async function loadBgTasksPage() {
  if (!bgInitialized) {
    bgInitialized = true
    try {
      // Use /api/schedules/agents (not /api/agents) so the main agent is a
      // selectable background-task target too -- /api/agents lists sub-agents
      // only, while the backend (spawnBackgroundTask) accepts any agent_id.
      const res = await fetch('/api/schedules/agents')
      if (res.ok) {
        const agents = await res.json()
        const sel = document.getElementById('bgAgent')
        agents.forEach(a => {
          const opt = document.createElement('option')
          opt.value = a.name
          opt.textContent = a.label || a.name
          sel.appendChild(opt)
        })
        if (agents.length === 1) sel.value = agents[0].name
      }
    } catch {}

    document.getElementById('bgStartBtn').addEventListener('click', startBgTask)
    document.getElementById('bgPrompt').addEventListener('keydown', e => { if (e.key === 'Enter') startBgTask() })
    document.getElementById('bgShowAll').addEventListener('change', loadBgTasks)
  }
  loadBgTasks()
  if (bgRefreshTimer) clearInterval(bgRefreshTimer)
  bgRefreshTimer = setInterval(loadBgTasks, 10000)
}

async function startBgTask() {
  const agent = document.getElementById('bgAgent').value
  const prompt = document.getElementById('bgPrompt').value.trim()
  if (!agent) { showToast(t('bgTasks.select_agent')); return }
  if (!prompt) { showToast(t('bgTasks.enter_task')); return }

  const btn = document.getElementById('bgStartBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/background-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent, prompt }),
    })
    const data = await res.json()
    if (!res.ok) {
      showToast(data.error || t('common.error'))
      return
    }
    document.getElementById('bgPrompt').value = ''
    showToast(t('bgTasks.toast.started'))
    loadBgTasks()
  } catch {
    showToast(t('bgTasks.toast.start_error'))
  } finally {
    btn.disabled = false
  }
}

async function loadBgTasks() {
  const list = document.getElementById('bgTasksList')
  const showAll = document.getElementById('bgShowAll').checked
  const agentVal = document.getElementById('bgAgent')?.value || ''

  try {
    const params = new URLSearchParams()
    if (agentVal) params.set('agent', agentVal)
    if (showAll) params.set('all', 'true')
    const res = await fetch('/api/background-tasks?' + params.toString())
    if (!res.ok) { list.innerHTML = `<p style="color:var(--danger)">${t('bgTasks.error')}</p>`; return }
    const tasks = await res.json()

    if (!tasks.length) {
      list.innerHTML = `<p style="color:var(--text-muted)">${t('bgTasks.empty')}</p>`
      return
    }

    list.innerHTML = tasks.map(t => {
      const statusColors = { running: '#f59e0b', done: '#22c55e', failed: '#ef4444', timeout: '#6b7280' }
      const statusLabels = { running: () => t('bgTasks.status.running'), done: () => t('bgTasks.status.done'), failed: () => t('bgTasks.status.failed'), timeout: () => t('bgTasks.status.timeout') }
      const color = statusColors[t.status] || '#6b7280'
      const labelRaw = statusLabels[t.status]; const label = labelRaw ? (typeof labelRaw === 'function' ? labelRaw() : labelRaw) : t.status
      const output = t.output ? `<pre style="margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;">${esc(t.output.slice(-2000))}</pre>` : ''
      return `<div style="margin-bottom:12px;padding:12px 16px;border-radius:8px;background:var(--surface);border:1px solid var(--border);border-left:3px solid ${color};">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-weight:600;font-size:13px;">${esc(t.id)}</span>
            <span class="badge" style="font-size:11px;background:${color};color:#fff;padding:2px 8px;border-radius:12px;">${label}</span>
            <span class="badge" style="font-size:11px;background:var(--primary);color:#fff;padding:2px 8px;border-radius:12px;">${esc(t.agent_id)}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-size:12px;color:var(--text-muted)">${esc(t.started_label)}</span>
            ${t.status === 'running' ? `<button class="btn btn-sm" onclick="viewBgTask('${esc(t.id)}')" style="font-size:11px;padding:2px 8px;">${t('bgTasks.output_btn')}</button><button class="btn btn-sm" onclick="cancelBgTask('${esc(t.id)}')" style="font-size:11px;padding:2px 8px;color:var(--danger)">${t('bgTasks.stop_btn')}</button>` : ''}
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-primary);margin-bottom:4px;">${esc(t.prompt)}</div>
        ${t.finished_label ? `<div style="font-size:12px;color:var(--text-muted);">${t('bgTasks.finished_label')} ${esc(t.finished_label)}</div>` : ''}
        ${output}
      </div>`
    }).join('')
  } catch {
    list.innerHTML = `<p style="color:var(--danger)">${t('bgTasks.load_error')}</p>`
  }
}

async function viewBgTask(id) {
  try {
    const res = await fetch(`/api/background-tasks/${id}`)
    if (!res.ok) { showToast(t('bgTasks.load_error')); return }
    const task = await res.json()
    const output = task.liveOutput || task.output || t('bgTasks.no_output')
    const modal = document.createElement('div')
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;'
    modal.innerHTML = `<div style="background:var(--surface);border-radius:12px;padding:20px;max-width:800px;width:90%;max-height:80vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <h3 style="margin:0;">${t('bgTasks.modal.title', { id: esc(id) })}</h3>
        <button class="btn btn-sm" id="bgModalClose" style="font-size:13px;">${t('bgTasks.modal.close_btn')}</button>
      </div>
      <pre style="white-space:pre-wrap;font-size:12px;line-height:1.4;">${esc(output)}</pre>
    </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove() })
    document.getElementById('bgModalClose').addEventListener('click', () => modal.remove())
  } catch {
    showToast('Hiba')
  }
}

async function cancelBgTask(id) {
  if (!confirm(t('bgTasks.cancel.confirm'))) return
  try {
    const res = await fetch(`/api/background-tasks/${id}`, { method: 'DELETE' })
    if (res.ok) {
      showToast(t('bgTasks.toast.stopped'))
      loadBgTasks()
    } else {
      showToast(t('bgTasks.toast.stop_error'))
    }
  } catch {
    showToast('Hiba')
  }
}

// ============================================================
// === Autonomy ===
// ============================================================

document.getElementById('refreshAutonomyBtn').addEventListener('click', loadAutonomy)

async function loadAutonomy() {
  const grid = document.getElementById('autonomyGrid')
  const footer = document.getElementById('autonomyUpdatedAt')
  grid.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('autonomy.loading')}</p>`

  try {
    const res = await fetch('/api/autonomy')
    if (!res.ok) throw new Error('fetch failed')
    const config = await res.json()

    grid.innerHTML = ''
    for (const cat of config.categories) {
      const isCapped = !cat.locked && cat.maxLevel < 3
      const row = document.createElement('div')
      row.className = 'autonomy-row' + (cat.locked ? ' locked' : '') + (isCapped ? ' capped' : '')

      const label = document.createElement('div')
      label.className = 'autonomy-row-label'
      label.textContent = cat.label

      const levels = document.createElement('div')
      levels.className = 'autonomy-levels'

      for (let l = 1; l <= 3; l++) {
        const btn = document.createElement('button')
        const isOver = l > cat.maxLevel
        btn.className = 'autonomy-level-btn' + (l === cat.level ? ' active' : '') + (isOver ? ' over-cap' : '')
        btn.dataset.level = String(l)
        btn.textContent = String(l)
        btn.disabled = cat.locked || isOver
        if (!cat.locked && !isOver) {
          btn.addEventListener('click', () => setAutonomyLevel(cat.key, l))
        }
        levels.appendChild(btn)
      }

      row.appendChild(label)
      if (cat.locked) {
        const lock = document.createElement('div')
        lock.className = 'autonomy-row-lock'
        lock.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ${t('autonomy.lock_label')}`
        row.appendChild(lock)
      } else if (isCapped) {
        const cap = document.createElement('div')
        cap.className = 'autonomy-row-cap'
        cap.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> ${t('autonomy.cap_label', { n: cat.maxLevel })}`
        row.appendChild(cap)
      }
      row.appendChild(levels)
      grid.appendChild(row)
    }

    if (config.updated_at > 0) {
      const d = new Date(config.updated_at * 1000)
      footer.textContent = t('autonomy.last_modified', { date: d.toLocaleString('hu-HU') })
    } else {
      footer.textContent = t('autonomy.not_modified')
    }
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--danger)">${t('autonomy.error')}</p>`
    footer.textContent = ''
  }
}

async function setAutonomyLevel(key, level) {
  try {
    const res = await fetch('/api/autonomy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, level }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || 'Hiba')
      return
    }
    loadAutonomy()
  } catch {
    showToast(t('kanban.toast.save_error'))
  }
}

// ============================================================
// === Settings (central config registry) ===
// ============================================================

document.getElementById('refreshSettingsBtn').addEventListener('click', loadSettings)
window.addEventListener('beforeunload', (e) => {
  if (settingsDirty.size > 0) { e.preventDefault(); e.returnValue = '' }
})

// Human label for a registry "module" -- falls back to a capitalised key for
// any future module the UI doesn't know about yet, so adding a registry
// entry never requires a frontend change just to render a sane heading.
function settingsModuleLabel(mod) {
  const key = `settings.module.${mod}`
  const known = { kanban: true, system: true, heartbeat: true, audit: true, ideabox: true }
  return known[mod] ? t(key) : (mod.charAt(0).toUpperCase() + mod.slice(1))
}

// Track dirty state: key -> { input, originalValue, type, errorEl }
const settingsDirty = new Map()

function updateSettingsSaveBar() {
  const bar = document.getElementById('settingsSaveBar')
  const countEl = document.getElementById('settingsDirtyCount')
  if (!bar) return
  const n = settingsDirty.size
  bar.style.display = n > 0 ? 'flex' : 'none'
  if (countEl) countEl.textContent = t('settings.dirty_count', {n})
}

function markSettingDirty(key, input, originalValue, type, errorEl) {
  const currentVal = type === 'color' ? input.value : input.value
  if (currentVal === String(originalValue)) {
    settingsDirty.delete(key)
  } else {
    settingsDirty.set(key, { input, originalValue, type, errorEl })
  }
  updateSettingsSaveBar()
}

async function loadSettings() {
  const container = document.getElementById('settingsGroups')
  container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('settings.loading')}</p>`
  settingsDirty.clear()
  updateSettingsSaveBar()

  try {
    const res = await fetch('/api/settings')
    if (!res.ok) throw new Error('fetch failed')
    const { settings } = await res.json()

    const byModule = new Map()
    for (const s of settings) {
      if (!byModule.has(s.module)) byModule.set(s.module, [])
      byModule.get(s.module).push(s)
    }

    container.innerHTML = ''
    if (byModule.size === 0) {
      container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('settings.empty')}</p>`
      return
    }

    for (const [mod, defs] of byModule) {
      const group = document.createElement('div')
      group.className = 'settings-group'

      const heading = document.createElement('h3')
      heading.className = 'settings-group-title'
      heading.textContent = settingsModuleLabel(mod)
      group.appendChild(heading)

      for (const def of defs) {
        group.appendChild(buildSettingRow(def))
      }
      container.appendChild(group)
    }
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">${t('settings.error')}</p>`
  }
}

function buildSettingRow(def) {
  const row = document.createElement('div')
  row.className = 'settings-row'

  const info = document.createElement('div')
  info.className = 'settings-row-info'

  const title = document.createElement('div')
  title.className = 'settings-row-key'
  title.textContent = def.key
  if (def.requiresRestart) {
    const badge = document.createElement('span')
    badge.className = 'settings-restart-badge'
    badge.textContent = t('settings.restart_badge')
    title.appendChild(badge)
  }
  info.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'settings-row-desc'
  desc.textContent = t('settings.desc.' + def.key) || def.description
  info.appendChild(desc)

  const meta = document.createElement('div')
  meta.className = 'settings-row-meta'
  const metaParts = []
  if (Array.isArray(def.valueSet) && def.valueSet.length) metaParts.push(t('settings.meta.values') + ': ' + def.valueSet.join(', '))
  if (def.type === 'int' && (def.min !== undefined || def.max !== undefined)) {
    metaParts.push(t('settings.meta.range') + ': ' + (def.min ?? '–') + '–' + (def.max ?? '–'))
  }
  if (def.type === 'color') metaParts.push(t('settings.meta.format') + ': #rrggbb')
  metaParts.push(t('settings.meta.default') + ': ' + def.default)
  meta.textContent = metaParts.join(' · ')
  info.appendChild(meta)

  row.appendChild(info)

  const editor = document.createElement('div')
  editor.className = 'settings-row-editor'

  const originalValue = String(def.value)
  let valueInput
  if (Array.isArray(def.valueSet) && def.valueSet.length) {
    valueInput = document.createElement('select')
    valueInput.className = 'input'
    for (const opt of def.valueSet) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      valueInput.appendChild(o)
    }
    valueInput.value = originalValue
  } else if (def.type === 'color') {
    valueInput = document.createElement('input')
    valueInput.type = 'color'
    valueInput.className = 'settings-color-input'
    valueInput.value = def.value
  } else if (def.type === 'int') {
    valueInput = document.createElement('input')
    valueInput.type = 'number'
    valueInput.className = 'input'
    if (def.min !== undefined) valueInput.min = def.min
    if (def.max !== undefined) valueInput.max = def.max
    valueInput.value = def.value
  } else {
    valueInput = document.createElement('input')
    valueInput.type = 'text'
    valueInput.className = 'input'
    valueInput.value = def.value
  }
  valueInput.dataset.settingKey = def.key
  valueInput.dataset.settingType = def.type
  valueInput.dataset.originalValue = originalValue
  editor.appendChild(valueInput)

  const errorEl = document.createElement('div')
  errorEl.className = 'settings-row-error'
  editor.appendChild(errorEl)

  valueInput.addEventListener('input', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))
  valueInput.addEventListener('change', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))

  row.appendChild(editor)
  return row
}

async function saveAllSettings() {
  if (settingsDirty.size === 0) return
  const btn = document.getElementById('settingsSaveAllBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('settings.save_btn.saving') }

  const errors = []
  let needsRestart = false

  for (const [key, { input, type, errorEl }] of settingsDirty) {
    errorEl.textContent = ''
    const raw = type === 'int' ? Number(input.value) : input.value
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: raw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        errorEl.textContent = data.error || 'Hiba'
        errors.push(`${key}: ${data.error || 'hiba'}`)
      } else {
        input.dataset.originalValue = String(raw)
        if (data.requiresRestart) needsRestart = true
      }
    } catch {
      errorEl.textContent = 'Kapcsolati hiba'
      errors.push(`${key}: kapcsolati hiba`)
    }
  }

  // Remove successfully saved keys from dirty map
  for (const [key, { input }] of settingsDirty) {
    if (String(input.value) === input.dataset.originalValue) settingsDirty.delete(key)
  }
  updateSettingsSaveBar()

  if (btn) { btn.disabled = false; btn.textContent = t('settings.btn.save') }
  if (errors.length) {
    showToast(t('settings.toast.partial_error'), 'error')
  } else {
    showToast(needsRestart ? t('settings.toast.saved_restart') : t('settings.toast.saved'))
  }
}

function resetAllSettings() {
  for (const [key, { input, originalValue }] of settingsDirty) {
    input.value = originalValue
    const errorEl = document.querySelector(`[data-setting-key="${key}"]`)?.closest('.settings-row')?.querySelector('.settings-row-error')
    if (errorEl) errorEl.textContent = ''
  }
  settingsDirty.clear()
  updateSettingsSaveBar()
}

document.getElementById('settingsSaveAllBtn')?.addEventListener('click', saveAllSettings)
document.getElementById('settingsResetBtn')?.addEventListener('click', resetAllSettings)

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

// === Token Usage Monitor ===
const TU_COLORS = {
  marveen: '#6366f1',
  codi: '#f59e0b',
  dexi: '#ec4899',
  finci: '#10b981',
  hilti: '#ef4444',
  szurcsi: '#8b5cf6',
}
let tuSelectedAgent = ''
let tuChartState = null

function tuGetColor(agent) {
  return TU_COLORS[agent] || '#64748b'
}

function tuFormatTokens(n) {
  if (n == null || isNaN(n)) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function tuGetTimeRange() {
  const period = document.getElementById('tuPeriod')?.value || '7d'
  const now = Math.floor(Date.now() / 1000)
  if (period === '1h') return { from: now - 3600, to: now }
  if (period === '24h') return { from: now - 86400, to: now }
  if (period === '7d') return { from: now - 7 * 86400, to: now }
  if (period === '30d') return { from: now - 30 * 86400, to: now }
  return { from: undefined, to: undefined }
}

async function loadTokenUsage() {
  const { from, to } = tuGetTimeRange()
  const agent = tuSelectedAgent

  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)

  const summaryRes = await fetch('/api/token-usage/summary?' + params)
  if (!summaryRes.ok) return
  const summary = await summaryRes.json()
  summary.sort((a, b) => {
    const aTotal = (a.totalInput || 0) + (a.totalCacheRead || 0) + (a.totalCacheCreation || 0)
    const bTotal = (b.totalInput || 0) + (b.totalCacheRead || 0) + (b.totalCacheCreation || 0)
    return bTotal - aTotal
  })
  renderTuSummary(summary)

  const agentSelect = document.getElementById('tuAgent')
  if (agentSelect && agentSelect.options.length <= 1) {
    for (const s of summary) {
      const opt = document.createElement('option')
      opt.value = s.agent
      opt.textContent = s.agent
      agentSelect.appendChild(opt)
    }
  }
  if (agentSelect) agentSelect.value = agent

  const period = document.getElementById('tuPeriod')?.value || '7d'
  const bucketMin = period === '1h' ? 5 : 60
  const tlParams = new URLSearchParams(params)
  tlParams.set('bucket', String(bucketMin))
  const tlRes = await fetch('/api/token-usage/timeline?' + tlParams)
  if (!tlRes.ok) return
  const timeline = await tlRes.json()
  renderTuTimeline(timeline, agent)
  renderTuBudgetCards()

  tuDetailSearch = ''
  const searchEl = document.getElementById('tuSearchInput')
  if (searchEl) searchEl.value = ''
  await tuFetchDetails()
}

function renderTuSummary(summary) {
  const el = document.getElementById('tuSummaryCards')
  if (!el) return
  if (!summary.length) {
    el.innerHTML = `<div class="overview-stat"><div class="overview-stat-label">${t('tokenUsage.no_data')}</div><div class="overview-stat-value">0</div><div class="overview-stat-sub">${t('tokenUsage.collect_hint')}</div></div>`
    return
  }
  el.innerHTML = summary.map(s => {
    const totalIn = (s.totalInput || 0) + (s.totalCacheRead || 0) + (s.totalCacheCreation || 0)
    const isActive = tuSelectedAgent === s.agent
    const dimmed = tuSelectedAgent && !isActive
    return `
      <div class="overview-stat tu-agent-card${isActive ? ' tu-active' : ''}" data-agent="${escapeHtml(s.agent)}"
        style="border-left:3px solid ${tuGetColor(s.agent)};cursor:pointer;${dimmed ? 'opacity:0.4;' : ''}transition:opacity 0.2s">
        <div class="overview-stat-label">${escapeHtml(s.agent)}</div>
        <div class="overview-stat-value">${tuFormatTokens(totalIn)}</div>
        <div class="overview-stat-sub">${t('tokenUsage.calls_sub', { calls: (s.totalCalls || 0).toLocaleString(), out: tuFormatTokens(s.totalOutput) })}</div>
      </div>`
  }).join('')

  el.querySelectorAll('.tu-agent-card').forEach(card => {
    card.addEventListener('click', () => {
      const clickedAgent = card.dataset.agent
      if (tuSelectedAgent === clickedAgent) {
        tuSelectedAgent = ''
      } else {
        tuSelectedAgent = clickedAgent
      }
      const agentSelect = document.getElementById('tuAgent')
      if (agentSelect) agentSelect.value = tuSelectedAgent
      loadTokenUsage()
    })
  })
}

function tuGetResetLines(bucketStart, bucketEnd) {
  const lines = []
  // 5h session lines
  const win5h = 5 * 3600
  let t5 = bucketStart - (bucketStart % win5h) + win5h
  while (t5 < bucketEnd) {
    lines.push({ ts: t5, type: '5h', label: '5h' })
    t5 += win5h
  }
  // Daily midnight + weekly Monday midnight
  const d = new Date(bucketStart * 1000)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  while (d.getTime() / 1000 < bucketEnd) {
    const ts = Math.floor(d.getTime() / 1000)
    const isMonday = d.getDay() === 1
    const near5h = lines.find(l => l.type === '5h' && Math.abs(l.ts - ts) < 1800)
    if (!near5h) lines.push({ ts, type: isMonday ? 'weekly' : 'daily', label: isMonday ? t('tokenUsage.chart.week') : t('tokenUsage.chart.day') })
    else if (isMonday) { near5h.type = 'weekly'; near5h.label = t('tokenUsage.chart.week') }
    d.setDate(d.getDate() + 1)
  }
  return lines
}

function tuFillBuckets(data, bucketSeconds) {
  if (!data.length) return data
  const agents = [...new Set(data.map(d => d.agent))]
  const bucketMap = {}
  for (const d of data) {
    const key = d.bucket + ':' + d.agent
    bucketMap[key] = d
  }
  const minB = Math.min(...data.map(d => d.bucket))
  const maxB = Math.max(...data.map(d => d.bucket))
  const filled = []
  for (let b = minB; b <= maxB; b += bucketSeconds) {
    for (const agent of agents) {
      const key = b + ':' + agent
      filled.push(bucketMap[key] || { bucket: b, agent, calls: 0, inputTokens: 0, outputTokens: 0 })
    }
  }
  return filled
}

function tuFormatLocalDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function tuFormatLocalShort(ts) {
  const d = new Date(ts * 1000)
  const period = document.getElementById('tuPeriod')?.value || '7d'
  if (period === '1h' || period === '24h') {
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`
}

function tuIsPeakHour(ts) {
  const d = new Date(ts * 1000)
  if (d.getDay() === 0 || d.getDay() === 6) return false
  try {
    const ptHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }))
    return ptHour >= 5 && ptHour < 11
  } catch { return false }
}

function tuCalcCumulativeWindows(buckets, bucketTotals, windowSeconds) {
  const result = []
  let windowStart = null
  let cumulative = 0
  for (const b of buckets) {
    const total = bucketTotals[b] || 0
    if (windowStart === null) {
      if (total > 0) { windowStart = b; cumulative = total }
      else { cumulative = 0 }
    } else if (b >= windowStart + windowSeconds) {
      if (total > 0) { windowStart = b; cumulative = total }
      else { windowStart = null; cumulative = 0 }
    } else {
      cumulative += total
    }
    result.push({ bucket: b, cumulative })
  }
  return result
}

let tuBudgetView = ''

function renderTuTimeline(data, filterAgent) {
  const canvas = document.getElementById('tuCanvas')
  if (!canvas) return
  const container = canvas.parentElement
  const dpr = window.devicePixelRatio || 1
  const cssW = container.offsetWidth
  const cssH = 360
  canvas.width = cssW * dpr
  canvas.height = cssH * dpr
  canvas.style.width = cssW + 'px'
  canvas.style.height = cssH + 'px'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, cssW, cssH)

  const textSecondary = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#64748b'
  const textPrimary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#1e293b'
  const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e2e8f0'

  if (!data.length) {
    ctx.fillStyle = textSecondary
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(t('tokenUsage.no_period_data'), cssW / 2, 160)
    tuChartState = null
    return
  }

  renderTuTimeline.__lastData = data
  renderTuTimeline.__lastAgent = filterAgent
  const period = document.getElementById('tuPeriod')?.value || '7d'
  const bucketSec = period === '1h' ? 300 : 3600
  const filled = tuFillBuckets(data, bucketSec)
  const agents = [...new Set(filled.map(d => d.agent))]
  const buckets = [...new Set(filled.map(d => d.bucket))].sort((a, b) => a - b)
  const pad = { top: 20, right: 65, bottom: 70, left: 70 }
  const w = cssW - pad.left - pad.right
  const h = cssH - pad.top - pad.bottom

  const bucketMap = {}
  for (const d of filled) {
    if (!bucketMap[d.bucket]) bucketMap[d.bucket] = {}
    bucketMap[d.bucket][d.agent] = (bucketMap[d.bucket][d.agent] || 0) + (d.inputTokens || 0)
  }

  const bucketTotals = {}
  for (const b of buckets) {
    let sum = 0
    for (const a of agents) sum += (bucketMap[b]?.[a] || 0)
    bucketTotals[b] = sum
  }

  let maxVal = 0
  for (const b of buckets) {
    if (filterAgent) {
      const v = bucketMap[b]?.[filterAgent] || 0
      if (v > maxVal) maxVal = v
    } else {
      if (bucketTotals[b] > maxVal) maxVal = bucketTotals[b]
    }
  }
  if (maxVal === 0) maxVal = 1

  const barW = Math.max(2, Math.min(20, w / buckets.length - 1))
  const barGap = Math.max(0, (w / buckets.length) - barW)
  const bucketRange = buckets[buckets.length - 1] - buckets[0] + bucketSec

  // Peak hours shading
  for (let i = 0; i < buckets.length; i++) {
    if (tuIsPeakHour(buckets[i])) {
      const x = pad.left + (i / buckets.length) * w
      ctx.fillStyle = 'rgba(239, 68, 68, 0.06)'
      ctx.fillRect(x, pad.top, barW + barGap, h)
    }
  }

  // Day/week reset lines
  const resetLines = tuGetResetLines(buckets[0], buckets[buckets.length - 1] + 3600)
  for (const rl of resetLines) {
    const frac = (rl.ts - buckets[0]) / bucketRange
    if (frac < 0 || frac > 1) continue
    const x = pad.left + frac * w
    ctx.save()
    ctx.strokeStyle = rl.type === 'weekly' ? '#ef444480' : rl.type === '5h' ? '#3b82f680' : '#f59e0b60'
    ctx.lineWidth = rl.type === 'weekly' ? 1.5 : 1
    ctx.setLineDash(rl.type === 'weekly' ? [6, 4] : rl.type === '5h' ? [3, 3] : [4, 4])
    ctx.beginPath()
    ctx.moveTo(x, pad.top)
    ctx.lineTo(x, pad.top + h)
    ctx.stroke()
    ctx.restore()
  }

  // Bars (dimmed when budget view is active)
  const barDimmed = tuBudgetView !== ''
  const barRects = []
  for (let i = 0; i < buckets.length; i++) {
    const x = pad.left + (i / buckets.length) * w
    let yOffset = 0
    const segments = []
    const drawAgents = filterAgent ? [filterAgent] : agents
    for (const agent of drawAgents) {
      const val = bucketMap[buckets[i]]?.[agent] || 0
      const barH = (val / maxVal) * h
      ctx.globalAlpha = barDimmed ? 0.2 : 1
      ctx.fillStyle = tuGetColor(agent)
      ctx.fillRect(x, pad.top + h - yOffset - barH, barW, barH)
      ctx.globalAlpha = 1
      if (val > 0) segments.push({ agent, val })
      yOffset += barH
    }
    barRects.push({ x, w: barW + barGap, bucket: buckets[i], segments, totalH: yOffset })
  }

  // Cumulative budget lines
  const win5h = tuCalcCumulativeWindows(buckets, bucketTotals, 5 * 3600)
  const winWeekly = tuCalcCumulativeWindows(buckets, bucketTotals, 7 * 86400)
  const maxCum = Math.max(
    ...win5h.map(w => w.cumulative),
    ...winWeekly.map(w => w.cumulative),
    1
  )

  function drawCumLine(windows, color, lineW, active) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = active ? lineW + 1 : lineW
    ctx.globalAlpha = active ? 1 : (tuBudgetView === '' ? 0.7 : 0.15)
    ctx.setLineDash([])
    ctx.beginPath()
    let prevCum = 0
    for (let i = 0; i < windows.length; i++) {
      const x = pad.left + (i / buckets.length) * w + barW / 2
      const y = pad.top + h - (windows[i].cumulative / maxCum) * h
      if (i === 0) { ctx.moveTo(x, y) }
      else if (windows[i].cumulative < prevCum) {
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(x, pad.top + h)
        ctx.lineTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
      prevCum = windows[i].cumulative
    }
    ctx.stroke()
    ctx.restore()
  }

  const is5hActive = tuBudgetView === '5h'
  const isWeeklyActive = tuBudgetView === 'weekly'
  drawCumLine(winWeekly, '#8b5cf6', 1.5, isWeeklyActive)
  drawCumLine(win5h, '#06b6d4', 2, is5hActive)

  // X axis
  ctx.strokeStyle = borderColor
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(pad.left, pad.top + h)
  ctx.lineTo(pad.left + w, pad.top + h)
  ctx.stroke()

  // X labels
  ctx.fillStyle = textSecondary
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'center'
  const labelInterval = Math.max(1, Math.floor(buckets.length / 8))
  for (let i = 0; i < buckets.length; i += labelInterval) {
    const x = pad.left + (i / buckets.length) * w + barW / 2
    ctx.fillText(tuFormatLocalShort(buckets[i]), x, pad.top + h + 18)
  }

  // Left Y axis (per-bucket)
  ctx.textAlign = 'right'
  ctx.fillStyle = textSecondary
  ctx.font = '10px sans-serif'
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i
    const y = pad.top + h - (i / 4) * h
    ctx.fillText(tuFormatTokens(val), pad.left - 8, y + 4)
  }

  // Right Y axis (cumulative)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#06b6d4'
  for (let i = 0; i <= 4; i++) {
    const val = (maxCum / 4) * i
    const y = pad.top + h - (i / 4) * h
    ctx.fillText(tuFormatTokens(val), pad.left + w + 6, y + 4)
  }

  // Legend: single dynamic row with wrapping
  let legendY = pad.top + h + 38
  let legendX = pad.left
  const maxLegW = cssW - pad.right
  function legWrap(needed) { if (legendX + needed > maxLegW) { legendX = pad.left; legendY += 16 } }

  ctx.font = '11px sans-serif'
  ctx.textAlign = 'left'
  for (const agent of agents) {
    const tw = ctx.measureText(agent).width + 28
    legWrap(tw)
    ctx.fillStyle = tuGetColor(agent)
    ctx.fillRect(legendX, legendY - 7, 10, 10)
    ctx.fillStyle = textPrimary
    ctx.fillText(agent, legendX + 14, legendY + 2)
    legendX += tw
  }

  const legendHits = []
  const lineItems = [
    { label: t('tokenUsage.chart.window_5h'), color: '#06b6d4', lw: 2, dash: [], id: '5h', active: is5hActive },
    { label: t('tokenUsage.chart.window_weekly'), color: '#8b5cf6', lw: 1.5, dash: [], id: 'weekly', active: isWeeklyActive },
    { label: '5h', color: '#3b82f680', lw: 1, dash: [3, 3] },
    { label: t('tokenUsage.chart.day'), color: '#f59e0b60', lw: 1, dash: [4, 4] },
    { label: t('tokenUsage.chart.week'), color: '#ef444480', lw: 1.5, dash: [6, 4] },
  ]
  for (const li of lineItems) {
    const tw = ctx.measureText(li.label).width + 34
    legWrap(tw)
    ctx.save()
    ctx.strokeStyle = li.color; ctx.lineWidth = li.lw; ctx.setLineDash(li.dash)
    ctx.beginPath(); ctx.moveTo(legendX, legendY - 1); ctx.lineTo(legendX + 16, legendY - 1); ctx.stroke()
    ctx.restore()
    ctx.fillStyle = li.active ? li.color : textSecondary
    ctx.font = li.active ? 'bold 10px sans-serif' : '10px sans-serif'
    ctx.fillText(li.label, legendX + 20, legendY + 2)
    if (li.id) legendHits.push({ x: legendX, y: legendY - 10, w: tw, h: 16, id: li.id })
    legendX += tw
  }
  legWrap(70)
  ctx.fillStyle = 'rgba(239, 68, 68, 0.15)'
  ctx.fillRect(legendX, legendY - 7, 10, 10)
  ctx.fillStyle = textSecondary; ctx.font = '10px sans-serif'
  ctx.fillText('csúcsidő', legendX + 14, legendY + 2)

  // Store legend hit areas for click handling
  tuChartState = { barRects, pad, h, cssW, cssH, maxVal, maxCum, win5h, winWeekly, legendHits }
}

;(function setupTuTooltip() {
  const canvas = document.getElementById('tuCanvas')
  if (!canvas) return
  let tooltip = document.getElementById('tuTooltip')
  if (!tooltip) {
    tooltip = document.createElement('div')
    tooltip.id = 'tuTooltip'
    tooltip.style.cssText = 'position:absolute;background:var(--bg-elevated,#1e293b);color:var(--text-primary,#f8fafc);padding:8px 12px;border-radius:6px;font-size:12px;pointer-events:none;z-index:100;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:240px;line-height:1.5'
    canvas.parentElement.appendChild(tooltip)
  }

  canvas.addEventListener('mousemove', e => {
    if (!tuChartState) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { barRects, pad, h } = tuChartState

    let hit = null
    for (const br of barRects) {
      if (mx >= br.x && mx < br.x + br.w) { hit = br; break }
    }

    if (hit && my >= pad.top && my <= pad.top + h) {
      const isPeak = tuIsPeakHour(hit.bucket)
      let html = `<div style="font-weight:600;margin-bottom:4px">${tuFormatLocalShort(hit.bucket)}${isPeak ? ` <span style="color:#ef4444;font-size:10px">${t('tokenUsage.chart.peak')}</span>` : ''}</div>`
      let total = 0
      for (const seg of hit.segments) {
        html += `<div><span style="color:${tuGetColor(seg.agent)}">&#9632;</span> ${seg.agent}: ${tuFormatTokens(seg.val)}</div>`
        total += seg.val
      }
      if (hit.segments.length > 1) html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin-top:4px;padding-top:4px;font-weight:600">${t('tokenUsage.total')} ${tuFormatTokens(total)}</div>`
      if (tuChartState.win5h || tuChartState.winWeekly) {
        const idx = barRects.indexOf(hit)
        if (idx >= 0) {
          const c5 = tuChartState.win5h?.[idx]
          const cw = tuChartState.winWeekly?.[idx]
          html += '<div style="border-top:1px solid rgba(255,255,255,0.2);margin-top:4px;padding-top:4px;font-size:11px">'
          if (c5) html += `<div><span style="color:#06b6d4">━</span> 5h ablak: ${tuFormatTokens(c5.cumulative)}</div>`
          if (cw) html += `<div><span style="color:#8b5cf6">━</span> Heti ablak: ${tuFormatTokens(cw.cumulative)}</div>`
          html += '</div>'
        }
      }
      tooltip.innerHTML = html
      tooltip.style.display = 'block'
      const tx = Math.min(e.clientX - rect.left + 12, canvas.parentElement.offsetWidth - 250)
      tooltip.style.left = tx + 'px'
      tooltip.style.top = (my - 10) + 'px'
    } else {
      tooltip.style.display = 'none'
    }
  })

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none'
  })

  canvas.addEventListener('click', e => {
    if (!tuChartState?.legendHits) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    for (const lh of tuChartState.legendHits) {
      if (mx >= lh.x && mx <= lh.x + lh.w && my >= lh.y && my <= lh.y + lh.h) {
        tuBudgetView = tuBudgetView === lh.id ? '' : lh.id
        if (renderTuTimeline.__lastData) renderTuTimeline(renderTuTimeline.__lastData, renderTuTimeline.__lastAgent)
        return
      }
    }
  })
})()

function renderTuBudgetCards() {
  const el = document.getElementById('tuBudgetCards')
  if (!el || !tuChartState) return
  const { win5h, winWeekly } = tuChartState
  const cur5h = win5h?.length ? win5h[win5h.length - 1].cumulative : 0
  const curWeekly = winWeekly?.length ? winWeekly[winWeekly.length - 1].cumulative : 0

  el.innerHTML = `
    <div class="overview-stat tu-budget-card${tuBudgetView === '5h' ? ' tu-active' : ''}" data-budget="5h"
      style="border-left:3px solid #06b6d4;cursor:pointer;${tuBudgetView === 'weekly' ? 'opacity:0.4;' : ''}transition:opacity 0.2s">
      <div class="overview-stat-label">${t('tokenUsage.window_5h_label')}</div>
      <div class="overview-stat-value" style="color:#06b6d4">${tuFormatTokens(cur5h)}</div>
      <div class="overview-stat-sub">${t('tokenUsage.cumulative_sub')}</div>
    </div>
    <div class="overview-stat tu-budget-card${tuBudgetView === 'weekly' ? ' tu-active' : ''}" data-budget="weekly"
      style="border-left:3px solid #8b5cf6;cursor:pointer;${tuBudgetView === '5h' ? 'opacity:0.4;' : ''}transition:opacity 0.2s">
      <div class="overview-stat-label">${t('tokenUsage.window_weekly_label')}</div>
      <div class="overview-stat-value" style="color:#8b5cf6">${tuFormatTokens(curWeekly)}</div>
      <div class="overview-stat-sub">${t('tokenUsage.cumulative_sub')}</div>
    </div>`

  el.querySelectorAll('.tu-budget-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.budget
      tuBudgetView = tuBudgetView === id ? '' : id
      if (renderTuTimeline.__lastData) renderTuTimeline(renderTuTimeline.__lastData, renderTuTimeline.__lastAgent)
      renderTuBudgetCards()
    })
  })
}

let tuDetailData = []
let tuDetailSort = { col: 'timestamp', dir: 'desc' }
let tuDetailSearch = ''
let tuSearchTimer = null

function tuSortDetails(data) {
  return [...data].sort((a, b) => {
    const { col, dir } = tuDetailSort
    let va, vb
    if (col === 'input') {
      va = (a.input_tokens || 0) + (a.cache_read_tokens || 0) + (a.cache_creation_tokens || 0)
      vb = (b.input_tokens || 0) + (b.cache_read_tokens || 0) + (b.cache_creation_tokens || 0)
    } else if (col === 'output') {
      va = a.output_tokens || 0; vb = b.output_tokens || 0
    } else if (col === 'agent') {
      va = a.agent || ''; vb = b.agent || ''
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    } else {
      va = a.timestamp || 0; vb = b.timestamp || 0
    }
    return dir === 'asc' ? va - vb : vb - va
  })
}

function renderTuDetailsTable() {
  const tbody = document.getElementById('tuDetailsTbody')
  const countEl = document.getElementById('tuDetailsCount')
  if (!tbody) return

  const sorted = tuSortDetails(tuDetailData)
  if (countEl) countEl.textContent = `${sorted.length} sor`

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-secondary);font-size:13px;text-align:center;padding:16px">${t('tokenUsage.no_calls')}</td></tr>`
    return
  }

  tbody.innerHTML = sorted.map(d => {
    const totalIn = (d.input_tokens || 0) + (d.cache_read_tokens || 0) + (d.cache_creation_tokens || 0)
    const timeStr = tuFormatLocalDate(d.timestamp)
    const preview = d.content_preview ? d.content_preview.slice(0, 80) + (d.content_preview.length > 80 ? '...' : '') : ''
    const taskInfo = d.task_title ? `<span style="color:var(--text-secondary);font-size:11px"> [${escapeHtml(d.task_title)}]</span>` : ''
    return `<tr>
      <td style="white-space:nowrap">${timeStr}</td>
      <td><span style="color:${tuGetColor(d.agent)};font-weight:600">${escapeHtml(d.agent)}</span>${taskInfo}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${tuFormatTokens(totalIn)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${tuFormatTokens(d.output_tokens)}</td>
      <td style="font-size:12px;color:var(--text-secondary);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(preview || '')}">${d.tool_name ? '<code>' + escapeHtml(d.tool_name) + '</code> ' : ''}${escapeHtml(preview)}</td>
    </tr>`
  }).join('')
}

function renderTuDetails(data) {
  if (data) tuDetailData = data
  const el = document.getElementById('tuDetailsTable')
  if (!el) return

  if (!document.getElementById('tuDetailsTbody')) {
    const arrow = col => tuDetailSort.col === col ? (tuDetailSort.dir === 'asc' ? ' ▲' : ' ▼') : ''
    const thStyle = 'cursor:pointer;user-select:none'
    const thStyleR = thStyle + ';text-align:right'
    el.innerHTML = `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <input id="tuSearchInput" type="text" placeholder="${t('tokenUsage.search_placeholder')}"
        style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);width:260px;font-size:13px">
      <span id="tuDetailsCount" style="color:var(--text-secondary);font-size:12px"></span>
    </div>
    <div style="overflow-x:auto"><table class="mem-table" style="width:100%;min-width:600px">
      <thead><tr>
        <th style="${thStyle}" data-sort="timestamp">${t('tokenUsage.col.time')}${arrow('timestamp')}</th>
        <th style="${thStyle}" data-sort="agent">${t('tokenUsage.col.agent')}${arrow('agent')}</th>
        <th style="${thStyleR}" data-sort="input">Input${arrow('input')}</th>
        <th style="${thStyleR}" data-sort="output">Output${arrow('output')}</th>
        <th>${t('tokenUsage.col.content')}</th>
      </tr></thead>
      <tbody id="tuDetailsTbody"></tbody>
    </table></div>`

    el.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort
        if (tuDetailSort.col === col) {
          tuDetailSort.dir = tuDetailSort.dir === 'asc' ? 'desc' : 'asc'
        } else {
          tuDetailSort = { col, dir: col === 'agent' ? 'asc' : 'desc' }
        }
        th.closest('thead').querySelectorAll('th[data-sort]').forEach(h => {
          const c = h.dataset.sort
          const arrow = tuDetailSort.col === c ? (tuDetailSort.dir === 'asc' ? ' ▲' : ' ▼') : ''
          const labels = { timestamp: t('tokenUsage.col.time'), agent: t('tokenUsage.col.agent'), input: 'Input', output: 'Output' }
          h.textContent = (labels[c] || c) + arrow
        })
        renderTuDetailsTable()
      })
    })

    document.getElementById('tuSearchInput').addEventListener('input', e => {
      tuDetailSearch = e.target.value
      clearTimeout(tuSearchTimer)
      tuSearchTimer = setTimeout(() => tuFetchDetails(), 400)
    })
  }

  renderTuDetailsTable()
}

async function tuFetchDetails() {
  const { from, to } = tuGetTimeRange()
  const agent = tuSelectedAgent
  const minTokens = document.getElementById('tuMinTokens')?.value || '50000'
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (agent) params.set('agent', agent)
  if (!tuDetailSearch) params.set('min_tokens', minTokens)
  if (tuDetailSearch) params.set('q', tuDetailSearch)
  params.set('limit', '200')
  const detailRes = await fetch('/api/token-usage?' + params)
  if (!detailRes.ok) return
  const details = await detailRes.json()
  renderTuDetails(details)
}

document.getElementById('tuCollectBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('tuCollectBtn')
  btn.disabled = true
  btn.textContent = t('tokenUsage.collect_btn.collecting')
  try {
    const res = await fetch('/api/token-usage/collect', { method: 'POST' }).then(r => r.json())
    btn.textContent = t('tokenUsage.collect_done', { n: res.inserted || 0 })
    setTimeout(() => { btn.textContent = t('tokenUsage.collect_btn.collect'); btn.disabled = false }, 2000)
    loadTokenUsage()
  } catch {
    btn.textContent = t('tokenUsage.collect_error')
    setTimeout(() => { btn.textContent = t('tokenUsage.collect_btn.collect'); btn.disabled = false }, 2000)
  }
})

document.getElementById('tuPeriod')?.addEventListener('change', () => { tuSelectedAgent = ''; loadTokenUsage() })
document.getElementById('tuAgent')?.addEventListener('change', () => { tuSelectedAgent = document.getElementById('tuAgent').value; loadTokenUsage() })
document.getElementById('tuMinTokens')?.addEventListener('change', () => tuFetchDetails())

window.addEventListener('resize', () => {
  if (!document.getElementById('tokenUsagePage')?.hidden) {
    if (tuChartState && renderTuTimeline.__lastData) renderTuTimeline(renderTuTimeline.__lastData, renderTuTimeline.__lastAgent)
  }
})

// ============================================================
// Ideas (Ötletláda)
// ============================================================
let ideas = []
let ideasPromoteId = null
let ideaEditId = null
let ideaDetailId = null
const STATUS_COLORS = { new: 'var(--accent)', reviewed: '#f59e0b', kanban: '#22c55e', rejected: '#ef4444' }
const STATUS_LABELS = { new: () => t('ideas.status.new'), reviewed: () => t('ideas.status.reviewed'), kanban: () => t('ideas.status.kanban'), rejected: () => t('ideas.status.rejected') }

async function loadIdeasPage() {
  const statusFilter = document.getElementById('ideaStatusFilter')?.value ?? 'active'
  const categoryFilter = document.getElementById('ideaCategoryFilter')?.value || ''
  const params = new URLSearchParams()
  // 'active' = new+reviewed, fetched unfiltered then narrowed client-side
  if (statusFilter && statusFilter !== 'active') params.set('status', statusFilter)
  if (categoryFilter) params.set('category', categoryFilter)
  const [ideasRes, catsRes] = await Promise.all([fetch('/api/ideas?' + params), fetch('/api/ideas/categories')])
  ideas = await ideasRes.json()
  if (statusFilter === 'active') ideas = ideas.filter(i => i.status === 'new' || i.status === 'reviewed')
  const cats = await catsRes.json()
  const catSel = document.getElementById('ideaCategoryFilter')
  if (catSel) {
    const prev = catSel.value
    catSel.innerHTML = `<option value="">${t('ideas.filter.all_categories')}</option>` + cats.map(c => `<option value="${escapeHtml(c)}" ${c === prev ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')
  }
  renderIdeasStats()
  renderIdeasList()
}

function renderIdeasStats() {
  const counts = { new: 0, reviewed: 0, kanban: 0, rejected: 0 }
  for (const i of ideas) counts[i.status] = (counts[i.status] || 0) + 1
  const el = document.getElementById('ideasStats')
  if (!el) return
  el.innerHTML = Object.entries(counts).map(([s, n]) =>
    `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 16px;min-width:90px">
      <div style="font-size:22px;font-weight:700;color:${STATUS_COLORS[s]}">${n}</div>
      <div style="font-size:12px;color:var(--text-muted)">${typeof STATUS_LABELS[s] === 'function' ? STATUS_LABELS[s]() : STATUS_LABELS[s]}</div>
    </div>`
  ).join('')
}

function renderIdeasList() {
  const el = document.getElementById('ideasList')
  if (!el) return
  if (!ideas.length) { el.innerHTML = `<div style="color:var(--text-muted);padding:32px;text-align:center">${t('ideas.empty')}</div>`; return }
  const byCategory = {}
  for (const idea of ideas) {
    if (!byCategory[idea.category]) byCategory[idea.category] = []
    byCategory[idea.category].push(idea)
  }
  el.innerHTML = Object.entries(byCategory).map(([cat, items]) => `
    <div style="margin-bottom:8px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);padding:4px 0 6px">${escapeHtml(cat)}</div>
      ${items.map(renderIdeaCard).join('')}
    </div>`).join('')
}

function ideaScoreBadge(idea) {
  if (!idea.impact || !idea.effort) return ''
  const score = idea.impact - idea.effort
  const color = score > 0 ? '#22c55e' : score < 0 ? '#ef4444' : 'var(--text-muted)'
  return `<span style="font-size:11px;color:${color};border:1px solid ${color};border-radius:4px;padding:2px 5px" title="Impact ${idea.impact} - Effort ${idea.effort}">I${idea.impact}·E${idea.effort}</span>`
}

function renderIdeaCard(idea) {
  const statusColor = STATUS_COLORS[idea.status] || 'var(--text-muted)'
  const statusLabelRaw = STATUS_LABELS[idea.status]; const statusLabel = statusLabelRaw ? (typeof statusLabelRaw === 'function' ? statusLabelRaw() : statusLabelRaw) : idea.status
  const desc = idea.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px">${escapeHtml(idea.description.slice(0, 120))}${idea.description.length > 120 ? '…' : ''}</div>` : ''
  const staleBadge = idea.stale ? `<span style="font-size:11px;background:#92400e22;color:#d97706;border:1px solid #d97706;border-radius:4px;padding:2px 5px" title="${t('ideas.stale_tooltip')}">${t('ideas.stale_badge')}</span>` : ''
  return `<div class="card" style="padding:12px 16px;margin-bottom:4px${idea.stale ? ';border-left:3px solid #d97706' : ''}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="idea-title-link" style="font-weight:600;font-size:14px;cursor:pointer" onclick="openIdeaDetail('${idea.id}')">${escapeHtml(idea.title)}</span>
          <span style="font-size:11px;color:${statusColor};padding:2px 6px;border:1px solid ${statusColor};border-radius:4px">${statusLabel}</span>
          ${ideaScoreBadge(idea)}
          ${staleBadge}
        </div>
        ${desc}
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
        ${idea.status !== 'reviewed' && idea.status !== 'kanban' ? `<button class="btn-secondary btn-compact" onclick="setIdeaStatus('${idea.id}','reviewed')" style="font-size:11px">${t('ideas.btn.reviewed')}</button>` : ''}
        ${idea.status !== 'rejected' ? `<button class="btn-secondary btn-compact" onclick="setIdeaStatus('${idea.id}','rejected')" style="font-size:11px;color:#ef4444">${t('ideas.btn.rejected')}</button>` : ''}
        ${idea.status === 'reviewed' || idea.status === 'rejected' ? `<button class="btn-secondary btn-compact" onclick="setIdeaStatus('${idea.id}','new')" style="font-size:11px">${t('ideas.btn.reopen')}</button>` : ''}
        <button class="btn-secondary btn-compact" onclick="openIdeaEdit('${idea.id}')" style="font-size:11px">${t('ideas.btn.edit')}</button>
        ${idea.status !== 'kanban' && idea.status !== 'rejected' ? `<button class="btn-primary btn-compact" onclick="openIdeaBreakdown('${idea.id}')" style="font-size:11px">${t('ideas.btn.kanban_ai')}</button>` : ''}
        <button class="btn-secondary btn-compact" onclick="deleteIdeaItem('${idea.id}')" style="font-size:11px;color:#ef4444">${t('ideas.btn.delete')}</button>
      </div>
    </div>
  </div>`
}

function applyIdeaModalI18n() {
  const labels = document.querySelectorAll('#ideaModalOverlay .form-label')
  const keys = ['ideas.modal.title_label', 'ideas.modal.desc_label', 'ideas.modal.category_label', 'ideas.modal.impact_label', 'ideas.modal.effort_label']
  labels.forEach((el, i) => { if (keys[i]) el.textContent = t(keys[i]) })
  const saveBtn = document.getElementById('ideaModalSave')
  const cancelBtn = document.getElementById('ideaModalCancel')
  if (saveBtn) saveBtn.textContent = t('ideas.modal.save_btn')
  if (cancelBtn) cancelBtn.textContent = t('ideas.modal.cancel_btn')
}

function openIdeaNew() {
  ideaEditId = null
  document.getElementById('ideaModalTitle').textContent = t('ideas.modal.title_new')
  document.getElementById('ideaTitleInput').value = ''
  document.getElementById('ideaDescInput').value = ''
  applyIdeaModalI18n()
  openModal(document.getElementById('ideaModalOverlay'))
}

function openIdeaEdit(id) {
  const idea = ideas.find(i => i.id === id)
  if (!idea) return
  ideaEditId = id
  document.getElementById('ideaModalTitle').textContent = t('ideas.modal.title_edit')
  document.getElementById('ideaTitleInput').value = idea.title
  document.getElementById('ideaDescInput').value = idea.description || ''
  document.getElementById('ideaCategoryInput').value = idea.category
  document.getElementById('ideaImpactInput').value = idea.impact ?? ''
  document.getElementById('ideaEffortInput').value = idea.effort ?? ''
  openModal(document.getElementById('ideaModalOverlay'))
}

async function saveIdea() {
  const title = document.getElementById('ideaTitleInput').value.trim()
  if (!title) { showToast(t('common.title') + ' ' + t('common.error'), 'error'); return }
  const impactRaw = document.getElementById('ideaImpactInput').value
  const effortRaw = document.getElementById('ideaEffortInput').value
  const body = {
    title,
    description: document.getElementById('ideaDescInput').value.trim() || undefined,
    category: document.getElementById('ideaCategoryInput').value,
    source: 'manual',
    impact: impactRaw ? parseInt(impactRaw) : null,
    effort: effortRaw ? parseInt(effortRaw) : null,
  }
  if (ideaEditId) {
    await fetch(`/api/ideas/${ideaEditId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } else {
    await fetch('/api/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, status: 'new' }) })
  }
  closeModal(document.getElementById('ideaModalOverlay'))
  loadIdeasPage()
}

async function deleteIdeaItem(id) {
  if (!confirm(t('kanban.confirm.delete'))) return
  await fetch(`/api/ideas/${id}`, { method: 'DELETE' })
  loadIdeasPage()
}

// --- Idea detail modal (comments + impact/effort view) ---

async function openIdeaDetail(id) {
  const idea = ideas.find(i => i.id === id)
  if (!idea) return
  ideaDetailId = id
  const statusLabel = STATUS_LABELS[idea.status] || idea.status
  document.getElementById('ideaDetailTitle').textContent = idea.title
  document.getElementById('ideaDetailMeta').textContent = `${idea.category} · ${statusLabel}`
  document.getElementById('ideaDetailDesc').textContent = idea.description || t('ideas.no_description')
  document.getElementById('ideaDetailImpact').value = idea.impact ?? ''
  document.getElementById('ideaDetailEffort').value = idea.effort ?? ''
  updateDetailScoreChip()
  document.getElementById('ideaCommentsList').innerHTML = ''
  document.getElementById('ideaCommentContent').value = ''
  openModal(document.getElementById('ideaDetailOverlay'))
  await loadIdeaComments(id)
}

function updateDetailScoreChip() {
  const chip = document.getElementById('ideaDetailScoreChip')
  if (!chip) return
  const impact = Number(document.getElementById('ideaDetailImpact').value) || 0
  const effort = Number(document.getElementById('ideaDetailEffort').value) || 0
  if (!impact && !effort) { chip.textContent = ''; return }
  if (!impact || !effort) { chip.textContent = ''; return }
  const score = impact - effort
  const color = score > 0 ? '#22c55e' : score < 0 ? '#ef4444' : 'var(--text-muted)'
  chip.innerHTML = `<span class="idea-score-chip" style="border-color:${color};color:${color}">Pont: <strong>${score >= 0 ? '+' : ''}${score}</strong></span>`
}

document.getElementById('ideaDetailImpact')?.addEventListener('change', updateDetailScoreChip)
document.getElementById('ideaDetailEffort')?.addEventListener('change', updateDetailScoreChip)

document.getElementById('ideaDetailScoreSave')?.addEventListener('click', async () => {
  if (!ideaDetailId) return
  const impact = document.getElementById('ideaDetailImpact').value
  const effort = document.getElementById('ideaDetailEffort').value
  try {
    const res = await fetch(`/api/ideas/${encodeURIComponent(ideaDetailId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impact: impact ? Number(impact) : null,
        effort: effort ? Number(effort) : null,
      }),
    })
    if (!res.ok) { showToast(t('ideas.toast.score_saved_error'), 'error'); return }
    // update local cache so card chip refreshes on close
    const idea = ideas.find(i => i.id === ideaDetailId)
    if (idea) {
      idea.impact = impact ? Number(impact) : null
      idea.effort = effort ? Number(effort) : null
    }
    updateDetailScoreChip()
    showToast(t('ideas.toast.score_saved'))
    renderIdeasList()
  } catch { showToast(t('ideas.toast.score_saved_error'), 'error') }
})

async function loadIdeaComments(id) {
  const list = document.getElementById('ideaCommentsList')
  try {
    const res = await fetch(`/api/ideas/${encodeURIComponent(id)}/comments`)
    const data = await res.json()
    if (!data.comments || !data.comments.length) {
      list.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:6px 0">${t('ideas.comments.empty')}</div>`
      return
    }
    list.innerHTML = ''
    for (const c of data.comments) {
      const date = new Date(c.created_at * 1000).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const div = document.createElement('div')
      div.className = 'comment-item'
      div.innerHTML = `<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px"><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-date">${date}</span></div><div class="comment-body">${escapeHtml(c.content)}</div>`
      list.appendChild(div)
    }
  } catch {
    list.innerHTML = `<div style="color:var(--danger);font-size:12px">${t('ideas.comments.error')}</div>`
  }
}

document.getElementById('ideaCommentSubmit')?.addEventListener('click', async () => {
  if (!ideaDetailId) return
  const content = document.getElementById('ideaCommentContent').value.trim()
  if (!content) { document.getElementById('ideaCommentContent').focus(); return }
  try {
    const res = await fetch(`/api/ideas/${encodeURIComponent(ideaDetailId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) { showToast(t('ideas.toast.comment_error'), 'error'); return }
    document.getElementById('ideaCommentContent').value = ''
    await loadIdeaComments(ideaDetailId)
  } catch { showToast(t('ideas.toast.comment_error'), 'error') }
})

document.getElementById('ideaDetailClose')?.addEventListener('click', () => closeModal(document.getElementById('ideaDetailOverlay')))
document.getElementById('ideaDetailCloseBtn')?.addEventListener('click', () => closeModal(document.getElementById('ideaDetailOverlay')))
document.getElementById('ideaDetailEditBtn')?.addEventListener('click', () => {
  if (!ideaDetailId) return
  closeModal(document.getElementById('ideaDetailOverlay'))
  openIdeaEdit(ideaDetailId)
})

function openIdeaPromote(id) {
  ideasPromoteId = id
  openModal(document.getElementById('ideaPromoteOverlay'))
}

async function promoteIdea(phase) {
  if (!ideasPromoteId) return
  const res = await fetch(`/api/ideas/${ideasPromoteId}/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase }) })
  const data = await res.json()
  ideasPromoteId = null
  closeModal(document.getElementById('ideaPromoteOverlay'))
  if (data.ok) showToast(t('kanban.toast.card_created') + ': ' + data.kanban_id)
  loadIdeasPage()
}

async function setIdeaStatus(id, status) {
  try {
    const res = await fetch(`/api/ideas/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    if (!res.ok) { showToast(t('ideas.toast.status_error')); return }
    loadIdeasPage()
  } catch { showToast(t('ideas.toast.status_error')) }
}

// Promote an idea to the board via AI breakdown + per-subtask approval.
// Reuses the shared breakdown modal (breakdownMode='idea').
async function openIdeaBreakdown(id) {
  const idea = ideas.find(i => i.id === id)
  if (!idea) return
  // The breakdown modal's assignee dropdown reads kanbanAssignees, which is only
  // populated by loadKanban(). If the user lands here without visiting the board,
  // fetch it so the AI-suggested assignees are selectable.
  if (!kanbanAssignees.length) {
    try { kanbanAssignees = await (await fetch('/api/kanban/assignees')).json() } catch { /* dropdown falls back to "nincs" */ }
  }
  showToast(t('ideas.toast.ai_elaborating'))
  try {
    const res = await fetch(`/api/ideas/${id}/breakdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Breakdown hiba'); return }
    if (!data.subtasks || !data.subtasks.length) { showToast('Az AI nem adott vissza alfeladatot'); return }
    breakdownMode = 'idea'
    breakdownIdeaId = id
    breakdownSubtasks = data.subtasks
    showBreakdownModal(data.subtasks, { title: idea.title })
    // Show DoD field only in idea mode
    const dodSection = document.getElementById('breakdownDoDSection')
    if (dodSection) { dodSection.style.display = ''; document.getElementById('breakdownSuccessCriteria').value = '' }
  } catch {
    showToast('Breakdown hiba')
  }
}

document.getElementById('ideaNewBtn')?.addEventListener('click', openIdeaNew)
document.getElementById('ideaModalClose')?.addEventListener('click', () => { closeModal(document.getElementById('ideaModalOverlay')) })
document.getElementById('ideaModalCancel')?.addEventListener('click', () => { closeModal(document.getElementById('ideaModalOverlay')) })
document.getElementById('ideaModalSave')?.addEventListener('click', saveIdea)
document.getElementById('ideaPromoteClose')?.addEventListener('click', () => { closeModal(document.getElementById('ideaPromoteOverlay')) })
document.getElementById('ideaPromoteCancel')?.addEventListener('click', () => { closeModal(document.getElementById('ideaPromoteOverlay')) })
document.getElementById('ideaPromoteDetail')?.addEventListener('click', () => promoteIdea('detail'))
document.getElementById('ideaPromotePlan')?.addEventListener('click', () => promoteIdea('plan'))
document.getElementById('ideaStatusFilter')?.addEventListener('change', loadIdeasPage)
document.getElementById('ideaCategoryFilter')?.addEventListener('change', loadIdeasPage)


// === Agent reauth login flow ===
async function handleAgentLogin(agentName, btn) {
  const phase = btn.dataset.phase || 'start'
  btn.disabled = true
  const origText = btn.textContent
  btn.textContent = phase === 'start' ? t('agents.auth.btn_starting') : t('agents.auth.btn_confirming')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase }),
    })
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + res.status) }
    if (phase === 'start') {
      btn.dataset.phase = 'confirm'
      btn.textContent = t('agents.auth.btn_confirm')
      btn.disabled = false
      showToast(t('agents.auth.toast_started'))
    } else {
      btn.textContent = t('agents.auth.btn_logged_in')
      showToast(t('agents.auth.toast_success'))
      setTimeout(() => loadAgents(), 1500)
    }
  } catch (e) {
    showToast('Hiba: ' + (e.message || e))
    btn.textContent = origText
    btn.dataset.phase = 'start'
    btn.disabled = false
  }
}

// === Agent terminal modal (xterm.js) ===
let terminalInstance = null
let terminalSSE = null
let terminalFit = null

function openTerminalModal(agentName) {
  const overlay = document.getElementById('terminalOverlay')
  const container = document.getElementById('terminalContainer')
  const title = document.getElementById('terminalModalTitle')
  if (!overlay || !container) return

  title.textContent = agentName + ' - Terminal'

  // Cleanup previous
  if (terminalSSE) { terminalSSE.close(); terminalSSE = null }
  if (terminalInstance) { terminalInstance.dispose(); terminalInstance = null }
  container.innerHTML = ''

  // Init xterm — fontSize 12 + wider modal fits ~140 chars of tmux output
  const term = new window.Terminal({
    theme: { background: '#1a1a1a', foreground: '#e8e4da' },
    fontFamily: 'JetBrains Mono, Menlo, monospace',
    fontSize: 12,
    cursorBlink: false,
    disableStdin: false,
    scrollback: 4000,
    convertEol: true,
    allowProposedApi: true,
  })
  const fitAddon = new window.FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)
  fitAddon.fit()
  terminalInstance = term
  terminalFit = fitAddon

  openModal(overlay)
  setTimeout(() => term.focus(), 50)

  // SSE pane stream.
  // The pane snapshot now includes scrollback history (server uses
  // `capture-pane -S -2000`), so the user can scroll back. To keep scrolling
  // stable we (a) only repaint when the snapshot actually changed, and (b) only
  // repaint while the viewport is at the bottom — if the user has scrolled up we
  // freeze their view and resume painting when they return to the bottom (the
  // onScroll handler below). The repaint clears the scrollback (CSI 3 J) before
  // rewriting the full snapshot so frames don't accumulate duplicate history.
  let latestPane = null
  let paintedPane = null
  const isAtBottom = () => {
    const buf = term.buffer.active
    return buf.viewportY >= buf.baseY
  }
  const repaint = () => {
    if (latestPane === null || latestPane === paintedPane) return
    if (!isAtBottom()) return // user scrolled up — keep their view put
    paintedPane = latestPane
    term.write('\x1b[3J\x1b[2J\x1b[H' + latestPane)
  }
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const sse = new EventSource(`/api/agents/${encodeURIComponent(agentName)}/pane/stream?token=${encodeURIComponent(token)}`)
  sse.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.pane !== undefined) {
        latestPane = msg.pane.replace(/\x1b]8;[^\x1b]*\x1b\\/g, '')
        repaint()
      }
    } catch {}
  }
  sse.onerror = () => term.write(`\r\n${t('terminal.stream_error')}\r\n`)
  terminalSSE = sse
  // When the user scrolls back down to the bottom, resume live repainting.
  term.onScroll(() => { if (isAtBottom()) repaint() })

  // Single onData handler — maps escape sequences to {special}, plain chars to {keys}
  // Using onData only (no onKey) avoids double-firing on arrow/Enter keys.
  // PageUp/PageDown are intentionally NOT forwarded: they scroll the xterm
  // scrollback locally (history viewing) instead of going to the agent.
  const ESC_TO_SPECIAL = {
    '\r': 'Enter', '\x1b': 'Escape',
    '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
    '\x7f': 'BSpace', '\t': 'Tab', '\x1b[Z': 'S-Tab',
    '\x03': 'C-c', '\x04': 'C-d', '\x15': 'C-u', '\x0c': 'C-l',
  }
  term.onData(data => {
    if (data === '\x1b[5~') { term.scrollPages(-1); return } // PageUp -> scroll history up
    if (data === '\x1b[6~') { term.scrollPages(1); return }  // PageDown -> scroll history down
    const special = ESC_TO_SPECIAL[data]
    const body = special ? { special } : { keys: data }
    fetch(`/api/agents/${encodeURIComponent(agentName)}/keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  })

  // Resize fit on modal resize — observe the modal wrapper (not the xterm container
  // itself) to avoid a ResizeObserver->fit->resize->ResizeObserver infinite loop
  let fitTimer = null
  const ro = new ResizeObserver(() => {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(() => { try { fitAddon.fit() } catch {} }, 50)
  })
  const modalEl = container.closest('.terminal-modal') || container.parentElement
  if (modalEl) ro.observe(modalEl)
}

document.getElementById('terminalClose')?.addEventListener('click', () => {
  const overlay = document.getElementById('terminalOverlay')
  if (overlay) closeModal(overlay)
  if (terminalSSE) { terminalSSE.close(); terminalSSE = null }
  if (terminalInstance) { terminalInstance.dispose(); terminalInstance = null }
})

// === Agent conversation (readable transcript) modal ===
// Renders the agent's Claude Code transcript as a chat-style timeline: inbound
// Telegram messages, the agent's replies, and (optionally) its notes/actions.
// Solves what the raw terminal can't: a readable, searchable review of what
// actually happened -- also the support view for customer-hosted Marveens.
const CONVERSATION_PAGE_SIZE = 400
let conversationEntries = []
let conversationAgentName = null
let conversationHasOlder = false
let conversationLoadingOlder = false

async function openConversationModal(agentName, displayName) {
  const overlay = document.getElementById('conversationOverlay')
  const container = document.getElementById('conversationContainer')
  const title = document.getElementById('conversationModalTitle')
  if (!overlay || !container) return
  conversationAgentName = agentName
  title.textContent = t('conversation.title', { name: displayName || agentName })
  container.innerHTML = `<div class="conversation-empty">${t('conversation.loading')}</div>`
  openModal(overlay)
  await loadConversation()
}

// Latest page (offset=0); resets the loaded window.
async function loadConversation() {
  const container = document.getElementById('conversationContainer')
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(conversationAgentName)}/conversation?limit=${CONVERSATION_PAGE_SIZE}&offset=0`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    const d = await r.json()
    conversationEntries = Array.isArray(d.entries) ? d.entries : []
    conversationHasOlder = !!d.hasOlder
    renderConversation()
  } catch {
    if (container) container.innerHTML = `<div class="conversation-empty">${t('conversation.error')}</div>`
  }
}

// Page further back: fetch the window of entries immediately before the oldest
// loaded one and PREPEND it, keeping the scroll position so the view does not
// jump. Lets the operator read history beyond the on-screen window (and beyond
// the old fixed cap).
async function loadOlderConversation() {
  if (conversationLoadingOlder || !conversationHasOlder) return
  conversationLoadingOlder = true
  const btn = document.getElementById('conversationLoadOlder')
  if (btn) { btn.disabled = true; btn.textContent = t('conversation.loading') }
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const offset = conversationEntries.length
    const r = await fetch(`/api/agents/${encodeURIComponent(conversationAgentName)}/conversation?limit=${CONVERSATION_PAGE_SIZE}&offset=${offset}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    const d = await r.json()
    const older = Array.isArray(d.entries) ? d.entries : []
    conversationHasOlder = !!d.hasOlder
    if (older.length) {
      conversationEntries = older.concat(conversationEntries)
      renderConversation({ preserveScroll: true })
    } else {
      renderConversation()
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = t('conversation.load_more') }
  } finally {
    conversationLoadingOlder = false
  }
}

function fmtConvTs(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function renderConversation(opts = {}) {
  const container = document.getElementById('conversationContainer')
  if (!container) return
  const prevH = container.scrollHeight
  const prevTop = container.scrollTop
  const q = (document.getElementById('conversationSearch')?.value || '').toLowerCase().trim()
  const showActions = document.getElementById('conversationShowActions')?.checked
  let list = conversationEntries
  if (!showActions) list = list.filter(e => e.kind === 'in' || e.kind === 'out')
  if (q) list = list.filter(e => (e.text || '').toLowerCase().includes(q))
  // "Korábbiak betöltése" sits at the top so the operator can page further back;
  // shown whenever the server still has older entries beyond the loaded window.
  const olderBtn = conversationHasOlder
    ? `<button id="conversationLoadOlder" class="conv-load-older">${t('conversation.load_more')}</button>`
    : ''
  if (!list.length) {
    container.innerHTML = olderBtn || `<div class="conversation-empty">${t('conversation.empty')}</div>`
  } else {
    container.innerHTML = olderBtn + list.map(renderConvEntry).join('')
  }
  document.getElementById('conversationLoadOlder')?.addEventListener('click', loadOlderConversation)
  if (opts.preserveScroll) {
    // After prepending older messages, keep the previously-visible ones in place.
    container.scrollTop = prevTop + (container.scrollHeight - prevH)
  } else {
    container.scrollTop = container.scrollHeight
  }
}

function renderConvEntry(e) {
  const ts = fmtConvTs(e.ts)
  const txt = escapeHtml(e.text || '').replace(/\n/g, '<br>')
  if (e.kind === 'in') {
    return `<div class="conv-row conv-in"><div class="conv-bubble"><div class="conv-meta">Telegram be · ${ts}</div><div class="conv-text">${txt}</div></div></div>`
  }
  if (e.kind === 'out') {
    const lbl = escapeHtml(e.label || t('messages.conv.reply_label'))
    return `<div class="conv-row conv-out"><div class="conv-bubble"><div class="conv-meta">${lbl} · ${ts}</div><div class="conv-text">${txt}</div></div></div>`
  }
  if (e.kind === 'note') {
    return `<div class="conv-row conv-note"><div class="conv-note-text">📝 ${txt}</div></div>`
  }
  return `<div class="conv-row conv-action"><div class="conv-action-text">⚙ ${txt}<span class="conv-action-ts">${ts}</span></div></div>`
}

document.getElementById('conversationClose')?.addEventListener('click', () => {
  const overlay = document.getElementById('conversationOverlay')
  if (overlay) closeModal(overlay)
})
document.getElementById('conversationSearch')?.addEventListener('input', () => renderConversation())
document.getElementById('conversationShowActions')?.addEventListener('change', () => renderConversation())
document.getElementById('conversationRefresh')?.addEventListener('click', () => loadConversation())
;(() => {
  function routeFromHash() {
    let pageId = decodeURIComponent((location.hash || '').replace(/^#/, ''))
    if (!pageId) pageId = new URLSearchParams(window.location.search).get('page') || ''
    if (pageId && document.getElementById(pageId + 'Page')) switchPage(pageId)
  }
  window.addEventListener('hashchange', routeFromHash)
  routeFromHash()
})()

// ============================================================
// === Docs (read-only viewer for the project's docs/ folder) ===
// ============================================================

function escapeAttr(s) {
  return escapeHtml(String(s)).replace(/"/g, '&quot;')
}

// Minimal, dependency-free Markdown -> HTML renderer. Inputs come from the
// repo's own docs/ folder (trusted), but we HTML-escape everything anyway and
// only emit a fixed set of tags. Covers the constructs our docs use: fenced
// code, headings, hr, tables, ordered/unordered lists, blockquotes, paragraphs,
// and inline code/bold/italic/links.
function mdInline(text) {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) =>
    '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>')
  return s
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  const isBlockStart = (l) =>
    /^```/.test(l) || /^(#{1,6})\s/.test(l) || /^\s*[-*]\s+/.test(l) ||
    /^\s*\d+\.\s+/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /^\s*>\s?/.test(l) ||
    /^\s*([-*_])\1{2,}\s*$/.test(l) || /^\s*$/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      const code = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      i++
      out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>')
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { const lvl = h[1].length; out.push('<h' + lvl + '>' + mdInline(h[2].trim()) + '</h' + lvl + '>'); i++; continue }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const parseRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      const headers = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++ }
      let t = '<table><thead><tr>' + headers.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
      for (const r of rows) t += '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>'
      t += '</tbody></table>'
      out.push(t)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      out.push('<ul>' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ul>')
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      out.push('<ol>' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ol>')
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const q = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push('<blockquote>' + q.map(mdInline).join('<br>') + '</blockquote>')
      continue
    }
    if (/^\s*$/.test(line)) { i++; continue }
    const para = []
    while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++ }
    if (para.length) out.push('<p>' + para.map(mdInline).join('<br>') + '</p>')
  }
  return out.join('\n')
}

async function loadDocs() {
  const listEl = document.getElementById('docsList')
  const contentEl = document.getElementById('docsContent')
  if (!listEl) return
  listEl.innerHTML = '<p class="muted">' + t('docs.loading') + '</p>'
  let docs = []
  try {
    const res = await fetch('/api/docs')
    docs = await res.json()
    if (!Array.isArray(docs)) docs = []
  } catch (e) {
    listEl.innerHTML = '<p class="muted">' + t('docs.list_load_error') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
    return
  }
  if (!docs.length) {
    listEl.innerHTML = '<p class="muted">' + t('docs.empty_list') + '</p>'
    if (contentEl) contentEl.innerHTML = '<p class="muted">' + t('docs.empty_content') + '</p>'
    return
  }
  listEl.innerHTML = docs.map(d =>
    '<a href="#" class="docs-list-item" data-doc="' + escapeAttr(d.name) + '">' +
      '<span class="docs-list-title">' + escapeHtml(d.title || d.name) + '</span>' +
      (d.created ? '<span class="docs-list-date">' + escapeHtml(d.created) + '</span>' : '') +
    '</a>'
  ).join('')
  listEl.querySelectorAll('.docs-list-item').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      listEl.querySelectorAll('.docs-list-item').forEach(x => x.classList.remove('active'))
      a.classList.add('active')
      openDoc(a.dataset.doc)
    })
  })
  const first = listEl.querySelector('.docs-list-item')
  if (first) { first.classList.add('active'); openDoc(first.dataset.doc) }
}

async function openDoc(name) {
  const contentEl = document.getElementById('docsContent')
  if (!contentEl) return
  contentEl.innerHTML = '<p class="muted">' + t('docs.loading') + '</p>'
  try {
    const res = await fetch('/api/docs/' + encodeURIComponent(name))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const doc = await res.json()
    const content = doc.content || ''
    // Toolbar with a raw-.md download, then the rendered markdown.
    contentEl.innerHTML =
      '<div class="docs-content-toolbar">' +
        '<button class="btn-secondary btn-compact" id="docsDownloadBtn">' + t('docs.download_btn') + '</button>' +
      '</div>' +
      '<div class="docs-rendered markdown-body">' + renderMarkdown(content) + '</div>'
    const dl = document.getElementById('docsDownloadBtn')
    if (dl) dl.addEventListener('click', () => downloadMarkdown(name, content))
  } catch (e) {
    contentEl.innerHTML = '<p class="muted">' + t('docs.open_error') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
  }
}

// Download a doc's raw markdown as a .md file (client-side Blob, no server).
function downloadMarkdown(name, content) {
  try {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = /\.md$/.test(name) ? name : (name + '.md')
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (e) {
    showToast(t('common.toast.download_failed', { msg: String(e && e.message || e) }))
  }
}

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
