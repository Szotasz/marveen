// Marveen CRM, 1. utem (CRM1SKEL922 + the actor field, decision 2026-09-22).
// Live: POST /api/leads (body.actor carries the author) and GET /api/leads/today.
// Still static: the Leadek list (no list endpoint yet) and the Szal timeline
// (CRM1MAILSYNC922). The bearer token arrives like the dashboard's: once via
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

  // Leadek: NO demo rows. There is no list endpoint in phase 1; the table stays empty with a notice, never example data.
  var DEMO = {
    thread: [
      { dir: 'in', at: '2026-09-18 09:12', from: 'pelda@example.com', text: 'Érdekelne a Marveen telepítés, mikor érnétek rá?' },
      { dir: 'out', at: '2026-09-18 10:05', from: 'szota.szabolcs.ai@gmail.com', text: 'Jövő héten kedd vagy csütörtök délelőtt megfelel?' },
      { dir: 'in', at: '2026-09-19 08:40', from: 'pelda@example.com', text: 'Csütörtök jó lenne, 10 órakor.' }
    ]
  }
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

  // --- Szal: demo until CRM1MAILSYNC922 ---
  function renderThread() {
    var ol = document.getElementById('szal-timeline'); ol.innerHTML = ''
    DEMO.thread.forEach(function (m) {
      var li = el('li', 'msg ' + (m.dir === 'out' ? 'out' : 'in'))
      li.appendChild(el('div', 'meta', m.at + ' · ' + (m.dir === 'out' ? 'kimenő' : 'bejövő') + ' · ' + m.from))
      li.appendChild(el('div', 'body', m.text))
      ol.appendChild(li)
    })
  }

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

  renderLeads(); renderThread(); loadMa()
  var saved = null; try { saved = localStorage.getItem('crm.screen') } catch (e) { /* private mode */ }
  show(saved && document.querySelector('.screen[data-screen="' + saved + '"]') ? saved : 'ma')
})()
