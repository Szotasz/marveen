// Backups page module
import { t } from './i18n.js'
import { showToast } from './toast.js'

// app.js patches the global fetch so same-origin /api/ calls carry the
// dashboard Bearer token; this module only needs a thin JSON wrapper.
async function apiFetch(url, opts = {}) {
  const init = { ...opts }
  if (init.body && !init.headers) init.headers = { 'Content-Type': 'application/json' }
  let res
  try {
    res = await fetch(url, init)
  } catch {
    return null
  }
  let data = null
  try { data = await res.json() } catch { /* empty or non-JSON body */ }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return 'ok' in data ? data : { ...data, ok: res.ok }
  }
  return data ?? { ok: res.ok }
}

let pendingDeleteName = null

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

function tsToLocal(unixSeconds) {
  if (!unixSeconds) return '-'
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', hour12: false })
}

function makeChecksumCell(entry) {
  const td = document.createElement('td')
  if (!entry.has_checksum) {
    td.style.color = 'var(--text-muted)'
    td.style.fontSize = '11px'
    td.textContent = '-'
    return td
  }
  const span = document.createElement('span')
  span.className = 'badge badge-ok'
  span.style.cssText = 'font-family:monospace;font-size:11px'
  const short = entry.checksum ? entry.checksum.slice(0, 12) + '…' : '?'
  span.textContent = 'sha256: ' + short
  if (entry.checksum) span.title = entry.checksum
  td.appendChild(span)
  return td
}

function makeActionCell(name) {
  const td = document.createElement('td')
  td.style.cssText = 'white-space:nowrap;display:flex;gap:4px'

  const verifyBtn = document.createElement('button')
  verifyBtn.className = 'btn-secondary btn-compact backups-verify-btn'
  verifyBtn.dataset.name = name
  verifyBtn.textContent = 'Verify'

  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'btn-secondary btn-compact backups-delete-btn'
  deleteBtn.dataset.name = name
  deleteBtn.style.color = 'var(--danger,#e53e3e)'
  deleteBtn.textContent = t('backups.modal.delete.confirm')

  td.appendChild(verifyBtn)
  td.appendChild(deleteBtn)
  return td
}

function renderTable(backups) {
  const tbody = document.getElementById('backupsTbody')
  if (!tbody) return
  tbody.innerHTML = ''
  backups.forEach((b) => {
    const tr = document.createElement('tr')

    const tdName = document.createElement('td')
    tdName.style.cssText = 'font-family:monospace;font-size:12px'
    tdName.textContent = b.name

    const tdDate = document.createElement('td')
    tdDate.style.whiteSpace = 'nowrap'
    tdDate.textContent = tsToLocal(b.created_at)

    const tdSize = document.createElement('td')
    tdSize.style.whiteSpace = 'nowrap'
    tdSize.textContent = formatSize(b.size)

    tr.appendChild(tdName)
    tr.appendChild(tdDate)
    tr.appendChild(tdSize)
    tr.appendChild(makeChecksumCell(b))
    tr.appendChild(makeActionCell(b.name))
    tbody.appendChild(tr)
  })
}

async function loadBackups() {
  const data = await apiFetch('/api/backups')
  if (!data) return

  const backups = data.backups || []
  const countEl = document.getElementById('backupsCount')
  const lastEl = document.getElementById('backupsLastTime')
  const table = document.getElementById('backupsTable')
  const empty = document.getElementById('backupsEmpty')

  if (countEl) countEl.textContent = backups.length
  if (lastEl) lastEl.textContent = tsToLocal(data.last_backup)

  if (backups.length === 0) {
    if (table) table.hidden = true
    if (empty) empty.hidden = false
  } else {
    if (table) table.hidden = false
    if (empty) empty.hidden = true
    renderTable(backups)
  }
}

async function loadRetentionSetting() {
  const data = await apiFetch('/api/settings?keys=BACKUP_KEEP')
  const val = data && data.BACKUP_KEEP ? String(data.BACKUP_KEEP) : '30'
  const stat = document.getElementById('backupsRetentionStat')
  if (stat) stat.textContent = val
  const sel = document.getElementById('backupsKeepSelect')
  if (sel) {
    for (const opt of sel.options) {
      opt.selected = opt.value === val
    }
  }
}

async function runBackup() {
  const btn = document.getElementById('backupsRunBtn')
  if (btn) btn.disabled = true
  try {
    const r = await apiFetch('/api/backups/run', { method: 'POST' })
    showToast(r && r.ok ? 'Mentés elindítva.' : 'Hiba a mentés indításakor.')
    setTimeout(loadBackups, 3000)
  } finally {
    if (btn) btn.disabled = false
  }
}

async function verifyBackup(name) {
  const panel = document.getElementById('backupsVerifyPanel')
  const output = document.getElementById('backupsVerifyOutput')
  if (panel) panel.hidden = false
  if (output) output.textContent = 'Ellenőrzés folyamatban...'
  const r = await apiFetch(`/api/backups/${encodeURIComponent(name)}/verify`, { method: 'POST' })
  if (output) output.textContent = r ? r.output || (r.ok ? 'OK' : 'Hiba') : 'Kommunikációs hiba.'
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

async function deleteBackup(name) {
  const r = await apiFetch(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' })
  showToast(r && r.ok ? 'Törölve.' : 'Törlési hiba.')
  loadBackups()
}

async function saveRetention() {
  const sel = document.getElementById('backupsKeepSelect')
  if (!sel) return
  const val = sel.value
  const r = await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ BACKUP_KEEP: parseInt(val, 10) }) })
  showToast(r && (r.ok || r.saved) ? 'Beállítás mentve.' : 'Hiba a mentéskor.')
  loadRetentionSetting()
}

function wireEvents() {
  document.getElementById('backupsRunBtn')?.addEventListener('click', runBackup)
  document.getElementById('backupsRefreshBtn')?.addEventListener('click', loadBackups)
  document.getElementById('backupsVerifyCloseBtn')?.addEventListener('click', () => {
    const p = document.getElementById('backupsVerifyPanel')
    if (p) p.hidden = true
  })
  document.getElementById('backupsSaveSettingsBtn')?.addEventListener('click', saveRetention)

  // Delete modal
  document.getElementById('backupsDeleteCancelBtn')?.addEventListener('click', () => {
    document.getElementById('backupsDeleteModal').hidden = true
    pendingDeleteName = null
  })
  document.getElementById('backupsDeleteConfirmBtn')?.addEventListener('click', () => {
    document.getElementById('backupsDeleteModal').hidden = true
    if (pendingDeleteName) deleteBackup(pendingDeleteName)
    pendingDeleteName = null
  })

  // Table delegation
  document.getElementById('backupsTbody')?.addEventListener('click', (e) => {
    const verifyBtn = e.target.closest('.backups-verify-btn')
    if (verifyBtn) { verifyBackup(verifyBtn.dataset.name); return }

    const deleteBtn = e.target.closest('.backups-delete-btn')
    if (deleteBtn) {
      pendingDeleteName = deleteBtn.dataset.name
      const desc = document.getElementById('backupsDeleteModalDesc')
      if (desc) desc.textContent = deleteBtn.dataset.name
      document.getElementById('backupsDeleteModal').hidden = false
    }
  })
}

export function initBackups() {
  wireEvents()
  loadBackups()
  loadRetentionSetting()
}

export function refreshBackups() {
  loadBackups()
  loadRetentionSetting()
}
