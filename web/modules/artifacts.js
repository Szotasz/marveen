import { escapeHtml, highlightJson } from './util.js'
import { renderMarkdown } from './docs-research.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'

const PREVIEW_TEXT_KINDS = new Set(['text', 'markdown', 'json'])

// ── DOM refs ─────────────────────────────────────────────────────────────────

const agentFilter  = () => document.getElementById('artifactsAgentFilter')
const kindFilter   = () => document.getElementById('artifactsKindFilter')
const dateFilter   = () => document.getElementById('artifactsDateFilter')
const searchBtn    = () => document.getElementById('artifactsSearchBtn')
const listEl       = () => document.getElementById('artifactsList')
const emptyEl      = () => document.getElementById('artifactsEmpty')
const previewPanel = () => document.getElementById('artifactsPreview')
const previewTitle = () => document.getElementById('artifactsPreviewTitle')
const previewBody  = () => document.getElementById('artifactsPreviewBody')
const previewClose = () => document.getElementById('artifactsPreviewClose')

// ── Fetch & render list ───────────────────────────────────────────────────────

export async function loadArtifacts() {
  const agent = agentFilter()?.value?.trim() || ''
  const kind  = kindFilter()?.value || ''
  const date  = dateFilter()?.value || ''

  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  if (kind)  params.set('kind', kind)
  if (date) {
    // date filter: from midnight to end-of-day (client interprets as created_at >= day start)
    params.set('date', date)
  }
  params.set('limit', '100')

  try {
    const res = await fetch(`/api/artifacts?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rows = await res.json()
    renderList(rows)
  } catch (err) {
    showToast(t('common.error') || `Error: ${err.message}`, 'error')
  }
}

function renderList(rows) {
  const el = listEl()
  const emp = emptyEl()
  if (!el || !emp) return

  if (!rows.length) {
    el.innerHTML = ''
    emp.hidden = false
    return
  }
  emp.hidden = true

  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="border-bottom:1px solid var(--border);text-align:left">
        <th style="padding:6px 8px">Cím</th>
        <th style="padding:6px 8px">Agent</th>
        <th style="padding:6px 8px">Típus</th>
        <th style="padding:6px 8px">Idő</th>
        <th style="padding:6px 8px"></th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r => `
        <tr style="border-bottom:1px solid var(--border-subtle)" data-artifact-id="${escapeHtml(r.id)}">
          <td style="padding:6px 8px">${escapeHtml(r.title)}</td>
          <td style="padding:6px 8px;color:var(--text-muted)">${escapeHtml(r.agent_id)}</td>
          <td style="padding:6px 8px"><code>${escapeHtml(r.kind)}</code></td>
          <td style="padding:6px 8px;color:var(--text-muted)">${fmtTime(r.created_at)}</td>
          <td style="padding:6px 8px;white-space:nowrap">
            <button class="btn-secondary btn-compact artifact-preview-btn" data-id="${escapeHtml(r.id)}" data-kind="${escapeHtml(r.kind)}" data-title="${escapeHtml(r.title)}">Előnézet</button>
            <button class="btn-secondary btn-compact artifact-delete-btn" data-id="${escapeHtml(r.id)}" style="color:var(--danger)">Törlés</button>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>`
}

function fmtTime(unixSec) {
  if (!unixSec) return ''
  return new Date(unixSec * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
}

// ── Preview ───────────────────────────────────────────────────────────────────

async function openPreview(id, kind, title) {
  const panel = previewPanel()
  const body  = previewBody()
  const ttl   = previewTitle()
  if (!panel || !body || !ttl) return

  ttl.textContent = title
  body.innerHTML = '<span style="color:var(--text-muted)">Betöltés...</span>'
  panel.hidden = false

  try {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const artifact = await res.json()
    renderPreview(body, artifact)
  } catch (err) {
    body.innerHTML = `<span style="color:var(--danger)">Hiba: ${escapeHtml(err.message)}</span>`
  }
}

function renderPreview(container, artifact) {
  const { kind, content, mime, title, id } = artifact

  if (kind === 'html') {
    // Sandboxed iframe prevents script execution; srcdoc keeps content local
    const csp = "default-src 'none'; style-src 'unsafe-inline'"
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('csp', csp)
    iframe.style.cssText = 'width:100%;height:400px;border:1px solid var(--border);border-radius:4px'
    iframe.srcdoc = content
    container.innerHTML = ''
    container.appendChild(iframe)
    return
  }

  if (kind === 'markdown') {
    // renderMarkdown escapes all user content via escapeHtml/mdInline -- safe for innerHTML
    container.innerHTML = `<div class="markdown-body md-rendered" style="padding:12px;overflow-y:auto;max-height:400px;font-size:13px">${renderMarkdown(content)}</div>`
    return
  }

  if (kind === 'json') {
    // highlightJson HTML-escapes all string values via escapeHtml -- safe for innerHTML
    container.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;background:var(--bg-code,var(--bg-input));padding:12px;border-radius:4px;overflow-x:auto;max-height:400px;overflow-y:auto;line-height:1.5">${highlightJson(content)}</pre>`
    return
  }

  if (kind === 'text') {
    container.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;background:var(--surface-2);padding:12px;border-radius:4px;overflow-x:auto;max-height:400px;overflow-y:auto">${escapeHtml(content)}</pre>`
    return
  }

  // binary: download link from base64
  const blob = b64toBlob(content, mime || 'application/octet-stream')
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = title || `artifact-${id}`
  a.textContent = 'Letöltés'
  a.className = 'btn-primary btn-compact'
  container.innerHTML = ''
  container.appendChild(a)
}

function b64toBlob(b64, mime) {
  const bytes = atob(b64)
  const arr   = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteArtifact(id) {
  if (!confirm('Biztosan törlöd?')) return
  try {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    showToast('Artifakt törölve.', 'success')
    loadArtifacts()
    // close preview if open for this id
    const panel = previewPanel()
    if (panel && !panel.hidden) panel.hidden = true
  } catch (err) {
    showToast(`Hiba: ${err.message}`, 'error')
  }
}

// ── Event wiring (called once on page enter) ──────────────────────────────────

let _wired = false

export function initArtifacts() {
  if (_wired) return
  _wired = true

  searchBtn()?.addEventListener('click', loadArtifacts)

  // Delegate preview + delete clicks on the list
  listEl()?.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('.artifact-preview-btn')
    if (previewBtn) {
      openPreview(previewBtn.dataset.id, previewBtn.dataset.kind, previewBtn.dataset.title)
      return
    }
    const deleteBtn = e.target.closest('.artifact-delete-btn')
    if (deleteBtn) {
      deleteArtifact(deleteBtn.dataset.id)
    }
  })

  previewClose()?.addEventListener('click', () => {
    const panel = previewPanel()
    if (panel) panel.hidden = true
  })
}
