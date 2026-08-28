import { escapeHtml, mainAgentId } from './util.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'
import { getErrorMessage } from './error-message.js'


let _openModal = null, _closeModal = null
export function initConnectors({ openModal, closeModal } = {}) {
  _openModal = openModal; _closeModal = closeModal
}

// ============================================================
// === Connectors ===
// ============================================================

const connectorGrid = document.getElementById('connectorGrid')
const connectorStats = document.getElementById('connectorStats')
const connectorModalOverlay = document.getElementById('connectorModalOverlay')
const connectorDetailOverlay = document.getElementById('connectorDetailOverlay')
const catalogInstallOverlay = document.getElementById('catalogInstallOverlay')
let connectors = []
let catalogItems = []
let catalogFilter = 'all'
let catalogInstallTarget = null

// Connector tab switching
document.querySelectorAll('.connector-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.connector-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const tabId = tab.dataset.ctab
    document.getElementById('connectorInstalledTab').hidden = tabId !== 'installed'
    document.getElementById('connectorGalleryTab').hidden = tabId !== 'gallery'
    if (tabId === 'gallery') loadCatalog()
  })
})

// Refresh button: triggers the server-side `claude mcp list` refresh.
// Deliberately manual because every refresh spawns stdio / plugin MCPs
// for a health check and can race the live Telegram bot. Button is
// shared by both the Installed and Gallery tabs.
document.getElementById('connectorRefreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectorRefreshBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/connectors/refresh', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      showToast(t('updates.error', {msg: getErrorMessage(data, 'HTTP ' + res.status)}))
    } else {
      showToast(t('connectors.toast.mcp_refreshed', { n: data.count || 0 }))
    }
    await loadConnectors()
    // Reload catalog only if the Gallery tab is currently active so we
    // do not fight for the catalog grid while the user is on Installed.
    if (!document.getElementById('connectorGalleryTab').hidden) {
      await loadCatalog()
    }
  } catch (err) {
    showToast(t('updates.toast.error', {msg: err.message || err}))
  } finally {
    btn.disabled = false
  }
})

// Catalog filter buttons
document.querySelectorAll('.catalog-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.catalog-filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    catalogFilter = btn.dataset.cat
    renderCatalog()
  })
})

// Catalog install modal
document.getElementById('catalogInstallClose').addEventListener('click', () => _closeModal?.(catalogInstallOverlay))
catalogInstallOverlay.addEventListener('click', (e) => { if (e.target === catalogInstallOverlay) _closeModal?.(catalogInstallOverlay) })

async function loadCatalog() {
  const grid = document.getElementById('catalogGrid')
  grid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('connectors.catalog_loading')}</div>`
  try {
    const res = await fetch('/api/mcp-catalog')
    catalogItems = await res.json()
    renderCatalog()
  } catch (err) {
    console.error('Catalog load error:', err)
    grid.innerHTML = `<div class="connector-loading">${t('connectors.catalog_error')}</div>`
  }
}

function renderCatalog() {
  const grid = document.getElementById('catalogGrid')
  grid.innerHTML = ''
  const filtered = catalogFilter === 'all' ? catalogItems : catalogItems.filter(i => i.category === catalogFilter)
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="connector-loading">${t('connectors.catalog_empty')}</div>`
    return
  }
  for (const item of filtered) {
    const card = document.createElement('div')
    card.className = 'catalog-card'
    const authHint = item.authType === 'oauth' && item.authNote ? `<span class="catalog-auth-hint">${escapeHtml(item.authNote)}</span>` : ''
    card.innerHTML = `
      <div class="catalog-card-header">
        <div class="catalog-card-icon">${item.icon || '?'}</div>
        <div class="catalog-card-info">
          <div class="catalog-card-name">
            ${escapeHtml(item.name)}
            <span class="catalog-card-type ${item.type}">${item.type}</span>
            ${item.infoUrl ? `<a href="${escapeHtml(item.infoUrl)}" target="_blank" rel="noopener" class="catalog-card-link" title="${t('connectors.tooltip.docs')}" onclick="event.stopPropagation()">&#x2197;</a>` : ''}
          </div>
          <div class="catalog-card-desc">${escapeHtml(item.description)}</div>
        </div>
      </div>
      <div class="catalog-card-footer">
        ${item.installed
          ? `<span class="catalog-install-btn installed" title="${item.configMatch ? t('connectors.tooltip.installed_mcp') : t('connectors.tooltip.installed_src', { src: escapeHtml(item.installedSource || '') })}">Telepítve &#10003;${item.configMatch ? ' (.mcp.json)' : item.installedSource === 'claude.ai' ? ' (claude.ai)' : item.installedSource === 'plugin' ? ' (plugin)' : ''}</span>${(item.installedSource === 'claude.ai' || item.configMatch) ? '' : `<a class="catalog-uninstall-link" data-id="${item.id}">Eltávolítás</a>`}`
          : `<button class="catalog-install-btn install" data-id="${item.id}">${t('connectors.catalog.install_btn')}</button>${authHint}`
        }
      </div>
    `
    // Install button
    const installBtn = card.querySelector('.catalog-install-btn.install')
    if (installBtn) {
      installBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        openCatalogInstall(item)
      })
    }
    // Uninstall link
    const uninstallLink = card.querySelector('.catalog-uninstall-link')
    if (uninstallLink) {
      uninstallLink.addEventListener('click', (e) => {
        e.stopPropagation()
        catalogUninstall(item)
      })
    }
    grid.appendChild(card)
  }
}

function openCatalogInstall(item) {
  catalogInstallTarget = item
  document.getElementById('catalogInstallTitle').textContent = t('connectors.catalog.install_title', { icon: item.icon, name: item.name })
  document.getElementById('catalogInstallDesc').textContent = item.description

  const envContainer = document.getElementById('catalogInstallEnvFields')
  envContainer.innerHTML = ''
  const noteEl = document.getElementById('catalogInstallNote')
  noteEl.hidden = true

  if (item.authType === 'apikey') {
    // Show env key input fields
    const envKeys = Object.keys(item.env || {})
    for (const key of envKeys) {
      const div = document.createElement('div')
      div.className = 'catalog-env-group'
      div.innerHTML = `
        <label>${escapeHtml(key)}</label>
        <input type="text" data-env-key="${escapeHtml(key)}" placeholder="${t('connectors.catalog.env_placeholder', { key: escapeHtml(key) })}">
      `
      envContainer.appendChild(div)
    }
    if (item.authNote) {
      noteEl.textContent = item.authNote
      noteEl.hidden = false
    }
  } else if (item.authType === 'oauth') {
    if (item.authNote) {
      noteEl.textContent = item.authNote
      noteEl.hidden = false
    }
  }
  // authType === 'none' -> no extra fields

  _openModal?.(catalogInstallOverlay)
}

document.getElementById('catalogInstallBtn').addEventListener('click', async () => {
  if (!catalogInstallTarget) return
  const item = catalogInstallTarget
  const btn = document.getElementById('catalogInstallBtn')

  // Collect env values
  const envData = {}
  const envInputs = document.querySelectorAll('#catalogInstallEnvFields input[data-env-key]')
  for (const input of envInputs) {
    const key = input.dataset.envKey
    const val = input.value.trim()
    if (!val) {
      input.focus()
      showToast(t('connectors.toast.required_field', { key }))
      return
    }
    envData[key] = val
  }

  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/mcp-catalog/${encodeURIComponent(item.id)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: envData }),
    })
    const data = await res.json()
    // apiData carries the full response object for getErrorMessage(); do NOT use err.message
    if (!res.ok) throw Object.assign(new Error('api call failed'), { apiData: data })
    _closeModal?.(catalogInstallOverlay)
    showToast(data.message || t('connectors.toast.installed'))
    // Reload both views
    loadCatalog()
    loadConnectors()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Hiba'))
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

async function catalogUninstall(item) {
  if (!confirm(t('connectors.confirm.remove', { name: item.name }))) return
  try {
    const res = await fetch(`/api/mcp-catalog/${encodeURIComponent(item.id)}/uninstall`, { method: 'DELETE' })
    const data = await res.json()
    // apiData carries the full response object for getErrorMessage(); do NOT use err.message
    if (!res.ok) throw Object.assign(new Error('api call failed'), { apiData: data })
    showToast(data.message || t('connectors.toast.removed'))
    loadCatalog()
    loadConnectors()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Hiba'))
  }
}

// Modal wiring
document.getElementById('addConnectorBtn').addEventListener('click', () => {
  document.getElementById('connectorName').value = ''
  document.getElementById('connectorUrl').value = ''
  document.getElementById('connectorCmd').value = ''
  document.getElementById('connectorArgs').value = ''
  document.getElementById('connectorType').value = 'stdio'
  document.getElementById('connectorScope').value = 'user'
  document.getElementById('connectorUrlGroup').hidden = true
  document.getElementById('connectorCmdGroup').hidden = false
  document.getElementById('connectorArgsGroup').hidden = false
  document.getElementById('connectorEnvGroup').hidden = false
  document.getElementById('connectorEnvList').innerHTML = ''
  document.getElementById('connectorAssignGroup').hidden = true
  loadNewConnectorAgents()
  _openModal?.(connectorModalOverlay)
})
document.getElementById('connectorModalClose').addEventListener('click', () => _closeModal?.(connectorModalOverlay))
document.getElementById('connectorDetailClose').addEventListener('click', () => _closeModal?.(connectorDetailOverlay))
connectorModalOverlay.addEventListener('click', (e) => { if (e.target === connectorModalOverlay) _closeModal?.(connectorModalOverlay) })
connectorDetailOverlay.addEventListener('click', (e) => { if (e.target === connectorDetailOverlay) _closeModal?.(connectorDetailOverlay) })

// Type toggle
document.getElementById('connectorType').addEventListener('change', () => {
  const isStdio = document.getElementById('connectorType').value === 'stdio'
  document.getElementById('connectorUrlGroup').hidden = isStdio
  document.getElementById('connectorCmdGroup').hidden = !isStdio
  document.getElementById('connectorArgsGroup').hidden = !isStdio
  document.getElementById('connectorEnvGroup').hidden = !isStdio
})

// Scope toggle: hide agent assignment for global scope
document.getElementById('connectorScope').addEventListener('change', () => {
  const isProject = document.getElementById('connectorScope').value === 'project'
  document.getElementById('connectorAssignGroup').hidden = !isProject
})

// Default TRUE: if we never successfully read /api/connectors/status
// (endpoint missing on older backends, network error, non-2xx response)
// the safe assumption is that the cache has not populated yet. That
// way an empty list renders as "warming" rather than the misleading
// "no connectors" the F2 round-3 fix was meant to eliminate.
let connectorCacheWarming = true
let connectorCacheError = ''

export async function loadConnectors() {
  connectorGrid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('connectors.loading')}</div>`
  connectorStats.innerHTML = ''
  // Reset pessimistic state at the top of every load. Only an authoritative
  // positive signal (status endpoint reports cacheLastRefreshed > 0) flips
  // it to false, so a later status-fetch failure cannot leave a stale
  // `false` that regresses into "no connectors" again.
  connectorCacheWarming = true
  connectorCacheError = ''
  try {
    // Fetch both in parallel: the list itself and a lightweight status
    // readout that tells us whether the server-side cache has ever run.
    // Without the status, a cold-start hit on the page would render
    // "Nincsenek MCP connectorok" -- contradicting the info-box that
    // says "A lista a dashboard indulasakor toltodik be".
    const [listRes, statusRes] = await Promise.all([
      fetch('/api/connectors'),
      fetch('/api/connectors/status').catch(() => null),
    ])
    connectors = await listRes.json()
    if (statusRes && statusRes.ok) {
      const s = await statusRes.json().catch(() => ({}))
      if (s && s.cacheLastRefreshed > 0) connectorCacheWarming = false
      if (s && s.cacheError) connectorCacheError = String(s.cacheError)
    }
    renderConnectors()
    loadExternalPaths()
    loadGitHubRepos()
    loadVault()
  } catch (err) {
    console.error('Connector betöltés hiba:', err)
    connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.load_error')}</div>`
  }
}

// Built-in MCPs: features that live inside the Claude Code binary or
// app rather than as a registered MCP server. They cannot be detected
// via `claude mcp list`, so the "Aktív / Kikapcsolva" label used to
// always read "Kikapcsolva" regardless of the real state. Replace the
// misleading state badge with a "Részletek" button that opens a modal
// carrying the real enable instructions (which previously hid inside
// a `title` tooltip the user had to hover to discover).
const BUILTIN_MCPS = [
  {
    name: 'computer-use',
    label: 'Computer Use',
    desc: () => t('connectors.builtin.computer_use'),
    get detailHtml() { return t('connectors.builtin.computer_use_html') },
  },
  {
    name: 'chrome',
    label: 'Claude in Chrome',
    desc: () => t('connectors.builtin.chrome'),
    get detailHtml() { return t('connectors.builtin.chrome_html') },
  },
]

function openBuiltinDetail(item) {
  const overlay = document.getElementById('builtinDetailOverlay')
  if (!overlay) return
  document.getElementById('builtinDetailTitle').textContent = item.label
  document.getElementById('builtinDetailDesc').textContent = typeof item.desc === 'function' ? item.desc() : item.desc
  // Static strings only. Never interpolate user or server input here
  // without passing it through escapeHtml first -- detailHtml is a
  // raw HTML sink.
  document.getElementById('builtinDetailBody').innerHTML = item.detailHtml
  _openModal?.(overlay)
  // Move focus into the dialog so keyboard users land inside the new
  // surface instead of keeping the Részletek button focused behind
  // the overlay. Same pattern the other modals in this file skip, but
  // cheap to add for accessibility.
  const closeBtn = document.getElementById('builtinDetailClose')
  if (closeBtn) setTimeout(() => closeBtn.focus(), 50)
}

// Wire close paths for the built-in detail modal once per load. Guarded
// so a future refactor that moves the script tag above the modal HTML
// (e.g. deferred <head> load) does not fire a silent null-ref here.
function wireBuiltinDetailModal() {
  const overlay = document.getElementById('builtinDetailOverlay')
  const closeBtn = document.getElementById('builtinDetailClose')
  if (!overlay || !closeBtn) return
  closeBtn.addEventListener('click', () => _closeModal?.(overlay))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) _closeModal?.(overlay)
  })
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireBuiltinDetailModal, { once: true })
} else {
  wireBuiltinDetailModal()
}

function renderConnectors() {
  // Detach panels that live inside connectorGrid before innerHTML wipes them
  const _extPathsPanel = document.getElementById('externalPathsSection')
  if (_extPathsPanel) _extPathsPanel.remove()

  // Stats
  if (connectors.length === 0 && connectorCacheWarming) {
    connectorStats.innerHTML = ''
  } else {
    const connected = connectors.filter(c => c.status === 'connected').length
    // 'configured' = declared in a .mcp.json (not health-checked, the backend
    // never spawns them). These are known-good, not broken -- surface them in a
    // positive count so file-defined servers (e.g. gmail-egov) do not look
    // un-ready just because they never went through the claude mcp list cache.
    const configured = connectors.filter(c => c.status === 'configured').length
    const needsAuth = connectors.filter(c => c.status === 'needs_auth').length
    const failed = connectors.filter(c => c.status === 'failed').length
    connectorStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${connectors.length}</div><div class="stat-label">${t('connectors.stat.total')}</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--success)">${connected}</div><div class="stat-label">${t('connectors.stat.active')}</div></div>
      ${configured ? `<div class="stat-card"><div class="stat-value" style="color:var(--info)">${configured}</div><div class="stat-label">${t('connectors.stat.configured')}</div></div>` : ''}
      ${needsAuth ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${needsAuth}</div><div class="stat-label">${t('connectors.stat.needs_auth')}</div></div>` : ''}
      ${failed ? `<div class="stat-card"><div class="stat-value" style="color:var(--danger)">${failed}</div><div class="stat-label">${t('connectors.stat.failed')}</div></div>` : ''}
    `
  }

  connectorGrid.innerHTML = ''
  const hasClaudeAiEntries = connectors.some(c => c.source === 'claude.ai')
  if (connectors.length > 0 && !connectorCacheWarming && connectorCacheError && hasClaudeAiEntries) {
    const banner = document.createElement('div')
    banner.className = 'connector-stale-banner'
    banner.innerHTML = t('connectors.stale_banner', { msg: escapeHtml(connectorCacheError) })
    connectorGrid.appendChild(banner)
  }
  if (connectors.length === 0 && !BUILTIN_MCPS.length) {
    if (connectorCacheWarming && connectorCacheError) {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.mcp_load_failed', { msg: escapeHtml(connectorCacheError) })}</div>`
    } else if (connectorCacheWarming) {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.mcp_not_loaded')}</div>`
    } else {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.no_mcps')}</div>`
    }
    return
  }

  // Group by scope
  const groups = new Map()
  for (const c of connectors) {
    const scope = c.scope || 'global'
    if (!groups.has(scope)) groups.set(scope, [])
    groups.get(scope).push(c)
  }

  const globalScopes = ['global', 'plugin']
  const agentScopes = []
  const internalProjectScopes = []
  const externalProjectScopes = []
  for (const scope of groups.keys()) {
    if (scope.startsWith('agent:')) agentScopes.push(scope)
    else if (scope.startsWith('project:external/')) externalProjectScopes.push(scope)
    else if (scope.startsWith('project:')) internalProjectScopes.push(scope)
    else if (!globalScopes.includes(scope)) globalScopes.push(scope)
  }
  agentScopes.sort()
  internalProjectScopes.sort()
  externalProjectScopes.sort()

  const sourceLabels = {
    'claude.ai': 'claude.ai',
    'plugin': 'plugin',
    'local-user': 'local (user)',
    'local-project': 'local (project)',
    'local': 'local',
    'agent': 'agent',
    'agent-project': 'project',
    'external-project': 'external',
  }

  function renderCard(c, container) {
    const card = document.createElement('div')
    card.className = 'connector-card'
    const sourceTag = c.source ? `<span class="connector-source-badge">${escapeHtml(sourceLabels[c.source] || c.source)}</span>` : ''
    const readOnly = c.source === 'claude.ai'
    if (readOnly) card.classList.add('connector-card-readonly')
    const readonlyHint = readOnly ? `<div class="connector-readonly-hint">${t('connectors.readonly_hint')}</div>` : ''
    card.innerHTML = `
      <div class="connector-status-dot ${c.status}"></div>
      <div class="connector-info">
        <div class="connector-name">${escapeHtml(c.name)} ${sourceTag}</div>
        <div class="connector-endpoint">${escapeHtml(c.endpoint || '')}</div>
        ${readonlyHint}
      </div>
      <span class="connector-type-badge ${c.type}">${c.type}</span>
    `
    if (!readOnly) card.addEventListener('click', () => openConnectorDetail(c))
    container.appendChild(card)
  }

  function renderCollapsible(label, icon, items, container) {
    const section = document.createElement('div')
    section.className = 'connector-scope-section'
    const header = document.createElement('div')
    header.className = 'connector-scope-header collapsible'
    header.innerHTML = `<span class="connector-scope-toggle">▶</span> ${icon} ${escapeHtml(label)} <span class="connector-scope-count">${items.length}</span>`
    header.addEventListener('click', () => {
      const grid = section.querySelector('.connector-scope-grid')
      const toggle = header.querySelector('.connector-scope-toggle')
      if (grid.hidden) { grid.hidden = false; toggle.textContent = '▼' }
      else { grid.hidden = true; toggle.textContent = '▶' }
    })
    section.appendChild(header)
    const grid = document.createElement('div')
    grid.className = 'connector-scope-grid'
    grid.hidden = true
    for (const c of items) renderCard(c, grid)
    section.appendChild(grid)
    container.appendChild(section)
  }

  // === Claude globális ===
  const globalHeading = document.createElement('div')
  globalHeading.className = 'connector-group-heading'
  globalHeading.textContent = t('connectors.heading.global')
  connectorGrid.appendChild(globalHeading)

  const builtinGrid = document.createElement('div')
  builtinGrid.className = 'connector-builtin-grid'
  for (const b of BUILTIN_MCPS) {
    const div = document.createElement('div')
    div.className = 'connector-builtin'
    div.innerHTML = `
      <div class="connector-status-dot unknown" title="${t('connectors.tooltip.auto_detect')}"></div>
      <div class="connector-builtin-name">${escapeHtml(b.label)}<br><span style="font-size:11px;color:var(--text-muted);font-weight:400">${escapeHtml(typeof b.desc === 'function' ? b.desc() : b.desc)}</span></div>
      <button type="button" class="connector-builtin-action btn-link" data-builtin="${escapeHtml(b.name)}">${t('connectors.builtin.details')}</button>
    `
    const btn = div.querySelector('button[data-builtin]')
    if (btn) btn.addEventListener('click', () => openBuiltinDetail(b))
    builtinGrid.appendChild(div)
  }
  connectorGrid.appendChild(builtinGrid)

  const globalGrid = document.createElement('div')
  globalGrid.className = 'connector-scope-grid'
  for (const scope of globalScopes) {
    for (const c of (groups.get(scope) || [])) renderCard(c, globalGrid)
  }
  if (globalGrid.children.length > 0) connectorGrid.appendChild(globalGrid)

  // === Ügynökök ===
  if (agentScopes.length > 0) {
    const agentHeading = document.createElement('div')
    agentHeading.className = 'connector-group-heading'
    agentHeading.textContent = t('connectors.heading.agents')
    connectorGrid.appendChild(agentHeading)

    for (const ag of agentScopes) {
      const agentName = ag.slice('agent:'.length)
      renderCollapsible(agentName, '🤖', groups.get(ag), connectorGrid)
    }
  }

  // === Projektek (belső) ===
  if (internalProjectScopes.length > 0) {
    const projectHeading = document.createElement('div')
    projectHeading.className = 'connector-group-heading'
    projectHeading.textContent = t('connectors.heading.projects')
    connectorGrid.appendChild(projectHeading)

    for (const ps of internalProjectScopes) {
      const parts = ps.slice('project:'.length).split('/')
      const projLabel = parts[parts.length - 1]
      renderCollapsible(projLabel, '📁', groups.get(ps), connectorGrid)
    }
  }

  // === Külső projektek ===
  if (externalProjectScopes.length > 0 || _extPathsPanel) {
    const extHeading = document.createElement('div')
    extHeading.className = 'connector-group-heading'
    extHeading.textContent = t('connectors.heading.external')
    connectorGrid.appendChild(extHeading)

    if (_extPathsPanel) connectorGrid.appendChild(_extPathsPanel)

    for (const ps of externalProjectScopes) {
      const projLabel = ps.slice('project:external/'.length)
      renderCollapsible(projLabel, '📂', groups.get(ps), connectorGrid)
    }
  }
}

// --- GitHub repo management ---
async function loadGitHubRepos() {
  try {
    const res = await fetch('/api/connectors/github-repos')
    const data = await res.json()
    const repos = data.repos || []
    document.getElementById('githubRepoCount').textContent = String(repos.length)
    const list = document.getElementById('githubRepoList')
    list.innerHTML = ''
    for (const r of repos) {
      const item = document.createElement('div')
      item.className = 'connector-external-item github-repo-item'
      const date = new Date(r.installedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(r.name.replace('--', '/'))}</span><span class="github-repo-date">${date}</span></div><div class="github-repo-actions"><button class="github-repo-update" title="Frissites">&#x21bb;</button><button class="github-repo-delete" title="Torles">&times;</button></div>`
      item.querySelector('.github-repo-update').addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.textContent = '...'
        try {
          const res = await fetch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`, { method: 'PATCH' })
          const data = await res.json()
          if (data.error) { alert(getErrorMessage(data)); return }
          loadConnectors()
        } finally { btn.disabled = false; btn.innerHTML = '&#x21bb;' }
      })
      item.querySelector('.github-repo-delete').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${r.name.replace('--', '/')}?`)) return
        await fetch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`, { method: 'DELETE' })
        loadGitHubRepos()
        loadExternalPaths()
        loadConnectors()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireGitHubRepos() {
  const toggle = document.getElementById('githubReposToggle')
  const body = document.getElementById('githubReposBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('githubRepoAddBtn')
  const input = document.getElementById('githubRepoInput')
  const status = document.getElementById('githubRepoStatus')
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    addBtn.disabled = true
    addBtn.textContent = 'Telepites...'
    status.hidden = false
    status.className = 'github-repo-status loading'
    status.textContent = t('connectors.cloning')
    try {
      const res = await fetch('/api/connectors/github-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: val }),
      })
      const data = await res.json()
      if (data.error) {
        status.className = 'github-repo-status error'
        status.textContent = getErrorMessage(data)
        return
      }
      if (data.requiredEnvVars && data.requiredEnvVars.length > 0) {
        status.className = 'github-repo-status loading'
        status.textContent = t('connectors.api_keys_needed')
        const envValues = await showEnvVarModal(data.requiredEnvVars)
        if (envValues && Object.keys(envValues).length > 0) {
          let vaultAllOk = true
          for (const [key, value] of Object.entries(envValues)) {
            const r = await fetch('/api/vault', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: `github-env-${data.repo.name}-${key}`, label: `${key} (${data.repo.name.replace('--', '/')})`, value }),
            })
            if (!r.ok) vaultAllOk = false
          }
          if (vaultAllOk) {
            status.className = 'github-repo-status success'
            status.textContent = 'Telepitve, kulcsok mentve a Vault-ba!'
          } else {
            status.className = 'github-repo-status error'
            status.textContent = 'Telepitve, de néhány kulcs mentése sikertelen. Add meg újra a Vault-ban.'
          }
          loadVault()
        } else {
          status.className = 'github-repo-status success'
          status.textContent = 'Telepitve (kulcsok kihagyva)'
        }
      } else {
        status.className = 'github-repo-status success'
        status.textContent = 'Telepitve!'
      }
      input.value = ''
      loadGitHubRepos()
      loadExternalPaths()
      loadConnectors()
      setTimeout(() => { status.hidden = true }, 4000)
    } catch (err) {
      status.className = 'github-repo-status error'
      status.textContent = 'Hiba: ' + err.message
    } finally {
      addBtn.disabled = false
      addBtn.textContent = 'Telepites'
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

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
        const res = await fetch(`/api/vault/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        if (!res.ok) { showToast('Törlés sikertelen'); return }
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
    const res = await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label: id, value: val }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      showToast('Mentés sikertelen: ' + getErrorMessage(e, String(res.status)))
      return
    }
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

// --- SSH Vault ---
let _sshServers = []
let _sshKeys = []
let _sshView = 'table'
let _sshEditingId = null

async function loadSshServers() {
  try {
    const res = await fetch('/api/vault/ssh-servers')
    const data = await res.json()
    _sshServers = data.servers || []
    renderSshServers()
  } catch { /* ignore */ }
}

async function loadSshKeys() {
  try {
    const res = await fetch('/api/vault/ssh-keys')
    if (!res.ok) return
    const data = await res.json()
    _sshKeys = data.keys || []
    renderSshKeys()
    _refreshKeySelects()
  } catch { /* ignore */ }
}

function renderSshKeys() {
  const tbody = document.getElementById('sshKeysTableBody')
  const keysView = document.getElementById('sshKeysView')
  const emptyEl = document.getElementById('sshKeysEmpty')
  if (!tbody) return
  if (_sshKeys.length === 0) {
    keysView.hidden = true
    emptyEl.hidden = false
    return
  }
  keysView.hidden = false
  emptyEl.hidden = true
  tbody.innerHTML = _sshKeys.map(k => `
    <tr>
      <td class="ssh-table-name">${escapeHtml(k.label || k.id)}</td>
      <td class="ssh-table-mono">${escapeHtml(k.username || '')}</td>
      <td class="ssh-table-mono">${escapeHtml(k.keyType || 'ed25519')}</td>
      <td class="ssh-table-mono" style="font-size:11px">${k.fingerprint ? escapeHtml(k.fingerprint.slice(0,28)) + '…' : ''}</td>
      <td class="ssh-table-mono">${k.createdAt ? new Date(k.createdAt).toLocaleDateString('hu-HU') : ''}</td>
      <td><div class="ssh-table-actions">
        <button class="btn ssh-key-copy-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(k.id)}" title="Publikus kulcs másolása">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn ssh-key-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(k.id)}" title="Törlés">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </div></td>
    </tr>
  `).join('')
  tbody.querySelectorAll('.ssh-key-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = _sshKeys.find(k => k.id === btn.dataset.id)
      if (!key) return
      try {
        const res = await fetch(`/api/vault/ssh-keys/${encodeURIComponent(btn.dataset.id)}/public-key`)
        if (res.ok) {
          const data = await res.json()
          await navigator.clipboard.writeText(data.publicKey || '')
          btn.textContent = '✓'
          setTimeout(() => { btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' }, 1500)
        }
      } catch { /* ignore */ }
    })
  })
  tbody.querySelectorAll('.ssh-key-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Biztosan törlöd ezt a kulcsot?')) return
      await fetch(`/api/vault/ssh-keys/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
      await loadSshKeys()
    })
  })
}

function _refreshKeySelects() {
  const opts = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
  ].join('')
  document.querySelectorAll('.ssh-key-select').forEach(sel => {
    const prev = sel.value
    sel.innerHTML = opts
    sel.value = prev
  })
}

function _sshKeyBadge(status) {
  const labels = { ok: 'OK', missing: 'Hiányzó', expired: 'Lejárt' }
  const icons = {
    ok: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    missing: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    expired: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  }
  return `<span class="ssh-key-badge ${status}">${icons[status] || ''} ${labels[status] || status}</span>`
}

function _sshKeyAssignSelect(s) {
  const currentKeyId = s.sshKeyId || s.assignedKeyId || s.vaultKeyId || ''
  const opts = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => {
      const sel = (currentKeyId && currentKeyId === k.id) ? ' selected' : ''
      return `<option value="${escapeHtml(k.id)}"${sel}>${escapeHtml(k.label || k.id)}</option>`
    })
  ].join('')
  return `<select class="ssh-key-assign ssh-key-select" data-id="${escapeHtml(s.id)}" title="Kulcs hozzárendelése">${opts}</select>`
}

function _sshInfoBtn(s) {
  return `<button class="ssh-info-btn" data-id="${escapeHtml(s.id)}" data-user="${escapeHtml(s.user)}" title="Telepítési útmutató">i</button>`
}

function renderSshServers() {
  const cardsEl = document.getElementById('sshCardsView')
  const tableView = document.getElementById('sshTableView')
  const tableBody = document.getElementById('sshTableBody')
  const emptyEl = document.getElementById('sshEmpty')
  if (!cardsEl || !tableBody || !emptyEl) return

  // Sync view state with _sshView
  const isTable = _sshView === 'table'
  cardsEl.hidden = isTable
  if (tableView) tableView.hidden = !isTable
  document.getElementById('sshViewCards')?.classList.toggle('active', !isTable)
  document.getElementById('sshViewTable')?.classList.toggle('active', isTable)

  if (_sshServers.length === 0) {
    cardsEl.innerHTML = ''
    tableBody.innerHTML = ''
    emptyEl.hidden = false
    return
  }
  emptyEl.hidden = true

  // Cards
  cardsEl.innerHTML = _sshServers.map(s => `
    <div class="ssh-card" data-id="${escapeHtml(s.id)}">
      <div class="ssh-card-head">
        <div class="ssh-card-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
        </div>
        <div class="ssh-card-title">
          <div class="ssh-card-name">${escapeHtml(s.name)}</div>
          ${s.desc ? `<div class="ssh-card-desc">${escapeHtml(s.desc)}</div>` : ''}
        </div>
      </div>
      <div class="ssh-card-meta">
        <div class="ssh-card-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span>${escapeHtml(s.host)}</span>
        </div>
        <div class="ssh-card-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>${escapeHtml(s.user)}${s.port !== 22 ? ` :${s.port}` : ''}</span>
        </div>
        ${s.fingerprint ? `<div class="ssh-card-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>${escapeHtml(s.keyType || '')} ${escapeHtml(s.fingerprint.slice(0,24))}…</span></div>` : ''}
      </div>
      <div class="ssh-card-footer">
        <div style="display:flex;align-items:center;gap:4px;width:100%">
          ${_sshKeyAssignSelect(s)}
          <div class="ssh-card-actions">
            <button class="btn ssh-edit-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Szerkesztés">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn ssh-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Törlés">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `).join('')

  // Table
  tableBody.innerHTML = _sshServers.map(s => `
    <tr data-id="${escapeHtml(s.id)}">
      <td class="ssh-table-name">${escapeHtml(s.name)}</td>
      <td class="ssh-table-mono">${escapeHtml(s.host)}</td>
      <td class="ssh-table-mono">${escapeHtml(s.user)}</td>
      <td class="ssh-table-mono">${s.port}</td>
      <td>${_sshKeyAssignSelect(s)}</td>
      <td style="color:var(--text-muted)">${escapeHtml(s.desc || '')}</td>
      <td><div class="ssh-table-actions">
        <button class="btn ssh-edit-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Szerkesztés">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn ssh-delete-btn" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" title="Törlés">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div></td>
    </tr>
  `).join('')

  // Delete handlers
  document.querySelectorAll('.ssh-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Törlöd: ${id}?`)) return
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
        await loadSshServers()
      } catch { showToast('Törlés sikertelen') }
    })
  })

  // Edit handlers -- open the add-server panel pre-filled, switch it to edit mode
  document.querySelectorAll('.ssh-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      const server = _sshServers.find(s => s.id === id)
      if (!server) return
      _sshEditingId = id

      document.getElementById('sshNameInput').value = server.name || ''
      document.getElementById('sshHostInput').value = server.host || ''
      document.getElementById('sshUserInput').value = server.user || ''
      document.getElementById('sshPortInput').value = server.port || 22
      document.getElementById('sshDescInput').value = server.desc || ''
      const keySel = document.getElementById('sshKeySelectInput')
      if (keySel) keySel.value = server.sshKeyId || server.assignedKeyId || server.vaultKeyId || ''

      const titleEl = document.getElementById('sshAddPanelTitle')
      if (titleEl) titleEl.textContent = `Szerver szerkesztése – ${server.name}`

      const panel = document.getElementById('sshAddPanel')
      panel.hidden = false
      document.getElementById('sshNameInput').focus()
    })
  })

  // Key assign select handlers
  document.querySelectorAll('.ssh-key-assign').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-id')
      const sshKeyId = sel.value || null
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshKeyId }),
        })
        await loadSshServers()
      } catch { /* ignore */ }
    })
  })

}

// --- SSH Keygen modal (standalone key creation for Kulcstároló) ---
let _sshKeygenCallback = null  // called with new key after successful generation

function openSshKeygenModal(callback) {
  const overlay = document.getElementById('sshKeygenOverlay')
  document.getElementById('sshKeygenLabelInput').value = ''
  document.getElementById('sshKeygenUserInput').value = ''
  document.getElementById('sshKeygenSpinner').hidden = true
  document.getElementById('sshKeygenResult').hidden = true
  document.getElementById('sshKeygenFooter').hidden = false
  document.getElementById('sshKeygenForm').hidden = false
  document.getElementById('sshKeygenPubkeyBox').value = ''
  _sshKeygenCallback = callback || null
  _openModal?.(overlay)
  document.getElementById('sshKeygenLabelInput').focus()
}

;(function wireSshKeygenModal() {
  const overlay = document.getElementById('sshKeygenOverlay')
  const closeBtn = document.getElementById('sshKeygenClose')
  const submitBtn = document.getElementById('sshKeygenSubmitBtn')
  const copyBtn = document.getElementById('sshKeygenCopyBtn')
  if (!overlay) return

  overlay.addEventListener('click', e => { if (e.target === overlay) _closeModal?.(overlay) })
  closeBtn.addEventListener('click', () => _closeModal?.(overlay))

  submitBtn.addEventListener('click', async () => {
    const label = document.getElementById('sshKeygenLabelInput').value.trim()
    const username = document.getElementById('sshKeygenUserInput').value.trim()
    if (!label || !username) { showToast('Cimke és felhasználónév megadása kötelező'); return }

    document.getElementById('sshKeygenForm').hidden = true
    document.getElementById('sshKeygenSpinner').hidden = false
    document.getElementById('sshKeygenResult').hidden = true
    document.getElementById('sshKeygenFooter').hidden = true

    try {
      const res = await fetch('/api/vault/ssh-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, username }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(getErrorMessage(data, 'Generálás sikertelen')); resetKeygenForm(); return }

      const pubkey = data.publicKey || (data.key && data.key.publicKey) || ''
      document.getElementById('sshKeygenPubkeyBox').value = pubkey
      document.getElementById('sshKeygenSpinner').hidden = true
      document.getElementById('sshKeygenResult').hidden = false

      await loadSshKeys()
      if (_sshKeygenCallback) _sshKeygenCallback(data.key || data)
    } catch { showToast('Hálózati hiba'); resetKeygenForm() }
  })

  copyBtn?.addEventListener('click', () => {
    const val = document.getElementById('sshKeygenPubkeyBox').value
    navigator.clipboard.writeText(val).then(() => {
      copyBtn.textContent = 'Másolva!'
      setTimeout(() => { copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Másolás' }, 2000)
    }).catch(() => {})
  })

  function resetKeygenForm() {
    document.getElementById('sshKeygenForm').hidden = false
    document.getElementById('sshKeygenSpinner').hidden = true
    document.getElementById('sshKeygenResult').hidden = true
    document.getElementById('sshKeygenFooter').hidden = false
  }
})()

// --- SSH Info modal ---
let _sshInfoServerId = null

async function _sshInfoLoadKey(keyId, serverUser) {
  const installSection = document.getElementById('sshInfoInstallSection')
  const noKeyEl = document.getElementById('sshInfoNoKey')
  if (!keyId) {
    installSection.hidden = true
    noKeyEl.hidden = false
    return
  }
  installSection.hidden = false
  noKeyEl.hidden = true

  let pubkey = ''
  try {
    const res = await fetch(`/api/vault/ssh-keys/${encodeURIComponent(keyId)}/public-key`)
    if (res.ok) { const d = await res.json(); pubkey = d.publicKey || '' }
  } catch {}

  const targetUser = serverUser || 'root'
  document.getElementById('sshInfoUser').textContent = targetUser

  // root always exists -- only show the "create user" step for a real,
  // non-root target user (e.g. a fresh server that needs the account first).
  const step0 = document.getElementById('sshInfoStep0')
  if (targetUser === 'root') {
    step0.hidden = true
  } else {
    step0.hidden = false
    document.getElementById('sshInfoCmd0').textContent = `useradd -m -s /bin/bash ${targetUser}`
  }

  const cmd2text = pubkey
    ? `echo "${pubkey}" >> ~/.ssh/authorized_keys`
    : `echo "<publikus kulcs ide>" >> ~/.ssh/authorized_keys`
  document.getElementById('sshInfoCmd2').textContent = cmd2text
  document.getElementById('sshInfoPubkey').textContent = pubkey || '(kulcs nem elérhető)'

  const overlay = document.getElementById('sshInfoOverlay')
  overlay.querySelectorAll('.ssh-code-copy').forEach(btn => {
    const clone = btn.cloneNode(true)
    btn.parentNode.replaceChild(clone, btn)
    clone.addEventListener('click', () => {
      const text = document.getElementById(clone.getAttribute('data-target'))?.textContent || ''
      navigator.clipboard.writeText(text).then(() => {
        clone.classList.add('copied')
        setTimeout(() => clone.classList.remove('copied'), 2000)
      }).catch(() => {})
    })
  })
}

function _sshInfoLoadServer(serverId) {
  _sshInfoServerId = serverId
  const server = _sshServers.find(s => s.id === serverId)

  document.getElementById('sshInfoServerName').textContent = server ? server.name : (serverId || '')

  const keySel = document.getElementById('sshInfoKeySelect')
  keySel.innerHTML = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
  ].join('')
  const assignedKeyId = (server && (server.sshKeyId || server.assignedKeyId || server.vaultKeyId)) || ''
  keySel.value = assignedKeyId
  return { server, assignedKeyId }
}

function openSshInfoModal(preselectedServerId, { keyOnly = false } = {}) {
  const overlay = document.getElementById('sshInfoOverlay')
  const serverSection = overlay.querySelector('.ssh-info-server-section')

  if (keyOnly) {
    // Key-only mode: hide server selector, reset server context
    serverSection.hidden = true
    _sshInfoServerId = null
    document.getElementById('sshInfoServerName').textContent = 'Új szerver'

    // Populate key selector without a pre-selected key
    const keySel = document.getElementById('sshInfoKeySelect')
    keySel.innerHTML = ['<option value="">-- Válassz kulcsot --</option>',
      ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
    ].join('')
    // Pre-select whatever is chosen in the form's key dropdown
    const formKeyId = document.getElementById('sshKeySelectInput')?.value || ''
    keySel.value = formKeyId

    // Use the username typed into the new-server form, not a hardcoded root
    const formUser = document.getElementById('sshUserInput')?.value.trim() || 'root'

    _openModal?.(overlay)
    _sshInfoLoadKey(formKeyId, formUser)
  } else {
    // Normal mode: show server selector, pick first server by default
    serverSection.hidden = false
    const serverSel = document.getElementById('sshInfoServerSelect')
    serverSel.innerHTML = ['<option value="">-- Válassz szervert --</option>',
      ..._sshServers.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.host)})</option>`)
    ].join('')

    const firstId = preselectedServerId || (_sshServers[0] && _sshServers[0].id) || ''
    serverSel.value = firstId

    const { server, assignedKeyId } = _sshInfoLoadServer(firstId)
    const targetUser = (server && server.user) || 'root'

    _openModal?.(overlay)
    _sshInfoLoadKey(assignedKeyId, targetUser)
  }
}

;(function wireSshInfoModal() {
  const overlay = document.getElementById('sshInfoOverlay')
  const closeBtn = document.getElementById('sshInfoClose')
  const serverSel = document.getElementById('sshInfoServerSelect')
  const keySel = document.getElementById('sshInfoKeySelect')
  if (!overlay) return

  overlay.addEventListener('click', e => { if (e.target === overlay) _closeModal?.(overlay) })
  closeBtn.addEventListener('click', () => _closeModal?.(overlay))

  serverSel?.addEventListener('change', () => {
    const { server, assignedKeyId } = _sshInfoLoadServer(serverSel.value)
    _sshInfoLoadKey(assignedKeyId, (server && server.user) || 'root')
  })

  keySel?.addEventListener('change', async () => {
    const keyId = keySel.value || null
    // Key-only mode (new-server flow) has no _sshInfoServerId -- read the
    // username from the new-server form instead of falling back to root.
    const targetUser = _sshInfoServerId
      ? ((_sshServers.find(s => s.id === _sshInfoServerId) || {}).user || 'root')
      : (document.getElementById('sshUserInput')?.value.trim() || 'root')

    if (_sshInfoServerId) {
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(_sshInfoServerId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshKeyId: keyId }),
        })
        await loadSshServers()
      } catch { /* ignore */ }
    }
    await _sshInfoLoadKey(keyId, targetUser)
  })
})()

;(function wireSshSection() {
  const newBtn = document.getElementById('sshNewBtn')
  const panel = document.getElementById('sshAddPanel')
  const closeBtn = document.getElementById('sshAddPanelClose')
  const addBtn = document.getElementById('sshAddBtn')
  const cardViewBtn = document.getElementById('sshViewCards')
  const tableViewBtn = document.getElementById('sshViewTable')
  const cardsView = document.getElementById('sshCardsView')
  const tableView = document.getElementById('sshTableView')

  if (!newBtn) return

  function resetSshAddForm() {
    _sshEditingId = null
    const titleEl = document.getElementById('sshAddPanelTitle')
    if (titleEl) titleEl.textContent = 'Szerver hozzáadása'
    document.getElementById('sshNameInput').value = ''
    document.getElementById('sshHostInput').value = ''
    document.getElementById('sshUserInput').value = ''
    document.getElementById('sshPortInput').value = '22'
    document.getElementById('sshDescInput').value = ''
    if (document.getElementById('sshKeySelectInput')) document.getElementById('sshKeySelectInput').value = ''
  }

  newBtn.addEventListener('click', () => {
    if (panel.hidden) resetSshAddForm()
    panel.hidden = !panel.hidden
    if (!panel.hidden) document.getElementById('sshNameInput').focus()
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true; resetSshAddForm() })

  // (i) install guide button inside the "new server" form -- key-only mode
  document.getElementById('sshKeyInstallFromFormBtn')?.addEventListener('click', () => {
    openSshInfoModal(null, { keyOnly: true })
  })

  // "+ Új kulcs" button inside the "new server" form
  document.getElementById('sshKeyNewFromFormBtn')?.addEventListener('click', () => {
    openSshKeygenModal(newKey => {
      // After key created, select it in the form dropdown
      if (newKey && newKey.id) {
        const sel = document.getElementById('sshKeySelectInput')
        if (sel) sel.value = newKey.id
      }
    })
  })

  addBtn?.addEventListener('click', async () => {
    const name = document.getElementById('sshNameInput').value.trim()
    const host = document.getElementById('sshHostInput').value.trim()
    const user = document.getElementById('sshUserInput').value.trim()
    const port = parseInt(document.getElementById('sshPortInput').value, 10) || 22
    const desc = document.getElementById('sshDescInput').value.trim()
    const sshKeyId = document.getElementById('sshKeySelectInput')?.value || null
    if (!name || !host || !user) { showToast('Név, IP és felhasználó megadása kötelező'); return }
    const isEdit = !!_sshEditingId
    try {
      const res = await fetch(
        isEdit ? `/api/vault/ssh-servers/${encodeURIComponent(_sshEditingId)}` : '/api/vault/ssh-servers',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, host, user, port, desc, sshKeyId: sshKeyId || undefined }),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        showToast(getErrorMessage(err, 'Hiba a mentéskor')); return
      }
      resetSshAddForm()
      panel.hidden = true
      await loadSshServers()
      showToast(isEdit ? 'Szerver frissítve' : 'Szerver hozzáadva')
    } catch { showToast('Hálózati hiba') }
  })

  cardViewBtn?.addEventListener('click', () => {
    _sshView = 'cards'
    cardViewBtn.classList.add('active')
    tableViewBtn.classList.remove('active')
    cardsView.hidden = false
    tableView.hidden = true
  })

  tableViewBtn?.addEventListener('click', () => {
    _sshView = 'table'
    tableViewBtn.classList.add('active')
    cardViewBtn.classList.remove('active')
    cardsView.hidden = true
    tableView.hidden = false
  })

  // Kulcstároló "Új kulcs generálása" button
  document.getElementById('sshKeyNewBtn')?.addEventListener('click', () => {
    openSshKeygenModal()
  })

  // Global (i) info button in section header
  document.getElementById('sshInfoGlobalBtn')?.addEventListener('click', () => {
    openSshInfoModal()
  })
})()

// --- Vault Page ---
let _vaultSecrets = []

let _vaultBindings = []

export async function loadVaultPage() {
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
    await Promise.all([loadSshKeys(), loadSshServers()])
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
    card.innerHTML = `<div class="vault-card-header"><div class="vault-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="vault-card-title"><div class="vault-card-id">${escapeHtml(s.id)} ${bindingBadge}</div>${s.label !== s.id ? `<div class="vault-card-label">${escapeHtml(s.label)}</div>` : ''}</div><div class="vault-card-meta">${date}</div></div><div class="vault-card-actions"><button class="btn vault-card-reveal" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${t('vault.btn.show')}</button><button class="btn vault-card-edit" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}" data-label="${escapeHtml(s.label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${t('vault.btn.edit')}</button><button class="btn vault-card-delete" data-variant="secondary" data-size="compact" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>${t('vault.btn.delete')}</button></div>`
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
      form.innerHTML = `<input type="password" class="input vault-edit-value" value="${escapeHtml(data.value)}" style="font-size:13px;margin-bottom:6px"><button class="btn vault-edit-save" data-variant="primary" data-size="compact" >${t('vault.btn.save')}</button> <button class="btn vault-edit-cancel" data-variant="secondary" data-size="compact" >${t('vault.btn.cancel')}</button>`
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
        const res = await fetch('/api/vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label, value: newVal }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          showToast('Frissítés sikertelen: ' + getErrorMessage(e, String(res.status)))
          saveBtn.disabled = false
          saveBtn.textContent = 'Mentés'
          return
        }
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
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) { showToast('Törlés sikertelen'); return }
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

  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeModal?.(overlay) })
  closeBtn.addEventListener('click', () => { _closeModal?.(overlay) })

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

      _openModal?.(overlay)
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
        setTimeout(() => { _closeModal?.(overlay) }, 1500)
      } else {
        statusEl.textContent = getErrorMessage(data, 'Hiba tortent')
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
      _openModal?.(overlay)
    } finally {
      scanBtn.disabled = false
      scanBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan &amp; Import'
    }
  })

  closeBtn?.addEventListener('click', () => { _closeModal?.(overlay) })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeModal?.(overlay) })

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
    _closeModal?.(overlay)
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
    if (data.error) { alert(getErrorMessage(data)); return }
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
      _closeModal?.(connectorDetailOverlay)
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
      _closeModal?.(connectorDetailOverlay)
      loadConnectors()
    } catch {
      showToast(t('connectors.toast.assignment_error'))
    }
  }

  _openModal?.(connectorDetailOverlay)
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
      // apiData carries the full response object for getErrorMessage(); do NOT use err.message
      throw Object.assign(new Error('api call failed'), { apiData: err })
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

    _closeModal?.(connectorModalOverlay)
    if (result.nameChanged) {
      showToast(t('connectors.toast.added', { name: savedName }))
    } else {
      showToast(t('connectors.toast.created'))
    }
    loadConnectors()
  } catch (err) {
    showToast(getErrorMessage(err.apiData, 'Hiba'))
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

