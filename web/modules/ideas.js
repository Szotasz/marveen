import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'
import { kanbanState, showBreakdownModal } from './kanban.js'


let _openModal = null
let _closeModal = null

let ideas = []
let ideasPromoteId = null
let ideaEditId = null
let ideaDetailId = null
const STATUS_COLORS = { new: 'var(--accent)', reviewed: '#f59e0b', kanban: '#22c55e', rejected: '#ef4444' }
const STATUS_LABELS = { new: () => t('ideas.status.new'), reviewed: () => t('ideas.status.reviewed'), kanban: () => t('ideas.status.kanban'), rejected: () => t('ideas.status.rejected') }

export async function loadIdeasPage() {
  const statusFilter = document.getElementById('ideaStatusFilter')?.value ?? 'active'
  const categoryFilter = document.getElementById('ideaCategoryFilter')?.value || ''
  const params = new URLSearchParams()
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
  _openModal(document.getElementById('ideaModalOverlay'))
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
  _openModal(document.getElementById('ideaModalOverlay'))
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
  _closeModal(document.getElementById('ideaModalOverlay'))
  loadIdeasPage()
}

async function deleteIdeaItem(id) {
  if (!confirm(t('kanban.confirm.delete'))) return
  await fetch(`/api/ideas/${id}`, { method: 'DELETE' })
  loadIdeasPage()
}

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
  _openModal(document.getElementById('ideaDetailOverlay'))
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

function openIdeaPromote(id) {
  ideasPromoteId = id
  _openModal(document.getElementById('ideaPromoteOverlay'))
}

async function promoteIdea(phase) {
  if (!ideasPromoteId) return
  const res = await fetch(`/api/ideas/${ideasPromoteId}/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase }) })
  const data = await res.json()
  ideasPromoteId = null
  _closeModal(document.getElementById('ideaPromoteOverlay'))
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

async function openIdeaBreakdown(id) {
  const idea = ideas.find(i => i.id === id)
  if (!idea) return
  if (!kanbanState.assignees.length) {
    try { kanbanState.assignees = await (await fetch('/api/kanban/assignees')).json() } catch { /* dropdown falls back to "nincs" */ }
  }
  showToast(t('ideas.toast.ai_elaborating'))
  try {
    const res = await fetch(`/api/ideas/${id}/breakdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Breakdown hiba'); return }
    if (!data.subtasks || !data.subtasks.length) { showToast('Az AI nem adott vissza alfeladatot'); return }
    kanbanState.breakdownMode = 'idea'
    kanbanState.breakdownIdeaId = id
    kanbanState.breakdownSubtasks = data.subtasks
    showBreakdownModal(data.subtasks, { title: idea.title })
    const dodSection = document.getElementById('breakdownDoDSection')
    if (dodSection) { dodSection.style.display = ''; document.getElementById('breakdownSuccessCriteria').value = '' }
  } catch {
    showToast('Breakdown hiba')
  }
}

export function initIdeas({ openModal, closeModal }) {
  _openModal = openModal
  _closeModal = closeModal

  // Expose inline onclick handlers on window (used in template strings)
  window.openIdeaDetail = openIdeaDetail
  window.setIdeaStatus = setIdeaStatus
  window.openIdeaEdit = openIdeaEdit
  window.openIdeaBreakdown = openIdeaBreakdown
  window.deleteIdeaItem = deleteIdeaItem

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

  document.getElementById('ideaDetailClose')?.addEventListener('click', () => _closeModal(document.getElementById('ideaDetailOverlay')))
  document.getElementById('ideaDetailCloseBtn')?.addEventListener('click', () => _closeModal(document.getElementById('ideaDetailOverlay')))
  document.getElementById('ideaDetailEditBtn')?.addEventListener('click', () => {
    if (!ideaDetailId) return
    _closeModal(document.getElementById('ideaDetailOverlay'))
    openIdeaEdit(ideaDetailId)
  })

  document.getElementById('ideaNewBtn')?.addEventListener('click', openIdeaNew)
  document.getElementById('ideaModalClose')?.addEventListener('click', () => _closeModal(document.getElementById('ideaModalOverlay')))
  document.getElementById('ideaModalCancel')?.addEventListener('click', () => _closeModal(document.getElementById('ideaModalOverlay')))
  document.getElementById('ideaModalSave')?.addEventListener('click', saveIdea)
  document.getElementById('ideaPromoteClose')?.addEventListener('click', () => _closeModal(document.getElementById('ideaPromoteOverlay')))
  document.getElementById('ideaPromoteCancel')?.addEventListener('click', () => _closeModal(document.getElementById('ideaPromoteOverlay')))
  document.getElementById('ideaPromoteDetail')?.addEventListener('click', () => promoteIdea('detail'))
  document.getElementById('ideaPromotePlan')?.addEventListener('click', () => promoteIdea('plan'))
  document.getElementById('ideaStatusFilter')?.addEventListener('change', loadIdeasPage)
  document.getElementById('ideaCategoryFilter')?.addEventListener('change', loadIdeasPage)
}
