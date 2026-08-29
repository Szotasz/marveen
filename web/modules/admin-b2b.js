// B2B Admin UI: Tenantok / Felhasználók / Eszközkulcsok
// Global admin only (role=admin, tenant_id=null).

const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const $ = (id) => document.getElementById(id)
const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : null) ?? fb

let _authCache = null
async function fetchAuth() {
  if (_authCache) return _authCache
  try {
    const r = await fetch('/api/auth/status')
    if (r.ok) _authCache = await r.json()
  } catch {}
  return _authCache
}

function isGlobalAdmin(auth) {
  return auth?.role === 'admin' && auth?.tenant_id === null
}

// ── Toast ────────────────────────────────────────────────────────────────────

let _toastTimer
function showToast(msg, variant = '') {
  const el = $('toast') || document.querySelector('.toast')
  if (!el) return
  el.textContent = msg
  el.className = 'toast show' + (variant ? ' toast-' + variant : '')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800)
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal(id) { const m = $(id); if (m) m.hidden = false }
function closeModal(id) { const m = $(id); if (m) m.hidden = true }

document.addEventListener('click', (e) => {
  const closeId = e.target.closest('[data-close]')?.dataset.close
  if (closeId) closeModal(closeId)
})

// ── Tabs ─────────────────────────────────────────────────────────────────────

let _activeTab = 'tenants'

function switchTab(tab) {
  _activeTab = tab
  document.querySelectorAll('.admin-b2b-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
  ;['tenants', 'users', 'deviceKeys'].forEach(p => {
    const panel = $('adminPanel' + p.charAt(0).toUpperCase() + p.slice(1))
    if (panel) panel.hidden = p !== tab
  })
  if (tab === 'tenants') loadTenants()
  if (tab === 'users') loadUsers()
  if (tab === 'deviceKeys') loadDeviceKeys()
}

// ── Tenants ───────────────────────────────────────────────────────────────────

let _tenants = []
let _selectedTenantId = null

async function loadTenants() {
  const list = $('tenantList')
  if (!list) return
  list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Betöltés...</p>'
  try {
    const r = await fetch('/api/admin/tenants?include_disabled=true')
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    _tenants = data.items ?? []
    renderTenantList()
    populateUserTenantFilter()
    populateNewUserTenantSelect()
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderTenantList() {
  const list = $('tenantList')
  if (!list) return
  if (!_tenants.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0" data-i18n="admin.b2b.tenant.empty">Nincs tenant.</p>'
    return
  }
  list.innerHTML = _tenants.map(ten => `
    <div class="admin-b2b-row ${ten.disabled_at ? 'admin-b2b-row--disabled' : ''} ${_selectedTenantId === ten.id ? 'admin-b2b-row--selected' : ''}" data-tenant-id="${esc(ten.id)}">
      <div class="admin-b2b-row-main">
        <span class="admin-b2b-row-name">${esc(ten.display_name)}</span>
        <code class="admin-b2b-row-id">${esc(ten.id)}</code>
        ${ten.disabled_at ? '<span class="badge" data-variant="neutral">letiltva</span>' : ''}
      </div>
      <div class="admin-b2b-row-actions">
        <button class="btn" data-variant="secondary" data-size="compact" data-action="toggle-tenant" data-id="${esc(ten.id)}" data-disabled="${ten.disabled_at ? '1' : '0'}">
          ${ten.disabled_at ? 'Engedélyez' : 'Letilt'}
        </button>
        <button class="btn" data-variant="secondary" data-size="compact" data-action="show-agents" data-id="${esc(ten.id)}">
          Agentkezelés
        </button>
      </div>
    </div>
  `).join('')
}

async function toggleTenant(id, currentlyDisabled) {
  try {
    const r = await fetch(`/api/admin/tenants/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: !currentlyDisabled }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast(currentlyDisabled ? 'Tenant engedélyezve' : 'Tenant letiltva')
    await loadTenants()
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function showAgentMatrix(tenantId) {
  _selectedTenantId = tenantId
  renderTenantList()
  const container = $('agentMatrixContainer')
  if (!container) return
  container.hidden = false
  const matrix = $('agentMatrix')
  matrix.innerHTML = '<p style="color:var(--text-muted)">Betöltés...</p>'
  try {
    const r = await fetch(`/api/admin/agent-availability?tenant_id=${encodeURIComponent(tenantId)}`)
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    renderAgentMatrix(data.items ?? [], tenantId)
  } catch (err) {
    matrix.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderAgentMatrix(items, tenantId) {
  const matrix = $('agentMatrix')
  if (!items.length) {
    matrix.innerHTML = '<p style="color:var(--text-muted)">Nincs ismert agent.</p>'
    return
  }
  matrix.innerHTML = items.map(item => `
    <label class="admin-b2b-matrix-row">
      <input type="checkbox" class="admin-b2b-matrix-check"
        data-agent="${esc(item.agent_id)}" data-tenant="${esc(tenantId)}"
        ${item.enabled ? 'checked' : ''}>
      <span class="admin-b2b-matrix-agent">${esc(item.agent_id)}</span>
      <span class="admin-b2b-matrix-status ${item.enabled ? 'enabled' : 'disabled'}">
        ${item.enabled ? 'Engedélyezve' : 'Letiltva'}
      </span>
    </label>
  `).join('')
}

async function setAgentAvailability(tenantId, agentId, enabled) {
  try {
    const r = await fetch('/api/admin/agent-availability', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId, agent_id: agentId, enabled }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast(`${agentId}: ${enabled ? 'engedélyezve' : 'letiltva'}`)
    await showAgentMatrix(tenantId)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function addTenant() {
  const id = $('tenantIdInput')?.value.trim()
  const name = $('tenantNameInput')?.value.trim()
  if (!id || !name) { showToast('ID és név szükséges', 'error'); return }
  try {
    const r = await fetch('/api/admin/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, display_name: name }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    closeModal('tenantAddModal')
    if ($('tenantIdInput')) $('tenantIdInput').value = ''
    if ($('tenantNameInput')) $('tenantNameInput').value = ''
    showToast('Tenant létrehozva')
    await loadTenants()
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────

let _users = []

async function loadUsers(tenantFilter) {
  const list = $('userList')
  if (!list) return
  list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Betöltés...</p>'
  const params = new URLSearchParams({ include_disabled: 'true' })
  if (tenantFilter) params.set('tenant_id', tenantFilter)
  try {
    const r = await fetch('/api/admin/users?' + params)
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    _users = data.items ?? []
    renderUserList()
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderUserList() {
  const list = $('userList')
  if (!list) return
  if (!_users.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Nincs felhasználó.</p>'
    return
  }
  list.innerHTML = _users.map(u => `
    <div class="admin-b2b-row ${u.disabled ? 'admin-b2b-row--disabled' : ''}">
      <div class="admin-b2b-row-main">
        <span class="admin-b2b-row-name">${esc(u.display_name || u.username)}</span>
        ${u.display_name ? `<code class="admin-b2b-row-id">${esc(u.username)}</code>` : ''}
        <span class="badge" data-variant="${u.role === 'admin' ? 'info' : 'neutral'}">${esc(u.role)}</span>
        ${u.tenant_id ? `<code class="admin-b2b-row-id">${esc(u.tenant_id)}</code>` : '<span class="badge" data-variant="info">global admin</span>'}
        ${u.disabled ? '<span class="badge" data-variant="neutral">letiltva</span>' : ''}
      </div>
      <div class="admin-b2b-row-actions">
        <button class="btn" data-variant="secondary" data-size="compact"
          data-action="toggle-user" data-id="${u.id}" data-disabled="${u.disabled ? '1' : '0'}">
          ${u.disabled ? 'Engedélyez' : 'Letilt'}
        </button>
      </div>
    </div>
  `).join('')
}

function populateUserTenantFilter() {
  const sel = $('userTenantFilter')
  if (!sel) return
  const current = sel.value
  sel.innerHTML = `<option value="">${t('admin.b2b.user.filter.all', 'Mind a tenantok')}</option>` +
    _tenants.map(ten => `<option value="${esc(ten.id)}" ${current === ten.id ? 'selected' : ''}>${esc(ten.display_name)}</option>`).join('')
}

function populateNewUserTenantSelect() {
  const sel = $('newUserTenant')
  if (!sel) return
  sel.innerHTML = _tenants.filter(t => !t.disabled_at)
    .map(ten => `<option value="${esc(ten.id)}">${esc(ten.display_name)} (${esc(ten.id)})</option>`).join('')
}

async function toggleUser(id, currentlyDisabled) {
  try {
    const r = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: !currentlyDisabled }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast(currentlyDisabled ? 'Felhasználó engedélyezve' : 'Felhasználó letiltva')
    await loadUsers($('userTenantFilter')?.value || undefined)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

async function addUser() {
  const username = $('newUserUsername')?.value.trim()
  const password = $('newUserPassword')?.value
  const role = $('newUserRole')?.value
  const tenantId = role === 'admin' ? null : ($('newUserTenant')?.value || null)
  const email = $('newUserEmail')?.value.trim() || null
  const displayName = $('newUserDisplayName')?.value.trim() || null

  if (!username || !password) { showToast('Felhasználónév és jelszó szükséges', 'error'); return }
  try {
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role, tenant_id: tenantId, email, display_name: displayName }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    closeModal('userAddModal')
    showToast('Felhasználó létrehozva')
    await loadUsers($('userTenantFilter')?.value || undefined)
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
  }
}

// ── Device Keys ───────────────────────────────────────────────────────────────

let _deviceKeys = []

async function loadDeviceKeys() {
  const list = $('deviceKeyList')
  if (!list) return
  list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Betöltés...</p>'
  try {
    const r = await fetch('/api/admin/device-keys')
    if (!r.ok) throw new Error(r.status)
    const data = await r.json()
    _deviceKeys = data.items ?? []
    renderDeviceKeyList()
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">Hiba: ${esc(String(err))}</p>`
  }
}

function renderDeviceKeyList() {
  const list = $('deviceKeyList')
  if (!list) return
  if (!_deviceKeys.length) {
    list.innerHTML = '<p style="color:var(--text-muted);padding:8px 0">Nincs eszközkulcs.</p>'
    return
  }
  list.innerHTML = _deviceKeys.map(k => {
    const tenantName = _tenants.find(t => t.id === k.tenantId)?.display_name
    const expiresLabel = k.expiresAt
      ? new Date(k.expiresAt * 1000).toLocaleDateString('hu-HU')
      : 'Sosem'
    const lastUsed = k.lastUsedAt
      ? new Date(k.lastUsedAt * 1000).toLocaleDateString('hu-HU')
      : 'Soha'
    return `
    <div class="admin-b2b-row">
      <div class="admin-b2b-row-main" style="flex-wrap:wrap;gap:6px">
        <span class="admin-b2b-row-name">${esc(k.name)}</span>
        <span class="admin-b2b-row-meta">Lejár: ${esc(expiresLabel)}</span>
        <span class="admin-b2b-row-meta">Utolsó: ${esc(lastUsed)}</span>
      </div>
      <div class="admin-b2b-row-actions">
        <select class="admin-b2b-select" data-action="assign-tenant" data-key-id="${k.id}" style="min-width:160px">
          <option value="">Fleet-szintű (globális)</option>
          ${_tenants.filter(t => !t.disabled_at).map(ten =>
            `<option value="${esc(ten.id)}" ${k.tenantId === ten.id ? 'selected' : ''}>${esc(ten.display_name)}</option>`
          ).join('')}
        </select>
      </div>
    </div>
  `}).join('')
}

async function assignDeviceKeyTenant(keyId, tenantId) {
  try {
    const r = await fetch(`/api/admin/device-keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId || null }),
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.hint || e.error) }
    showToast('Eszközkulcs hozzárendelve')
  } catch (err) {
    showToast('Hiba: ' + err.message, 'error')
    await loadDeviceKeys()
  }
}

// ── Role-based visibility of new user tenant field ────────────────────────────

function wireNewUserRoleChange() {
  const roleSelect = $('newUserRole')
  const tenantGroup = $('newUserTenantGroup')
  if (!roleSelect || !tenantGroup) return
  roleSelect.addEventListener('change', () => {
    tenantGroup.hidden = roleSelect.value === 'admin'
  })
}

// ── Init & event delegation ───────────────────────────────────────────────────

let _inited = false

export async function initAdminB2b() {
  if (_inited) return
  _inited = true

  const auth = await fetchAuth()
  if (!isGlobalAdmin(auth)) return

  const navLink = $('navAdminB2b')
  if (navLink) navLink.hidden = false

  // Tab switching
  $('adminB2bTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-b2b-tab')
    if (btn) switchTab(btn.dataset.tab)
  })

  // Tenant actions (event delegation on the list + matrix)
  $('tenantList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const id = btn.dataset.id
    if (btn.dataset.action === 'toggle-tenant') await toggleTenant(id, btn.dataset.disabled === '1')
    if (btn.dataset.action === 'show-agents') await showAgentMatrix(id)
  })

  $('agentMatrix')?.addEventListener('change', async (e) => {
    const cb = e.target.closest('.admin-b2b-matrix-check')
    if (!cb) return
    await setAgentAvailability(cb.dataset.tenant, cb.dataset.agent, cb.checked)
  })

  // Tenant add modal
  $('tenantAddBtn')?.addEventListener('click', () => openModal('tenantAddModal'))
  $('tenantAddConfirmBtn')?.addEventListener('click', addTenant)

  // Users
  $('userList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'toggle-user') await toggleUser(Number(btn.dataset.id), btn.dataset.disabled === '1')
  })
  $('userTenantFilter')?.addEventListener('change', (e) => loadUsers(e.target.value || undefined))
  $('userAddBtn')?.addEventListener('click', () => openModal('userAddModal'))
  $('userAddConfirmBtn')?.addEventListener('click', addUser)

  // Device keys: event delegation for tenant assign select
  $('deviceKeyList')?.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-action="assign-tenant"]')
    if (!sel) return
    await assignDeviceKeyTenant(Number(sel.dataset.keyId), sel.value)
  })

  wireNewUserRoleChange()
}

export async function loadAdminB2b() {
  const auth = await fetchAuth()
  if (!isGlobalAdmin(auth)) return
  // Ensure tenants are loaded first (device keys and user filter need them).
  await loadTenants()
  if (_activeTab === 'users') await loadUsers()
  if (_activeTab === 'deviceKeys') await loadDeviceKeys()
}
