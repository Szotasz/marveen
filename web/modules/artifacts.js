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
const previewClose    = () => document.getElementById('artifactsPreviewClose')
const previewDownload = () => document.getElementById('artifactsPreviewDownload')

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
        <th style="padding:6px 8px">Módosítva</th>
        <th style="padding:6px 8px"></th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r => `
        <tr style="border-bottom:1px solid var(--border-subtle)" data-artifact-id="${escapeHtml(r.id)}">
          <td class="artifact-title-cell" style="padding:6px 8px" data-id="${escapeHtml(r.id)}" data-title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</td>
          <td style="padding:6px 8px;color:var(--text-muted)">${escapeHtml(r.agent_id)}</td>
          <td style="padding:6px 8px"><code>${escapeHtml(r.kind)}</code></td>
          <td style="padding:6px 8px;color:var(--text-muted)" title="${r.updated_at !== r.created_at ? 'Létrehozva: ' + fmtTime(r.created_at) : ''}">${fmtTime(r.updated_at ?? r.created_at)}</td>
          <td style="padding:6px 8px;white-space:nowrap">
            <button class="btn artifact-preview-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(r.id)}" data-kind="${escapeHtml(r.kind)}" data-title="${escapeHtml(r.title)}" data-i18n="memories.artifacts.btn.preview">Előnézet</button>
            <button class="btn artifact-rename-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(r.id)}" data-i18n="artifacts.btn.rename">Átnevezés</button>
            <button class="btn artifact-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(r.id)}" style="color:var(--danger)">Törlés</button>
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

// Last artifact fetched in the preview panel -- used by the download button.
let _previewArtifact = null

async function openPreview(id, kind, title) {
  const panel = previewPanel()
  const body  = previewBody()
  const ttl   = previewTitle()
  if (!panel || !body || !ttl) return

  _previewArtifact = null
  ttl.textContent = title
  body.innerHTML = '<span style="color:var(--text-muted)">Betöltés...</span>'
  panel.hidden = false

  try {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const artifact = await res.json()
    _previewArtifact = artifact
    renderPreview(body, artifact)
  } catch (err) {
    body.innerHTML = `<span style="color:var(--danger)">Hiba: ${escapeHtml(err.message)}</span>`
  }
}

function downloadArtifact(artifact) {
  if (!artifact) return
  const { kind, content, mime, title, id } = artifact
  const filename = title || `artifact-${id}`
  let blob
  if (kind === 'binary') {
    blob = b64toBlob(content, mime || 'application/octet-stream')
  } else if (kind === 'html') {
    // Re-wrap HTML fragments stored without a document skeleton.
    // iframe.srcdoc is forgiving and renders bare fragments fine, but a
    // downloaded .html file opened directly in the browser needs a proper
    // document structure to render reliably. If the stored content already
    // starts with <!doctype or <html we leave it untouched.
    const trimmed = content.trimStart()
    const alreadyWrapped = /^<!doctype\b/i.test(trimmed) || /^<html\b/i.test(trimmed)
    const downloadContent = alreadyWrapped
      ? content
      : `<!doctype html>\n<html lang="hu">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>\n<body>\n${content}\n</body>\n</html>`
    blob = new Blob([downloadContent], { type: 'text/html; charset=utf-8' })
  } else {
    blob = new Blob([content], { type: mime || 'text/plain' })
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function renderPreview(container, artifact) {
  const { kind, content, mime, title, id } = artifact

  if (kind === 'html') {
    // allow-scripts: enables inline JS (e.g. tab switching, form logic).
    // Omitting allow-same-origin keeps the iframe at null origin so scripts
    // cannot reach parent cookies, localStorage, or the dashboard session.
    const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
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
  a.className = 'btn'
  a.dataset.variant = 'primary'
  a.dataset.size = 'compact'
  container.innerHTML = ''
  container.appendChild(a)
}

function b64toBlob(b64, mime) {
  const bytes = atob(b64)
  const arr   = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// ── Rename ───────────────────────────────────────────────────────────────────

// Opens an inline input in the title cell. Commits on Enter or blur; cancels on Escape.
function startInlineRename(btn) {
  const id = btn.dataset.id
  const titleCell = listEl()?.querySelector(`.artifact-title-cell[data-id="${CSS.escape(id)}"]`)
  if (!titleCell || titleCell.querySelector('input')) return  // already editing

  const currentTitle = titleCell.dataset.title
  const input = document.createElement('input')
  input.type = 'text'
  input.value = currentTitle
  input.placeholder = t('artifacts.rename.placeholder') || 'New title...'
  input.style.cssText = 'width:100%;box-sizing:border-box;font-size:inherit;padding:2px 4px'
  input.setAttribute('maxlength', '250')

  titleCell.textContent = ''
  titleCell.appendChild(input)
  input.focus()
  input.select()

  let committed = false

  async function commit() {
    if (committed) return
    committed = true
    const newTitle = input.value.trim()
    if (!newTitle || newTitle === currentTitle) {
      titleCell.textContent = currentTitle
      return
    }
    titleCell.textContent = newTitle
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      titleCell.dataset.title = newTitle
      // update the preview button's data-title so re-opening preview shows the new name
      const previewBtn = listEl()?.querySelector(`.artifact-preview-btn[data-id="${CSS.escape(id)}"]`)
      if (previewBtn) previewBtn.dataset.title = newTitle
      showToast(t('artifacts.rename.success') || 'Artifact renamed.', 'success')
    } catch (err) {
      titleCell.textContent = currentTitle
      showToast(t('artifacts.rename.error') || `Rename failed: ${err.message}`, 'error')
    }
  }

  function cancel() {
    if (committed) return
    committed = true
    titleCell.textContent = currentTitle
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit() }
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  input.addEventListener('blur', commit)
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

  // Delegate preview, rename, and delete clicks on the list
  listEl()?.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('.artifact-preview-btn')
    if (previewBtn) {
      openPreview(previewBtn.dataset.id, previewBtn.dataset.kind, previewBtn.dataset.title)
      return
    }
    const renameBtn = e.target.closest('.artifact-rename-btn')
    if (renameBtn) {
      startInlineRename(renameBtn)
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

  previewDownload()?.addEventListener('click', () => {
    downloadArtifact(_previewArtifact)
  })
}
