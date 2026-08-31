import { escapeHtml } from './util.js'
import { renderMarkdown } from './docs-research.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'

// ── DOM refs ─────────────────────────────────────────────────────────────────

const agentFilter       = () => document.getElementById('wdAgentFilter')
const typeFilter        = () => document.getElementById('wdTypeFilter')
const contentTypeFilter = () => document.getElementById('wdContentTypeFilter')
const tenantFilter      = () => document.getElementById('wdTenantFilter')
const tenantFilterWrap  = () => document.getElementById('wdTenantFilterWrap')
const searchBtn         = () => document.getElementById('wdSearchBtn')
const listEl            = () => document.getElementById('wdList')
const emptyEl           = () => document.getElementById('wdEmpty')
const previewPanel      = () => document.getElementById('wdPreview')
const previewTitle      = () => document.getElementById('wdPreviewTitle')
const previewMeta       = () => document.getElementById('wdPreviewMeta')
const previewBody       = () => document.getElementById('wdPreviewBody')
const previewDelete     = () => document.getElementById('wdPreviewDelete')
const previewClose      = () => document.getElementById('wdPreviewClose')

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(unixSec) {
  if (!unixSec) return ''
  return new Date(unixSec * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

// ── Fetch & render list ───────────────────────────────────────────────────────

export async function loadWorkspaceDocs() {
  const agent       = agentFilter()?.value?.trim() || ''
  const type        = typeFilter()?.value || ''
  const contentType = contentTypeFilter()?.value || ''
  const tenant      = tenantFilter()?.value?.trim() || ''

  const params = new URLSearchParams()
  if (agent)       params.set('agent', agent)
  if (type)        params.set('type', type)
  if (contentType) params.set('content_type', contentType)
  if (tenant)      params.set('tenant', tenant)

  try {
    const res = await fetch(`/api/workspace?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    renderList(Array.isArray(data.items) ? data.items : [])
  } catch (err) {
    showToast(`Betöltési hiba: ${err.message}`, 'error')
  }
}

function renderList(docs) {
  const el  = listEl()
  const emp = emptyEl()
  if (!el || !emp) return

  if (!docs.length) {
    el.innerHTML = ''
    emp.hidden = false
    return
  }
  emp.hidden = true

  el.innerHTML = `<div class="table-wrap"><table class="table" data-variant="compact">
    <thead>
      <tr>
        <th>Cím</th>
        <th>Agent</th>
        <th>Típus</th>
        <th>Tartalom</th>
        <th>Méret</th>
        <th>Módosítva</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${docs.map(d => `
        <tr data-wd-id="${escapeHtml(d.id)}">
          <td>${escapeHtml(d.title)}${d.task_ref ? ' <span style="color:var(--text-muted);font-size:11px">[' + escapeHtml(d.task_ref) + ']</span>' : ''}</td>
          <td style="color:var(--text-muted)">${escapeHtml(d.agent_id)}</td>
          <td><code>${escapeHtml(d.type)}</code></td>
          <td><code>${escapeHtml(d.content_type)}</code></td>
          <td style="color:var(--text-muted)">${fmtBytes(d.size_bytes)}</td>
          <td style="color:var(--text-muted)">${fmtTime(d.updated_at)}</td>
          <td style="white-space:nowrap">
            <button class="btn wd-view-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(d.id)}" data-title="${escapeHtml(d.title)}">Megtekint</button>
            <button class="btn wd-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(d.id)}" style="color:var(--danger)">Törlés</button>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table></div>`
}

// ── Preview ───────────────────────────────────────────────────────────────────

let _previewDoc = null

async function openPreview(id, title) {
  const panel = previewPanel()
  const body  = previewBody()
  const ttl   = previewTitle()
  const meta  = previewMeta()
  if (!panel || !body || !ttl) return

  _previewDoc = null
  ttl.textContent = title || id
  if (meta) meta.textContent = ''
  body.innerHTML = '<span style="color:var(--text-muted)">Betöltés...</span>'
  panel.hidden = false
  if (previewDelete()) previewDelete().dataset.id = id

  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const doc = await res.json()
    _previewDoc = doc
    if (meta) meta.textContent = `${doc.type} | ${doc.content_type} | ${fmtBytes(doc.size_bytes)} | ${doc.agent_id}`
    renderPreview(body, doc)
  } catch (err) {
    body.innerHTML = `<span style="color:var(--danger)">Hiba: ${escapeHtml(err.message)}</span>`
  }
}

function renderPreview(container, doc) {
  if (doc.content_type === 'binary') {
    if (!doc.content_blob_b64) {
      container.innerHTML = '<span style="color:var(--text-muted)">Bináris tartalom nem elérhető.</span>'
      return
    }
    const bytes = atob(doc.content_blob_b64)
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    const blob = new Blob([arr], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.doc_key || `workspace-${doc.id}`
    a.textContent = 'Letöltés'
    a.className = 'btn'
    a.dataset.variant = 'primary'
    a.dataset.size = 'compact'
    container.innerHTML = ''
    container.appendChild(a)
    return
  }

  const content = doc.content || ''

  if (doc.content_type === 'code') {
    container.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;background:var(--bg-code,var(--bg-input));padding:12px;border-radius:4px;overflow-x:auto;max-height:500px;overflow-y:auto;line-height:1.5">${escapeHtml(content)}</pre>`
    return
  }

  // text: try markdown rendering if it looks like markdown, otherwise plain pre
  const looksLikeMd = /^(#{1,6}\s|>\s|\*\*|```|\* |- |\d+\. )/.test(content.trimStart())
  if (looksLikeMd) {
    container.innerHTML = `<div class="markdown-body md-rendered" style="padding:12px;overflow-y:auto;max-height:500px;font-size:13px">${renderMarkdown(content)}</div>`
  } else {
    container.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;background:var(--surface-2);padding:12px;border-radius:4px;overflow-x:auto;max-height:500px;overflow-y:auto">${escapeHtml(content)}</pre>`
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

async function deleteWorkspaceDoc(id) {
  if (!confirm('Biztosan törlöd ezt a munkadokumentumot?')) return
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    showToast('Dokumentum törölve.', 'success')
    const panel = previewPanel()
    if (panel && !panel.hidden) panel.hidden = true
    _previewDoc = null
    loadWorkspaceDocs()
  } catch (err) {
    showToast(`Törlési hiba: ${err.message}`, 'error')
  }
}

// ── Filter population ────────────────────────────────────────────────────────

async function populateAgentFilter() {
  const sel = agentFilter()
  if (!sel) return
  try {
    const r = await fetch('/api/agents')
    if (!r.ok) return
    const agents = await r.json()
    if (!Array.isArray(agents)) return
    agents.forEach(a => {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.displayName || a.name
      sel.appendChild(opt)
    })
  } catch {}
}

async function populateTenantFilter() {
  let auth = null
  try { auth = await fetch('/api/auth/status').then(r => r.ok ? r.json() : null) } catch {}
  const isAdmin = auth?.role === 'admin' && auth?.tenant_id === null
  if (!isAdmin) return  // non-admin: tenant wrapper stays hidden

  const wrap = tenantFilterWrap()
  const tenSel = tenantFilter()
  if (!wrap || !tenSel) return

  try {
    const r = await fetch('/api/admin/tenants')
    if (!r.ok) return
    const data = await r.json()
    const tenants = data.items ?? []
    tenants.forEach(ten => {
      const opt = document.createElement('option')
      opt.value = ten.id
      opt.textContent = ten.display_name || ten.id
      tenSel.appendChild(opt)
    })
    wrap.hidden = false
  } catch {}
}

// ── Event wiring (called once on page enter) ──────────────────────────────────

let _wired = false

export async function initWorkspaceDocs() {
  if (_wired) return
  _wired = true

  await Promise.all([populateAgentFilter(), populateTenantFilter()])

  searchBtn()?.addEventListener('click', loadWorkspaceDocs)

  listEl()?.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('.wd-view-btn')
    if (viewBtn) {
      openPreview(viewBtn.dataset.id, viewBtn.dataset.title)
      return
    }
    const deleteBtn = e.target.closest('.wd-delete-btn')
    if (deleteBtn) {
      deleteWorkspaceDoc(deleteBtn.dataset.id)
    }
  })

  previewClose()?.addEventListener('click', () => {
    const panel = previewPanel()
    if (panel) panel.hidden = true
  })

  previewDelete()?.addEventListener('click', () => {
    const id = previewDelete()?.dataset.id
    if (id) deleteWorkspaceDoc(id)
  })
}
