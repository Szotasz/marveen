import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'
import { openModal, closeModal, showToast } from '/js/core/ui.js'
import { mainAgentId } from '/js/core/api.js'
import { loadConnectors } from '/js/pages/connectors.js'

// --- Vault management ---
async function loadVault() {
  try {
    const res = await fetch('/api/vault')
    const data = await res.json()
    const secrets = data.secrets || []
    document.getElementById('vaultCount').textContent = String(secrets.length)
    const list = document.getElementById('vaultList')
    list.innerHTML = ''
    for (const s of secrets) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(s.label)}</span><span class="github-repo-date">${escapeHtml(s.id)} &middot; ${date}</span></div><button title="Torles" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:2px 6px">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${s.label}?`)) return
        await fetch(`/api/vault/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        loadVault()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireVault() {
  const toggle = document.getElementById('vaultToggle')
  const body = document.getElementById('vaultBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('vaultAddBtn')
  const idInput = document.getElementById('vaultIdInput')
  const valInput = document.getElementById('vaultValueInput')
  addBtn.addEventListener('click', async () => {
    const id = idInput.value.trim()
    const val = valInput.value
    if (!id || !val) return
    await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label: id, value: val }),
    })
    idInput.value = ''
    valInput.value = ''
    loadVault()
  })
  valInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- Env var modal for GitHub repo install ---
let _envVarResolve = null
function showEnvVarModal(envVars) {
  return new Promise((resolve) => {
    _envVarResolve = resolve
    const modal = document.getElementById('envVarModal')
    const fields = document.getElementById('envVarFields')
    fields.innerHTML = ''
    for (const v of envVars) {
      const row = document.createElement('div')
      row.className = 'env-var-row'
      row.innerHTML = `<label class="env-var-label">${escapeHtml(v)}</label><input type="password" class="input env-var-input" data-key="${escapeHtml(v)}" placeholder="Ertek...">`
      fields.appendChild(row)
    }
    modal.hidden = false
  })
}

;(function wireEnvVarModal() {
  const modal = document.getElementById('envVarModal')
  if (!modal) return
  document.getElementById('envVarModalClose').addEventListener('click', () => {
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(null); _envVarResolve = null }
  })
  document.getElementById('envVarSkipBtn').addEventListener('click', () => {
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(null); _envVarResolve = null }
  })
  document.getElementById('envVarSaveBtn').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#envVarFields .env-var-input')
    const env = {}
    for (const inp of inputs) {
      const key = inp.getAttribute('data-key')
      const val = inp.value.trim()
      if (key && val) env[key] = val
    }
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(env); _envVarResolve = null }
  })
})()

// --- Vault Page ---
let _vaultSecrets = []

let _vaultBindings = []

async function loadVaultPage() {
  try {
    const [secretsRes, bindingsRes] = await Promise.all([
      fetch('/api/vault'),
      fetch('/api/vault/bindings'),
    ])
    const secretsData = await secretsRes.json()
    const bindingsData = await bindingsRes.json()
    _vaultSecrets = secretsData.secrets || []
    _vaultBindings = bindingsData.bindings || []
    document.getElementById('vaultStatTotal').textContent = String(_vaultSecrets.length)
    document.getElementById('vaultStatBindings').textContent = String(_vaultBindings.length)
    renderVaultGrid(_vaultSecrets)
  } catch { /* ignore */ }
}

function renderVaultGrid(secrets) {
  const list = document.getElementById('vaultPageList')
  const empty = document.getElementById('vaultPageEmpty')
  list.innerHTML = ''
  if (secrets.length === 0) { empty.hidden = false; return }
  empty.hidden = true
  for (const s of secrets) {
    const card = document.createElement('div')
    card.className = 'vault-card'
    const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
    const bindingCount = _vaultBindings.filter(b => b.vaultSecretId === s.id).length
    const bindingBadge = bindingCount > 0 ? `<span class="vault-binding-badge" title="${bindingCount} kotes">${bindingCount} kotes</span>` : ''
    card.innerHTML = `<div class="vault-card-header"><div class="vault-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="vault-card-title"><div class="vault-card-id">${escapeHtml(s.id)} ${bindingBadge}</div>${s.label !== s.id ? `<div class="vault-card-label">${escapeHtml(s.label)}</div>` : ''}</div><div class="vault-card-meta">${date}</div></div><div class="vault-card-actions"><button class="btn-secondary btn-compact vault-card-reveal" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${t('vault.btn.show')}</button><button class="btn-secondary btn-compact vault-card-edit" data-id="${escapeHtml(s.id)}" data-label="${escapeHtml(s.label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${t('vault.btn.edit')}</button><button class="btn-secondary btn-compact vault-card-delete" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>${t('vault.btn.delete')}</button></div>`
    list.appendChild(card)
  }
  list.querySelectorAll('.vault-card-reveal').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-value')
      if (existing) { existing.remove(); btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${t('vault.btn.show')}`; return }
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (data.value) {
        const valEl = document.createElement('div')
        valEl.className = 'vault-card-value'
        valEl.textContent = data.value
        card.appendChild(valEl)
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> ${t('vault.btn.hide')}`
      }
    })
  })
  list.querySelectorAll('.vault-card-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const label = btn.getAttribute('data-label')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-edit-form')
      if (existing) { existing.remove(); return }
      card.querySelector('.vault-card-value')?.remove()
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!data.value) return
      const form = document.createElement('div')
      form.className = 'vault-card-edit-form'
      form.innerHTML = `<input type="password" class="input vault-edit-value" value="${escapeHtml(data.value)}" style="font-size:13px;margin-bottom:6px"><button class="btn-primary btn-compact vault-edit-save">${t('vault.btn.save')}</button> <button class="btn-secondary btn-compact vault-edit-cancel">${t('vault.btn.cancel')}</button>`
      card.appendChild(form)
      const input = form.querySelector('.vault-edit-value')
      input.focus()
      input.select()
      form.querySelector('.vault-edit-cancel').addEventListener('click', () => form.remove())
      form.querySelector('.vault-edit-save').addEventListener('click', async () => {
        const newVal = input.value
        if (!newVal) return
        const saveBtn = form.querySelector('.vault-edit-save')
        saveBtn.disabled = true
        saveBtn.textContent = '...'
        await fetch('/api/vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label, value: newVal }),
        })
        form.remove()
        showToast('Kulcs frissitve es szinkronizalva')
        loadVaultPage()
        loadVault()
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') form.querySelector('.vault-edit-save').click()
        if (e.key === 'Escape') form.remove()
      })
    })
  })
  list.querySelectorAll('.vault-card-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Torlod: ${id}?`)) return
      await fetch(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' })
      loadVaultPage()
      loadVault()
    })
  })
}

;(function wireVaultPage() {
  const newBtn = document.getElementById('vaultPageNewBtn')
  const panel = document.getElementById('vaultAddPanel')
  const closeBtn = document.getElementById('vaultAddPanelClose')
  const addBtn = document.getElementById('vaultPageAddBtn')
  if (!newBtn || !panel) return

  newBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) document.getElementById('vaultPageIdInput').focus()
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true })

  addBtn.addEventListener('click', async () => {
    const id = document.getElementById('vaultPageIdInput').value.trim()
    const label = document.getElementById('vaultPageLabelInput').value.trim() || id
    const value = document.getElementById('vaultPageValueInput').value
    if (!id || !value) return
    addBtn.disabled = true
    await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, value }),
    })
    document.getElementById('vaultPageIdInput').value = ''
    document.getElementById('vaultPageLabelInput').value = ''
    document.getElementById('vaultPageValueInput').value = ''
    addBtn.disabled = false
    panel.hidden = true
    loadVaultPage()
    loadVault()
  })
  document.getElementById('vaultPageValueInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })

  document.getElementById('vaultSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim()
    if (!q) { renderVaultGrid(_vaultSecrets); return }
    renderVaultGrid(_vaultSecrets.filter(s => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)))
  })
})()

// --- Vault Binding modal ---
;(function wireVaultBind() {
  const bindBtn = document.getElementById('vaultBindBtn')
  const overlay = document.getElementById('vaultBindOverlay')
  const closeBtn = document.getElementById('vaultBindClose')
  const saveBtn = document.getElementById('vaultBindSaveBtn')
  const secretSelect = document.getElementById('vaultBindSecret')
  const serverSelect = document.getElementById('vaultBindServer')
  const envVarInput = document.getElementById('vaultBindEnvVar')
  const statusEl = document.getElementById('vaultBindStatus')
  if (!bindBtn || !overlay) return

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })
  closeBtn.addEventListener('click', () => { closeModal(overlay) })

  bindBtn.addEventListener('click', async () => {
    try {
      statusEl.hidden = true
      envVarInput.value = ''

      const [secretsRes, connectorsRes] = await Promise.all([
        fetch('/api/vault'),
        fetch('/api/connectors'),
      ])
      const secrets = (await secretsRes.json()).secrets || []
      const connectors = await connectorsRes.json()

      secretSelect.innerHTML = ''
      for (const s of secrets) {
        const opt = document.createElement('option')
        opt.value = s.id
        opt.textContent = s.label !== s.id ? `${s.id} (${s.label})` : s.id
        secretSelect.appendChild(opt)
      }
      if (secrets.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs vault kulcs --'
        opt.disabled = true
        secretSelect.appendChild(opt)
      }

      const mcpConnectors = connectors.filter(c => c.source !== 'plugin' && c.source !== 'claude.ai')
      serverSelect.innerHTML = ''
      for (const c of mcpConnectors) {
        const opt = document.createElement('option')
        opt.value = c.name
        opt.textContent = c.scope !== 'global' ? `${c.name} (${c.scope})` : c.name
        serverSelect.appendChild(opt)
      }
      if (mcpConnectors.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs MCP szerver --'
        opt.disabled = true
        serverSelect.appendChild(opt)
      }

      openModal(overlay)
    } catch (err) {
      console.error('Vault bind modal error:', err)
      showToast('Hiba a hozzarendeles betoltesekor: ' + err.message)
    }
  })

  saveBtn.addEventListener('click', async () => {
    const vaultSecretId = secretSelect.value
    const serverName = serverSelect.value
    const envVar = envVarInput.value.trim()
    if (!vaultSecretId || !serverName || !envVar) {
      statusEl.textContent = 'Minden mezo kitoltese kotelezo'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = t('connectors.save_btn')
    try {
      const res = await fetch('/api/vault/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultSecretId, envVar, serverName }),
      })
      const data = await res.json()
      if (data.ok) {
        statusEl.textContent = `Hozzarendelve! ${data.synced || 0} fajl frissitve.`
        statusEl.className = 'vault-bind-status success'
        statusEl.hidden = false
        loadVaultPage()
        loadVault()
        setTimeout(() => { closeModal(overlay) }, 1500)
      } else {
        statusEl.textContent = data.error || 'Hiba tortent'
        statusEl.className = 'vault-bind-status error'
        statusEl.hidden = false
      }
    } catch (err) {
      statusEl.textContent = 'Halozati hiba'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Hozzarendeles'
    }
  })
})()

// --- Vault Scan & Import ---
;(function wireVaultScan() {
  const scanBtn = document.getElementById('vaultScanBtn')
  const syncBtn = document.getElementById('vaultSyncBtn')
  const overlay = document.getElementById('vaultScanOverlay')
  const closeBtn = document.getElementById('vaultScanClose')
  const importBtn = document.getElementById('vaultScanImportBtn')
  if (!scanBtn || !overlay) return

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true
    scanBtn.textContent = 'Kereses...'
    try {
      const res = await fetch('/api/vault/scan')
      const data = await res.json()
      const findings = data.findings || []
      renderScanResults(findings)
      openModal(overlay)
    } finally {
      scanBtn.disabled = false
      scanBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan &amp; Import'
    }
  })

  closeBtn?.addEventListener('click', () => { closeModal(overlay) })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })

  syncBtn?.addEventListener('click', async () => {
    syncBtn.disabled = true
    syncBtn.textContent = 'Szinkron...'
    try {
      const res = await fetch('/api/vault/sync', { method: 'POST' })
      const data = await res.json()
      if (data.updated > 0) {
        showToast(`${data.updated} .mcp.json frissitve`)
      } else {
        showToast('Nincs szinkronizalando kotes')
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      syncBtn.disabled = false
      syncBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Szinkron'
    }
  })

  function renderScanResults(findings) {
    const results = document.getElementById('vaultScanResults')
    const empty = document.getElementById('vaultScanEmpty')
    const footer = document.getElementById('vaultScanFooter')
    results.innerHTML = ''

    const actionable = findings.filter(f => !f.alreadyInVault)
    if (actionable.length === 0) {
      empty.hidden = false
      footer.hidden = true
      if (findings.length > 0) {
        empty.textContent = `${findings.length} erzekeny ertek talalva, de mind mar a Vault-ban van.`
      }
      return
    }
    empty.hidden = true
    footer.hidden = false

    const grouped = new Map()
    for (const f of actionable) {
      const key = `${f.serverName}|${f.envVar}`
      if (!grouped.has(key)) grouped.set(key, { ...f, allTargets: [] })
      grouped.get(key).allTargets.push({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })
    }

    for (const [key, f] of grouped) {
      const row = document.createElement('div')
      row.className = 'vault-scan-row'
      row.innerHTML = `
        <label class="vault-scan-check">
          <input type="checkbox" checked data-key="${escapeHtml(key)}">
        </label>
        <div class="vault-scan-info">
          <div class="vault-scan-server">${escapeHtml(f.serverName)}</div>
          <div class="vault-scan-env">${escapeHtml(f.envVar)} = <code>${escapeHtml(f.maskedValue)}</code></div>
          <div class="vault-scan-targets">${f.allTargets.length} fajlban</div>
        </div>
        <div class="vault-scan-id">
          <input type="text" class="input vault-scan-vault-id" value="${escapeHtml(f.suggestedVaultId)}" data-key="${escapeHtml(key)}" style="font-size:12px;width:180px">
        </div>
      `
      results.appendChild(row)
    }
  }

  importBtn?.addEventListener('click', async () => {
    const results = document.getElementById('vaultScanResults')
    const rows = results.querySelectorAll('.vault-scan-row')
    const imports = []

    const scanRes = await fetch('/api/vault/scan')
    const scanData = await scanRes.json()
    const allFindings = scanData.findings || []

    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]')
      if (!cb?.checked) continue
      const key = cb.getAttribute('data-key')
      const [serverName, envVar] = key.split('|')
      const vaultIdInput = row.querySelector('.vault-scan-vault-id')
      const vaultId = vaultIdInput?.value?.trim() || key

      const matchingFindings = allFindings.filter(
        f => f.serverName === serverName && f.envVar === envVar && !f.alreadyInVault,
      )
      if (matchingFindings.length === 0) continue

      imports.push({
        serverName,
        envVar,
        vaultId,
        label: `${envVar} (${serverName})`,
        createBinding: true,
        targets: matchingFindings.map(f => ({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })),
      })
    }

    if (imports.length === 0) { showToast('Nincs kivalasztott elem'); return }

    importBtn.disabled = true
    importBtn.textContent = 'Importalas...'

    try {
      const res = await fetch('/api/vault/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imports }),
      })
      const data = await res.json()
      if (data.imported > 0) {
        showToast(`${data.imported} kulcs importalva, ${data.bound} kotes letrehozva`)
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      importBtn.disabled = false
      importBtn.textContent = 'Kivalasztottak importalasa'
    }
    closeModal(overlay)
    loadVaultPage()
    loadVault()
  })
})()

// --- External project paths management ---
async function loadExternalPaths() {
  try {
    const res = await fetch('/api/connectors/external-paths')
    const data = await res.json()
    const paths = data.paths || []
    document.getElementById('externalPathCount').textContent = String(paths.length)
    const list = document.getElementById('externalPathList')
    list.innerHTML = ''
    for (const p of paths) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      item.innerHTML = `<span>${escapeHtml(p)}</span><button title="Torles">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        await fetch('/api/connectors/external-paths', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        })
        loadExternalPaths()
        loadConnectors()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireExternalPaths() {
  const toggle = document.getElementById('externalPathsToggle')
  const body = document.getElementById('externalPathsBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('externalPathAddBtn')
  const input = document.getElementById('externalPathInput')
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    const res = await fetch('/api/connectors/external-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: val }),
    })
    const data = await res.json()
    if (data.error) { alert(data.error); return }
    input.value = ''
    loadExternalPaths()
    loadConnectors()
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

async function openConnectorDetail(connector) {
  document.getElementById('connectorDetailTitle').textContent = connector.name

  // Fetch detailed info
  try {
    const res = await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`)
    const detail = await res.json()

    const statusLabels = { connected: t('connectors.status.connected'), needs_auth: t('connectors.status.needs_auth'), failed: t('connectors.status.failed'), unknown: t('connectors.status.unknown') }
    const statusColors = { connected: 'var(--success)', needs_auth: 'var(--accent)', failed: 'var(--danger)', unknown: 'var(--text-muted)' }

    document.getElementById('connectorDetailInfo').innerHTML = `
      <div class="connector-detail-row">
        <span class="meta-label">Statusz</span>
        <span class="meta-value" style="color:${statusColors[detail.status] || ''}">${statusLabels[detail.status] || detail.status}</span>
      </div>
      <div class="connector-detail-row">
        <span class="meta-label">Hatokor</span>
        <span class="meta-value">${escapeHtml(detail.scope || '-')}</span>
      </div>
      ${detail.type ? `<div class="connector-detail-row"><span class="meta-label">Tipus</span><span class="meta-value">${escapeHtml(detail.type)}</span></div>` : ''}
      ${detail.command ? `<div class="connector-detail-row"><span class="meta-label">Parancs</span><span class="meta-value" style="font-family:monospace;font-size:12px">${escapeHtml(detail.command)} ${escapeHtml(detail.args || '')}</span></div>` : ''}
      ${Object.keys(detail.env || {}).length ? `<div class="connector-detail-row"><span class="meta-label">Env</span><span class="meta-value" style="font-family:monospace;font-size:11px">${Object.entries(detail.env).map(([k,v]) => `${k}=${v}`).join(', ')}</span></div>` : ''}
    `
  } catch {
    document.getElementById('connectorDetailInfo').innerHTML = `<p>${t('connectors.detail_error')}</p>`
  }

  try {
    const [agentsRes, connectorsRes] = await Promise.all([
      fetch('/api/schedules/agents'),
      fetch('/api/connectors'),
    ])
    const allAgents = await agentsRes.json()
    const allConnectors = await connectorsRes.json()
    const assignedAgents = new Set()
    for (const c of allConnectors) {
      if (c.name === connector.name && c.source === 'agent') {
        assignedAgents.add(c.scope.replace('agent:', ''))
      }
    }
    const mainAgent = allAgents.find(a => a.name === mainAgentId())
    const subAgents = allAgents.filter(a => a.name !== mainAgentId())

    const listEl = document.getElementById('connectorAgentList')
    listEl.innerHTML = ''
    if (mainAgent) {
      const item = document.createElement('div')
      item.className = 'connector-agent-item connector-agent-auto'
      item.innerHTML = `
        <input type="checkbox" checked disabled title="${t('connectors.tooltip.global')}">
        <label>${escapeHtml(mainAgent.label || mainAgent.name)} <span class="tag-auto">automatikus</span></label>
      `
      listEl.appendChild(item)
    }
    for (const agent of subAgents) {
      const isAssigned = assignedAgents.has(agent.name)
      const item = document.createElement('div')
      item.className = 'connector-agent-item'
      item.innerHTML = `
        <input type="checkbox" id="assign-${agent.name}" value="${agent.name}" ${isAssigned ? 'checked' : ''}>
        <label for="assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
      `
      listEl.appendChild(item)
    }
    if (subAgents.length === 0 && !mainAgent) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('connectors.no_agents')}</p>`
    }
  } catch {
    document.getElementById('connectorAgentList').innerHTML = ''
  }

  // Delete button
  document.getElementById('connectorDeleteBtn').onclick = async () => {
    if (!confirm(`Biztosan torlod: ${connector.name}?`)) return
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`, { method: 'DELETE' })
      closeModal(connectorDetailOverlay)
      showToast(t('connectors.toast.deleted'))
      loadConnectors()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Assign button
  document.getElementById('connectorAssignBtn').onclick = async () => {
    const checked = [...document.querySelectorAll('#connectorAgentList input:checked:not(:disabled)')].map(i => i.value)
    const allVisible = [...document.querySelectorAll('#connectorAgentList input:not(:disabled)')].map(i => i.value)
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checked, allAgents: allVisible }),
      })
      showToast(t('connectors.toast.assignment_updated'))
      closeModal(connectorDetailOverlay)
      loadConnectors()
    } catch {
      showToast(t('connectors.toast.assignment_error'))
    }
  }

  openModal(connectorDetailOverlay)
}

// ENV row management for new connector form
document.getElementById('connectorEnvAddBtn').addEventListener('click', () => {
  const list = document.getElementById('connectorEnvList')
  const row = document.createElement('div')
  row.className = 'connector-env-row'
  row.innerHTML = `
    <input type="text" class="input env-key" placeholder="KULCS" style="flex:1">
    <span style="color:var(--text-muted)">=</span>
    <input type="text" class="input env-val" placeholder="${t('connectors.env_val_placeholder')}" style="flex:2">
    <button type="button" class="btn-link" style="color:var(--danger);padding:2px 6px">&times;</button>
  `
  row.querySelector('button').addEventListener('click', () => row.remove())
  list.appendChild(row)
})

async function loadNewConnectorAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const list = document.getElementById('connectorNewAssignList')
    list.innerHTML = ''
    for (const agent of agents) {
      const item = document.createElement('div')
      item.className = 'connector-agent-item'
      item.innerHTML = `
        <input type="checkbox" id="new-assign-${agent.name}" value="${agent.name}">
        <label for="new-assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
      `
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

// Save new connector
document.getElementById('saveConnectorBtn').addEventListener('click', async () => {
  const name = document.getElementById('connectorName').value.trim()
  const type = document.getElementById('connectorType').value
  const scope = document.getElementById('connectorScope').value

  if (!name) { document.getElementById('connectorName').focus(); return }

  const data = { name, type, scope }
  if (type === 'http' || type === 'sse') {
    data.url = document.getElementById('connectorUrl').value.trim()
    if (!data.url) { document.getElementById('connectorUrl').focus(); return }
  } else {
    data.command = document.getElementById('connectorCmd').value.trim()
    data.args = document.getElementById('connectorArgs').value.trim()
    if (!data.command) { document.getElementById('connectorCmd').focus(); return }
    const envRows = document.querySelectorAll('#connectorEnvList .connector-env-row')
    if (envRows.length > 0) {
      const env = {}
      for (const row of envRows) {
        const k = row.querySelector('.env-key').value.trim()
        const v = row.querySelector('.env-val').value.trim()
        if (k) env[k] = v
      }
      if (Object.keys(env).length > 0) data.env = env
    }
  }

  const btn = document.getElementById('saveConnectorBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    const result = await res.json()
    const savedName = result.name || name

    const checkedAgents = Array.from(document.querySelectorAll('#connectorNewAssignList input[type=checkbox]:checked')).map(cb => cb.value)
    const allAgents = Array.from(document.querySelectorAll('#connectorNewAssignList input[type=checkbox]')).map(cb => cb.value)
    if (checkedAgents.length > 0) {
      await fetch(`/api/connectors/${encodeURIComponent(savedName)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checkedAgents, allAgents }),
      }).catch(() => {})
    }

    closeModal(connectorModalOverlay)
    if (result.nameChanged) {
      showToast(t('connectors.toast.added', { name: savedName }))
    } else {
      showToast(t('connectors.toast.created'))
    }
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

export { loadVaultPage, loadVault }
// Bridge so connectors.js can call vault helpers before vault is imported
window.loadExternalPaths = loadExternalPaths
window.loadNewConnectorAgents = loadNewConnectorAgents
