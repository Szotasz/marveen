import { t, setLang, renderNav, renderStaticI18n } from '/js/core/i18n.js'
import { mainAgentId } from '/js/core/api.js'
import { escapeHtml } from '/js/core/dom.js'
const esc = escapeHtml
import { openModal, closeModal, showToast, skillModalScope, setSkillModalScope } from '/js/core/ui.js'
import { loadActivity, startActivityPoll, stopActivityPoll } from '/js/pages/activity.js'
import { loadTeamGraph, renderTeamGraph } from '/js/pages/team.js'
import { loadMessagesPage, loadChatAgentList, loadChatThread } from '/js/pages/messages.js'
import { loadOverview } from '/js/pages/overview.js'
import { loadKanban, startKanbanRefresh, stopKanbanRefresh } from '/js/pages/kanban.js'
import { loadAgents } from '/js/pages/agents.js'
import { loadMemAgents, loadMemStats, loadMemories } from '/js/pages/memories.js'
import { loadRecallPage } from '/js/pages/recall.js'
import { loadBgTasksPage, viewBgTask, cancelBgTask } from '/js/pages/bgTasks.js'
import { loadTokenUsage } from '/js/pages/tokenUsage.js'
import { loadIdeasPage, openIdeaDetail, openIdeaEdit, openIdeaBreakdown, setIdeaStatus, deleteIdeaItem } from '/js/pages/ideas.js'
import { loadNaplo } from '/js/pages/naplo.js'
import { loadConnectors } from '/js/pages/connectors.js'
import { loadVaultPage, loadVault } from '/js/pages/vault.js'
import { loadStatus } from '/js/pages/status.js'
import { loadMigrateAgents } from '/js/pages/migrate.js'
import { loadGlobalSkills } from '/js/pages/skills.js'
import { loadUpdates } from '/js/pages/updates.js'
import { loadAutonomy } from '/js/pages/autonomy.js'
import { loadSettings, settingsDirty } from '/js/pages/settings.js'



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
  if (pageId === 'kanban') { if (typeof _initGanttViewSwitcher === 'function') _initGanttViewSwitcher(); loadKanban(); startKanbanRefresh() }
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
// ============================================================
// loadActivity, startActivityPoll, stopActivityPoll -> js/pages/activity.js
// ============================================================
// Kanban page -> js/pages/kanban.js
// Agents page -> js/pages/agents.js
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
// memories page -> js/pages/memories.js
function pauseIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
}
function playIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
}
function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
}

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

// connectors page -> js/pages/connectors.js
// escapeHtml -> imported from /js/core/dom.js

// status page -> js/pages/status.js
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

// migrate page -> js/pages/migrate.js
// skills page -> js/pages/skills.js
// loadTeamGraph, renderTeamGraph -> js/pages/team.js

// messages + inter-agent log -> js/pages/messages.js
// loadOverview -> js/pages/overview.js
// updates page -> js/pages/updates.js
// === Init ===
// populateAvatarGrid / loadAvailableModels -> js/pages/agents.js (self-init)
loadMemAgents()
loadOverview()

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

// recall page -> js/pages/recall.js
// bgTasks page -> js/pages/bgTasks.js
// autonomy page -> js/pages/autonomy.js
// settings page -> js/pages/settings.js
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

// tokenUsage page -> js/pages/tokenUsage.js
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
    else if (!pageId) switchPage('overview')
  }
  window.switchPage = switchPage
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

// naplo page -> js/pages/naplo.js

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
    let cards = (Array.isArray(kanbanCards) ? kanbanCards : []).filter(c => c.due_date)

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

    // Re-render on data refresh (hook into global loadKanban completion)
    const _origRenderKanban = window.renderKanban
    if (typeof _origRenderKanban === 'function') {
      window.renderKanban = function () {
        _origRenderKanban.apply(this, arguments)
        if (ganttEl.style.display !== 'none') renderGantt()
      }
    }
  }

  window._initGanttViewSwitcher = initGanttViewSwitcher
  window.renderGantt = renderGantt
})()
// ESM bootstrap: expose functions referenced by inline onclick="" attributes.
// These are the only top-level names that must stay on window once the file
// is loaded as a module (<script type="module">).
window.openTerminalModal = openTerminalModal
window.openConversationModal = openConversationModal
window.loadGlobalSkills = loadGlobalSkills
window.cancelBgTask = cancelBgTask
window.deleteIdeaItem = deleteIdeaItem
window.loadChatThread = loadChatThread
window.openIdeaBreakdown = openIdeaBreakdown
window.openIdeaDetail = openIdeaDetail
window.openIdeaEdit = openIdeaEdit
window.setIdeaStatus = setIdeaStatus
window.viewBgTask = viewBgTask
