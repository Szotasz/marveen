import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'

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
      timeline.innerHTML = `<p class="recall-error">${escapeHtml(err.error || t('recall.error'))}</p>`
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
    parts.push(`<strong>${escapeHtml(dateRange.from)}</strong>`)
  } else if (dateRange.from && dateRange.to) {
    parts.push(`<strong>${escapeHtml(dateRange.from)}</strong> &ndash; <strong>${escapeHtml(dateRange.to)}</strong>`)
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
      html += `<div class="recall-date-header">${escapeHtml(dateStr)}</div>`
    }
    if (item.type === 'log') {
      html += `<div class="recall-item recall-log">
        <div class="recall-item-header">
          <span class="recall-item-label">${escapeHtml(item.label)}</span>
          <div class="recall-item-badges">
            <span class="recall-badge recall-badge-agent">${escapeHtml(item.agent)}</span>
          </div>
        </div>
        <div class="recall-item-content">${escapeHtml(item.content)}</div>
      </div>`
    } else {
      const cat = item.category || 'warm'
      html += `<div class="recall-item recall-memory" data-cat="${escapeHtml(cat)}">
        <div class="recall-item-header">
          <span class="recall-item-label">${escapeHtml(item.label)}</span>
          <div class="recall-item-badges">
            <span class="recall-badge recall-badge-cat" data-cat="${escapeHtml(cat)}">${escapeHtml(item.category)}</span>
            <span class="recall-badge recall-badge-agent">${escapeHtml(item.agent)}</span>
          </div>
        </div>
        <div class="recall-item-content">${escapeHtml(item.content)}</div>
        ${item.keywords ? `<div class="recall-item-keywords">Kulcsszavak: ${escapeHtml(item.keywords)}</div>` : ''}
      </div>`
    }
  }
  el.innerHTML = html
}

export { loadRecallPage }
