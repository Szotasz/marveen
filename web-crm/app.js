// Marveen CRM, 1. utem (CRM1SKEL922 + the actor field, decision 2026-09-22).
// Live: POST /api/leads (body.actor carries the author) and GET /api/leads/today.
// Live too: the Szal view over the synced mail (GET /api/threads?q=,
// /api/threads/:id, /api/messages/unthreaded; CRM1MAILSYNC922). Still static:
// the Leadek list (no list endpoint in phase 1). The bearer token arrives like the dashboard's: once via
// ?token=... in the URL, then from localStorage; every same-origin /api/ call
// carries it. The service never fills the author: the "Ki vagy" field does,
// per viewer, and the server refuses an empty one (the gate is there, the
// disabled button is only convenience).
(function () {
  'use strict'
  var TOKEN_KEY = 'marveen-crm-token'
  var ACTOR_KEY = 'crm.actor'
  var params = new URLSearchParams(window.location.search)
  var urlToken = params.get('token')
  var sessionToken = urlToken || ''
  if (urlToken) {
    try { localStorage.setItem(TOKEN_KEY, urlToken) } catch (e) { /* storage blocked */ }
    params.delete('token')
    window.history.replaceState({}, '', window.location.pathname + (params.toString() ? '?' + params : '') + window.location.hash)
  } else {
    try { sessionToken = localStorage.getItem(TOKEN_KEY) || '' } catch (e) { /* storage blocked */ }
  }
  function api(path, init) {
    init = init || {}
    var headers = new Headers(init.headers || {})
    if (sessionToken) headers.set('Authorization', 'Bearer ' + sessionToken)
    init.headers = headers
    return fetch(path, init)
  }

  // No demo data anywhere: every list is live or empty with a notice.
  var LABEL = {
    origin: { email: 'e-mail', telegram: 'Telegram', phone: 'telefon', meeting: 'találkozó', referral: 'ajánlás', other: 'egyéb' },
    status: { open: 'nyitott', won: 'nyert', lost: 'vesztett', parked: 'parkol' },
    step: { email: 'e-mail', call: 'hívás', meeting: 'találkozó', offer: 'ajánlat', wakeup: 'ébresztés' }
  }
  function today() { return new Date().toISOString().slice(0, 10) }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }
  function fmtDay(epochSec) { var d = new Date(epochSec * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

  // --- Ma: live from GET /api/leads/today ---
  function renderMaRows(rows) {
    var lejart = document.getElementById('ma-lejart'); var mai = document.getElementById('ma-mai')
    lejart.innerHTML = ''; mai.innerHTML = ''
    rows.forEach(function (l) {
      var li = el('li', 'row')
      li.appendChild(el('span', 'when', fmtDay(l.next_step_at)))
      li.appendChild(el('span', 'what', (LABEL.step[l.next_step_type] || l.next_step_type) + ': ' + l.next_step_text))
      li.appendChild(el('span', 'who', l.title + ' · ' + (LABEL.origin[l.origin] || l.origin) + ' · ' + l.owner))
      ;(l.lejart ? lejart : mai).appendChild(li)
    })
    if (!lejart.children.length) lejart.appendChild(el('li', 'muted', 'Nincs lejárt lépés.'))
    if (!mai.children.length) mai.appendChild(el('li', 'muted', 'Mára nincs lépés.'))
  }
  function loadMa() {
    var notice = document.getElementById('ma-notice'); var sleeping = document.getElementById('ma-sleeping')
    return api('/api/leads/today').then(function (r) {
      if (r.status === 401) { notice.textContent = 'Nincs érvényes token: nyisd meg az oldalt ?token=<dashboard token> paraméterrel. A lista addig üres, nem példaadat.'; notice.className = 'notice error'; renderMaRows([]); return }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json().then(function (d) {
        notice.textContent = 'Lejárt és mai következő lépések, élő adat (GET /api/leads/today).'; notice.className = 'muted'
        renderMaRows(d.leads || [])
        if (d.sleeping && d.sleeping.count > 0) { sleeping.hidden = false; sleeping.textContent = 'Alvó (ébresztésre váró) leadek: ' + d.sleeping.count + (d.sleeping.next_wake_at ? ', a legközelebbi ' + fmtDay(d.sleeping.next_wake_at) : '') }
        else sleeping.hidden = true
      })
    }).catch(function (e) { notice.textContent = 'A Ma nézet nem tölthető be: ' + e.message; notice.className = 'notice error'; renderMaRows([]) })
  }

  // --- Leadek: no list endpoint in phase 1 (comes after CRM1MAILSYNC922); the table is empty, the notice says so ---
  function renderLeads() {
    var body = document.getElementById('leads-body'); body.innerHTML = ''
    var tr = document.createElement('tr'); tr.appendChild(el('td', 'muted', 'Még nincs lista-végpont: a lista üres, nem példaadat.')); body.appendChild(tr)
  }

  // --- Szal: live over the synced mail (CRM1MAILSYNC922) ---
  function fmtAt(epochSec) {
    if (!epochSec) return 'ismeretlen idő'
    var d = new Date(epochSec * 1000)
    return fmtDay(epochSec) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  function szalAuthNotice(status) {
    var notice = document.getElementById('szal-notice')
    if (status === 401) { notice.textContent = 'Nincs érvényes token: nyisd meg az oldalt ?token=<dashboard token> paraméterrel. A szálak addig nem töltődnek, a lista üres, nem példaadat.'; notice.className = 'notice error'; return true }
    return false
  }
  var currentThread = null
  function renderThreadList(rows) {
    var body = document.getElementById('szal-list'); body.innerHTML = ''
    rows.forEach(function (t) {
      var tr = document.createElement('tr'); tr.className = 'pick' + (currentThread === t.id ? ' picked' : ''); tr.dataset.thread = String(t.id)
      ;[t.subject || '(tárgy nélkül)', String(t.message_count), String(t.out_count || 0), fmtAt(t.last_at)].forEach(function (v) { tr.appendChild(el('td', null, v)) })
      tr.addEventListener('click', function () { openThread(t.id) })
      body.appendChild(tr)
    })
    if (!rows.length) { var tr0 = document.createElement('tr'); tr0.appendChild(el('td', 'muted', 'Nincs szál: vagy még nem futott a szinkron, vagy a keresés nem talált.')); body.appendChild(tr0) }
  }
  function loadThreads() {
    var q = document.getElementById('szal-q').value.trim()
    var count = document.getElementById('szal-count')
    return api('/api/threads?q=' + encodeURIComponent(q)).then(function (r) {
      if (szalAuthNotice(r.status)) { renderThreadList([]); return }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json().then(function (d) {
        renderThreadList(d.threads || [])
        count.textContent = (d.threads || []).length + ' szál' + (q ? ' a keresésre' : '') + ', ' + (d.unthreaded_messages || 0) + ' nem szálazható másolat'
      })
    }).catch(function (e) { count.textContent = 'A szálak nem tölthetők be: ' + e.message; renderThreadList([]) })
  }
  function renderTimeline(messages) {
    var ol = document.getElementById('szal-timeline'); ol.innerHTML = ''
    messages.forEach(function (m) {
      var li = el('li', 'msg ' + (m.direction === 'out' ? 'out' : 'in'))
      li.appendChild(el('div', 'meta', fmtAt(m.sent_at) + ' · ' + (m.direction === 'out' ? 'kimenő' : 'bejövő') + ' · ' + (m.from_addr || '?') + ' · ' + m.source))
      li.appendChild(el('div', 'body', m.body_text || '(üres törzs)'))
      ol.appendChild(li)
    })
    if (!messages.length) ol.appendChild(el('li', 'muted', 'Válassz egy szálat a listából.'))
  }
  function openThread(id) {
    currentThread = id
    var head = document.getElementById('szal-head')
    return api('/api/threads/' + id).then(function (r) {
      if (szalAuthNotice(r.status)) return
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json().then(function (d) {
        head.hidden = false
        document.getElementById('szal-subject').textContent = d.thread.subject || '(tárgy nélkül)'
        document.getElementById('szal-key').textContent = 'szál-kulcs: ' + d.thread.thread_key + ' · ' + d.messages.length + ' levél'
        renderTimeline(d.messages || [])
        document.querySelectorAll('#szal-list tr.pick').forEach(function (tr) { tr.classList.toggle('picked', tr.dataset.thread === String(id)) })
      })
    }).catch(function (e) { head.hidden = false; document.getElementById('szal-subject').textContent = 'A szál nem tölthető be: ' + e.message; renderTimeline([]) })
  }
  function loadUnthreaded() {
    var ul = document.getElementById('szal-unthreaded'); var note = document.getElementById('szal-unthreaded-note')
    return api('/api/messages/unthreaded').then(function (r) {
      if (szalAuthNotice(r.status)) return
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json().then(function (d) {
        ul.innerHTML = ''
        note.textContent = d.note || ''
        ;(d.messages || []).forEach(function (m) {
          var li = el('li', 'row')
          li.appendChild(el('span', 'when', fmtAt(m.sent_at)))
          li.appendChild(el('span', 'what', (m.subject || '(tárgy nélkül)')))
          li.appendChild(el('span', 'who', (m.direction === 'out' ? 'kimenő' : 'bejövő') + ' · ' + (m.from_addr || '?') + ' -> ' + (m.to_addrs || '?') + ' · ' + m.source))
          ul.appendChild(li)
        })
        if (!ul.children.length) ul.appendChild(el('li', 'muted', 'Nincs nem szálazható másolat.'))
      })
    }).catch(function (e) { note.textContent = 'A másolatok nem tölthetők be: ' + e.message })
  }
  function loadSzal() { renderTimeline([]); return Promise.all([loadThreads(), loadUnthreaded()]) }
  var szalTimer = null
  document.getElementById('szal-q').addEventListener('input', function () { clearTimeout(szalTimer); szalTimer = setTimeout(loadThreads, 200) })

  // --- actor ("Ki vagy") ---
  var actorInput = document.getElementById('actor')
  var submitBtn = document.getElementById('lead-submit')
  function actor() { return (actorInput.value || '').trim() }
  function syncActor() {
    var a = actor()
    submitBtn.disabled = a.length === 0
    try { if (a) localStorage.setItem(ACTOR_KEY, a); else localStorage.removeItem(ACTOR_KEY) } catch (e) { /* storage blocked */ }
  }
  try { actorInput.value = localStorage.getItem(ACTOR_KEY) || '' } catch (e) { /* storage blocked */ }
  actorInput.addEventListener('input', syncActor)
  syncActor()

  // --- Lead felvetele: POST /api/leads, the body carries the actor ---
  document.getElementById('lead-form').addEventListener('submit', function (ev) {
    ev.preventDefault()
    var hint = document.getElementById('lead-form-hint')
    var a = actor()
    if (!a) { hint.textContent = 'Add meg a fejlécben, ki vagy: a szerző nélküli felvételt a szerver megtagadja.'; return }
    var f = ev.target
    var contact = (f.contact.value || '').trim()
    var payload = {
      actor: a,
      title: f.title.value.trim(),
      origin: f.origin.value,
      next_step_type: f.next_step_type.value,
      next_step_at: f.next_step_at.value,
      next_step_text: f.next_step_text.value.trim()
    }
    if (contact.indexOf('@') > 0) payload.email = contact
    else if (contact) payload.display_name = contact
    submitBtn.disabled = true
    api('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d } }) })
      .then(function (x) {
        if (x.status === 201) { hint.textContent = 'Lead felvéve (#' + x.d.id + '), szerző: ' + a + '.'; f.reset(); f.next_step_at.value = today(); loadMa() }
        else if (x.status === 401) hint.textContent = 'Nincs érvényes token (401): nyisd meg az oldalt ?token=<dashboard token> paraméterrel.'
        else hint.textContent = 'A szerver megtagadta (' + x.status + '): ' + (x.d.message || x.d.error || 'ismeretlen ok')
      })
      .catch(function (e) { hint.textContent = 'A felvétel nem ment el: ' + e.message })
      .then(function () { submitBtn.disabled = actor().length === 0 })
  })

  function show(name) {
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.dataset.screen !== name })
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.screen === name)) })
    try { localStorage.setItem('crm.screen', name) } catch (e) { /* private mode */ }
  }
  document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.screen) }) })
  ;['filter-status', 'filter-origin', 'filter-text'].forEach(function (id) { document.getElementById(id).addEventListener('input', renderLeads) })
  var d = document.querySelector('input[name=next_step_at]'); if (d && !d.value) d.value = today()

  fetch('/health').then(function (r) { return r.json() }).then(function (h) {
    document.getElementById('status').textContent = h.ok ? ('szolgáltatás él' + (h.claudeclawReadOnly ? ', flotta-tár olvasható' : ', flotta-tár nem elérhető')) : 'szolgáltatás hiba'
  }).catch(function () { document.getElementById('status').textContent = 'szolgáltatás nem válaszol' })

  renderLeads(); loadMa(); loadSzal()
  var saved = null; try { saved = localStorage.getItem('crm.screen') } catch (e) { /* private mode */ }
  show(saved && document.querySelector('.screen[data-screen="' + saved + '"]') ? saved : 'ma')
})()
