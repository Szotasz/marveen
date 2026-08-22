import { escapeHtml } from './util.js'
import { t } from './i18n.js'
import { showToast } from './toast.js'
import { getFederatedPeerStatus, setFederatedPeerStatus } from './agents.js'
import { getChatSelectedAgent, setChatSelectedAgent } from './messages.js'


let _openModal = null
let _closeModal = null

// State declared before the router IIFE: a first-load #federation route must
// not hit a TDZ on these.
let fedPageWired = false
let fedPeersViewCache = null
let fedPeerModalEditId = null
let _fedLoadGen = 0

export async function loadFederationPage() {
  const gen = ++_fedLoadGen
  wireFederationPage()
  const statsEl = document.getElementById('federationStats')
  const masterEl = document.getElementById('federationMaster')
  const peersEl = document.getElementById('federationPeers')
  if (!statsEl || !masterEl || !peersEl) return
  peersEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('common.loading')}</p>`
  try {
    const [peersRes, statusRes] = await Promise.all([
      fetch('/api/federation/peers'),
      fetch('/api/federation/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    if (!peersRes.ok) throw new Error('HTTP ' + peersRes.status)
    if (gen !== _fedLoadGen) return
    fedPeersViewCache = await peersRes.json()
    if (statusRes && Array.isArray(statusRes.peers)) setFederatedPeerStatus(statusRes.peers)
    renderFederationPage()
  } catch (e) {
    if (gen !== _fedLoadGen) return
    peersEl.innerHTML = `<p style="color:var(--danger)">${t('federation.error', { msg: escapeHtml(String(e.message || e)) })}</p>`
  }
}

function fedStateLabel(state) {
  const key = 'federation.peer_state.' + (state || 'unknown')
  return t(key)
}

function renderFederationPage() {
  const view = fedPeersViewCache
  if (!view) return
  const statsEl = document.getElementById('federationStats')
  const masterEl = document.getElementById('federationMaster')
  const peersEl = document.getElementById('federationPeers')
  const statusById = new Map(getFederatedPeerStatus().map((p) => [p.id, p]))
  const okCount = getFederatedPeerStatus().filter((p) => p.state === 'ok').length

  const statBox = (value, label) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 16px;min-width:110px">
    <div style="font-size:20px;font-weight:600">${value}</div>
    <div style="font-size:12px;color:var(--text-muted)">${label}</div>
  </div>`
  statsEl.innerHTML = [
    statBox(view.enabled ? t('common.yes') : t('common.no'), t('federation.stat.enabled')),
    statBox(String(view.peers.length), t('federation.stat.peers')),
    statBox(String(okCount), t('federation.stat.reachable')),
    statBox(escapeHtml(view.systemId || '-'), t('federation.stat.system_id')),
  ].join('')

  const routingMode = view.routingMode || 'catalog-first'
  const routingRadios = ['strong', 'catalog-first', 'advisory'].map((m) => `
    <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 0">
      <input type="radio" name="fedRoutingMode" value="${m}" ${routingMode === m ? 'checked' : ''} style="margin-top:3px;accent-color:var(--accent)">
      <span>
        <span style="font-weight:600">${t('federation.routing.mode.' + m + '.label')}</span>
        <span style="display:block;font-size:12px;color:var(--text-muted)">${t('federation.routing.mode.' + m + '.hint')}</span>
      </span>
    </label>`).join('')
  masterEl.innerHTML = `
    <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
      <input type="checkbox" id="fedEnabledToggle" style="width:16px;height:16px;accent-color:var(--accent)" ${view.enabled ? 'checked' : ''}>
      <span style="font-weight:600">${t('federation.master_label')}</span>
    </label>
    <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0 26px">${t('federation.master_hint')}</p>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <div style="font-weight:600">${t('federation.routing.title')}</div>
      <p style="font-size:12px;color:var(--text-muted);margin:2px 0 8px 0">${t('federation.routing.subtitle')}</p>
      ${routingRadios}
      <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0 0">${t('federation.routing.apply_note')}</p>
    </div>`
  document.getElementById('fedEnabledToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked
    if (!enabled && !confirm(t('federation.confirm.disable'))) { e.target.checked = true; return }
    try {
      const res = await fetch('/api/federation/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); e.target.checked = !enabled; return }
      showToast(enabled ? t('federation.toast.enabled') : t('federation.toast.disabled'))
      fedRefreshAndReload()
    } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })); e.target.checked = !enabled }
  })
  document.querySelectorAll('input[name="fedRoutingMode"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      const mode = e.target.value
      try {
        const res = await fetch('/api/federation/routing-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
        showToast(t('federation.routing.toast_set', { mode: t('federation.routing.mode.' + mode + '.label') }))
      } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
    })
  })

  if (!view.peers.length) {
    peersEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('federation.peers_empty')}</p>`
    return
  }
  peersEl.innerHTML = ''
  for (const peer of view.peers) {
    const st = statusById.get(peer.id)
    const state = peer.hasOutboundToken ? (st ? st.state : 'unknown') : 'unpaired'
    const reachable = state === 'ok'
    const lastOk = st && st.lastOkAt ? new Date(st.lastOkAt).toLocaleString() : '-'
    const agentCount = st && st.manifest && Array.isArray(st.manifest.agents) ? String(st.manifest.agents.length) : '-'
    const card = document.createElement('div')
    card.className = 'card'
    card.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px'
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="font-size:15px">${escapeHtml(peer.id)}</strong>
        <span class="tg-status"><span class="tg-dot ${reachable ? 'connected' : 'disconnected'}"></span> ${fedStateLabel(state)}</span>
        <span style="color:var(--text-muted);font-size:12px;margin-left:auto">${t('federation.card.last_ok')}: ${escapeHtml(lastOk)} · ${t('federation.card.agents')}: ${escapeHtml(agentCount)}</span>
      </div>
      <div style="font-size:13px;color:var(--text-muted);word-break:break-all">${escapeHtml(peer.baseUrl)}</div>
      ${st && st.error ? `<div style="font-size:12px;color:var(--danger)">${escapeHtml(st.error)}</div>` : ''}
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer">
        <input type="checkbox" class="fed-share-cap" ${peer.shareCapabilitySummaries ? 'checked' : ''} style="accent-color:var(--accent)">
        ${t('federation.share_cap_label')}
      </label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn" data-variant="secondary" data-size="compact" data-action="reveal">${t('federation.btn.reveal')}</button>
        <button class="btn" data-variant="secondary" data-size="compact" data-action="rotate">${t('federation.btn.rotate')}</button>
        <button class="btn" data-variant="secondary" data-size="compact" data-action="edit">${t('common.edit')}</button>
        <button class="btn" data-variant="secondary" data-size="compact" data-action="delete" style="color:var(--danger)">${t('common.delete')}</button>
      </div>
      <div class="fed-token-reveal" hidden style="font-family:monospace;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px;word-break:break-all"></div>`
    card.querySelector('[data-action="reveal"]').addEventListener('click', () => fedRevealToken(peer.id, card))
    card.querySelector('[data-action="rotate"]').addEventListener('click', () => fedRotateToken(peer.id))
    card.querySelector('[data-action="edit"]').addEventListener('click', () => fedOpenPeerModal(peer))
    card.querySelector('[data-action="delete"]').addEventListener('click', () => fedDeletePeer(peer.id))
    card.querySelector('.fed-share-cap').addEventListener('change', (e) => fedToggleShareCap(peer.id, e.target.checked))
    peersEl.appendChild(card)
  }
}

async function fedRevealToken(peerId, card) {
  const box = card.querySelector('.fed-token-reveal')
  if (!box.hidden) { box.hidden = true; box.textContent = ''; return }
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}/inbound-token`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    box.textContent = data.inboundToken
    box.hidden = false
    navigator.clipboard?.writeText(data.inboundToken).then(
      () => showToast(t('federation.toast.token_copied')),
      () => {},
    )
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedRotateToken(peerId) {
  if (!confirm(t('federation.confirm.rotate', { peer: peerId }))) return
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}/rotate-inbound-token`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    showToast(t('federation.toast.rotated'))
    loadFederationPage()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedToggleShareCap(peerId, share) {
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareCapabilitySummaries: share }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); loadFederationPage(); return }
    showToast(share ? t('federation.toast.share_cap_on') : t('federation.toast.share_cap_off'))
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })); loadFederationPage() }
}

async function fedDeletePeer(peerId) {
  if (!confirm(t('federation.confirm.delete_peer', { peer: peerId }))) return
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && key.startsWith('chat_last_seen_' + peerId + '/')) localStorage.removeItem(key)
    }
    if (getChatSelectedAgent()?.startsWith(peerId + '/')) setChatSelectedAgent(null)
    showToast(t('federation.toast.peer_deleted'))
    loadFederationPage()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedApplyToMainAgent() {
  if (!confirm(t('federation.confirm.apply'))) return
  try {
    const res = await fetch('/api/federation/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    showToast(t('federation.toast.applied'))
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedRefreshAndReload() {
  try { await fetch('/api/federation/refresh', { method: 'POST' }) } catch { /* best effort */ }
  loadFederationPage()
}

function fedOpenPeerModal(peer) {
  fedPeerModalEditId = peer ? peer.id : null
  document.getElementById('fedPeerModalTitle').textContent = peer ? t('federation.modal.edit_title', { peer: peer.id }) : t('federation.modal.add_title')
  const idInput = document.getElementById('fedPeerId')
  idInput.value = peer ? peer.id : ''
  idInput.disabled = !!peer
  document.getElementById('fedPeerBaseUrl').value = peer ? peer.baseUrl : ''
  document.getElementById('fedPeerOutboundToken').value = ''
  document.getElementById('fedPeerOutboundToken').placeholder = peer && peer.hasOutboundToken ? t('federation.modal.outbound_keep') : ''
  document.getElementById('fedPeerAbandonWindow').value = peer && peer.abandonWindowMinutes ? String(peer.abandonWindowMinutes) : ''
  _openModal(document.getElementById('fedPeerModalOverlay'))
}

async function fedSavePeerModal() {
  const id = document.getElementById('fedPeerId').value.trim().toLowerCase()
  const baseUrl = document.getElementById('fedPeerBaseUrl').value.trim()
  const outbound = document.getElementById('fedPeerOutboundToken').value.trim()
  const abandonRaw = document.getElementById('fedPeerAbandonWindow').value.trim()
  try {
    let res, data
    if (fedPeerModalEditId) {
      const body = { baseUrl }
      if (outbound) body.outboundToken = outbound
      if (abandonRaw) body.abandonWindowMinutes = parseInt(abandonRaw, 10)
      else body.abandonWindowMinutes = null
      res = await fetch(`/api/federation/peers/${encodeURIComponent(fedPeerModalEditId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
      showToast(t('federation.toast.peer_saved'))
    } else {
      const body = { id, baseUrl }
      if (outbound) body.outboundToken = outbound
      res = await fetch('/api/federation/peers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
      prompt(t('federation.modal.minted_token_hint'), data.inboundToken)
      showToast(t('federation.toast.peer_added'))
    }
    _closeModal(document.getElementById('fedPeerModalOverlay'))
    fedRefreshAndReload()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedRemoveAll() {
  if (!confirm(t('federation.confirm.remove'))) return
  try {
    const res = await fetch('/api/federation/remove', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    setFederatedPeerStatus([])
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && /^chat_last_seen_[^/]+\//.test(key)) localStorage.removeItem(key)
    }
    if (getChatSelectedAgent()?.includes('/')) setChatSelectedAgent(null)
    showToast(t('federation.toast.removed'))
    loadFederationPage()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

function wireFederationPage() {
  if (fedPageWired) return
  fedPageWired = true
  const fedApplyBtn = document.getElementById('federationApplyBtn')
  if (fedApplyBtn) { fedApplyBtn.title = t('federation.apply_hint'); fedApplyBtn.addEventListener('click', fedApplyToMainAgent) }
  document.getElementById('federationAddPeerBtn')?.addEventListener('click', () => fedOpenPeerModal(null))
  document.getElementById('federationRemoveBtn')?.addEventListener('click', fedRemoveAll)
  document.getElementById('fedPeerModalSave')?.addEventListener('click', fedSavePeerModal)
  document.getElementById('fedPeerModalCancel')?.addEventListener('click', () => _closeModal(document.getElementById('fedPeerModalOverlay')))
  document.getElementById('fedPeerModalClose')?.addEventListener('click', () => _closeModal(document.getElementById('fedPeerModalOverlay')))
  const overlay = document.getElementById('fedPeerModalOverlay')
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) _closeModal(overlay) })
}

export function initFederation({ openModal, closeModal }) {
  _openModal = openModal
  _closeModal = closeModal
}
