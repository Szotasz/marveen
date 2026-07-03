import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'
import { showToast } from '/js/core/ui.js'
import { mainAgentId } from '/js/core/api.js'
import { loadAgents } from '/js/pages/agents.js'

// === Team: inter-agent message log + compose ===
// View the /api/messages queue and let the operator send a message to an agent
// from the dashboard. Targets come from /api/schedules/agents (the same allowed
// agent list the scheduler uses) -- never a free-text target. The sender is the
// owner (resolved by type from /api/kanban/assignees), so the receiving agent
// sees a message from Gábor, not a spoofable string. /api/messages sits behind
// the dashboard bearer token + Cloudflare Access.
const MSG_STATUS_META = {
  pending: { label: () => t('messages.status.pending'), cls: 'badge-warm' },
  delivered: { label: () => t('messages.status.delivered'), cls: 'badge-active' },
  done: { label: () => t('messages.status.done'), cls: 'badge-active' },
  failed: { label: () => t('messages.status.failed'), cls: 'badge-paused' },
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
    ? `/api/marveen/avatar?t=${Date.now()}`
    : `/api/agents/${encodeURIComponent(lower)}/avatar?t=${Date.now()}`
  return `<img class="chat-avatar" src="${src}" width="${size}" height="${size}" alt="${escapeHtml(agentName)}" data-agent-name="${escapeHtml(agentName)}" onerror="chatImgError(this)">`
}

async function loadMessagesPage() {
  await loadChatAgentList()
}

const CHAT_SYSTEM_AGENTS = new Set(['heartbeat','telegram-coordinator','channel-coordinator'])
// The owner's own message thread is pinned to the top and labelled "<name> (te)".
// The owner display name comes from the backend (OWNER_NAME via /api/marveen ->
// window._marveen.ownerName), not a hardcoded literal, so a renamed install
// recognizes its real owner. Empty until _marveen resolves (no false match).
function chatOwnerName() { return window._marveen?.ownerName || '' }

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

async function loadChatAgentList() {
  const sidebar = document.getElementById('chatAgentList')
  if (!sidebar) return
  try {
    // Load fleet agents + threads in parallel
    const [agentsRes, threadsRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/messages/threads'),
    ])
    const agentsRaw = agentsRes.ok ? await agentsRes.json() : []
    const threads = threadsRes.ok ? await threadsRes.json() : []

    // Build fleet list: API agents + marveen, minus system agents
    const fleetNames = [mainAgentId(), ...agentsRaw.map(a => a.name || a)]
      .filter(n => !CHAT_SYSTEM_AGENTS.has(n))
      .filter((n, i, arr) => arr.indexOf(n) === i)

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
      const displayName = owner && name === owner ? owner + ' (te)' : name
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

    if (!chatSelectedAgent) {
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
  const threadDisplayName = owner && agentName === owner ? owner + ' (te)' : agentName

  panel.innerHTML = `
    <div class="chat-thread-header">
      ${chatAvatarHtml(agentName, 32)}
      <span class="chat-thread-title">${escapeHtml(threadDisplayName)}</span>
      <button class="btn-secondary btn-compact" style="margin-left:auto" onclick="loadChatThread('${escapeHtml(agentName)}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
    </div>
    <div class="chat-bubbles" id="chatBubbles"><div class="chat-loading-indicator" id="chatLoadingTop" style="display:none;text-align:center;padding:8px;font-size:11px;color:var(--text-muted)">${t('messages.loading')}</div></div>
    <div class="chat-compose">
      <div class="chat-compose-row">
        <textarea id="chatComposeText" class="chat-compose-input" rows="2" placeholder="${t('messages.placeholder', { agent: escapeHtml(agentName) })}"></textarea>
        <button class="btn-primary btn-compact chat-send-btn" id="chatSendBtn">${t('messages.send_btn')}</button>
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
  const threadData = (await fetch('/api/messages/threads').then(r => r.ok ? r.json() : []).catch(() => []))
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
}

function buildBubbleHtml(m) {
  const isOutgoing = m.from_agent === mainAgentId()
  const senderName = isOutgoing ? mainAgentId() : m.from_agent
  const when = m.created_at ? new Date(m.created_at * 1000).toLocaleString('hu-HU', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
  const statusMetaRaw = MSG_STATUS_META[m.status] || { label: m.status || '', cls: 'badge' }
  const statusMeta = { ...statusMetaRaw, label: typeof statusMetaRaw.label === 'function' ? statusMetaRaw.label() : statusMetaRaw.label }
  return `<div class="chat-bubble-row ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${m.id}">
    ${!isOutgoing ? `<div class="chat-bubble-avatar">${chatAvatarHtml(senderName, 28)}</div>` : ''}
    <div class="chat-bubble ${isOutgoing ? 'bubble-out' : 'bubble-in'}">
      <div class="bubble-meta">
        ${!isOutgoing ? `<span class="bubble-sender">${escapeHtml(senderName)}</span>` : ''}
        <span class="bubble-id-chip">#${m.id}</span>
        <span class="badge ${statusMeta.cls}" style="font-size:10px">${escapeHtml(statusMeta.label)}</span>
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
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Hiba') }
    if (textarea) textarea.value = ''
    showToast(t('messages.sent'))
    await loadChatThread(toAgent)
    await loadChatAgentList()
  } catch (e) {
    showToast(t('messages.error_send', { msg: e.message || e }))
  } finally {
    if (btn) btn.disabled = false
  }
}

document.getElementById('chatRefreshBtn')?.addEventListener('click', () => {
  loadChatAgentList()
  if (chatSelectedAgent) loadChatThread(chatSelectedAgent)
})

function renderTeamEditor(agent, allAgents) {
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


export { loadMessagesPage, loadChatAgentList, loadChatThread }
