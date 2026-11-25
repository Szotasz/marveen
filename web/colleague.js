// The colleague board page (docs/board-access.md, "Colleague login").
// Talks to /api/colleague/* and /api/board/* only, and relies on the HttpOnly
// colleague cookie the login sets; nothing is kept in browser storage except the
// dashboard's language choice (marveen.lang), read, never written, and this
// page's view choice (marveen.colleague.view: 'columns' or 'list'), a per-browser
// convenience. Every value from the server goes in through textContent.
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const PRIORITIES = ['low', 'normal', 'high', 'urgent']
  let me = null
  let openCard = null

  // --- i18n: the dashboard's language files (window._i18n), the dashboard's lookup rule ---
  let lang = 'hu'
  try { const v = localStorage.getItem('marveen.lang'); if (v === 'en' || v === 'hu') lang = v } catch { /* storage blocked */ }
  document.documentElement.lang = lang
  function t(key, params) {
    const str = (window._i18n && window._i18n[lang] && window._i18n[lang][key]) ||
      (window._i18n && window._i18n.en && window._i18n.en[key]) || key
    const vals = params || {}
    return String(str).replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? String(vals[k]) : `{${k}}`))
  }
  function applyI18n() {
    for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n)
    for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder)
    for (const e of document.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria))
    for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle)
  }
  const statusLabel = (s) => t(`kanban.status.${s}`)
  const priorityLabel = (p) => t(`kanban.priority.${p}`)

  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' }
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    const res = await fetch(path, opts)
    let data = null
    try { data = await res.json() } catch { /* empty or non-JSON body */ }
    return { status: res.status, ok: res.ok, data }
  }

  function el(tag, text, cls) {
    const e = document.createElement(tag)
    if (text !== undefined && text !== null) e.textContent = String(text)
    if (cls) e.className = cls
    return e
  }

  function msg(id, text, kind) {
    const e = $(id)
    e.textContent = text || ''
    e.className = `cb-msg${kind ? ` ${kind}` : ''}`
    e.hidden = !text
  }

  function showLogin(text) {
    me = null
    $('cb-app').hidden = true
    $('cb-login').hidden = false
    msg('cb-login-msg', text || '', 'err')
    $('cb-login-user').focus()
  }

  /** A 401/403 from an API call means the session is gone (expired, disabled, reset): back to the login. */
  function sessionLost(r) {
    if (r.status === 401 || r.status === 403) { showLogin(t('colleague.err.session')); return true }
    return false
  }

  function dueText(due) {
    if (typeof due !== 'number') return ''
    // A date-only due date is UTC midnight (board.ts cardDueDay); show that calendar day.
    return new Date(due * 1000).toISOString().slice(0, 10)
  }

  async function start() {
    applyI18n()
    const sel = $('cb-new-priority')
    for (const p of PRIORITIES) {
      const o = el('option', priorityLabel(p))
      o.value = p
      if (p === 'normal') o.selected = true
      sel.append(o)
    }
    const r = await api('GET', '/api/colleague/me')
    if (!r.ok || !r.data) { showLogin(''); return }
    enter(r.data)
  }

  function enter(data) {
    me = data
    $('cb-login').hidden = true
    $('cb-app').hidden = false
    $('cb-who').textContent = t('colleague.who', { name: (data.person && data.person.name) || data.username })
    if (!data.board_available) msg('cb-fatal', t('colleague.login.unavailable'), 'err')
    else { msg('cb-fatal', ''); load() }
  }

  async function load() {
    const r = await api('GET', '/api/board/cards')
    if (sessionLost(r)) return
    if (!r.ok || !r.data) { msg('cb-fatal', t('colleague.err.generic', { code: r.status }), 'err'); return }
    render(r.data.cards || [])
  }

  // The card being dragged: its record and its status select, so a drop goes through the same move() as the select.
  let dragged = null

  // The view: 'columns' (the kanban, with drag) or 'list' (one section per status that has cards, select only).
  // An unreadable or unknown stored value is the column view.
  const VIEW_KEY = 'marveen.colleague.view'
  let view = 'columns'
  try { if (localStorage.getItem(VIEW_KEY) === 'list') view = 'list' } catch { /* storage blocked */ }
  let lastCards = []

  function setView(v) {
    view = v === 'list' ? 'list' : 'columns'
    try { localStorage.setItem(VIEW_KEY, view) } catch { /* storage blocked: the choice lasts for this page only */ }
    render(lastCards)
  }

  function render(cards) {
    lastCards = cards
    $('cb-view-columns').setAttribute('aria-pressed', String(view === 'columns'))
    $('cb-view-list').setAttribute('aria-pressed', String(view === 'list'))
    const root = $('cb-groups')
    root.replaceChildren()
    root.classList.toggle('cb-list', view === 'list')
    const statuses = (me && me.statuses) || ['planned', 'in_progress', 'testing', 'waiting', 'done']
    const empty = $('cb-empty')
    empty.textContent = t('colleague.empty')
    empty.hidden = cards.length > 0
    if (view === 'list') renderList(root, cards, statuses)
    else renderColumns(root, cards, statuses)
  }

  /** The list view: a section per status that has cards; moving is the select's job, there is no drag. */
  function renderList(root, cards, statuses) {
    for (const s of statuses) {
      const list = cards.filter((c) => c.status === s)
      if (list.length === 0) continue
      const sec = el('section', null, 'cb-card cb-group')
      const h = el('h2', statusLabel(s))
      h.append(el('span', String(list.length), 'cb-count'))
      sec.append(h)
      for (const c of list) sec.append(renderCard(c, statuses, false))
      root.append(sec)
    }
  }

  /** One column per status, side by side, the empty ones too: an empty column is still a drop target. */
  function renderColumns(root, cards, statuses) {
    for (const s of statuses) {
      const list = cards.filter((c) => c.status === s)
      const col = el('section', null, 'cb-col')
      const head = el('div', null, 'cb-col-head')
      head.append(el('h2', statusLabel(s)), el('span', String(list.length), 'cb-count'))
      const body = el('div', null, 'cb-col-body')
      body.dataset.status = s
      wireDrop(body, s)
      for (const c of list) body.append(renderCard(c, statuses, true))
      col.append(head, body)
      root.append(col)
    }
  }

  /** A column body accepts a dragged card of another column; the move itself is the select's move(). */
  function wireDrop(body, status) {
    body.addEventListener('dragover', (e) => {
      if (!dragged || dragged.card.status === status) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      body.classList.add('drag-over')
    })
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) body.classList.remove('drag-over')
    })
    body.addEventListener('drop', (e) => {
      e.preventDefault()
      body.classList.remove('drag-over')
      const d = dragged
      dragged = null
      if (!d || d.card.status === status) return
      d.sel.value = status
      move(d.card, status, d.sel)
    })
  }

  function renderCard(c, statuses, canDrag) {
    const box = el('div', null, 'cb-task')
    box.append(el('span', c.title, 'cb-task-title'))
    const meta = el('div', null, 'cb-row cb-task-meta')
    if (c.priority && c.priority !== 'normal') meta.append(el('span', priorityLabel(c.priority), `cb-badge ${c.priority}`))
    const due = dueText(c.due_date)
    if (due) meta.append(el('span', t('colleague.card.due', { date: due }), 'cb-muted'))
    if (meta.childElementCount) box.append(meta)
    const top = el('div', null, 'cb-row cb-task-actions')
    const sel = el('select', null, 'cb-input')
    sel.setAttribute('aria-label', t('colleague.card.move'))
    for (const s of statuses) {
      const o = el('option', statusLabel(s))
      o.value = s
      if (s === c.status) o.selected = true
      sel.append(o)
    }
    sel.addEventListener('change', () => move(c, sel.value, sel))
    const detailBtn = el('button', t(openCard === c.id ? 'colleague.card.close' : 'colleague.card.open'), 'cb-btn')
    detailBtn.type = 'button'
    top.append(sel, detailBtn)
    box.append(top)
    const detail = el('div', null, 'cb-detail')
    detail.hidden = true
    box.append(detail)
    detailBtn.addEventListener('click', () => {
      if (!detail.hidden) { detail.hidden = true; openCard = null; detailBtn.textContent = t('colleague.card.open'); return }
      openCard = c.id
      detailBtn.textContent = t('colleague.card.close')
      showDetail(c.id, detail)
    })
    if (openCard === c.id) showDetail(c.id, detail)
    if (canDrag) wireDrag(box, c, sel)
    return box
  }

  function wireDrag(box, c, sel) {
    // Drag by the card itself, but not from its controls: a draggable ancestor stops a select from opening and
    // text from being selected in the comment box in some browsers, so dragging is off while the pointer is on one.
    box.draggable = true
    box.addEventListener('pointerdown', (e) => {
      box.draggable = !(e.target instanceof Element && e.target.closest('select, input, textarea, button, a, .cb-detail'))
    })
    box.addEventListener('dragstart', (e) => {
      dragged = { card: c, sel }
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', c.id) } catch { /* some browsers refuse; the drag still works */ }
      box.classList.add('dragging')
    })
    box.addEventListener('dragend', () => {
      box.classList.remove('dragging')
      box.draggable = true
      dragged = null
      for (const b of document.querySelectorAll('.cb-col-body.drag-over')) b.classList.remove('drag-over')
    })
  }

  async function showDetail(id, detail) {
    detail.hidden = false
    detail.replaceChildren(el('p', t('common.loading'), 'cb-muted'))
    const r = await api('GET', `/api/board/cards/${encodeURIComponent(id)}`)
    if (sessionLost(r)) return
    if (!r.ok || !r.data) { detail.replaceChildren(el('p', t('colleague.err.generic', { code: r.status }), 'cb-msg err')); return }
    const card = r.data
    detail.replaceChildren()
    if (card.description) detail.append(el('p', card.description, 'cb-desc'))
    detail.append(el('strong', t('colleague.card.comments')))
    const comments = Array.isArray(card.comments) ? card.comments : []
    if (!comments.length) detail.append(el('p', t('colleague.card.no_comments'), 'cb-muted'))
    for (const cm of comments) {
      const p = el('p', null, 'cb-comment')
      const when = typeof cm.created_at === 'number' ? new Date(cm.created_at * 1000).toLocaleString(lang) : ''
      p.append(el('span', `${cm.author || ''} ${when}`.trim(), 'cb-muted'), document.createTextNode(cm.content || ''))
      detail.append(p)
    }
    const form = el('form', null, 'cb-row')
    const input = el('input', null, 'cb-input')
    input.placeholder = t('colleague.card.comment_placeholder')
    input.setAttribute('aria-label', t('colleague.card.comment_placeholder'))
    input.maxLength = 10000
    input.required = true
    input.style.flex = '1 1 240px'
    const btn = el('button', t('colleague.card.comment_submit'), 'cb-btn')
    btn.type = 'submit'
    form.append(input, btn)
    const out = el('p', null, 'cb-msg err')
    out.hidden = true
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const content = input.value.trim()
      if (!content) return
      btn.disabled = true
      const res = await api('POST', `/api/board/cards/${encodeURIComponent(id)}/comments`, { content })
      btn.disabled = false
      if (sessionLost(res)) return
      if (!res.ok) { out.textContent = t('colleague.err.generic', { code: res.status }); out.hidden = false; return }
      showDetail(id, detail)
    })
    detail.append(form, out)
  }

  async function move(card, status, sel) {
    sel.disabled = true
    const r = await api('POST', `/api/board/cards/${encodeURIComponent(card.id)}/move`, { status })
    sel.disabled = false
    if (sessionLost(r)) return
    if (r.status === 409) { msg('cb-fatal', t('colleague.err.conflict'), 'err'); load(); return }
    if (!r.ok) { msg('cb-fatal', t('colleague.err.generic', { code: r.status }), 'err'); sel.value = card.status; return }
    // A 200 can still be a soft refusal (ok: false): show the server's answer and keep the card where it was.
    if (r.data && r.data.ok === false) {
      msg('cb-fatal', r.data.note || t('colleague.err.refused', { status: r.data.status || card.status }), 'err')
      sel.value = card.status
      return
    }
    msg('cb-fatal', '')
    load()
  }

  $('cb-login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    msg('cb-login-msg', '')
    const r = await api('POST', '/api/colleague/login', { username: $('cb-login-user').value, password: $('cb-login-pass').value })
    $('cb-login-pass').value = ''
    if (r.status === 429) { msg('cb-login-msg', t('colleague.login.throttled', { s: (r.data && r.data.retry_after_s) || 30 }), 'err'); return }
    if (r.status === 403) { msg('cb-login-msg', t('colleague.login.unavailable'), 'err'); return }
    if (!r.ok) { msg('cb-login-msg', t('colleague.login.invalid'), 'err'); return }
    const m = await api('GET', '/api/colleague/me')
    if (!m.ok || !m.data) { msg('cb-login-msg', t('colleague.err.generic', { code: m.status }), 'err'); return }
    enter(m.data)
  })

  $('cb-logout').addEventListener('click', async () => {
    await api('POST', '/api/colleague/logout')
    showLogin('')
  })

  $('cb-refresh').addEventListener('click', () => load())
  $('cb-view-columns').addEventListener('click', () => setView('columns'))
  $('cb-view-list').addEventListener('click', () => setView('list'))

  $('cb-new-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = { title: $('cb-new-title').value.trim(), priority: $('cb-new-priority').value }
    const desc = $('cb-new-desc').value.trim()
    if (desc) body.description = desc
    const due = $('cb-new-due').value
    if (due) body.due_date = due
    if (!body.title) return
    const r = await api('POST', '/api/board/cards', body)
    if (sessionLost(r)) return
    if (!r.ok) { msg('cb-new-msg', (r.data && r.data.error) || t('colleague.err.generic', { code: r.status }), 'err'); return }
    $('cb-new-form').reset()
    $('cb-new-priority').value = 'normal'
    msg('cb-new-msg', t('colleague.new.created'), 'ok')
    load()
  })

  start()
})()
