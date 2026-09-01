import { escapeHtml, escapeAttr } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getErrorMessage } from './error-message.js'
import { initTenantSelector } from './tenant-selector.js'



// ============================================================
// === Approvals ===
// ============================================================

const APPROVALS_PAGE_LIMIT = 50

let _approvalsCountdownInterval = null
const _approvalsState = { status: '', agent: '', category: '', offset: 0 }
let _approvalsAll = []
let _approvalsTenantGetter = null

export async function loadApprovalsPage() {
  const tbody = document.getElementById('approvalsTbody')
  const statsEl = document.getElementById('approvalsStats')
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:24px;text-align:center">${t('approvals.loading')}</td></tr>`
  statsEl.innerHTML = ''
  if (_approvalsCountdownInterval) { clearInterval(_approvalsCountdownInterval); _approvalsCountdownInterval = null }

  try {
    const tenant = _approvalsTenantGetter?.()
    const url = tenant ? `/api/approvals?limit=500&tenant=${encodeURIComponent(tenant)}` : '/api/approvals?limit=500'
    const res = await fetch(url)
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
           <button class="btn approvals-decide" data-variant="primary" data-size="compact" data-id="${escapeAttr(a.id)}" data-decision="approved" style="font-size:11px">${t('approvals.btn.approve')}</button>
           <button class="btn approvals-decide" data-variant="danger" data-size="compact" data-id="${escapeAttr(a.id)}" data-decision="rejected" style="font-size:11px">${t('approvals.btn.reject')}</button>
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
    <button class="btn" data-variant="secondary" data-size="compact" ${hasPrev ? '' : 'disabled'} id="approvalsPrev">&#8592; Előző</button>
    <span style="font-size:12px;color:var(--text-muted)">${offset + 1}-${Math.min(offset + APPROVALS_PAGE_LIMIT, total)} / ${total}</span>
    <button class="btn" data-variant="secondary" data-size="compact" ${hasNext ? '' : 'disabled'} id="approvalsNext">Következő &#8594;</button>
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
    if (!res.ok) { showToast(t('approvals.toast.error', { msg: getErrorMessage(data, 'HTTP ' + res.status) })); return }
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

export async function initApprovals() {
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
  _approvalsTenantGetter = await initTenantSelector('approvalsTenantSelectorContainer', () => loadApprovalsPage())
}
