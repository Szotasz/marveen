import { t } from '/js/core/i18n.js'
import { escapeHtml as esc } from '/js/core/dom.js'

// === Naplo (Audit Timeline) ===
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

export { loadNaplo }
