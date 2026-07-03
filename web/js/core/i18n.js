// === i18n module ===
// Extracted from app.js. Exports: t, setLang, renderNav, renderStaticI18n.

// === i18n runtime ===
// Priority: localStorage['marveen.lang'] > DASHBOARD_LANG (server default, read
// from /api/settings on init) > 'hu' (hardcoded fallback).
// Rick's spec (kanban card 209696a9): t(key,params), window._i18n={hu,en},
// window._lang; {name} interpolation; EN-fallback then key; dev-mode warning.
// Top-level declarations (not IIFE) so that t() and setLang() are accessible
// by name within the module scope without window. prefix.
const _I18N_LS_KEY = 'marveen.lang'
const _I18N_VALID = new Set(['hu', 'en'])

// Brand tokens ({brand} = product/brand name, {bot} = main agent display
// name, {agentId} = canonical slug) are filled from /api/marveen once it
// resolves (see initSidebarBrand). Until then these defaults keep a stock
// install byte-identical. Explicit params passed to t() still win over them.
window._brandTokens = window._brandTokens || { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' }

function t(key, params = {}) {
  const lang = window._lang || 'hu'
  const str =
    window._i18n?.[lang]?.[key] ??
    window._i18n?.['en']?.[key] ??
    key
  if (str === key && localStorage.getItem('marveen.dev') === '1') {
    console.warn('[i18n] missing key:', key)
  }
  const vals = { ...window._brandTokens, ...params }
  return str.replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? vals[k] : `{${k}}`))
}
window.t = t

function _applyLang(lang) {
  window._lang = _I18N_VALID.has(lang) ? lang : 'hu'
}

// Initialise from localStorage; server default fetched async below.
_applyLang(localStorage.getItem(_I18N_LS_KEY) || 'hu')

// Fetch server default (DASHBOARD_LANG) and apply only if localStorage not set.
fetch('/api/settings')
  .then(r => r.ok ? r.json() : null)
  .then(data => {
    if (!data || localStorage.getItem(_I18N_LS_KEY)) return
    const entry = (data.settings || []).find(s => s.key === 'DASHBOARD_LANG')
    if (entry && _I18N_VALID.has(entry.value)) _applyLang(entry.value)
  })
  .catch(() => {})

function setLang(lang) {
  if (!_I18N_VALID.has(lang)) return
  window._lang = lang
  localStorage.setItem(_I18N_LS_KEY, lang)
  renderNav()
  // Static elements (kanban column titles, hints, empty states) are otherwise
  // only translated at DOMContentLoaded -- re-apply them on every switch so the
  // currently-open page updates live, not just after a manual reload.
  renderStaticI18n()
  // Re-render the active page by re-triggering the switchPage handler.
  // window.switchPage is set by app.js after module init.
  const activeLink = document.querySelector('.sb-link.active[data-page]')
  if (activeLink) window.switchPage?.(activeLink.dataset.page)
}
window.setLang = setLang

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


export { t, setLang, renderNav, renderStaticI18n }
