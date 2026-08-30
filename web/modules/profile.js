// Self-service profile page for session-authenticated dashboard users.
// Handles: identity display, display_name/email edit, password change, session logout-all.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const $ = (id) => document.getElementById(id)
const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : null) ?? fb

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal(id) { const m = $(id); if (m) m.hidden = false }
function closeModal(id) { const m = $(id); if (m) m.hidden = true }

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-close]')
  if (el) closeModal(el.dataset.close)
  // Close on backdrop click
  if (e.target.classList?.contains('modal-overlay')) e.target.hidden = true
})

// ── State ─────────────────────────────────────────────────────────────────────

let _profile = null
let _inited = false

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const token = (() => { try { return localStorage.getItem('marveen_token') } catch { return '' } })()
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) }
  return fetch(path, { ...opts, headers })
}

async function fetchMe() {
  const r = await apiFetch('/api/v1/me')
  if (!r.ok) return null
  return r.json()
}

// ── Render ────────────────────────────────────────────────────────────────────

function initials(profile) {
  const name = profile.display_name || profile.username || '?'
  return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?'
}

function roleLabel(role) {
  return { admin: 'Admin', agent: 'Agent', read_only: 'Read-only', viewer: 'Viewer' }[role] ?? role
}

function renderSidebarUser(profile) {
  const nav = $('navProfile')
  if (!nav) return
  const abbr = initials(profile)
  const avatarEl = $('sbUserAvatar')
  const nameEl = $('sbUserName')
  const roleEl = $('sbUserRole')
  if (avatarEl) avatarEl.textContent = abbr
  if (nameEl) nameEl.textContent = profile.display_name || profile.username
  if (roleEl) {
    const role = roleLabel(profile.role)
    const tenant = profile.tenant_display_name || profile.tenant_id || ''
    roleEl.textContent = tenant ? `${role} · ${tenant}` : role
  }
  nav.hidden = false
}

function renderPage(profile) {
  _profile = profile

  const avatarEl = $('profileAvatar')
  if (avatarEl) avatarEl.textContent = initials(profile)

  const nameEl = $('profileDisplayName')
  if (nameEl) nameEl.textContent = profile.display_name || profile.username

  const badgesEl = $('profileBadges')
  if (badgesEl) {
    const roleBadge = `<span class="badge" data-variant="info">${esc(roleLabel(profile.role))}</span>`
    const tenantBadge = profile.tenant_display_name
      ? `<span class="badge" data-variant="neutral">${esc(profile.tenant_display_name)}</span>`
      : ''
    badgesEl.innerHTML = roleBadge + tenantBadge
  }

  const usernameEl = $('profileUsername')
  if (usernameEl) usernameEl.textContent = profile.username

  const emailEl = $('profileEmail')
  if (emailEl) emailEl.textContent = profile.email || '—'

  const roleEl = $('profileRole')
  if (roleEl) roleEl.innerHTML = `<span class="badge" data-variant="info">${esc(roleLabel(profile.role))}</span>`

  const tenantEl = $('profileTenant')
  if (tenantEl) {
    if (profile.tenant_display_name) {
      tenantEl.innerHTML = `${esc(profile.tenant_display_name)}<span style="font-family:monospace;font-size:11px;color:var(--text-muted);background:var(--neutral-soft,rgba(127,127,127,0.12));border-radius:999px;padding:2px 8px;margin-left:6px">${esc(profile.tenant_id)}</span>`
    } else {
      tenantEl.textContent = profile.tenant_id ? profile.tenant_id : t('profile.tenant.global', 'Globális admin')
    }
  }

  const sessDesc = $('profileSessionsDesc')
  if (sessDesc) {
    const n = profile.session_count ?? 0
    sessDesc.textContent = t('profile.security.sessions.desc', `${n} aktív munkamenet. A kiléptetés minden eszközre érvényes, erre a böngészőre is.`).replace('{n}', n)
  }

  const sessModalDesc = $('profileSessModalDesc')
  if (sessModalDesc) {
    const n = profile.session_count ?? 0
    sessModalDesc.textContent = `${n} ${t('profile.modal.sessions.desc', 'aktív munkamenetet léptetsz ki, ezt a böngészőt is beleértve. Utána újra be kell jelentkezned.')}`
  }
}

// ── Edit profile modal ─────────────────────────────────────────────────────────

async function saveProfileEdit() {
  const displayNameInput = $('profileEditDisplayName')
  const emailInput = $('profileEditEmail')
  if (!displayNameInput || !emailInput) return

  const patch = {}
  const newName = displayNameInput.value.trim()
  const newEmail = emailInput.value.trim()

  // Only include changed fields
  if (newName !== (_profile?.display_name ?? '')) patch.display_name = newName || null
  if (newEmail !== (_profile?.email ?? '')) patch.email = newEmail || null

  if (Object.keys(patch).length === 0) { closeModal('profileEditModal'); return }

  const btn = $('profileEditSaveBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('common.saving', 'Mentés...') }

  try {
    const r = await apiFetch('/api/v1/me', { method: 'PATCH', body: JSON.stringify(patch) })
    const data = await r.json()
    if (!r.ok) {
      alert(data.hint || t('common.error', 'Hiba történt'))
      return
    }
    _profile = { ..._profile, ...data }
    renderPage(_profile)
    renderSidebarUser(_profile)
    closeModal('profileEditModal')
    showToast(t('profile.saved', 'Adatok mentve'))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('common.btn.save', 'Mentés') }
  }
}

// ── Password change ───────────────────────────────────────────────────────────

async function savePassword() {
  const currentInput = $('profilePwCurrent')
  const newInput = $('profilePwNew')
  const confirmInput = $('profilePwConfirm')
  const errorEl = $('profilePwError')

  const current = currentInput?.value ?? ''
  const newPw = newInput?.value ?? ''
  const confirm = confirmInput?.value ?? ''

  if (errorEl) errorEl.hidden = true

  if (newPw !== confirm) {
    if (errorEl) { errorEl.textContent = t('profile.modal.password.mismatch', 'A két jelszó nem egyezik.'); errorEl.hidden = false }
    return
  }
  if (newPw.length < 12) {
    if (errorEl) { errorEl.textContent = t('profile.modal.password.too_short', 'A jelszó legalább 12 karakter legyen.'); errorEl.hidden = false }
    return
  }

  const btn = $('profilePwSaveBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('common.saving', 'Mentés...') }

  try {
    const r = await apiFetch('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: current, new_password: newPw }),
    })
    const data = await r.json()
    if (!r.ok) {
      const msg = data.hint || t('common.error', 'Hiba történt')
      if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false }
      return
    }
    if (currentInput) currentInput.value = ''
    if (newInput) newInput.value = ''
    if (confirmInput) confirmInput.value = ''
    closeModal('profilePasswordModal')
    showToast(t('profile.password_saved', 'Jelszó frissítve'))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('common.btn.save', 'Mentés') }
  }
}

// ── Logout-all sessions ───────────────────────────────────────────────────────

async function logoutAllSessions() {
  const btn = $('profileSessConfirmBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('common.working', 'Feldolgozás...') }
  try {
    const r = await apiFetch('/api/auth/logout-all', { method: 'POST' })
    if (r.ok) {
      closeModal('profileSessionsModal')
      showToast(t('profile.sessions_revoked', 'Minden munkamenet kiléptetve, átirányítás...'))
      setTimeout(() => { window.location.reload() }, 1500)
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('profile.modal.sessions.confirm', 'Kiléptetés') }
  }
}

// ── Toast (lightweight local) ─────────────────────────────────────────────────

let _toastTimer
function showToast(msg) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('visible')
  clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3000)
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initProfile() {
  if (_inited) return
  _inited = true

  // Wire edit modal
  $('profileEditBtn')?.addEventListener('click', () => {
    if (_profile) {
      const nameInput = $('profileEditDisplayName')
      const emailInput = $('profileEditEmail')
      if (nameInput) nameInput.value = _profile.display_name ?? ''
      if (emailInput) emailInput.value = _profile.email ?? ''
    }
    openModal('profileEditModal')
  })
  $('profileEditSaveBtn')?.addEventListener('click', saveProfileEdit)

  // Wire password modal
  $('profilePasswordBtn')?.addEventListener('click', () => openModal('profilePasswordModal'))
  $('profilePwSaveBtn')?.addEventListener('click', savePassword)

  // Wire sessions modal
  $('profileSessionsBtn')?.addEventListener('click', () => openModal('profileSessionsModal'))
  $('profileSessConfirmBtn')?.addEventListener('click', logoutAllSessions)
}

export async function loadProfilePage() {
  const profile = await fetchMe()
  if (!profile) return
  renderPage(profile)
}

// Called at startup to populate the sidebar user block for session callers.
export async function initSidebarUser() {
  try {
    const statusR = await fetch('/api/auth/status')
    if (!statusR.ok) return
    const status = await statusR.json()
    if (status.method !== 'session' || !status.user) return
    const profile = await fetchMe()
    if (!profile) return
    _profile = profile
    renderSidebarUser(profile)
  } catch { /* non-fatal */ }
}
