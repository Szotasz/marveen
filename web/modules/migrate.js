import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'


// ============================================================
// === Költöztetés (Migration) ===
// ============================================================

let migrateFindings = []

export async function loadMigrateAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('migrateAgent')
    sel.innerHTML = ''
    for (const a of agents) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.label || a.name
      sel.appendChild(opt)
    }
  } catch {}
}

function renderMigrateFindings(data) {
  const findingsEl = document.getElementById('migrateFindings')
  const summaryEl = document.getElementById('migrateSummary')

  const typeIcons = {
    'personality': '🎭',
    'profile': '👤',
    'memory': '🧠',
    'memory-hot': '🔥',
    'memory-warm': '🌡️',
    'memory-cold': '❄️',
    'heartbeat': '💓',
    'config': '⚙️',
    'daily-log': '📋',
    'schedule': '⏰',
  }
  const typeLabels = {
    'personality': () => t('migrate.type.personality'),
    'profile': () => t('migrate.type.profile'),
    'memory': () => t('migrate.type.memory'),
    'memory-hot': () => t('migrate.type.memory_hot'),
    'memory-warm': () => t('migrate.type.memory_warm'),
    'memory-cold': () => t('migrate.type.memory_cold'),
    'heartbeat': () => t('migrate.type.heartbeat'),
    'config': () => t('migrate.type.config'),
    'daily-log': () => t('migrate.type.daily_log'),
    'schedule': () => t('migrate.type.schedule'),
  }

  findingsEl.innerHTML = ''
  for (const f of data.findings) {
    const div = document.createElement('div')
    div.className = 'migrate-finding'
    const sizeKB = Math.round(f.size / 1024 * 10) / 10
    div.innerHTML = `
      <span class="migrate-finding-icon">${typeIcons[f.type] || '📄'}</span>
      <div class="migrate-finding-info">
        <div class="migrate-finding-name">${escapeHtml(f.name)}</div>
        <div class="migrate-finding-type">${(typeof typeLabels[f.type] === 'function' ? typeLabels[f.type]() : typeLabels[f.type]) || f.type}</div>
      </div>
      <span class="migrate-finding-size">${sizeKB} KB</span>
    `
    findingsEl.appendChild(div)
  }

  if (data.findings.length === 0) {
    findingsEl.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">${t('migrate.empty')}</div>`
  }

  const s = data.summary
  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-value">${s.total}</div><div class="stat-label">${t('migrate.stat.total')}</div></div>
    <div class="stat-card"><div class="stat-value">${s.memory}</div><div class="stat-label">${t('migrate.stat.memory')}</div></div>
    <div class="stat-card"><div class="stat-value">${s.personality + s.profile}</div><div class="stat-label">${t('migrate.stat.profile')}</div></div>
    <div class="stat-card"><div class="stat-value">${s.config + s.heartbeat}</div><div class="stat-label">${t('migrate.stat.config')}</div></div>
  `
}

// ============================================================
// === Fleet Migration ===
// ============================================================

// Holds the last successfully parsed fleet JSON text (for apply after dry-run)
let fleetLastBody = null

export function initMigrate() {
  // Step 1: Scan
  document.getElementById('migrateScanBtn').addEventListener('click', async () => {
    const path = document.getElementById('migratePath').value.trim()
    if (!path) { document.getElementById('migratePath').focus(); return }

    const btn = document.getElementById('migrateScanBtn')
    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    try {
      const res = await fetch('/api/migrate/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: path }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Hiba')

      migrateFindings = data.findings
      renderMigrateFindings(data)

      document.getElementById('migrateStep1').hidden = true
      document.getElementById('migrateStep2').hidden = false
    } catch (err) {
      showToast(`Hiba: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })

  // Back button
  document.getElementById('migrateBackBtn').addEventListener('click', () => {
    document.getElementById('migrateStep1').hidden = false
    document.getElementById('migrateStep2').hidden = true
  })

  // Step 2: Run migration
  document.getElementById('migrateRunBtn').addEventListener('click', async () => {
    const agentId = document.getElementById('migrateAgent').value
    const btn = document.getElementById('migrateRunBtn')
    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    try {
      const res = await fetch('/api/migrate/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findings: migrateFindings, agentId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Hiba')

      // Show results
      document.getElementById('migrateStep2').hidden = true
      document.getElementById('migrateStep3').hidden = false

      const resultEl = document.getElementById('migrateResult')
      resultEl.innerHTML = `
        <h4>${t('migrate.result.title')}</h4>
        <div class="migrate-result-stats">
          <div class="migrate-result-stat"><div class="migrate-result-stat-value">${data.imported}</div><div class="migrate-result-stat-label">${t('migrate.result.imported')}</div></div>
          <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#dc3c3c">${data.stats.hot}</div><div class="migrate-result-stat-label">Hot</div></div>
          <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#d97757">${data.stats.warm}</div><div class="migrate-result-stat-label">Warm</div></div>
          <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#6a9bcc">${data.stats.cold}</div><div class="migrate-result-stat-label">Cold</div></div>
          <div class="migrate-result-stat"><div class="migrate-result-stat-value" style="color:#9a8a30">${data.stats.shared}</div><div class="migrate-result-stat-label">Shared</div></div>
        </div>
        ${data.details ? '<div class="migrate-result-details">' + data.details.map(d => escapeHtml(d)).join('<br>') + '</div>' : ''}
      `
    } catch (err) {
      showToast(`Hiba: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })

  // New migration
  document.getElementById('migrateNewBtn').addEventListener('click', () => {
    document.getElementById('migrateStep1').hidden = false
    document.getElementById('migrateStep2').hidden = true
    document.getElementById('migrateStep3').hidden = true
  })

  document.getElementById('fleetExportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('fleetExportBtn')
    const password = document.getElementById('fleetExportPassword').value.trim()

    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    try {
      const headers = {}
      if (password) headers['X-Vault-Password'] = password

      const res = await fetch('/api/fleet/export', { headers })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || t('fleet.export.error'))
        return
      }

      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') || ''
      const nameMatch = cd.match(/filename="?([^";\s]+)"?/)
      const filename = nameMatch ? nameMatch[1] : `fleet-export-${new Date().toISOString().slice(0, 10)}.json`

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      showToast(t('fleet.export.success'))
    } catch (err) {
      showToast(`${t('fleet.export.error')}: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })

  document.getElementById('fleetDryRunBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('fleetImportFile')
    if (!fileInput.files.length) {
      showToast(t('fleet.import.no_file'))
      return
    }

    const btn = document.getElementById('fleetDryRunBtn')
    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    const applyBtn = document.getElementById('fleetApplyBtn')
    applyBtn.disabled = true
    fleetLastBody = null

    const resultEl = document.getElementById('fleetDryRunResult')
    resultEl.hidden = true
    resultEl.innerHTML = ''

    try {
      const text = await fileInput.files[0].text()
      // Validate JSON client-side first
      try { JSON.parse(text) } catch { showToast(t('fleet.import.invalid_json')); return }

      const password = document.getElementById('fleetImportPassword').value.trim()
      const headers = { 'Content-Type': 'application/json' }
      if (password) headers['X-Vault-Password'] = password

      const res = await fetch('/api/fleet/import', { method: 'POST', headers, body: text })
      const data = await res.json()

      const wc = data.wouldCreate || {}
      const hasErrors = data.errors && data.errors.length > 0
      const hasWarnings = data.warnings && data.warnings.length > 0

      resultEl.className = `fleet-dry-run-result ${hasErrors ? 'has-errors' : 'ok'}`
      resultEl.hidden = false

      const agentNames = Array.isArray(wc.agents) ? wc.agents : []
      const agentLabel = agentNames.length
        ? `${agentNames.length} (${agentNames.join(', ')})`
        : '0'

      resultEl.innerHTML = `
        <div class="fleet-dry-run-title">${hasErrors ? '❌ ' + t('fleet.import.dryrun_errors') : '✅ ' + t('fleet.import.dryrun_ok')}</div>
        ${!hasErrors ? `
        <div class="fleet-dry-run-grid">
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.mainAgent ? '✓' : '—'}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.main_agent')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${agentNames.length}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.agents')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.memories ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.memories')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.kanbanCards ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.kanban')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.globalSkills ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.skills')}</div>
          </div>
          <div class="fleet-dry-run-stat">
            <div class="fleet-dry-run-stat-value">${wc.scheduledTasks ?? 0}</div>
            <div class="fleet-dry-run-stat-label">${t('fleet.stat.tasks')}</div>
          </div>
        </div>
        ${agentNames.length ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${t('fleet.stat.agent_names')}: ${escapeHtml(agentNames.join(', '))}</div>` : ''}
        ` : ''}
        ${hasErrors ? `<div class="fleet-dry-run-errors">${data.errors.map(e => escapeHtml(e)).join('<br>')}</div>` : ''}
        ${hasWarnings ? `<div class="fleet-dry-run-warnings">⚠️ ${data.warnings.map(w => escapeHtml(w)).join('<br>')}</div>` : ''}
      `

      if (!hasErrors) {
        fleetLastBody = text
        applyBtn.disabled = false
      }
    } catch (err) {
      showToast(`${t('fleet.import.error')}: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })

  document.getElementById('fleetApplyBtn').addEventListener('click', async () => {
    if (!fleetLastBody) return

    if (!confirm(t('fleet.import.apply_confirm'))) return

    const btn = document.getElementById('fleetApplyBtn')
    btn.disabled = true
    btn.querySelector('.btn-text').hidden = true
    btn.querySelector('.btn-loading').hidden = false

    const resultEl = document.getElementById('fleetDryRunResult')

    try {
      const password = document.getElementById('fleetImportPassword').value.trim()
      const headers = { 'Content-Type': 'application/json' }
      if (password) headers['X-Vault-Password'] = password

      const res = await fetch('/api/fleet/import?apply=true', { method: 'POST', headers, body: fleetLastBody })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || t('fleet.import.error'))

      const imp = data.imported || {}
      const agentNames = Array.isArray(imp.agents) ? imp.agents : []

      resultEl.className = 'fleet-apply-result'
      resultEl.hidden = false
      resultEl.innerHTML = `
        <div class="fleet-apply-result-title">✅ ${t('fleet.import.apply_success')}</div>
        <div>
          ${imp.mainAgent ? `<div>${t('fleet.stat.main_agent')}: ✓</div>` : ''}
          ${agentNames.length ? `<div>${t('fleet.stat.agents')}: ${escapeHtml(agentNames.join(', '))}</div>` : ''}
          <div>${t('fleet.stat.memories')}: ${imp.memories ?? 0}</div>
          <div>${t('fleet.stat.kanban')}: ${imp.kanbanCards ?? 0}</div>
          <div>${t('fleet.stat.skills')}: ${imp.globalSkills ?? 0}</div>
          <div>${t('fleet.stat.tasks')}: ${imp.scheduledTasks ?? 0}</div>
        </div>
      `

      fleetLastBody = null
      btn.disabled = true
    } catch (err) {
      showToast(`${t('fleet.import.error')}: ${err.message}`)
      btn.disabled = false
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    } finally {
      btn.querySelector('.btn-text').hidden = false
      btn.querySelector('.btn-loading').hidden = true
    }
  })
}
