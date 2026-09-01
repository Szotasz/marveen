import { escapeHtml, mainAgentId } from './util.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'
import { avatarBust, setFederatedPeerStatus, federatedAgentEntries } from './agents.js'
import { getErrorMessage } from './error-message.js'
import { initTenantSelector } from './tenant-selector.js'


// === Team: inter-agent message log + compose ===
// View the /api/messages queue and let the operator send a message to an agent
// from the dashboard. Targets come from /api/schedules/agents (the same allowed
// agent list the scheduler uses) -- never a free-text target. The sender is the
// owner (resolved by type from /api/kanban/assignees), so the receiving agent
// sees a message from Gábor, not a spoofable string. /api/messages sits behind
// the dashboard bearer token + Cloudflare Access.
const MSG_STATUS_META = {
  pending:   { label: () => t('messages.status.pending'),   variant: 'accent'   },
  delivered: { label: () => t('messages.status.delivered'), variant: 'success'  },
  done:      { label: () => t('messages.status.done'),      variant: 'success'  },
  failed:    { label: () => t('messages.status.failed'),    variant: 'accent'   },
}
async function resolveOwnerName() {
  try {
    const res = await fetch('/api/kanban/assignees')
    if (res.ok) {
      const list = await res.json()
      const owner = Array.isArray(list) ? list.find(a => a.type === 'owner') : null
      if (owner && owner.name) return owner.name
    }
  } catch { /* fall through */ }
  return 'owner'
}

// === Messages page ===
// chatAgentHasAvatar: populated from /api/agents during loadChatAgentList
const chatAgentHasAvatar = new Map() // name -> true|false
let chatSelectedAgent = null
export function getChatSelectedAgent() { return chatSelectedAgent }
export function setChatSelectedAgent(id) { chatSelectedAgent = id }

let _msgTenantGetter = null
let _msgInited = false
async function _ensureMessagesInited() {
  if (_msgInited) return
  _msgInited = true
  _msgTenantGetter = await initTenantSelector('messagesTenantSelectorContainer', () => loadChatAgentList())
}

function chatMonogramEl(agentName, size) {
  const letter = agentName.charAt(0).toUpperCase()
  const colors = ['#d97757','#00C2A8','#818cf8','#22c55e','#f59e0b','#ec4899']
  const color = colors[agentName.split('').reduce((a,c)=>a+c.charCodeAt(0),0) % colors.length]
  return `<div class="chat-avatar chat-avatar-mono" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size*0.4)}px">${letter}</div>`
}

// Global onerror handler — avoids HTML-in-attribute escaping issues
window.chatImgError = function(img) {
  const name = img.getAttribute('data-agent-name') || img.alt || '?'
  const size = parseInt(img.width) || 32
  const letter = name.charAt(0).toUpperCase()
  const colors = ['#d97757','#00C2A8','#818cf8','#22c55e','#f59e0b','#ec4899']
  const color = colors[name.split('').reduce((a,c)=>a+c.charCodeAt(0),0) % colors.length]
  const div = document.createElement('div')
  div.className = 'chat-avatar chat-avatar-mono'
  div.style.cssText = `width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size*0.4)}px`
  div.textContent = letter
  img.replaceWith(div)
}

function chatAvatarHtml(agentName, size = 32) {
  const lower = agentName.toLowerCase()
  const hasAvatar = chatAgentHasAvatar.get(lower)
  if (!hasAvatar) return chatMonogramEl(agentName, size)
  const src = lower === mainAgentId().toLowerCase()
    ? `/api/marveen/avatar${avatarBust()}`
    : `/api/agents/${encodeURIComponent(lower)}/avatar${avatarBust()}`
  return `<img class="chat-avatar" src="${src}" width="${size}" height="${size}" alt="${escapeHtml(agentName)}" data-agent-name="${escapeHtml(agentName)}" onerror="chatImgError(this)">`
}

export async function loadMessagesPage() {
  await _ensureMessagesInited()
  await loadChatAgentList()
}

const CHAT_SYSTEM_AGENTS = new Set(['heartbeat','telegram-coordinator','channel-coordinator'])
// The owner's own message thread is pinned to the top and labelled "<name> (te)".
// The owner display name comes from the backend (OWNER_NAME via /api/marveen ->
// window._marveen.ownerName), not a hardcoded literal, so a renamed install
// recognizes its real owner. Empty until _marveen resolves (no false match).
function chatOwnerName() { return window._marveen?.ownerName || '' }

// The main agent's display name (BOT_NAME). mainAgentId() is the routing id
// (e.g. "marveen") used for matching, avatar lookups and API calls; this is
// what the user should SEE. Sourced from the backend (/api/marveen -> name,
// mirrored into _brandTokens.bot by initSidebarBrand), so a renamed install
// shows its real bot name. Falls back to the id before _marveen resolves.
// Regression #519/#520: keep the four Messages-view display points routing the
// main agent id through chatDisplayName -- a later refactor once stripped this
// and leaked the raw routing id again. Guarded by messages-view-display-name.test.ts.
function mainAgentDisplayName() {
  return window._marveen?.name || window._brandTokens?.bot || mainAgentId()
}
// Map a routing agent id to its user-facing label: the main agent's id becomes
// its BOT_NAME display name; every other agent already carries a human name as
// its id, so it passes through unchanged.
function chatDisplayName(name) {
  return name === mainAgentId() ? mainAgentDisplayName() : name
}

function chatLastSeenKey(agentName) { return 'chat_last_seen_' + agentName }
function chatGetLastSeen(agentName) { return parseInt(localStorage.getItem(chatLastSeenKey(agentName)) || '0', 10) }
function chatMarkSeen(agentName, maxId) {
  if (maxId > chatGetLastSeen(agentName)) localStorage.setItem(chatLastSeenKey(agentName), String(maxId))
}
function chatIsUnread(agentName, threadInfo) {
  const owner = chatOwnerName()
  if (!owner || agentName !== owner) return false
  if (!threadInfo?.lastMsg) return false
  return threadInfo.lastMsg.id > chatGetLastSeen(agentName)
}

export async function loadChatAgentList() {
  const sidebar = document.getElementById('chatAgentList')
  if (!sidebar) return
  try {
    // Load fleet agents + threads in parallel (the federation status fetch is
    // failure-proof: it must never take down the Messages page)
    const msgTenant = _msgTenantGetter?.()
    const threadsUrl = msgTenant ? `/api/messages/threads?tenant=${encodeURIComponent(msgTenant)}` : '/api/messages/threads'
    const [agentsRes, threadsRes, fedStatus] = await Promise.all([
      fetch('/api/agents'),
      fetch(threadsUrl),
      fetch('/api/federation/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    const agentsRaw = agentsRes.ok ? await agentsRes.json() : []
    const threads = threadsRes.ok ? await threadsRes.json() : []
    if (fedStatus && Array.isArray(fedStatus.peers)) setFederatedPeerStatus(fedStatus.peers)

    // Build fleet list: API agents + marveen, minus system agents; plus
    // federated agents from the poller cache so a remote conversation can be
    // STARTED without prior history. The system-agent filter runs on the
    // unqualified segment too ('teodor/heartbeat' is just as much noise).
    const fleetNames = [mainAgentId(), ...agentsRaw.map(a => a.name || a)]
      .filter(n => !CHAT_SYSTEM_AGENTS.has(n))
      .filter((n, i, arr) => arr.indexOf(n) === i)
    for (const fa of federatedAgentEntries()) {
      if (!fleetNames.includes(fa.qualified) && !CHAT_SYSTEM_AGENTS.has(fa.qualified.split('/').pop())) {
        fleetNames.push(fa.qualified)
      }
    }

    // Populate avatar map from API data
    chatAgentHasAvatar.clear()
    chatAgentHasAvatar.set(mainAgentId(), true)
    for (const a of agentsRaw) {
      if (a.name) chatAgentHasAvatar.set(a.name, !!a.hasAvatar)
    }

    // Build index from /api/messages/threads (per-agent, no global-window bug)
    const threadIndex = new Map() // agentName -> {lastMessage, count}
    for (const t of threads) {
      if (t.agent) threadIndex.set(t.agent, { lastMsg: t.lastMessage, count: t.count || 0 })
    }
    // Also include thread agents not in fleet (e.g. the owner's own direct msgs)
    for (const t of threads) {
      if (t.agent && !fleetNames.includes(t.agent) && !CHAT_SYSTEM_AGENTS.has(t.agent)) {
        fleetNames.push(t.agent)
      }
    }

    // Sort: owner pinned first, then agents with messages by recency, rest alphabetical
    const owner = chatOwnerName()
    const sorted = [...fleetNames].sort((a, b) => {
      if (owner && a === owner) return -1
      if (owner && b === owner) return 1
      const aHas = threadIndex.has(a), bHas = threadIndex.has(b)
      if (aHas && !bHas) return -1
      if (!aHas && bHas) return 1
      if (aHas && bHas) {
        const aTime = threadIndex.get(a).lastMsg?.created_at || 0
        const bTime = threadIndex.get(b).lastMsg?.created_at || 0
        return bTime - aTime
      }
      return a.localeCompare(b)
    })

    sidebar.innerHTML = sorted.map(name => {
      const info = threadIndex.get(name)
      const lm = info?.lastMsg
      const when = lm?.created_at ? new Date(lm.created_at * 1000).toLocaleTimeString('hu-HU', {hour:'2-digit',minute:'2-digit'}) : ''
      const preview = lm ? (lm.content || '').replace(/\n/g,' ').slice(0, 60) : t('messages.empty')
      const isSelected = name === chatSelectedAgent ? ' selected' : ''
      const dimmed = info ? '' : ' style="opacity:0.5"'
      const unread = chatIsUnread(name, info)
      const displayName = owner && name === owner ? owner + ' (te)' : chatDisplayName(name)
      return `<div class="chat-agent-item${isSelected}${unread ? ' unread' : ''}" data-agent="${escapeHtml(name)}"${dimmed}>
        <div class="chat-agent-avatar">${chatAvatarHtml(name, 40)}</div>
        <div class="chat-agent-info">
          <div class="chat-agent-name">${escapeHtml(displayName)}${unread ? '<span class="chat-unread-dot"></span>' : ''}</div>
          <div class="chat-agent-preview ${unread ? 'unread-preview' : ''}">${escapeHtml(preview)}</div>
        </div>
        <div class="chat-agent-time">${when}</div>
      </div>`
    }).join('')

    sidebar.querySelectorAll('.chat-agent-item').forEach(el => {
      el.addEventListener('click', () => {
        sidebar.querySelectorAll('.chat-agent-item').forEach(x => x.classList.remove('selected'))
        el.classList.add('selected')
        chatSelectedAgent = el.dataset.agent
        loadChatThread(chatSelectedAgent)
      })
    })

    if (chatSelectedAgent && chatThreadState.agent !== chatSelectedAgent) {
      // Preselected target (e.g. the federated card's message button): open
      // its thread. Direct loadChatThread fallback covers targets with no
      // sidebar entry yet (composer + history render for any id).
      const el = sidebar.querySelector(`.chat-agent-item[data-agent="${CSS.escape(chatSelectedAgent)}"]`)
      if (el) el.click()
      else loadChatThread(chatSelectedAgent)
    } else if (!chatSelectedAgent) {
      const first = sidebar.querySelector('.chat-agent-item')
      if (first) first.click()
    }
  } catch (e) {
    sidebar.innerHTML = `<div class="chat-sidebar-empty">${t('messages.sidebar_error', { msg: escapeHtml(String(e.message||e)) })}</div>`
  }
}

// Pagination state for the open thread
const chatThreadState = { agent: null, minLoadedId: null, hasMore: true, loading: false }
const CHAT_PAGE_SIZE = 10
const CHAT_LOAD_MORE = 20

async function loadChatThread(agentName) {
  const panel = document.getElementById('chatThreadPanel')
  if (!panel) return

  chatThreadState.agent = agentName
  chatThreadState.minLoadedId = null
  chatThreadState.hasMore = true
  chatThreadState.loading = false

  const owner = chatOwnerName()
  const threadDisplayName = owner && agentName === owner ? owner + ' (te)' : chatDisplayName(agentName)

  panel.innerHTML = `
    <div class="chat-upper-pane" id="chatUpperPane" style="flex:1 1 55%;min-height:180px">
      <div class="chat-thread-header">
        ${chatAvatarHtml(agentName, 32)}
        <span class="chat-thread-title">${escapeHtml(threadDisplayName)}</span>
        <button class="btn" data-variant="secondary" data-size="compact" style="margin-left:auto" onclick="loadChatThread('${escapeHtml(agentName)}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
      <div class="chat-bubbles" id="chatBubbles"><div class="chat-loading-indicator" id="chatLoadingTop" style="display:none;text-align:center;padding:8px;font-size:11px;color:var(--text-muted)">${t('messages.loading')}</div></div>
      <div class="chat-compose">
        <div class="chat-compose-row">
          <textarea id="chatComposeText" class="chat-compose-input" rows="2" placeholder="${t('messages.placeholder', { agent: escapeHtml(chatDisplayName(agentName)) })}"></textarea>
          <button class="btn chat-send-btn" data-variant="primary" data-size="compact" id="chatSendBtn">${t('messages.send_btn')}</button>
        </div>
      </div>
    </div>
    <div class="trace-resize-handle" id="traceResizeHandle"></div>
    <div class="trace-waterfall-panel" id="traceWaterfallPanel" style="flex:0 0 45%;min-height:140px">
      <div class="trace-waterfall-header">
        <span class="trace-waterfall-title">Trace</span>
        <select class="trace-select" id="traceSelect"><option value="">-- ${t('trace.loading')} --</option></select>
        <span id="traceStatusBadge"></span>
      </div>
      <div class="trace-waterfall-body" id="traceWaterfallBody">
        <div class="trace-waterfall-empty">${t('trace.no_traces')}</div>
      </div>
    </div>
  `

  document.getElementById('chatSendBtn')?.addEventListener('click', () => sendChatMessage(agentName))
  document.getElementById('chatComposeText')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChatMessage(agentName) }
  })

  // Initial load
  await fetchChatPage(agentName, null, CHAT_PAGE_SIZE, 'replace')
  // Mark thread as read (localStorage last-seen)
  const _threadTenant = _msgTenantGetter?.()
  const _threadUrl = _threadTenant ? `/api/messages/threads?tenant=${encodeURIComponent(_threadTenant)}` : '/api/messages/threads'
  const threadData = (await fetch(_threadUrl).then(r => r.ok ? r.json() : []).catch(() => []))
    .find(t => t.agent === agentName)
  if (threadData?.lastMessage?.id) {
    chatMarkSeen(agentName, threadData.lastMessage.id)
    // Remove unread indicator from sidebar item
    document.querySelector(`.chat-agent-item[data-agent="${CSS.escape(agentName)}"]`)?.classList.remove('unread')
    const dot = document.querySelector(`.chat-agent-item[data-agent="${CSS.escape(agentName)}"] .chat-unread-dot`)
    if (dot) dot.remove()
    const preview = document.querySelector(`.chat-agent-item[data-agent="${CSS.escape(agentName)}"] .unread-preview`)
    if (preview) preview.classList.remove('unread-preview')
  }

  // Scroll-up pagination handler
  const bubbles = document.getElementById('chatBubbles')
  if (bubbles) {
    bubbles.addEventListener('scroll', () => {
      if (bubbles.scrollTop < 80 && chatThreadState.hasMore && !chatThreadState.loading
          && chatThreadState.agent === agentName) {
        fetchChatPage(agentName, chatThreadState.minLoadedId, CHAT_LOAD_MORE, 'prepend')
      }
    })
  }

  // Resize handle: drag to split chat / waterfall vertically
  initTraceResizeHandle()

  // Load trace waterfall for this agent
  loadTraceWaterfall(agentName)
}

// --- Trace Waterfall (card def5a189) ---
const AGENT_COLORS = ['#d97757','#00C2A8','#818cf8','#22c55e','#f59e0b','#ec4899','#06b6d4','#a855f7']
function agentColor(name) {
  return AGENT_COLORS[name.split('').reduce((a,c) => a + c.charCodeAt(0), 0) % AGENT_COLORS.length]
}

function initTraceResizeHandle() {
  const handle = document.getElementById('traceResizeHandle')
  const upper  = document.getElementById('chatUpperPane')
  const lower  = document.getElementById('traceWaterfallPanel')
  if (!handle || !upper || !lower) return
  let dragging = false, startY = 0, startUpper = 0
  handle.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startUpper = upper.offsetHeight
    handle.classList.add('dragging'); e.preventDefault()
  })
  window.addEventListener('mousemove', e => {
    if (!dragging) return
    const dy = e.clientY - startY
    const newH = Math.max(120, startUpper + dy)
    upper.style.flex = `0 0 ${newH}px`
  })
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; handle.classList.remove('dragging') }
  })
}

async function loadTraceWaterfall(agentName) {
  const sel = document.getElementById('traceSelect')
  const body = document.getElementById('traceWaterfallBody')
  if (!sel || !body) return
  try {
    const res = await fetch('/api/traces?limit=100')
    if (!res.ok) throw new Error(res.status)
    const all = await res.json()
    // Show traces that involve this agent (as root or any span)
    const relevant = all.filter(tr => tr.root_agent === agentName)
    sel.innerHTML = relevant.length === 0
      ? `<option value="">${t('trace.no_traces')}</option>`
      : relevant.map(tr => {
          const dt = tr.start_ms ? new Date(tr.start_ms).toLocaleString('hu-HU', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
          const dur = tr.end_ms && tr.start_ms ? `${((tr.end_ms - tr.start_ms)/1000).toFixed(1)}s` : '...'
          return `<option value="${escapeHtml(tr.trace_id)}">[${dt}] ${escapeHtml(tr.root_operation)} ${dur} (${tr.span_count} span)</option>`
        }).join('')
    sel.addEventListener('change', () => {
      if (sel.value) renderTraceWaterfall(sel.value)
      else body.innerHTML = `<div class="trace-waterfall-empty">${t('trace.no_traces')}</div>`
    })
    if (relevant.length > 0) renderTraceWaterfall(relevant[0].trace_id)
  } catch {
    body.innerHTML = `<div class="trace-waterfall-empty">${t('trace.load_error')}</div>`
  }
}

async function renderTraceWaterfall(traceId) {
  const body = document.getElementById('traceWaterfallBody')
  const badge = document.getElementById('traceStatusBadge')
  if (!body) return

  // Re-render when the resize handle moves the panel boundary (debounced 60ms)
  if (body._traceObsId !== traceId) {
    if (body._traceResizeObs) body._traceResizeObs.disconnect()
    let _rTimer = null
    const ro = new ResizeObserver(() => {
      clearTimeout(_rTimer)
      _rTimer = setTimeout(() => renderTraceWaterfall(traceId), 60)
    })
    ro.observe(body)
    body._traceResizeObs = ro
    body._traceObsId = traceId
  }

  try {
    const res = await fetch(`/api/traces/${encodeURIComponent(traceId)}`)
    if (!res.ok) throw new Error(res.status)
    const { spans } = await res.json()
    if (!spans || !spans.length) {
      body.innerHTML = `<div class="trace-waterfall-empty">${t('trace.no_spans')}</div>`
      return
    }
    // Compute time range
    const minMs = Math.min(...spans.map(s => s.start_ms))
    const maxRaw = Math.max(...spans.map(s => s.end_ms || s.start_ms + 1))
    const totalMs = Math.max(maxRaw - minMs, 1)
    const now = Date.now()

    // Layout: measure actual container so bars fill the full width and height
    const svgW = body.clientWidth || 600
    const LABEL_W = 110, AXIS_H = 18, PAD_R = 8
    const ROW_H = Math.max(24, Math.floor((body.clientHeight - AXIS_H) / spans.length))
    const barArea = svgW - LABEL_W - PAD_R
    const svgH = spans.length * ROW_H + AXIS_H

    // Badge
    const hasError = spans.some(s => s.status === 'error')
    const hasRunning = spans.some(s => s.status === 'running')
    if (badge) {
      const cls = hasError ? 'trace-status-error' : hasRunning ? 'trace-status-running' : 'trace-status-ok'
      const lbl = hasError ? t('trace.status.error') : hasRunning ? t('trace.status.running') : t('trace.status.ok')
      badge.innerHTML = `<span class="trace-status-badge ${cls}">${lbl}</span>`
    }

    // Find bottleneck span (longest duration)
    const durations = spans.map(s => (s.end_ms || now) - s.start_ms)
    const maxDur = Math.max(...durations)

    let rows = ''
    spans.forEach((s, i) => {
      const y = i * ROW_H + AXIS_H
      const startOff = s.start_ms - minMs
      const dur = (s.end_ms || now) - s.start_ms
      const x = LABEL_W + (startOff / totalMs) * barArea
      const w = Math.max(3, (dur / totalMs) * barArea)
      const color = agentColor(s.agent_id)
      const isBottleneck = dur === maxDur && spans.length > 1
      const isRunning = s.status === 'running'
      const isError = s.status === 'error'
      const label = s.agent_id.length > 13 ? s.agent_id.slice(0,12) + '…' : s.agent_id
      const durLabel = dur >= 1000 ? `${(dur/1000).toFixed(1)}s` : `${dur}ms`
      rows += `<rect class="trace-wf-row-bg" x="0" y="${y}" width="${svgW}" height="${ROW_H}"/>`
      rows += `<text class="trace-wf-label" x="6" y="${y + ROW_H*0.65}">${escapeHtml(label)}</text>`
      rows += `<rect class="trace-wf-bar${isRunning?' trace-wf-bar-running':''}${isError?' trace-wf-bar-error':''}"
        x="${x.toFixed(1)}" y="${(y+4).toFixed(1)}" width="${w.toFixed(1)}" height="${ROW_H-8}"
        rx="3" fill="${isError ? 'var(--danger)' : color}" opacity="${isError?0.7:0.85}"/>`
      if (isBottleneck) {
        rows += `<line class="trace-bottleneck" x1="${(x+w).toFixed(1)}" y1="${AXIS_H}" x2="${(x+w).toFixed(1)}" y2="${svgH}"/>`
      }
      rows += `<text class="trace-wf-axis-label" x="${Math.min(x+w+3,svgW-30).toFixed(1)}" y="${(y+ROW_H*0.65).toFixed(1)}" fill="${color}">${durLabel}</text>`
    })

    // Axis ticks (4 ticks)
    let axis = ''
    for (let i = 0; i <= 4; i++) {
      const xPos = LABEL_W + (i / 4) * barArea
      const msVal = (i / 4) * totalMs
      const lbl = msVal >= 1000 ? `${(msVal/1000).toFixed(1)}s` : `${Math.round(msVal)}ms`
      axis += `<line class="trace-wf-axis-line" x1="${xPos.toFixed(1)}" y1="${AXIS_H}" x2="${xPos.toFixed(1)}" y2="${svgH}"/>`
      axis += `<text class="trace-wf-axis-label" x="${xPos.toFixed(1)}" y="${AXIS_H-4}" text-anchor="middle">${lbl}</text>`
    }

    body.innerHTML = `<svg class="trace-wf-svg" viewBox="0 0 ${svgW} ${svgH}" style="height:${svgH}px">${axis}${rows}</svg>`
  } catch {
    body.innerHTML = `<div class="trace-waterfall-empty">${t('trace.load_error')}</div>`
  }
}

function buildBubbleHtml(m) {
  const isOutgoing = m.from_agent === mainAgentId()
  // senderName stays the routing id (avatar lookup keys off it); senderLabel is
  // what the user sees, so the main agent reads as its BOT_NAME, not "marveen".
  const senderName = isOutgoing ? mainAgentId() : m.from_agent
  const senderLabel = chatDisplayName(senderName)
  const when = m.created_at ? new Date(m.created_at * 1000).toLocaleString('hu-HU', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
  const statusMetaRaw = MSG_STATUS_META[m.status] || { label: m.status || '', variant: 'neutral' }
  const statusMeta = { ...statusMetaRaw, label: typeof statusMetaRaw.label === 'function' ? statusMetaRaw.label() : statusMetaRaw.label }
  return `<div class="chat-bubble-row ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${m.id}">
    ${!isOutgoing ? `<div class="chat-bubble-avatar">${chatAvatarHtml(senderName, 28)}</div>` : ''}
    <div class="chat-bubble ${isOutgoing ? 'bubble-out' : 'bubble-in'}">
      <div class="bubble-meta">
        ${!isOutgoing ? `<span class="bubble-sender">${escapeHtml(senderLabel)}</span>` : ''}
        <span class="bubble-id-chip">#${m.id}</span>
        <span class="badge" data-variant="${statusMeta.variant}" style="font-size:10px">${escapeHtml(statusMeta.label)}</span>
        ${m.status === 'pending' && m.to_agent === mainAgentId() ? `<span style="font-size:10px;color:var(--text-muted)">${escapeHtml(t('messages.pending_main_hint'))}</span>` : ''}
        ${m.origin_note ? `<span class="badge" style="font-size:10px" title="Self-declared by the sender, not verified (card 06f062e4)">origin: ${escapeHtml(m.origin_note)}</span>` : ''}
      </div>
      <div class="bubble-text">${escapeHtml(m.content || '')}</div>
      <div class="bubble-time">${when}</div>
    </div>
    ${isOutgoing ? `<div class="chat-bubble-avatar">${chatAvatarHtml(mainAgentId(), 28)}</div>` : ''}
  </div>`
}

async function fetchChatPage(agentName, beforeId, limit, mode) {
  if (chatThreadState.loading) return
  chatThreadState.loading = true
  const container = document.getElementById('chatBubbles')
  const loadingIndicator = document.getElementById('chatLoadingTop')
  if (!container) { chatThreadState.loading = false; return }
  if (loadingIndicator && mode === 'prepend') loadingIndicator.style.display = 'block'
  try {
    let url = `/api/messages?agent=${encodeURIComponent(agentName)}&limit=${limit}`
    if (beforeId) url += `&before=${beforeId}`
    const _fetchTenant = _msgTenantGetter?.()
    if (_fetchTenant) url += `&tenant=${encodeURIComponent(_fetchTenant)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const msgs = await res.json()
    const sorted = Array.isArray(msgs) ? [...msgs].sort((a, b) => (a.created_at || 0) - (b.created_at || 0)) : []

    if (mode === 'replace') {
      if (sorted.length === 0) {
        container.innerHTML = '<p class="activity-empty">' + t('messages.empty_thread') + '</p>'
      } else {
        container.innerHTML = '<div class="chat-loading-indicator" id="chatLoadingTop" style="display:none;text-align:center;padding:8px;font-size:11px;color:var(--text-muted)">' + t('messages.loading') + '</div>'
        container.insertAdjacentHTML('beforeend', sorted.map(buildBubbleHtml).join(''))
        container.scrollTop = container.scrollHeight
      }
      if (sorted.length < limit) chatThreadState.hasMore = false
    } else { // prepend
      if (loadingIndicator) loadingIndicator.style.display = 'none'
      if (!sorted.length) { chatThreadState.hasMore = false; chatThreadState.loading = false; return }
      if (sorted.length < limit) chatThreadState.hasMore = false
      const prevHeight = container.scrollHeight
      const indicator = document.getElementById('chatLoadingTop')
      const html = sorted.map(buildBubbleHtml).join('')
      if (indicator) {
        indicator.insertAdjacentHTML('afterend', html)
      } else {
        container.insertAdjacentHTML('afterbegin', html)
      }
      // Restore scroll position so view doesn't jump
      container.scrollTop = container.scrollHeight - prevHeight
    }

    if (sorted.length > 0) {
      const minId = Math.min(...sorted.map(m => m.id))
      if (chatThreadState.minLoadedId === null || minId < chatThreadState.minLoadedId) {
        chatThreadState.minLoadedId = minId
      }
    }
  } catch (e) {
    if (loadingIndicator) loadingIndicator.style.display = 'none'
    if (mode === 'replace') {
      container.innerHTML = `<p class="activity-empty">Hiba: ${escapeHtml(String(e.message||e))}</p>`
    }
  } finally {
    chatThreadState.loading = false
  }
}

function renderChatBubbles(msgs, agentName) {
  const container = document.getElementById('chatBubbles')
  if (!container) return
  if (!msgs || msgs.length === 0) {
    container.innerHTML = '<p class="activity-empty">' + t('messages.empty_thread') + '</p>'
    return
  }
  const sorted = [...msgs].sort((a,b) => (a.created_at||0) - (b.created_at||0))
  container.innerHTML = sorted.map(buildBubbleHtml).join('')
  container.scrollTop = container.scrollHeight
}

async function sendChatMessage(toAgent) {
  const textarea = document.getElementById('chatComposeText')
  const btn = document.getElementById('chatSendBtn')
  const content = textarea?.value?.trim()
  if (!content) { textarea?.focus(); return }
  if (btn) btn.disabled = true
  try {
    const from = await resolveOwnerName()
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toAgent, content }),
    })
    // apiData carries the full response object for getErrorMessage(); do NOT use err.message
    if (!res.ok) { const err = await res.json(); throw Object.assign(new Error('api call failed'), { apiData: err }) }
    if (textarea) textarea.value = ''
    showToast(t('messages.sent'))
    await loadChatThread(toAgent)
    await loadChatAgentList()
  } catch (e) {
    showToast(getErrorMessage(e.apiData, t('common.error')))
  } finally {
    if (btn) btn.disabled = false
  }
}

document.getElementById('chatRefreshBtn')?.addEventListener('click', () => {
  loadChatAgentList()
  if (chatSelectedAgent) loadChatThread(chatSelectedAgent)
})

export function renderTeamEditor(agent, allAgents) {
  const team = agent.team || { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] }
  document.getElementById('editTeamRole').value = team.role || 'member'
  const reportsSel = document.getElementById('editTeamReportsTo')
  reportsSel.innerHTML = ''
  const emptyOpt = document.createElement('option')
  emptyOpt.value = ''
  emptyOpt.textContent = t('team.reports_to_empty')
  reportsSel.appendChild(emptyOpt)
  for (const other of allAgents) {
    if (other.name === agent.name) continue
    const opt = document.createElement('option')
    opt.value = other.name
    opt.textContent = other.displayName || other.name
    if (team.reportsTo === other.name) opt.selected = true
    reportsSel.appendChild(opt)
  }
  const buildCheckboxList = (boxId, selected) => {
    const box = document.getElementById(boxId)
    box.innerHTML = ''
    for (const other of allAgents) {
      if (other.name === agent.name) continue
      const label = document.createElement('label')
      label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = other.name
      cb.checked = !!(selected && selected.includes(other.name))
      label.appendChild(cb)
      const span = document.createElement('span')
      span.textContent = other.displayName || other.name
      label.appendChild(span)
      box.appendChild(label)
    }
  }
  buildCheckboxList('editTeamDelegatesList', team.delegatesTo)
  buildCheckboxList('editTeamTrustFromList', team.trustFrom)
  document.getElementById('editTeamAutoDelegation').checked = !!team.autoDelegation
  // Only leaders make sense to delegate from -- hide the lists for members.
  const updateLeaderVisibility = () => {
    const isLeader = document.getElementById('editTeamRole').value === 'leader'
    document.getElementById('editTeamDelegatesGroup').style.display = isLeader ? '' : 'none'
    document.getElementById('editTeamAutoGroup').style.display = isLeader ? '' : 'none'
  }
  document.getElementById('editTeamRole').onchange = updateLeaderVisibility
  updateLeaderVisibility()
}

document.getElementById('saveTeamBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const btn = document.getElementById('saveTeamBtn')
  const role = document.getElementById('editTeamRole').value
  const reportsToRaw = document.getElementById('editTeamReportsTo').value
  const delegates = Array.from(document.querySelectorAll('#editTeamDelegatesList input[type=checkbox]:checked')).map(cb => cb.value)
  const trustFrom = Array.from(document.querySelectorAll('#editTeamTrustFromList input[type=checkbox]:checked')).map(cb => cb.value)
  const autoDelegation = document.getElementById('editTeamAutoDelegation').checked
  const originalText = btn.textContent
  btn.disabled = true
  btn.textContent = t('team.save_saving')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/team`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role,
        reportsTo: reportsToRaw || null,
        delegatesTo: role === 'leader' ? delegates : [],
        trustFrom,
        autoDelegation: role === 'leader' ? autoDelegation : false,
      }),
    })
    if (!res.ok) throw new Error()
    // The server sanitizes the team config (strips self-references and
    // unknown agent ids) and reports what it dropped in `warnings`. Surface
    // that to the operator so a mistyped name isn't silently lost.
    let warningMsg = ''
    try {
      const body = await res.json()
      const w = body && body.warnings
      if (w) {
        const parts = []
        if (Array.isArray(w.droppedSelf) && w.droppedSelf.length) {
          parts.push(`${t('team.dropped_self')}: ${w.droppedSelf.join(', ')}`)
        }
        if (Array.isArray(w.droppedUnknown) && w.droppedUnknown.length) {
          parts.push(`${t('team.dropped_unknown')}: ${w.droppedUnknown.join(', ')}`)
        }
        if (parts.length) warningMsg = parts.join(' · ')
      }
    } catch { /* body already consumed or not JSON -- OK, no warnings to show */ }
    showToast(warningMsg ? t('team.save_warning', { detail: warningMsg }) : t('team.save_ok'))
    btn.textContent = t('team.save_done')
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false }, 1800)
    loadAgents()
  } catch {
    showToast(t('team.save_error'))
    btn.textContent = originalText
    btn.disabled = false
  }
})

