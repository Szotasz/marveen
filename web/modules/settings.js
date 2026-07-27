import { escapeHtml } from './util.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'
import { switchPage } from './app-core.js'


let _wireBranchDriftBanner = null
let _authBannerWired = false
// Incremented on every loadSettings() call so that a stale in-flight run can
// detect that a newer call has taken over and abort before touching the DOM.
let _loadGen = 0
export function initSettings({ wireBranchDriftBanner } = {}) {
  _wireBranchDriftBanner = wireBranchDriftBanner
}

// === Autonomy ===
// ============================================================

export async function renderAutonomyContent(gridEl, footerEl) {
  gridEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('autonomy.loading')}</p>`

  try {
    const res = await fetch('/api/autonomy')
    if (!res.ok) throw new Error('fetch failed')
    const config = await res.json()

    gridEl.innerHTML = ''
    for (const cat of config.categories) {
      const isCapped = !cat.locked && cat.maxLevel < 3
      const row = document.createElement('div')
      row.className = 'autonomy-row' + (cat.locked ? ' locked' : '') + (isCapped ? ' capped' : '')

      const label = document.createElement('div')
      label.className = 'autonomy-row-label'
      label.textContent = cat.label

      const levels = document.createElement('div')
      levels.className = 'autonomy-levels'

      for (let l = 1; l <= 3; l++) {
        const btn = document.createElement('button')
        const isOver = l > cat.maxLevel
        btn.className = 'autonomy-level-btn' + (l === cat.level ? ' active' : '') + (isOver ? ' over-cap' : '')
        btn.dataset.level = String(l)
        btn.textContent = String(l)
        btn.disabled = cat.locked || isOver
        if (!cat.locked && !isOver) {
          btn.addEventListener('click', () => setAutonomyLevel(cat.key, l))
        }
        levels.appendChild(btn)
      }

      row.appendChild(label)
      if (cat.locked) {
        const lock = document.createElement('div')
        lock.className = 'autonomy-row-lock'
        lock.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ${t('autonomy.lock_label')}`
        row.appendChild(lock)
      } else if (isCapped) {
        const cap = document.createElement('div')
        cap.className = 'autonomy-row-cap'
        cap.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> ${t('autonomy.cap_label', { n: cat.maxLevel })}`
        row.appendChild(cap)
      }
      row.appendChild(levels)
      gridEl.appendChild(row)
    }

    if (footerEl) {
      if (config.updated_at > 0) {
        const d = new Date(config.updated_at * 1000)
        footerEl.textContent = t('autonomy.last_modified', { date: d.toLocaleString('hu-HU') })
      } else {
        footerEl.textContent = t('autonomy.not_modified')
      }
    }
  } catch (err) {
    gridEl.innerHTML = `<p style="color:var(--danger)">${t('autonomy.error')}</p>`
    if (footerEl) footerEl.textContent = ''
  }
}

async function setAutonomyLevel(key, level) {
  try {
    const res = await fetch('/api/autonomy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, level }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || 'Hiba')
      return
    }
    // Refresh the settings tab autonomy grid if it is visible
    const tabGrid = document.getElementById('settingsAutonomyGrid')
    const tabFooter = document.getElementById('settingsAutonomyUpdatedAt')
    if (tabGrid) renderAutonomyContent(tabGrid, tabFooter)
  } catch {
    showToast(t('kanban.toast.save_error'))
  }
}

// ============================================================

// ============================================================
// === Settings (central config registry) ===
// ============================================================

document.getElementById('refreshSettingsBtn')?.addEventListener('click', loadSettings)
window.addEventListener('beforeunload', (e) => {
  if (settingsDirty.size > 0) { e.preventDefault(); e.returnValue = '' }
})

// Human label for a registry "module" -- falls back to a capitalised key for
// any future module the UI doesn't know about yet, so adding a registry
// entry never requires a frontend change just to render a sane heading.
function settingsModuleLabel(mod) {
  const key = `settings.module.${mod}`
  const known = { kanban: true, system: true, heartbeat: true, audit: true, ideabox: true, channels: true, security: true, autonomy: true }
  return known[mod] ? t(key) : (mod.charAt(0).toUpperCase() + mod.slice(1))
}

// Track dirty state: key -> { input, originalValue, type, errorEl }
const settingsDirty = new Map()
export function isSettingsDirty() { return settingsDirty.size > 0 }

function updateSettingsSaveBar() {
  const bar = document.getElementById('settingsSaveBar')
  const countEl = document.getElementById('settingsDirtyCount')
  if (!bar) return
  const n = settingsDirty.size
  bar.style.display = n > 0 ? 'flex' : 'none'
  if (countEl) countEl.textContent = t('settings.dirty_count', {n})
}

// Read the current editor value in the canonical form the API expects. A
// boolean setting renders as a checkbox, so its value is derived from .checked
// as the canonical "1"/"0" string (not the element's .value, which is "on").
function settingInputValue(input, type) {
  if (type === 'boolean') return input.checked ? '1' : '0'
  return input.value
}

function markSettingDirty(key, input, originalValue, type, errorEl) {
  const currentVal = settingInputValue(input, type)
  if (currentVal === String(originalValue)) {
    settingsDirty.delete(key)
  } else {
    settingsDirty.set(key, { input, originalValue, type, errorEl })
  }
  updateSettingsSaveBar()
}

const SETTINGS_ACTIVE_TAB_KEY = 'settings-active-tab'

// === Dashboard browser login (optional) ===
// The card in the Settings page lets the operator opt into a username+password
// login (in addition to the always-available access token). All copy is framed
// around the existing public remote-access surfaces (Tailscale Serve, LAN,
// mobile QR) -- no other transport is referenced.

async function fetchAuthStatus() {
  try {
    const r = await fetch('/api/auth/status')
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

async function renderAuthCard() {
  const body = document.getElementById('authCardBody')
  if (!body) return
  const status = await fetchAuthStatus()
  if (!status) { body.innerHTML = `<p class="auth-muted">${t('auth.card.unavailable')}</p>`; return }
  if (status.setup_required) { renderCreateLoginForm(body) }
  else if (status.method === 'session') { renderSessionPanel(body, status) }
  else renderTokenModePanel(body)
  // Device keys are managed by token/session operators only (a device key
  // itself gets 403 from the management endpoints, so don't render the panel).
  if (status.method === 'token' || status.method === 'session') {
    renderDeviceKeysSection(body)
    renderBridgeEnrollSection(body)
  }
}

// === Per-device keys (mint/list/revoke) ===
// A device key is a revocable per-device credential (Bridge, phone). The raw
// key is displayed exactly once, right after minting.

function renderDeviceKeysSection(body) {
  const wrap = document.createElement('div')
  wrap.className = 'auth-device-keys'
  wrap.id = 'authDeviceKeys'
  wrap.innerHTML =
    `<div class="auth-sessions-title">${t('auth.devices.title')}</div>` +
    `<p class="auth-muted">${t('auth.devices.desc')}</p>` +
    `<div class="auth-form-msg err auth-device-warn" id="authDeviceKeyWarn" hidden></div>` +
    `<div id="authDeviceKeyList"></div>` +
    `<div class="auth-form auth-device-mint">` +
      `<input id="authDevName" type="text" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="${t('auth.devices.name_placeholder')}">` +
      `<input id="authDevExpiry" type="number" min="1" max="3650" placeholder="${t('auth.devices.expiry_placeholder')}">` +
      `<button class="btn-secondary" id="authDevMintBtn">${t('auth.devices.mint')}</button>` +
      `<div class="auth-form-msg" id="authDevMsg"></div>` +
      `<div id="authDevMinted" hidden></div>` +
    `</div>`
  body.appendChild(wrap)
  wrap.querySelector('#authDevMintBtn')?.addEventListener('click', mintDeviceKey)
  refreshDeviceKeyList()
}

async function refreshDeviceKeyList() {
  const el = document.getElementById('authDeviceKeyList')
  if (!el) return
  try {
    const r = await fetch('/api/auth/device-keys')
    if (!r.ok) { el.innerHTML = ''; return }
    const { keys } = await r.json()
    if (!keys || !keys.length) { el.innerHTML = `<p class="auth-muted">${t('auth.devices.empty')}</p>`; return }
    el.innerHTML = keys.map((k) => {
      const created = new Date(k.createdAt * 1000).toLocaleDateString()
      const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt * 1000).toLocaleString() : t('auth.devices.never_used')
      const expires = k.expiresAt ? ` &middot; ${t('auth.devices.expires', { date: new Date(k.expiresAt * 1000).toLocaleDateString() })}` : ''
      const bridge = k.installId ? ` <span class="auth-device-bridge-badge">${t('auth.devices.bridge_badge')}</span>` : ''
      return `<div class="auth-session-row auth-device-row" data-key-id="${k.id}">` +
        `<span class="auth-device-name">${escapeHtml(k.name)}${bridge}</span>` +
        `<span class="auth-device-meta">${created} &middot; ${t('auth.devices.last_used', { date: lastUsed })}${expires}</span>` +
        `<button class="btn-secondary btn-compact auth-device-revoke" data-key-id="${k.id}">${t('auth.devices.revoke')}</button>` +
      `</div>`
    }).join('')
    el.querySelectorAll('.auth-device-revoke').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('auth.devices.revoke_confirm'))) return
        // A Bridge-paired revoke means BOTH halves (dashboard key + ssh line).
        // The key is dead either way, but ssh_removed:false means the
        // authorized_keys line survived (fs error) and the device can still
        // open the tunnel -- the ONE outcome the UI must never hide.
        const warnBefore = document.getElementById('authDeviceKeyWarn')
        if (warnBefore) warnBefore.hidden = true
        let sshWarn = false
        try {
          const r = await fetch(`/api/auth/device-keys/${btn.dataset.keyId}`, { method: 'DELETE' })
          const data = await r.json().catch(() => ({}))
          if (r.ok && data.ssh_removed === false) sshWarn = true
        } catch { /* ignore -- the list refresh below shows the real state */ }
        await refreshDeviceKeyList()
        const warnEl = document.getElementById('authDeviceKeyWarn')
        if (warnEl && sshWarn) {
          warnEl.hidden = false
          warnEl.textContent = t('auth.devices.revoke_ssh_warning')
        }
      })
    })
  } catch { el.innerHTML = '' }
}

async function mintDeviceKey() {
  const msg = document.getElementById('authDevMsg')
  const minted = document.getElementById('authDevMinted')
  const name = (document.getElementById('authDevName').value || '').trim()
  const expiryRaw = document.getElementById('authDevExpiry').value
  msg.className = 'auth-form-msg'
  minted.hidden = true
  if (!name) { msg.classList.add('err'); msg.textContent = t('auth.devices.err_name'); return }
  const payload = { name }
  if (expiryRaw) payload.expires_in_days = Number(expiryRaw)
  try {
    const r = await fetch('/api/auth/device-keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic'); return }
    document.getElementById('authDevName').value = ''
    document.getElementById('authDevExpiry').value = ''
    minted.hidden = false
    minted.innerHTML =
      `<p class="auth-muted">${t('auth.devices.minted_hint')}</p>` +
      `<div class="auth-form auth-device-minted-row">` +
        `<input id="authDevMintedKey" type="text" readonly value="${escapeHtml(data.key)}" onclick="this.select()">` +
        `<button class="btn-secondary btn-compact" id="authDevCopyBtn">${t('auth.devices.copy')}</button>` +
      `</div>`
    document.getElementById('authDevCopyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.key)
        document.getElementById('authDevCopyBtn').textContent = t('auth.devices.copied')
      } catch { document.getElementById('authDevMintedKey').select() }
    })
    refreshDeviceKeyList()
  } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
}

// === Bridge pairing (AUTHPLAN1 #2) ===
// Paste the public-key line shown by the Bridge app -> one confirm -> the
// server writes the restricted SSH entry + mints a per-device key -> the
// returned bundle (shown once, copyable) goes back into the Bridge.

function renderBridgeEnrollSection(body) {
  const wrap = document.createElement('div')
  wrap.className = 'auth-device-keys auth-bridge-enroll'
  wrap.id = 'authBridgeEnroll'
  wrap.innerHTML =
    `<div class="auth-sessions-title">${t('auth.bridge.title')}</div>` +
    `<p class="auth-muted">${t('auth.bridge.desc')}</p>` +
    `<div class="auth-form">` +
      `<input id="authBridgeKeyLine" type="text" autocapitalize="off" spellcheck="false" placeholder="${t('auth.bridge.key_placeholder')}">` +
      `<input id="authBridgeName" type="text" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="${t('auth.bridge.name_placeholder')}">` +
      `<button class="btn-secondary" id="authBridgeEnrollBtn">${t('auth.bridge.enroll')}</button>` +
      `<div class="auth-form-msg" id="authBridgeMsg"></div>` +
      `<div id="authBridgeBundle" hidden></div>` +
    `</div>`
  body.appendChild(wrap)
  document.getElementById('authBridgeEnrollBtn').addEventListener('click', bridgeEnrollFromUi)
}

async function bridgeEnrollFromUi() {
  const msg = document.getElementById('authBridgeMsg')
  const out = document.getElementById('authBridgeBundle')
  const keyLine = (document.getElementById('authBridgeKeyLine').value || '').trim()
  const name = (document.getElementById('authBridgeName').value || '').trim()
  msg.className = 'auth-form-msg'
  msg.textContent = ''
  out.hidden = true
  if (!keyLine || !name) { msg.classList.add('err'); msg.textContent = t('auth.bridge.err_empty'); return }
  // The confirm step: pairing grants the device SSH-tunnel + dashboard access.
  if (!confirm(t('auth.bridge.confirm', { name }))) return
  msg.textContent = t('auth.bridge.working')
  try {
    const r = await fetch('/api/security/bridge-enroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_line: keyLine, name }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic'); return }
    msg.classList.add('ok')
    msg.textContent = (data.action === 'replaced' ? t('auth.bridge.repaired') : t('auth.bridge.paired')) +
      (data.warnings && data.warnings.length ? ` (${data.warnings.join('; ')})` : '')
    document.getElementById('authBridgeKeyLine').value = ''
    document.getElementById('authBridgeName').value = ''
    out.hidden = false
    out.innerHTML =
      `<p class="auth-muted">${t('auth.bridge.bundle_hint', { host: escapeHtml(data.host || '') })}</p>` +
      `<div class="auth-form auth-device-minted-row">` +
        `<input id="authBridgeBundleVal" type="text" readonly value="${escapeHtml(data.bundle)}" onclick="this.select()">` +
        `<button class="btn-secondary btn-compact" id="authBridgeCopyBtn">${t('auth.devices.copy')}</button>` +
      `</div>`
    document.getElementById('authBridgeCopyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.bundle)
        document.getElementById('authBridgeCopyBtn').textContent = t('auth.devices.copied')
      } catch { document.getElementById('authBridgeBundleVal').select() }
    })
    refreshDeviceKeyList()
  } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
}

function renderCreateLoginForm(body) {
  body.innerHTML =
    `<p class="auth-muted">${t('auth.card.setup_desc')}</p>` +
    `<div class="auth-form">` +
      `<input id="authNewUser" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="${t('auth.login.username')}">` +
      `<input id="authNewPass" type="password" autocomplete="new-password" placeholder="${t('auth.card.new_password')}">` +
      `<input id="authNewPass2" type="password" autocomplete="new-password" placeholder="${t('auth.card.repeat_password')}">` +
      `<button class="btn-primary" id="authCreateBtn">${t('auth.card.create')}</button>` +
      `<div class="auth-form-msg" id="authCreateMsg"></div>` +
    `</div>`
  body.querySelector('#authCreateBtn')?.addEventListener('click', async () => {
    const msg = document.getElementById('authCreateMsg')
    const username = (document.getElementById('authNewUser').value || '').trim()
    const p1 = document.getElementById('authNewPass').value || ''
    const p2 = document.getElementById('authNewPass2').value || ''
    msg.className = 'auth-form-msg'
    if (!username || !p1) { msg.classList.add('err'); msg.textContent = t('auth.login.err_empty'); return }
    if (p1 !== p2) { msg.classList.add('err'); msg.textContent = t('auth.card.err_mismatch'); return }
    try {
      const r = await fetch('/api/auth/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: p1 }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok) { msg.classList.add('ok'); msg.textContent = t('auth.card.created'); renderAuthCard(); initAuthBanner() }
      else { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic') }
    } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
  })
}

function renderSessionPanel(body, status) {
  body.innerHTML =
    `<p class="auth-muted">${t('auth.card.signed_in_as', { user: escapeHtml(status.user) })}</p>` +
    `<div class="auth-form">` +
      `<input id="authCurPass" type="password" autocomplete="current-password" placeholder="${t('auth.card.current_password')}">` +
      `<input id="authChgPass" type="password" autocomplete="new-password" placeholder="${t('auth.card.new_password')}">` +
      `<input id="authChgPass2" type="password" autocomplete="new-password" placeholder="${t('auth.card.repeat_password')}">` +
      `<button class="btn-primary" id="authChgBtn">${t('auth.card.change_password')}</button>` +
      `<div class="auth-form-msg" id="authChgMsg"></div>` +
    `</div>` +
    `<div class="auth-sessions" id="authSessions"></div>` +
    `<div class="auth-actions">` +
      `<button class="btn-secondary btn-compact" id="authLogoutAllBtn">${t('auth.card.logout_all')}</button>` +
      `<button class="btn-secondary btn-compact" id="authLogoutBtn">${t('auth.card.logout')}</button>` +
    `</div>`
  document.getElementById('authChgBtn').addEventListener('click', async () => {
    const msg = document.getElementById('authChgMsg')
    const cur = document.getElementById('authCurPass').value || ''
    const p1 = document.getElementById('authChgPass').value || ''
    const p2 = document.getElementById('authChgPass2').value || ''
    msg.className = 'auth-form-msg'
    if (p1 !== p2) { msg.classList.add('err'); msg.textContent = t('auth.card.err_mismatch'); return }
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: cur, new_password: p1 }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok) { msg.classList.add('ok'); msg.textContent = t('auth.card.password_changed') }
      else { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic') }
    } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
  })
  document.getElementById('authLogoutBtn').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
    window.location.reload()
  })
  document.getElementById('authLogoutAllBtn').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout-all', { method: 'POST' }) } catch { /* ignore */ }
    window.location.reload()
  })
  renderAuthSessions()
}

async function renderAuthSessions() {
  const el = document.getElementById('authSessions')
  if (!el) return
  try {
    const r = await fetch('/api/auth/sessions')
    if (!r.ok) { el.innerHTML = ''; return }
    const { sessions } = await r.json()
    if (!sessions || !sessions.length) { el.innerHTML = ''; return }
    el.innerHTML = `<div class="auth-sessions-title">${t('auth.card.active_sessions')}</div>` +
      sessions.map((s) => {
        const last = new Date(s.lastSeenAt * 1000).toLocaleString()
        const ua = escapeHtml(s.userAgent || '-')
        return `<div class="auth-session-row"><code>${escapeHtml(s.idHashPrefix)}</code><span>${last}</span><span class="auth-session-ua">${ua}</span></div>`
      }).join('')
  } catch { el.innerHTML = '' }
}

function renderTokenModePanel(body) {
  body.innerHTML =
    `<p class="auth-muted">${t('auth.card.token_mode')}</p>`
}

// Dismissible setup banner: shown only when the operator is authed via the token
// and has not yet created a browser login. Dismissal persists per browser.
const AUTH_BANNER_DISMISS_KEY = 'marveen.auth-banner-dismissed'

async function initAuthBanner() {
  const banner = document.getElementById('authSetupBanner')
  if (!banner) return
  let dismissed = false
  try { dismissed = localStorage.getItem(AUTH_BANNER_DISMISS_KEY) === '1' } catch { /* storage blocked */ }
  const status = await fetchAuthStatus()
  const show = !!status && status.authenticated && status.method === 'token' && status.setup_required && !dismissed
  banner.hidden = !show
}

function wireAuthBanner() {
  if (_authBannerWired) return
  _authBannerWired = true
  const banner = document.getElementById('authSetupBanner')
  if (!banner) return
  const dismiss = document.getElementById('authBannerDismiss')
  const go = document.getElementById('authBannerGoBtn')
  if (dismiss) dismiss.addEventListener('click', () => {
    try { localStorage.setItem(AUTH_BANNER_DISMISS_KEY, '1') } catch { /* storage blocked */ }
    banner.hidden = true
  })
  if (go) go.addEventListener('click', () => {
    // Land on the Security tab, where the auth card lives now.
    try { localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, 'security') } catch { /* storage blocked */ }
    switchPage('settings')
    const link = document.querySelector('.sb-link[data-page="settings"]')
    if (link) { document.querySelectorAll('.sb-link').forEach((l) => l.classList.remove('active')); link.classList.add('active') }
  })
}


export async function loadSettings() {
  // Wire banner buttons once; refresh banner visibility on every settings open.
  wireAuthBanner()
  initAuthBanner()

  const gen = ++_loadGen

  const tabNav = document.getElementById('settingsTabNav')
  const tabPanels = document.getElementById('settingsTabPanels')
  if (!tabNav || !tabPanels) return

  // Park the auth card back outside the panels before wiping them: a previous
  // loadSettings run moved it INTO the Security panel, and clearing
  // tabPanels.innerHTML with the card still inside would destroy the node.
  const parkedAuthCard = document.getElementById('authCard')
  if (parkedAuthCard) {
    parkedAuthCard.hidden = true
    tabNav.parentElement.insertBefore(parkedAuthCard, tabNav)
  }

  tabNav.innerHTML = `<span style="color:var(--text-muted);font-size:13px;padding:12px 0;display:inline-block">${t('settings.loading')}</span>`
  tabPanels.innerHTML = ''
  settingsDirty.clear()
  updateSettingsSaveBar()

  renderAuthCard()

  try {
    const res = await fetch('/api/settings')
    if (!res.ok) throw new Error('fetch failed')
    const { settings } = await res.json()

    // A newer loadSettings() call started while we were fetching: bail out to
    // avoid clobbering the DOM that the newer call is building.
    if (gen !== _loadGen) return

    const byModule = new Map()
    for (const s of settings) {
      if (!byModule.has(s.module)) byModule.set(s.module, [])
      byModule.get(s.module).push(s)
    }

    tabNav.innerHTML = ''
    tabPanels.innerHTML = ''

    if (byModule.size === 0) {
      tabPanels.innerHTML = `<p style="padding:24px;color:var(--text-muted);font-size:13px">${t('settings.empty')}</p>`
      // No tabs to host the Security panel: fall back to showing the auth card
      // in its static spot above the (empty) tab area.
      const orphanAuthCard = document.getElementById('authCard')
      if (orphanAuthCard) orphanAuthCard.hidden = false
      return
    }

    // Registry keys declared with module:'security' render inside the synthetic
    // Security tab (below the auth card) instead of getting their own tab.
    const securityDefs = byModule.get('security') ?? []
    byModule.delete('security')

    const allModules = [...byModule.keys(), 'security', 'autonomy']
    const savedTab = localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY) || allModules[0]
    const activeTab = allModules.includes(savedTab) ? savedTab : allModules[0]

    // Build a tab button + panel for each settings module
    for (const [mod, defs] of byModule) {
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const group = document.createElement('div')
      group.className = 'settings-group'
      for (const def of defs) {
        group.appendChild(buildSettingRow(def))
      }
      panel.appendChild(group)
      tabPanels.appendChild(panel)
    }

    // Security tab (synthetic, like autonomy: exists even with zero registry
    // entries). Hosts the auth card -- browser login, password change, device
    // keys -- plus any module:'security' registry keys.
    {
      const mod = 'security'
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const authCard = document.getElementById('authCard')
      if (authCard) {
        panel.appendChild(authCard)
        authCard.hidden = false
      }

      if (securityDefs.length) {
        const group = document.createElement('div')
        group.className = 'settings-group'
        for (const def of securityDefs) {
          group.appendChild(buildSettingRow(def))
        }
        panel.appendChild(group)
      }
      tabPanels.appendChild(panel)
    }

    // Autonomy tab
    {
      const mod = 'autonomy'
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const legend = document.createElement('div')
      legend.className = 'autonomy-legend'
      legend.innerHTML = `
        <div class="autonomy-legend-item"><span class="autonomy-level-dot" style="background:var(--text-muted)"></span><span><strong>1</strong> ${t('autonomy.level.1')}</span></div>
        <div class="autonomy-legend-item"><span class="autonomy-level-dot" style="background:var(--accent)"></span><span><strong>2</strong> ${t('autonomy.level.2')}</span></div>
        <div class="autonomy-legend-item"><span class="autonomy-level-dot" style="background:var(--success)"></span><span><strong>3</strong> ${t('autonomy.level.3')}</span></div>
      `
      panel.appendChild(legend)

      const grid = document.createElement('div')
      grid.className = 'autonomy-grid'
      grid.id = 'settingsAutonomyGrid'
      panel.appendChild(grid)

      const footer = document.createElement('p')
      footer.className = 'autonomy-footer'
      footer.id = 'settingsAutonomyUpdatedAt'
      panel.appendChild(footer)

      const refreshBtn = document.createElement('button')
      refreshBtn.className = 'btn-secondary btn-compact'
      refreshBtn.textContent = t('common.btn.refresh')
      refreshBtn.addEventListener('click', () => renderAutonomyContent(grid, footer))
      panel.appendChild(refreshBtn)

      tabPanels.appendChild(panel)

      if (mod === activeTab) {
        renderAutonomyContent(grid, footer)
      }
    }
  } catch (err) {
    tabPanels.innerHTML = `<p style="padding:24px;color:var(--danger)">${t('settings.error')}</p>`
  }
}

function activateSettingsTab(mod) {
  document.querySelectorAll('#settingsTabNav .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === mod)
  })
  document.querySelectorAll('#settingsTabPanels .tab-panel').forEach(panel => {
    panel.hidden = panel.id !== `settings-panel-${mod}`
  })
  localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, mod)

  if (mod === 'autonomy') {
    const grid = document.getElementById('settingsAutonomyGrid')
    const footer = document.getElementById('settingsAutonomyUpdatedAt')
    if (grid && !grid.innerHTML.trim()) renderAutonomyContent(grid, footer)
  }
}

function buildSettingRow(def) {
  const row = document.createElement('div')
  row.className = 'settings-row'

  const info = document.createElement('div')
  info.className = 'settings-row-info'

  const title = document.createElement('div')
  title.className = 'settings-row-key'
  title.textContent = def.key
  if (def.requiresRestart) {
    const badge = document.createElement('span')
    badge.className = 'settings-restart-badge'
    badge.textContent = t('settings.restart_badge')
    title.appendChild(badge)
  }
  info.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'settings-row-desc'
  desc.textContent = t('settings.desc.' + def.key) || def.description
  info.appendChild(desc)

  const meta = document.createElement('div')
  meta.className = 'settings-row-meta'
  const metaParts = []
  if (Array.isArray(def.valueSet) && def.valueSet.length) metaParts.push(t('settings.meta.values') + ': ' + def.valueSet.join(', '))
  if (def.type === 'int' && (def.min !== undefined || def.max !== undefined)) {
    metaParts.push(t('settings.meta.range') + ': ' + (def.min ?? '–') + '–' + (def.max ?? '–'))
  }
  if (def.type === 'color') metaParts.push(t('settings.meta.format') + ': #rrggbb')
  metaParts.push(t('settings.meta.default') + ': ' + def.default)
  meta.textContent = metaParts.join(' · ')
  info.appendChild(meta)

  row.appendChild(info)

  const editor = document.createElement('div')
  editor.className = 'settings-row-editor'

  const originalValue = String(def.value)
  let valueInput
  if (Array.isArray(def.valueSet) && def.valueSet.length) {
    valueInput = document.createElement('select')
    valueInput.className = 'input'
    for (const opt of def.valueSet) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      valueInput.appendChild(o)
    }
    valueInput.value = originalValue
  } else if (def.type === 'boolean') {
    valueInput = document.createElement('input')
    valueInput.type = 'checkbox'
    valueInput.className = 'settings-toggle'
    valueInput.checked = String(def.value) === '1'
  } else if (def.type === 'color') {
    valueInput = document.createElement('input')
    valueInput.type = 'color'
    valueInput.className = 'settings-color-input'
    valueInput.value = def.value
  } else if (def.type === 'int') {
    valueInput = document.createElement('input')
    valueInput.type = 'number'
    valueInput.className = 'input'
    if (def.min !== undefined) valueInput.min = def.min
    if (def.max !== undefined) valueInput.max = def.max
    valueInput.value = def.value
  } else {
    valueInput = document.createElement('input')
    valueInput.type = 'text'
    valueInput.className = 'input'
    valueInput.value = def.value
  }
  valueInput.dataset.settingKey = def.key
  valueInput.dataset.settingType = def.type
  valueInput.dataset.originalValue = originalValue
  editor.appendChild(valueInput)

  const errorEl = document.createElement('div')
  errorEl.className = 'settings-row-error'
  editor.appendChild(errorEl)

  valueInput.addEventListener('input', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))
  valueInput.addEventListener('change', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))

  row.appendChild(editor)
  return row
}

async function saveAllSettings() {
  if (settingsDirty.size === 0) return
  const btn = document.getElementById('settingsSaveAllBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('settings.save_btn.saving') }

  const errors = []
  let needsRestart = false

  for (const [key, { input, type, errorEl }] of settingsDirty) {
    errorEl.textContent = ''
    const raw = type === 'int' ? Number(input.value) : settingInputValue(input, type)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: raw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        errorEl.textContent = data.error || 'Hiba'
        errors.push(`${key}: ${data.error || 'hiba'}`)
      } else {
        input.dataset.originalValue = String(raw)
        if (data.requiresRestart) needsRestart = true
      }
    } catch {
      errorEl.textContent = 'Kapcsolati hiba'
      errors.push(`${key}: kapcsolati hiba`)
    }
  }

  // Remove successfully saved keys from dirty map
  for (const [key, { input, type }] of settingsDirty) {
    if (settingInputValue(input, type) === input.dataset.originalValue) settingsDirty.delete(key)
  }
  updateSettingsSaveBar()

  if (btn) { btn.disabled = false; btn.textContent = t('settings.btn.save') }
  if (errors.length) {
    showToast(t('settings.toast.partial_error'), 'error')
  } else {
    showToast(needsRestart ? t('settings.toast.saved_restart') : t('settings.toast.saved'))
  }
}

function resetAllSettings() {
  for (const [key, { input, originalValue }] of settingsDirty) {
    input.value = originalValue
    const errorEl = document.querySelector(`[data-setting-key="${key}"]`)?.closest('.settings-row')?.querySelector('.settings-row-error')
    if (errorEl) errorEl.textContent = ''
  }
  settingsDirty.clear()
  updateSettingsSaveBar()
}

document.getElementById('settingsSaveAllBtn')?.addEventListener('click', saveAllSettings)
document.getElementById('settingsResetBtn')?.addEventListener('click', resetAllSettings)

