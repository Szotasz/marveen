// Router and navigation core module (S-3, issue #3).
//
// Exports:
//   registerPage(name, { enter?, leave? })  -- register per-page lifecycle hooks
//   registerAlias(from, to, before?)        -- register page-id alias with optional side-effect
//   switchPage(pageId)                       -- navigate to a page
//   renderNav()                              -- translate sidebar nav labels (called on lang change)
//   renderStaticI18n()                       -- translate static HTML elements (called on lang change)
//   boot()                                   -- wire up DOM: nav clicks, hash routing, i18n, initial render
//
// Design notes:
//   - Page handlers (loadXxx, startPoll, stopPoll) stay in app.js and are registered via
//     registerPage({ enter, leave }). The leave hook can abort navigation by returning false.
//   - The 'team' -> 'agents' alias and any other hash aliases are registered via registerAlias,
//     keeping app.js-specific side-effects (like _agentsActiveView) out of this module.
//   - renderNav and renderStaticI18n are exported so app.js can call renderStaticI18n() directly
//     after brand tokens are updated (initSidebarBrand fetch).

import { t, onLangChange } from './i18n.js'

// ── Page registry ─────────────────────────────────────────────────────────────

const _pageRegistry = new Map()   // name -> { enter?, leave? }
const _aliasRegistry = new Map()  // from -> { to, before? }
let _currentPage = null

// DOM refs populated in boot().
let _navLinks = null
let _pages = null

// Optional hook: called after every page switch with the resolved pageId.
// Used by sidebar group logic (app.js) to auto-open the active group.
let _pageSwitchHook = null
export function setPageSwitchHook(fn) { _pageSwitchHook = fn }

/**
 * Register lifecycle hooks for a page.
 * - leave({ to }) can return false to abort navigation.
 * - lazy: true marks the enter() as a lazy module loader — switchPage wraps it
 *   with a loading overlay and timeout. Do NOT set this on static pages whose
 *   enter() is an async data-fetch (always-async != lazy-import).
 */
export function registerPage(name, { enter = null, leave = null, lazy = false } = {}) {
  _pageRegistry.set(name, { enter, leave, lazy })
}

/** Register a page-id alias: hash `from` is rewritten to `to`; `before` fires first. */
export function registerAlias(from, to, before = null) {
  _aliasRegistry.set(from, { to, before })
}

// ── Page loading overlay (for async enter callbacks) ─────────────────────────

let _loadingOverlay = null

function _ensureOverlay() {
  if (_loadingOverlay) return _loadingOverlay
  _loadingOverlay = document.createElement('div')
  _loadingOverlay.id = 'page-loading-overlay'
  _loadingOverlay.setAttribute('aria-live', 'polite')
  _loadingOverlay.setAttribute('aria-label', 'Betöltés...')
  Object.assign(_loadingOverlay.style, {
    position: 'fixed', inset: '0', zIndex: '9999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.08)', backdropFilter: 'blur(1px)',
    pointerEvents: 'all',
  })
  _loadingOverlay.innerHTML = '<div class="spinner"></div>'
  document.body.appendChild(_loadingOverlay)
  return _loadingOverlay
}

function _showPageLoading() {
  _ensureOverlay().hidden = false
  document.querySelector('.sidebar-nav')?.setAttribute('aria-disabled', 'true')
}

function _hidePageLoading() {
  if (_loadingOverlay) _loadingOverlay.hidden = true
  document.querySelector('.sidebar-nav')?.removeAttribute('aria-disabled')
}

function _showPageError(pageId, err) {
  console.error('[lazy-load] Failed to load page:', pageId, err)
  _hidePageLoading()
  const pageEl = document.getElementById(pageId + 'Page')
  if (!pageEl) return
  pageEl.querySelector('.page-load-error')?.remove()
  const errDiv = document.createElement('div')
  errDiv.className = 'page-load-error'
  errDiv.setAttribute('role', 'alert')
  errDiv.style.cssText = 'padding:2rem;display:flex;gap:1rem;align-items:center;'
  const msg = document.createElement('span')
  msg.textContent = 'Nem sikerült betölteni az oldalt.'
  const retryBtn = document.createElement('button')
  retryBtn.className = 'btn'
  retryBtn.setAttribute('data-variant', 'secondary')
  retryBtn.textContent = 'Újra'
  retryBtn.addEventListener('click', () => { errDiv.remove(); switchPage(pageId) })
  errDiv.appendChild(msg)
  errDiv.appendChild(retryBtn)
  pageEl.prepend(errDiv)
}

// ── Router ────────────────────────────────────────────────────────────────────

export function switchPage(pageId) {
  // Resolve alias (e.g. 'team' -> 'agents' with a side-effect in app.js).
  const alias = _aliasRegistry.get(pageId)
  if (alias) {
    alias.before?.()
    pageId = alias.to
  }

  // Leave hook: skipped when re-navigating to the same page (e.g. lang-change re-render).
  if (_currentPage !== null && _currentPage !== pageId) {
    const cur = _pageRegistry.get(_currentPage)
    if (cur?.leave?.({ to: pageId }) === false) return
  }

  // Update page visibility and nav active state.
  _pages?.forEach(p => { p.hidden = p.id !== pageId + 'Page' })
  _navLinks?.forEach(l => l.classList.toggle('active', l.dataset.page === pageId))
  document.querySelector('main')?.classList.toggle('kanban-active', pageId === 'kanban')

  _currentPage = pageId
  const pageReg = _pageRegistry.get(pageId)
  const result = pageReg?.enter?.()
  // Only apply the loading overlay for pages explicitly marked lazy: true.
  // Static pages whose enter() happens to be async (loadOverview, loadKanban, etc.)
  // must NOT trigger the overlay -- they are fire-and-forget data fetches, not
  // blocking module loads. Using the "returns a Promise" heuristic would block
  // every navigation until the API calls resolve.
  if (pageReg?.lazy && result instanceof Promise) {
    _showPageLoading()
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    Promise.race([result, timeout])
      .then(() => _hidePageLoading())
      .catch(err => _showPageError(pageId, err))
  }
  _pageSwitchHook?.(pageId)
}

// ── i18n: nav labels ──────────────────────────────────────────────────────────

const NAV_I18N = {
  overview: 'nav.overview', kanban: 'nav.kanban', archived: 'nav.archived',
  agents: 'nav.agents', team: 'nav.team',
  messages: 'nav.messages', tasks: 'nav.tasks', memories: 'nav.memories',
  recall: 'nav.recall', naplo: 'nav.recall', bgTasks: 'nav.bgTasks',
  skills: 'nav.skills', connectors: 'nav.connectors', migrate: 'nav.migrate',
  approvals: 'nav.approvals',
  docs: 'nav.docs', status: 'nav.status',
  settings: 'nav.settings', vault: 'nav.vault', tokenUsage: 'nav.tokenUsage',
  ideas: 'nav.ideas', federation: 'nav.federation', updates: 'nav.updates',
}

export function renderNav() {
  document.querySelectorAll('.sb-link[data-page] .sb-label').forEach((span) => {
    const page = span.closest('[data-page]')?.dataset?.page
    if (page && NAV_I18N[page]) span.textContent = t(NAV_I18N[page])
  })
}

// ── i18n: static elements ─────────────────────────────────────────────────────

const PAGE_HEADER_I18N = {
  agentsPage:     { title: 'agents.page_title',     sub: 'agents.page_subtitle' },
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
  settingsPage:   { title: 'settings.page_title',    sub: 'settings.page_subtitle' },
  ideasPage:      { title: 'ideas.page_title',       sub: 'ideas.page_subtitle' },
  vaultPage:      { title: 'vault.page_title',       sub: 'vault.page_subtitle' },
  tokenUsagePage: { title: 'tokenUsage.page_title',  sub: 'tokenUsage.page_subtitle' },
  updatesPage:    { title: 'updates.page_title',     sub: null },
  naploPage:      { title: 'naplo.page_title',       sub: 'naplo.page_subtitle' },
  federationPage: { title: 'federation.page_title',  sub: 'federation.page_subtitle' },
  approvalsPage:  { title: 'approvals.page_title',   sub: 'approvals.page_subtitle' },
}

export function renderStaticI18n() {
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
  const statusKeys = ['kanban.col.planned', 'kanban.col.in_progress', 'kanban.col.waiting', 'kanban.col.testing', 'kanban.col.done']
  const statuses = ['planned', 'in_progress', 'waiting', 'testing', 'done']
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

  // Overview stat labels
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
  // Elements whose translation contains inline markup: set innerHTML.
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml)
  })
}

// ── Boot ──────────────────────────────────────────────────────────────────────

export function boot() {
  _navLinks = document.querySelectorAll('.sb-link[data-page], .nav-link[data-page]')
  _pages = document.querySelectorAll('.page')

  // Mobile off-canvas sidebar toggle.
  const sidebarEl = document.querySelector('.sidebar')
  const sidebarBackdrop = document.getElementById('sidebarBackdrop')
  const mobileMenuBtn = document.getElementById('mobileMenuBtn')

  function setSidebarOpen(open) {
    sidebarEl?.classList.toggle('open', open)
    sidebarBackdrop?.classList.toggle('open', open)
    mobileMenuBtn?.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  mobileMenuBtn?.addEventListener('click', () => setSidebarOpen(!sidebarEl?.classList.contains('open')))
  sidebarBackdrop?.addEventListener('click', () => setSidebarOpen(false))

  // Nav click -> set hash (hashchange listener drives the actual switchPage call).
  _navLinks.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault()
      const pageId = link.dataset.page
      // Same hash won't fire 'hashchange', so switch manually; otherwise let hash be the source of truth.
      if (location.hash.slice(1) === pageId) switchPage(pageId)
      else location.hash = pageId
      setSidebarOpen(false)
    })
  })

  // Hash -> switchPage. Also handles ?page= query param as fallback.
  function routeFromHash() {
    let pageId = decodeURIComponent((location.hash || '').replace(/^#/, ''))
    if (!pageId) pageId = new URLSearchParams(window.location.search).get('page') || ''
    // Can navigate to a registered alias even if there's no corresponding DOM page element.
    if (pageId && (document.getElementById(pageId + 'Page') || _aliasRegistry.has(pageId))) {
      switchPage(pageId)
    }
  }

  window.addEventListener('hashchange', routeFromHash)

  // i18n: translate on boot and whenever language changes.
  renderNav()
  renderStaticI18n()
  onLangChange(() => {
    renderNav()
    renderStaticI18n()
    // Re-enter the current page so page-specific translated content is refreshed.
    if (_currentPage) switchPage(_currentPage)
  })

  // Initial route from URL hash (or default page if no hash).
  routeFromHash()
}
