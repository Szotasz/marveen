// Marveen Chat — minimal per-user chat client over /chat-api/*.
// Same-origin cookie auth: no tokens in JS, fetch sends the HttpOnly session
// cookie automatically. Polling (not SSE) keeps the first release simple; the
// poll cadence backs off while the tab is hidden.
'use strict'

const $ = (id) => document.getElementById(id)

const LOGIN_ERRORS = {
  state_mismatch: 'A bejelentkezés megszakadt (lejárt vagy érvénytelen állapot). Próbáld újra.',
  cancelled: 'A bejelentkezést megszakítottad.',
  invalid_token: 'A Google-válasz érvénytelen volt. Próbáld újra.',
  forbidden_domain: 'Csak céges Google-fiókkal lehet belépni.',
  exchange_failed: 'A Google-bejelentkezés nem sikerült. Próbáld újra.',
  no_agent: 'Ehhez a fiókhoz nincs Marveen hozzárendelve. Szólj az adminnak.',
}

const POLL_MS_ACTIVE = 3000
const POLL_MS_HIDDEN = 15000

const state = {
  me: null,
  threads: [],
  currentId: null,
  pollTimer: null,
  sending: false,
  lastCount: -1,
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  })
  let data = null
  try { data = await res.json() } catch { /* empty body */ }
  return { status: res.status, data }
}

// --- Auth ---

async function init() {
  const { status, data } = await api('/chat-api/auth/me')
  if (status !== 200) {
    showLogin()
    return
  }
  state.me = data
  $('me-email').textContent = data.email
  $('login').classList.add('hidden')
  $('app').classList.remove('hidden')
  await refreshThreads()
  const open = state.threads.find(t => t.status === 'open') || state.threads[0]
  if (open) selectThread(open.id)
}

function showLogin() {
  $('app').classList.add('hidden')
  $('login').classList.remove('hidden')
  const code = new URLSearchParams(location.search).get('login_error')
  if (code) {
    const el = $('login-error')
    el.textContent = LOGIN_ERRORS[code] || 'A bejelentkezés nem sikerült.'
    el.classList.remove('hidden')
    history.replaceState(null, '', location.pathname)
  }
}

// --- Threads ---

async function refreshThreads() {
  const { status, data } = await api('/chat-api/threads')
  if (status === 401) { showLogin(); return }
  if (status !== 200) return
  state.threads = data.threads
  renderThreadList(data)
}

function renderThreadList(meta) {
  const list = $('thread-list')
  list.innerHTML = ''
  for (const t of state.threads) {
    const btn = document.createElement('button')
    btn.className = 'thread-item' + (t.id === state.currentId ? ' active' : '')
    const title = document.createElement('span')
    title.className = 't-title'
    title.textContent = t.title || 'Névtelen szál'
    const stateTag = document.createElement('span')
    stateTag.className = 't-state'
    stateTag.textContent = t.status === 'open' ? (t.running ? '●' : '…') : '⏸'
    stateTag.title = t.status === 'open' ? (t.running ? 'fut' : 'indul') : 'felfüggesztve'
    btn.append(title, stateTag)
    btn.onclick = () => { selectThread(t.id); closeSidebar() }
    list.appendChild(btn)
  }
  if (meta && meta.open_count >= meta.max_open) {
    setStatus(`Elérted a nyitott szálak felső határát (${meta.max_open}). Zárj le egyet újabb nyitásához.`)
  }
}

function currentThread() {
  return state.threads.find(t => t.id === state.currentId) || null
}

async function selectThread(id) {
  state.currentId = id
  state.lastCount = -1
  const t = currentThread()
  $('thread-title').textContent = (t && t.title) || 'Névtelen szál'
  $('rename-thread').classList.remove('hidden')
  $('close-thread').classList.remove('hidden')
  $('input').disabled = false
  $('send').disabled = false
  $('empty-state')?.remove()
  setStatus(null)
  renderThreadList()
  await pollMessages(true)
  schedulePoll()
}

async function newThread() {
  const { status, data } = await api('/chat-api/threads', { method: 'POST', body: '{}' })
  if (status === 401) { showLogin(); return }
  if (status === 409) { setStatus(data.error); return }
  if (status !== 201) { setStatus((data && data.error) || 'A szál létrehozása nem sikerült.'); return }
  await refreshThreads()
  selectThread(data.thread.id)
}

async function renameCurrent() {
  const t = currentThread()
  if (!t) return
  const title = prompt('Szál neve:', t.title || '')
  if (title === null || !title.trim()) return
  await api(`/chat-api/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) })
  await refreshThreads()
  $('thread-title').textContent = currentThread()?.title || 'Névtelen szál'
}

async function closeCurrent() {
  const t = currentThread()
  if (!t) return
  if (!confirm('Lezárod ezt a szálat? (Később újranyitható.)')) return
  await api(`/chat-api/threads/${t.id}`, { method: 'DELETE' })
  state.currentId = null
  $('thread-title').textContent = 'Marveen'
  $('messages').innerHTML = '<div id="empty-state" class="empty-state">Válassz egy szálat, vagy indíts újat.</div>'
  $('rename-thread').classList.add('hidden')
  $('close-thread').classList.add('hidden')
  $('input').disabled = true
  $('send').disabled = true
  await refreshThreads()
}

// --- Messages ---

async function pollMessages(force = false) {
  const t = currentThread()
  if (!t) return
  const { status, data } = await api(`/chat-api/threads/${t.id}/messages`)
  if (status === 401) { showLogin(); return }
  if (status !== 200) return
  if (force || data.count !== state.lastCount) {
    state.lastCount = data.count
    renderMessages(data.entries)
  }
  // Surface running-state changes (e.g. idle auto-suspend) in the list.
  if (data.thread && (t.running !== data.thread.running || t.status !== data.thread.status)) {
    await refreshThreads()
  }
}

function renderMessages(entries) {
  const box = $('messages')
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  box.innerHTML = ''
  for (const e of entries) {
    if (e.kind === 'action') {
      const row = document.createElement('div')
      row.className = 'action-row'
      row.textContent = '⚙ ' + e.text
      box.appendChild(row)
    } else {
      const b = document.createElement('div')
      b.className = 'bubble ' + (e.kind === 'user' ? 'user' : 'assistant')
      b.textContent = e.text
      box.appendChild(b)
    }
  }
  if (nearBottom || state.lastCount <= 2) box.scrollTop = box.scrollHeight
}

async function send() {
  const t = currentThread()
  const input = $('input')
  const text = input.value.trim()
  if (!t || !text || state.sending) return
  state.sending = true
  $('send').disabled = true
  try {
    const { status, data } = await api(`/chat-api/threads/${t.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
    if (status === 200) {
      input.value = ''
      autoGrow(input)
      setStatus(null)
      await refreshThreads()
      await pollMessages(true)
    } else if (status === 202) {
      setStatus('A szál indul… az üzenet pár másodperc múlva küldhető.')
      setTimeout(async () => { state.sending = false; $('send').disabled = false; await send() }, data.retry_after_ms || 5000)
      return // keep the text in the input for the retry
    } else if (status === 409) {
      setStatus(data.error || 'A szál még dolgozik — próbáld kicsit később.')
    } else if (status === 401) {
      showLogin()
    } else {
      setStatus((data && data.error) || 'A küldés nem sikerült.')
    }
  } finally {
    state.sending = false
    $('send').disabled = !currentThread()
  }
}

// --- Plumbing ---

function setStatus(msg) {
  const bar = $('status-bar')
  if (!msg) { bar.classList.add('hidden'); return }
  bar.textContent = msg
  bar.classList.remove('hidden')
}

function schedulePoll() {
  if (state.pollTimer) clearInterval(state.pollTimer)
  const cadence = document.hidden ? POLL_MS_HIDDEN : POLL_MS_ACTIVE
  state.pollTimer = setInterval(pollMessages, cadence)
}

function autoGrow(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

function openSidebar() { $('sidebar').classList.add('open'); $('backdrop').classList.remove('hidden') }
function closeSidebar() { $('sidebar').classList.remove('open'); $('backdrop').classList.add('hidden') }

$('new-thread').onclick = newThread
$('rename-thread').onclick = renameCurrent
$('close-thread').onclick = closeCurrent
$('logout').onclick = async () => { await api('/chat-api/auth/logout', { method: 'POST' }); location.reload() }
$('send').onclick = send
$('sidebar-open').onclick = openSidebar
$('sidebar-close').onclick = closeSidebar
$('backdrop').onclick = closeSidebar
$('input').addEventListener('input', (e) => autoGrow(e.target))
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
document.addEventListener('visibilitychange', schedulePoll)

init()
