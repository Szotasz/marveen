import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'

function esc(s) {
  if (!s) return ''
  const d = document.createElement('div')
  d.textContent = String(s)
  return d.innerHTML
}

// ============================================================
// === Recall / Napló ===
// ============================================================

let recallInitialized = false
let recallSortDesc = true

export async function loadRecallPage() {
  if (!recallInitialized) {
    recallInitialized = true
    const today = new Date().toISOString().split('T')[0]
    document.getElementById('recallDate').value = today

    try {
      // /api/schedules/agents includes the main agent (agent-a); /api/agents lists sub-agents only
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
      timeline.innerHTML = `<p class="recall-error">${esc(getErrorMessage(err, t('recall.error')))}</p>`
      return
    }
    const data = await res.json()
    renderRecallSummary(summary, data)
    renderRecallTimeline(timeline, data)
  } catch {
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
            <span class="recall-label recall-label-agent">${esc(item.agent)}</span>
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
            <span class="recall-label recall-label-cat" data-cat="${esc(cat)}">${esc(item.category)}</span>
            <span class="recall-label recall-label-agent">${esc(item.agent)}</span>
          </div>
        </div>
        <div class="recall-item-content">${esc(item.content)}</div>
        ${item.keywords ? `<div class="recall-item-keywords">Kulcsszavak: ${esc(item.keywords)}</div>` : ''}
      </div>`
    }
  }
  el.innerHTML = html
}

// ============================================================
// === Background Tasks ===
// ============================================================

let bgInitialized = false
let bgRefreshTimer = null

export async function loadBgTasksPage() {
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
      showToast(getErrorMessage(data, t('common.error')))
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

    list.innerHTML = tasks.map(task => {
      const statusColors = { running: '#f59e0b', done: '#22c55e', failed: '#ef4444', timeout: '#6b7280' }
      const statusLabels = { running: () => t('bgTasks.status.running'), done: () => t('bgTasks.status.done'), failed: () => t('bgTasks.status.failed'), timeout: () => t('bgTasks.status.timeout') }
      const color = statusColors[task.status] || '#6b7280'
      const labelRaw = statusLabels[task.status]
      const label = labelRaw ? (typeof labelRaw === 'function' ? labelRaw() : labelRaw) : task.status
      const output = task.output ? `<pre style="margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;">${esc(task.output.slice(-2000))}</pre>` : ''
      return `<div style="margin-bottom:12px;padding:12px 16px;border-radius:8px;background:var(--surface);border:1px solid var(--border);border-left:3px solid ${color};">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-weight:600;font-size:13px;">${esc(task.id)}</span>
            <span class="badge" style="font-size:11px;background:${color};color:#fff;padding:2px 8px;border-radius:12px;">${label}</span>
            <span class="badge" style="font-size:11px;background:var(--primary);color:#fff;padding:2px 8px;border-radius:12px;">${esc(task.agent_id)}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-size:12px;color:var(--text-muted)">${esc(task.started_label)}</span>
            ${task.status === 'running' ? `<button class="btn btn-sm" onclick="viewBgTask('${esc(task.id)}')" style="font-size:11px;padding:2px 8px;">${t('bgTasks.output_btn')}</button><button class="btn btn-sm" onclick="cancelBgTask('${esc(task.id)}')" style="font-size:11px;padding:2px 8px;color:var(--danger)">${t('bgTasks.stop_btn')}</button>` : ''}
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-primary);margin-bottom:4px;">${esc(task.prompt)}</div>
        ${task.finished_label ? `<div style="font-size:12px;color:var(--text-muted);">${t('bgTasks.finished_label')} ${esc(task.finished_label)}</div>` : ''}
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

export function initRecallBgTasks() {
  // viewBgTask and cancelBgTask are called from inline onclick handlers in the
  // bg-tasks list template; expose as window globals to cross the ES module boundary.
  window.viewBgTask = viewBgTask
  window.cancelBgTask = cancelBgTask
}
