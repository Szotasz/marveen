// Marveen Chat — minimal per-user chat client over /chat-api/*.
// Same-origin cookie auth: no tokens in JS, fetch sends the HttpOnly session
// cookie automatically. Polling (not SSE) keeps the first release simple; the
// poll cadence backs off while the tab is hidden.
'use strict'

const $ = (id) => document.getElementById(id)

// Inline SVG icons (feather/lucide-style strokes, theme-aware via currentColor)
const SVG_OPEN = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
const ICONS = {
  pencil: SVG_OPEN + '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  trash: SVG_OPEN + '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  moon: SVG_OPEN + '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  sun: SVG_OPEN + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/></svg>',
}

// --- Theme (dark/light, persisted; default follows the OS) ---

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  const btn = $('theme-toggle')
  if (btn) {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    btn.innerHTML = dark ? ICONS.sun : ICONS.moon
    btn.title = dark ? 'Világos téma' : 'Sötét téma'
  }
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const next = current === 'dark' ? 'light' : 'dark'
  localStorage.setItem('marveen_chat_theme', next)
  applyTheme(next)
}

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
  closeThreadMenu()
  const list = $('thread-list')
  list.innerHTML = ''
  for (const t of state.threads) {
    const item = document.createElement('div')
    item.className = 'thread-item' + (t.id === state.currentId ? ' active' : '')
    item.dataset.threadId = t.id
    const title = document.createElement('span')
    title.className = 't-title'
    title.textContent = t.title || 'Névtelen szál'
    const stateTag = document.createElement('span')
    stateTag.className = 't-state'
    stateTag.textContent = t.status === 'open' ? (t.running ? '●' : '…') : '⏸'
    stateTag.title = t.status === 'open' ? (t.running ? 'fut' : 'indul') : 'felfüggesztve'
    const menuBtn = document.createElement('button')
    menuBtn.className = 't-menu'
    menuBtn.textContent = '⋯'
    menuBtn.title = 'Műveletek'
    menuBtn.onclick = (e) => { e.stopPropagation(); openThreadMenu(t, menuBtn) }
    item.append(title, stateTag, menuBtn)
    item.onclick = () => { selectThread(t.id); closeSidebar() }
    list.appendChild(item)
  }
  if (meta && meta.open_count >= meta.max_open) {
    setStatus(`Elérted a nyitott szálak felső határát (${meta.max_open}). Zárj le egyet újabb nyitásához.`)
  }
}

// --- ChatGPT-style per-thread menu (hover ⋯ -> rename/close) ---

function closeThreadMenu() {
  document.querySelector('.thread-menu')?.remove()
}

function openThreadMenu(t, anchor) {
  closeThreadMenu()
  const menu = document.createElement('div')
  menu.className = 'thread-menu'
  const rename = document.createElement('button')
  rename.innerHTML = ICONS.pencil + '<span>Átnevezés</span>'
  rename.onclick = (e) => { e.stopPropagation(); closeThreadMenu(); startInlineRename(t) }
  const close = document.createElement('button')
  close.className = 'danger'
  close.innerHTML = ICONS.trash + '<span>Lezárás</span>'
  close.onclick = async (e) => {
    e.stopPropagation(); closeThreadMenu()
    if (!confirm('Lezárod ezt a szálat? (Később újranyitható.)')) return
    await api(`/chat-api/threads/${t.id}`, { method: 'DELETE' })
    if (t.id === state.currentId) clearCurrentThreadView()
    await refreshThreads()
  }
  menu.append(rename, close)
  const r = anchor.getBoundingClientRect()
  menu.style.top = `${r.bottom + 4}px`
  menu.style.left = `${Math.max(8, r.right - 150)}px`
  document.body.appendChild(menu)
  setTimeout(() => document.addEventListener('click', closeThreadMenu, { once: true }), 0)
}

// Inline rename: the title swaps to an input in place. Enter/blur saves,
// Esc cancels — the ChatGPT pattern.
function startInlineRename(t) {
  const item = document.querySelector(`.thread-item[data-thread-id="${t.id}"]`)
  const title = item?.querySelector('.t-title')
  if (!item || !title) return
  const input = document.createElement('input')
  input.className = 't-edit'
  input.value = t.title || ''
  input.maxLength = 120
  input.onclick = (e) => e.stopPropagation()
  let finished = false
  const finish = async (save) => {
    if (finished) return
    finished = true
    const value = input.value.trim()
    if (save && value && value !== t.title) {
      await api(`/chat-api/threads/${t.id}`, { method: 'PATCH', body: JSON.stringify({ title: value }) })
    }
    await refreshThreads()
    if (t.id === state.currentId) $('thread-title').textContent = currentThread()?.title || 'Névtelen szál'
  }
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') finish(false)
  }
  input.onblur = () => finish(true)
  title.replaceWith(input)
  input.focus()
  input.select()
}

function clearCurrentThreadView() {
  state.currentId = null
  $('thread-title').textContent = 'Marveen'
  $('messages').innerHTML = '<div id="empty-state" class="empty-state">Válassz egy szálat, vagy indíts újat.</div>'
  $('rename-thread').classList.add('hidden')
  $('close-thread').classList.add('hidden')
  $('input').disabled = true
  $('send').disabled = true
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

function renameCurrent() {
  const t = currentThread()
  if (!t) return
  startInlineRename(t)
}

async function closeCurrent() {
  const t = currentThread()
  if (!t) return
  if (!confirm('Lezárod ezt a szálat? (Később újranyitható.)')) return
  await api(`/chat-api/threads/${t.id}`, { method: 'DELETE' })
  clearCurrentThreadView()
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
      programmaticResize = true
      const baseH = parseInt(localStorage.getItem('marveen_chat_composer_h') || '', 10)
      input.style.height = Number.isFinite(baseH) ? baseH + 'px' : ''
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
  // Grow-only: expand while typing past the visible box, but never shrink a
  // height the user set by dragging the native resize handle. Send resets
  // to the user's preferred base height.
  if (el.scrollHeight > el.clientHeight) {
    programmaticResize = true
    el.style.height = Math.min(el.scrollHeight, Math.floor(innerHeight / 2)) + 'px'
  }
}

// --- Layout: collapsible + resizable sidebar, resizable composer ---

let programmaticResize = false

function isMobile() { return matchMedia('(max-width: 720px)').matches }

function initLayout() {
  const sidebarW = parseInt(localStorage.getItem('marveen_chat_sidebar_w') || '', 10)
  if (Number.isFinite(sidebarW)) $('sidebar').style.width = Math.min(Math.max(sidebarW, 200), 480) + 'px'
  if (localStorage.getItem('marveen_chat_sidebar_collapsed') === '1' && !isMobile()) {
    document.querySelector('.app').classList.add('sidebar-collapsed')
  }
  const composerH = parseInt(localStorage.getItem('marveen_chat_composer_h') || '', 10)
  if (Number.isFinite(composerH)) $('input').style.height = composerH + 'px'

  // Sidebar drag-resize
  const resizer = $('sidebar-resizer')
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    resizer.classList.add('dragging')
    resizer.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const w = Math.min(Math.max(ev.clientX, 200), 480)
      $('sidebar').style.width = w + 'px'
    }
    const up = () => {
      resizer.classList.remove('dragging')
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', up)
      localStorage.setItem('marveen_chat_sidebar_w', parseInt($('sidebar').style.width, 10))
    }
    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', up)
  })

  // Composer: remember the height the user sets with the native resize handle
  new ResizeObserver(() => {
    if (programmaticResize) { programmaticResize = false; return }
    const h = $('input').offsetHeight
    if (h > 0) localStorage.setItem('marveen_chat_composer_h', h)
  }).observe($('input'))
}

function toggleSidebar() {
  if (isMobile()) { openSidebar(); return }
  const app = document.querySelector('.app')
  app.classList.toggle('sidebar-collapsed')
  localStorage.setItem('marveen_chat_sidebar_collapsed', app.classList.contains('sidebar-collapsed') ? '1' : '0')
}

function openSidebar() { $('sidebar').classList.add('open'); $('backdrop').classList.remove('hidden') }
function closeSidebar() { $('sidebar').classList.remove('open'); $('backdrop').classList.add('hidden') }

$('new-thread').onclick = newThread
$('rename-thread').onclick = renameCurrent
$('close-thread').onclick = closeCurrent
$('logout').onclick = async () => { await api('/chat-api/auth/logout', { method: 'POST' }); location.reload() }
$('send').onclick = send
$('sidebar-open').onclick = toggleSidebar
$('sidebar-close').onclick = closeSidebar
$('backdrop').onclick = closeSidebar
$('input').addEventListener('input', (e) => autoGrow(e.target))
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
document.addEventListener('visibilitychange', schedulePoll)
$('theme-toggle').onclick = toggleTheme
applyTheme(localStorage.getItem('marveen_chat_theme'))
initLayout()

init()
