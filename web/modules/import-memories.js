import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'

// ============================================================
// === Import Memories -- external file sources ===
// ============================================================

let sourcesCache = []

function formatTs(unix) {
  if (!unix) return '-'
  return new Date(unix * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', hour12: false })
}

function intervalLabel(h) {
  return h === 1 ? '1h' : h === 2 ? '2h' : h === 4 ? '4h' : h === 24 ? '24h' : `${h}h`
}

function typeLabel(type) {
  if (type === 'local') return t('import.type.local')
  if (type === 'gdrive') return t('import.type.gdrive')
  if (type === 'sharepoint') return t('import.type.sharepoint')
  return type
}

function typeIcon(type) {
  if (type === 'local') return '💾'
  if (type === 'gdrive') return '☁️'
  if (type === 'sharepoint') return '🏢'
  return '📂'
}

function renderSources(sources) {
  const el = document.getElementById('importSourcesList')
  if (!el) return
  if (!sources.length) {
    el.innerHTML = `<p class="empty-state">${escapeHtml(t('import.sources.empty'))}</p>`
    return
  }
  el.innerHTML = sources.map(s => `
    <div class="import-source-card" data-id="${escapeHtml(s.id)}">
      <div class="import-source-header">
        <span class="import-source-icon">${typeIcon(s.type)}</span>
        <span class="import-source-label">${escapeHtml(s.label || s.path)}</span>
        <span class="import-source-type">${escapeHtml(typeLabel(s.type))}</span>
        <label class="import-toggle" title="${t('import.toggle.label')}">
          <input type="checkbox" class="import-enabled-toggle" data-id="${escapeHtml(s.id)}" ${s.enabled ? 'checked' : ''}>
          <span>${t('import.toggle.active')}</span>
        </label>
      </div>
      <div class="import-source-meta">
        <span title="${t('import.path.label')}">${escapeHtml(s.path)}</span>
        <span>${escapeHtml(intervalLabel(s.interval_hours))}</span>
        <span>${t('import.last_run')}: ${formatTs(s.last_run_at)}</span>
      </div>
      <div class="import-source-actions">
        <button class="btn-secondary btn-compact import-sync-btn" data-id="${escapeHtml(s.id)}">${t('import.btn.sync')}</button>
        <button class="btn-secondary btn-compact import-log-btn" data-id="${escapeHtml(s.id)}">${t('import.btn.log')}</button>
        <button class="btn-secondary btn-compact import-wipe-btn" data-id="${escapeHtml(s.id)}">${t('import.btn.wipe_source')}</button>
        <button class="btn-danger btn-compact import-delete-btn" data-id="${escapeHtml(s.id)}">${t('import.btn.delete')}</button>
      </div>
    </div>
  `).join('')

  // Event handlers
  el.querySelectorAll('.import-enabled-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.id
      await fetch(`/api/import/sources/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: cb.checked }),
      })
    })
  })

  el.querySelectorAll('.import-sync-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      btn.disabled = true; btn.textContent = t('import.btn.syncing')
      try {
        await fetch(`/api/import/sources/${id}/sync`, { method: 'POST' })
        showToast(t('import.toast.sync_queued'))
      } catch { showToast(t('import.toast.error')) }
      finally { btn.disabled = false; btn.textContent = t('import.btn.sync') }
    })
  })

  el.querySelectorAll('.import-log-btn').forEach(btn => {
    btn.addEventListener('click', () => loadSourceLog(btn.dataset.id))
  })

  el.querySelectorAll('.import-wipe-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('import.confirm.wipe_source'))) return
      await fetch(`/api/import/sources/${btn.dataset.id}/memories`, { method: 'DELETE' })
      showToast(t('import.toast.wiped'))
    })
  })

  el.querySelectorAll('.import-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('import.confirm.delete_source'))) return
      await fetch(`/api/import/sources/${btn.dataset.id}`, { method: 'DELETE' })
      showToast(t('import.toast.deleted'))
      loadImportSources()
    })
  })
}

async function loadSourceLog(sourceId) {
  const logEl = document.getElementById('importLog')
  if (!logEl) return
  try {
    const res = await fetch(`/api/import/sources/${sourceId}/log`)
    const rows = await res.json()
    if (!rows.length) { logEl.innerHTML = `<p class="empty-state">${escapeHtml(t('import.log.empty'))}</p>`; return }
    logEl.innerHTML = `<table class="import-log-table"><thead><tr>
      <th>${t('import.log.run_at')}</th>
      <th>${t('import.log.scanned')}</th>
      <th>${t('import.log.added')}</th>
      <th>${t('import.log.updated')}</th>
      <th>${t('import.log.skipped')}</th>
      <th>${t('import.log.error')}</th>
    </tr></thead><tbody>${rows.map(r => `<tr>
      <td>${formatTs(r.run_at)}</td>
      <td>${r.files_scanned}</td>
      <td>${r.files_added}</td>
      <td>${r.files_updated}</td>
      <td>${r.files_skipped_hash + r.files_skipped_secret + r.files_skipped_size + r.files_skipped_type}</td>
      <td>${r.error ? `<span class="error-text">${escapeHtml(r.error.slice(0, 80))}</span>` : '-'}</td>
    </tr>`).join('')}</tbody></table>`
  } catch { logEl.innerHTML = '<p class="empty-state">Hiba</p>' }
}

export async function loadImportSources() {
  try {
    const res = await fetch('/api/import/sources')
    sourcesCache = await res.json()
    renderSources(sourcesCache)
  } catch (err) {
    const el = document.getElementById('importSourcesList')
    if (el) el.innerHTML = `<p class="empty-state">${escapeHtml(t('import.sources.load_error'))}</p>`
  }
}

export function initImportMemories() {
  // Add source form
  const form = document.getElementById('importAddSourceForm')
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const type = document.getElementById('importSourceType').value
      const path = document.getElementById('importSourcePath').value.trim()
      const label = document.getElementById('importSourceLabel').value.trim()
      const interval = parseInt(document.getElementById('importSourceInterval').value, 10)

      if (!path) { showToast(t('import.toast.path_required')); return }

      const btn = form.querySelector('button[type="submit"]')
      if (btn) { btn.disabled = true }
      try {
        const res = await fetch('/api/import/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, path, label: label || undefined, interval_hours: interval }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Hiba' }))
          showToast(err.error || t('import.toast.error'))
          return
        }
        showToast(t('import.toast.source_added'))
        form.reset()
        loadImportSources()
      } catch { showToast(t('import.toast.error')) }
      finally { if (btn) btn.disabled = false }
    })
  }

  // Wipe all button
  const wipeAllBtn = document.getElementById('importWipeAllBtn')
  if (wipeAllBtn) {
    wipeAllBtn.addEventListener('click', async () => {
      if (!confirm(t('import.confirm.wipe_all'))) return
      await fetch('/api/import/memories', { method: 'DELETE' })
      showToast(t('import.toast.all_wiped'))
    })
  }

  // SharePoint disclaimer toggle
  const spInfo = document.getElementById('importSharePointInfo')
  const typeSelect = document.getElementById('importSourceType')
  if (spInfo && typeSelect) {
    typeSelect.addEventListener('change', () => {
      spInfo.hidden = typeSelect.value !== 'sharepoint'
    })
    spInfo.hidden = typeSelect.value !== 'sharepoint'
  }
}
