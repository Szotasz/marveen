import { t } from './i18n.js'
import { showToast } from './toast.js'

let _openModal = null
let _closeModal = null
let _loadAgents = null

// ============================================================
// === Agent reauth login flow ===
// ============================================================

export async function handleAgentLogin(agentName, btn) {
  const phase = btn.dataset.phase || 'start'
  btn.disabled = true
  const origText = btn.textContent
  btn.textContent = phase === 'start' ? t('agents.auth.btn_starting') : t('agents.auth.btn_confirming')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase }),
    })
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + res.status) }
    if (phase === 'start') {
      btn.dataset.phase = 'confirm'
      btn.textContent = t('agents.auth.btn_confirm')
      btn.disabled = false
      showToast(t('agents.auth.toast_started'))
    } else {
      btn.textContent = t('agents.auth.btn_logged_in')
      showToast(t('agents.auth.toast_success'))
      setTimeout(() => _loadAgents && _loadAgents(), 1500)
    }
  } catch (e) {
    showToast('Hiba: ' + (e.message || e))
    btn.textContent = origText
    btn.dataset.phase = 'start'
    btn.disabled = false
  }
}

// ============================================================
// === Agent terminal modal (xterm.js) ===
// ============================================================

let terminalInstance = null
let terminalSSE = null
let terminalFit = null
// Master input gate (mirrors the server-side terminal-input toggle). Keystrokes
// are dropped locally when OFF so we never spam the audit log with 403s; the
// server enforces the same gate independently (fail-closed). Owner flips it via
// the checkbox in the modal header (POST /api/terminal-input).
let terminalInputEnabled = false

function syncTerminalInputToggleUI() {
  const cb = document.getElementById('terminalInputToggle')
  const label = document.getElementById('terminalInputToggleLabel')
  if (cb) cb.checked = terminalInputEnabled
  if (label) {
    label.textContent = terminalInputEnabled ? 'Input on' : 'Input off'
    label.style.color = terminalInputEnabled ? '#8fbf6f' : '#b8b2a6'
  }
}

export function openTerminalModal(agentName) {
  const overlay = document.getElementById('terminalOverlay')
  const container = document.getElementById('terminalContainer')
  const title = document.getElementById('terminalModalTitle')
  if (!overlay || !container) return

  title.textContent = agentName + ' - Terminal'

  fetch('/api/terminal-input')
    .then(r => r.ok ? r.json() : { enabled: false })
    .then(d => { terminalInputEnabled = d.enabled === true; syncTerminalInputToggleUI() })
    .catch(() => { terminalInputEnabled = false; syncTerminalInputToggleUI() })

  if (terminalSSE) { terminalSSE.close(); terminalSSE = null }
  if (terminalInstance) { terminalInstance.dispose(); terminalInstance = null }
  container.innerHTML = ''

  const term = new window.Terminal({
    theme: { background: '#1a1a1a', foreground: '#e8e4da' },
    fontFamily: 'JetBrains Mono, Menlo, monospace',
    fontSize: 12,
    cursorBlink: false,
    disableStdin: false,
    scrollback: 4000,
    convertEol: true,
    allowProposedApi: true,
  })
  const fitAddon = new window.FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)
  fitAddon.fit()
  terminalInstance = term
  terminalFit = fitAddon

  _openModal(overlay)
  setTimeout(() => term.focus(), 50)

  // The pane snapshot includes scrollback history (server uses
  // `capture-pane -S -2000`). Only repaint when snapshot changed and viewport
  // is at the bottom -- if user scrolled up, freeze and resume on return.
  let latestPane = null
  let paintedPane = null
  const isAtBottom = () => {
    const buf = term.buffer.active
    return buf.viewportY >= buf.baseY
  }
  const repaint = () => {
    if (latestPane === null || latestPane === paintedPane) return
    if (!isAtBottom()) return
    paintedPane = latestPane
    term.write('\x1b[3J\x1b[2J\x1b[H' + latestPane)
  }
  // EventSource cannot set an Authorization header. In token mode we pass via
  // ?token=; in password-login (session-cookie) mode open a plain URL.
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const streamBase = `/api/agents/${encodeURIComponent(agentName)}/pane/stream`
  const sse = new EventSource(token ? `${streamBase}?token=${encodeURIComponent(token)}` : streamBase)
  sse.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.pane !== undefined) {
        latestPane = msg.pane.replace(/\x1b]8;[^\x1b]*\x1b\\/g, '')
        repaint()
      }
    } catch {}
  }
  sse.onerror = () => term.write(`\r\n${t('terminal.stream_error')}\r\n`)
  terminalSSE = sse
  term.onScroll(() => { if (isAtBottom()) repaint() })

  // Single onData handler -- maps escape sequences to {special}, plain chars to {keys}.
  // PageUp/PageDown scroll xterm scrollback locally (history viewing) instead of forwarding.
  const ESC_TO_SPECIAL = {
    '\r': 'Enter', '\x1b': 'Escape',
    '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
    '\x7f': 'BSpace', '\t': 'Tab', '\x1b[Z': 'S-Tab',
    '\x03': 'C-c', '\x04': 'C-d', '\x15': 'C-u', '\x0c': 'C-l',
  }
  term.onData(data => {
    if (data === '\x1b[5~') { term.scrollPages(-1); return }
    if (data === '\x1b[6~') { term.scrollPages(1); return }
    if (!terminalInputEnabled) {
      showToast('Terminal input is off. Enable it with the header toggle first.')
      return
    }
    const special = ESC_TO_SPECIAL[data]
    const body = special ? { special } : { keys: data }
    fetch(`/api/agents/${encodeURIComponent(agentName)}/keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  })

  let fitTimer = null
  const ro = new ResizeObserver(() => {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(() => { try { fitAddon.fit() } catch {} }, 50)
  })
  const modalEl = container.closest('.terminal-modal') || container.parentElement
  if (modalEl) ro.observe(modalEl)
}

// ============================================================
// === Agent conversation (readable transcript) modal ===
// ============================================================

const CONVERSATION_PAGE_SIZE = 400
let conversationEntries = []
let conversationAgentName = null
let conversationHasOlder = false
let conversationLoadingOlder = false

export async function openConversationModal(agentName, displayName) {
  const overlay = document.getElementById('conversationOverlay')
  const container = document.getElementById('conversationContainer')
  const title = document.getElementById('conversationModalTitle')
  if (!overlay || !container) return
  conversationAgentName = agentName
  title.textContent = t('conversation.title', { name: displayName || agentName })
  container.innerHTML = `<div class="conversation-empty">${t('conversation.loading')}</div>`
  _openModal(overlay)
  await loadConversation()
}

async function loadConversation() {
  const container = document.getElementById('conversationContainer')
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(conversationAgentName)}/conversation?limit=${CONVERSATION_PAGE_SIZE}&offset=0`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    const d = await r.json()
    conversationEntries = Array.isArray(d.entries) ? d.entries : []
    conversationHasOlder = !!d.hasOlder
    renderConversation()
  } catch {
    if (container) container.innerHTML = `<div class="conversation-empty">${t('conversation.error')}</div>`
  }
}

async function loadOlderConversation() {
  if (conversationLoadingOlder || !conversationHasOlder) return
  conversationLoadingOlder = true
  const btn = document.getElementById('conversationLoadOlder')
  if (btn) { btn.disabled = true; btn.textContent = t('conversation.loading') }
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const offset = conversationEntries.length
    const r = await fetch(`/api/agents/${encodeURIComponent(conversationAgentName)}/conversation?limit=${CONVERSATION_PAGE_SIZE}&offset=${offset}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    const d = await r.json()
    const older = Array.isArray(d.entries) ? d.entries : []
    conversationHasOlder = !!d.hasOlder
    if (older.length) {
      conversationEntries = older.concat(conversationEntries)
      renderConversation({ preserveScroll: true })
    } else {
      renderConversation()
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = t('conversation.load_more') }
  } finally {
    conversationLoadingOlder = false
  }
}

function fmtConvTs(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderConversation(opts = {}) {
  const container = document.getElementById('conversationContainer')
  if (!container) return
  const prevH = container.scrollHeight
  const prevTop = container.scrollTop
  const q = (document.getElementById('conversationSearch')?.value || '').toLowerCase().trim()
  const showActions = document.getElementById('conversationShowActions')?.checked
  let list = conversationEntries
  if (!showActions) list = list.filter(e => e.kind === 'in' || e.kind === 'out')
  if (q) list = list.filter(e => (e.text || '').toLowerCase().includes(q))
  const olderBtn = conversationHasOlder
    ? `<button id="conversationLoadOlder" class="conv-load-older">${t('conversation.load_more')}</button>`
    : ''
  if (!list.length) {
    container.innerHTML = olderBtn || `<div class="conversation-empty">${t('conversation.empty')}</div>`
  } else {
    container.innerHTML = olderBtn + list.map(renderConvEntry).join('')
  }
  document.getElementById('conversationLoadOlder')?.addEventListener('click', loadOlderConversation)
  if (opts.preserveScroll) {
    container.scrollTop = prevTop + (container.scrollHeight - prevH)
  } else {
    container.scrollTop = container.scrollHeight
  }
}

function renderConvEntry(e) {
  const ts = fmtConvTs(e.ts)
  const txt = escapeHtml(e.text || '').replace(/\n/g, '<br>')
  if (e.kind === 'in') {
    return `<div class="conv-row conv-in"><div class="conv-bubble"><div class="conv-meta">Telegram be · ${ts}</div><div class="conv-text">${txt}</div></div></div>`
  }
  if (e.kind === 'out') {
    const lbl = escapeHtml(e.label || t('messages.conv.reply_label'))
    return `<div class="conv-row conv-out"><div class="conv-bubble"><div class="conv-meta">${lbl} · ${ts}</div><div class="conv-text">${txt}</div></div></div>`
  }
  if (e.kind === 'note') {
    return `<div class="conv-row conv-note"><div class="conv-note-text">📝 ${txt}</div></div>`
  }
  return `<div class="conv-row conv-action"><div class="conv-action-text">⚙ ${txt}<span class="conv-action-ts">${ts}</span></div></div>`
}

export function initAgentModals({ openModal, closeModal, loadAgents }) {
  _openModal = openModal
  _closeModal = closeModal
  _loadAgents = loadAgents

  // agents.js calls handleAgentLogin by name from event listeners; expose as a
  // window global so the ES-module boundary doesn't break the reference.
  window.handleAgentLogin = handleAgentLogin

  document.getElementById('terminalClose')?.addEventListener('click', () => {
    const overlay = document.getElementById('terminalOverlay')
    if (overlay) _closeModal(overlay)
    if (terminalSSE) { terminalSSE.close(); terminalSSE = null }
    if (terminalInstance) { terminalInstance.dispose(); terminalInstance = null }
  })

  // Owner flips the master terminal-input gate. Optimistically reflect the desired
  // state, POST it, then reconcile with the server's authoritative response.
  document.getElementById('terminalInputToggle')?.addEventListener('change', (e) => {
    const desired = e.target.checked === true
    fetch('/api/terminal-input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: desired }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(d => {
        terminalInputEnabled = d.enabled === true
        syncTerminalInputToggleUI()
        showToast(terminalInputEnabled ? 'Terminal input enabled (audit-logged)' : 'Terminal input disabled')
      })
      .catch(() => {
        terminalInputEnabled = false
        syncTerminalInputToggleUI()
        showToast('Could not change terminal input state')
      })
  })

  document.getElementById('conversationClose')?.addEventListener('click', () => {
    const overlay = document.getElementById('conversationOverlay')
    if (overlay) _closeModal(overlay)
  })
  document.getElementById('conversationSearch')?.addEventListener('input', () => renderConversation())
  document.getElementById('conversationShowActions')?.addEventListener('change', () => renderConversation())
  document.getElementById('conversationRefresh')?.addEventListener('click', () => loadConversation())
}
