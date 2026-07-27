// Scheduled tasks (S-7, issue #3).
//
// Exports:
//   loadSchedules()      -- fetch + render the tasks list (registerPage enter)
//   loadScheduleAgents() -- refresh the agent selector (used by openEditSchedule)
//   openEditSchedule(task) -- open the edit modal for an existing schedule
//   getScheduleCron()    -- read the cron expression from the modal form

import { escapeHtml, mainAgentId } from './util.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'
import { avatarBust } from './agents.js'

// ─── Local utilities ─────────────────────────────────────────────────────────


function pauseIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
}
function playIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
}
function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
}

// ─── DI callbacks (injected by initSchedules) ─────────────────────────────────
let _openModal = null
let _closeModal = null

export function initSchedules({ openModal, closeModal } = {}) {
  _openModal = openModal
  _closeModal = closeModal
}

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
  _openModal?.(scheduleModalOverlay)
  loadScheduleAgents().then(() => {
    setTimeout(() => document.getElementById('scheduleName').focus(), 200)
  })
})
document.getElementById('scheduleModalClose').addEventListener('click', () => _closeModal?.(scheduleModalOverlay))
scheduleModalOverlay.addEventListener('click', (e) => { if (e.target === scheduleModalOverlay) _closeModal?.(scheduleModalOverlay) })

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

// Resolved once at page load: the server's actual bind port (WEB_PORT), not
// window.location.port which reflects the browser-side URL (e.g. 8443 for a
// tailscale-serve HTTPS PWA) and would be wrong in agent curl prompts.
let __serverPort = 3420
fetch('/api/network-info').then(r => r.ok ? r.json() : {}).then(info => {
  if (info.port) __serverPort = info.port
}).catch(() => {})

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
    prompt: () => `Ellenorizd a kanban tablat (curl -s http://localhost:${__serverPort}/api/kanban). Ha van olyan kartya aminek ma jar le a hatrideje vagy urgent prioritasu es meg nincs done, szolj Telegramon. Ha minden rendben, ne irj semmit.`,
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
  document.getElementById('schedulePrompt').value = typeof tpl.prompt === 'function' ? tpl.prompt() : tpl.prompt
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

export function getScheduleCron() {
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

export async function loadScheduleAgents() {
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

export async function loadSchedules() {
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
        <img src="${agent.avatar}${avatarBust()}" alt="" onerror="this.style.display='none'">
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
document.getElementById('scheduleRunHistoryClose').addEventListener('click', () => _closeModal?.(scheduleRunHistoryOverlay))
scheduleRunHistoryOverlay.addEventListener('click', (e) => { if (e.target === scheduleRunHistoryOverlay) _closeModal?.(scheduleRunHistoryOverlay) })

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
  _openModal?.(scheduleRunHistoryOverlay)
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
          <img src="${agent.avatar}${avatarBust()}" alt="" onerror="this.style.display='none'">
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
          <img src="${agent.avatar}${avatarBust()}" alt="" onerror="this.style.display='none'">
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
          <div class="week-task-avatar"><img src="${agent.avatar}${avatarBust()}" alt=""></div>
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

export function openEditSchedule(task) {
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

    _openModal?.(scheduleModalOverlay)
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
    _closeModal?.(scheduleModalOverlay)
    loadSchedules()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    saveScheduleBtn.disabled = false
    saveScheduleBtn.querySelector('.btn-text').hidden = false
    saveScheduleBtn.querySelector('.btn-loading').hidden = true
  }
})

