// Marveen CRM, 1. utem skeleton (CRM1SKEL922). Static demo data only: the
// four screens exist so the layout and the wording can be reviewed; live data
// arrives with CRM1LEADKAPU922 (leads) and CRM1MAILSYNC922 (threads).
(function () {
  'use strict'
  var DEMO = {
    leads: [
      { id: 1, title: 'Comline: voice-agent bővítés', contact: 'Hidli Gábor', origin: 'meeting', status: 'open', next_step_type: 'offer', next_step_at: '2026-09-19', next_step_text: 'Ajánlat kiküldése a bővítésre' },
      { id: 2, title: 'Marveen telepítés, Solymár', contact: 'pelda@example.com', origin: 'email', status: 'open', next_step_type: 'email', next_step_at: '2026-09-22', next_step_text: 'Időpont-javaslat visszaírása' },
      { id: 3, title: 'Alkuszoktatás 2.0 bemutató', contact: 'Zagyi Attila', origin: 'phone', status: 'open', next_step_type: 'call', next_step_at: '2026-09-22', next_step_text: 'Hívás a riport-visszajelzésről' },
      { id: 4, title: 'Előadás-felkérés, iskola', contact: 'iskola@example.org', origin: 'referral', status: 'parked', next_step_type: 'meeting', next_step_at: '2026-10-02', next_step_text: 'Találkozó egyeztetése az igazgatóval' }
    ],
    thread: [
      { dir: 'in', at: '2026-09-18 09:12', from: 'pelda@example.com', text: 'Érdekelne a Marveen telepítés, mikor érnétek rá?' },
      { dir: 'out', at: '2026-09-18 10:05', from: 'szota.szabolcs.ai@gmail.com', text: 'Jövő héten kedd vagy csütörtök délelőtt megfelel?' },
      { dir: 'in', at: '2026-09-19 08:40', from: 'pelda@example.com', text: 'Csütörtök jó lenne, 10 órakor.' }
    ]
  }
  var LABEL = {
    origin: { email: 'e-mail', telegram: 'Telegram', phone: 'telefon', meeting: 'találkozó', referral: 'ajánlás', other: 'egyéb' },
    status: { open: 'nyitott', won: 'nyert', lost: 'vesztett', parked: 'parkol' },
    step: { email: 'e-mail', call: 'hívás', meeting: 'találkozó', offer: 'ajánlat' }
  }
  function today() { return new Date().toISOString().slice(0, 10) }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e }

  function renderMa() {
    var t = today()
    var lejart = document.getElementById('ma-lejart'); var mai = document.getElementById('ma-mai')
    lejart.innerHTML = ''; mai.innerHTML = ''
    DEMO.leads.filter(function (l) { return l.status === 'open' }).forEach(function (l) {
      var li = el('li', 'row')
      li.appendChild(el('span', 'when', l.next_step_at))
      li.appendChild(el('span', 'what', LABEL.step[l.next_step_type] + ': ' + l.next_step_text))
      li.appendChild(el('span', 'who', l.title + ' (' + l.contact + ')'))
      if (l.next_step_at < t) lejart.appendChild(li)
      else if (l.next_step_at === t) mai.appendChild(li)
    })
    if (!lejart.children.length) lejart.appendChild(el('li', 'muted', 'Nincs lejárt lépés.'))
    if (!mai.children.length) mai.appendChild(el('li', 'muted', 'Mára nincs lépés.'))
  }

  function renderLeads() {
    var status = document.getElementById('filter-status').value
    var origin = document.getElementById('filter-origin').value
    var text = document.getElementById('filter-text').value.trim().toLowerCase()
    var body = document.getElementById('leads-body'); body.innerHTML = ''
    DEMO.leads.filter(function (l) {
      return (!status || l.status === status) && (!origin || l.origin === origin) && (!text || l.title.toLowerCase().indexOf(text) >= 0)
    }).forEach(function (l) {
      var tr = document.createElement('tr')
      ;[l.title, l.contact, LABEL.origin[l.origin], LABEL.status[l.status], LABEL.step[l.next_step_type] + ': ' + l.next_step_text, l.next_step_at].forEach(function (v) { tr.appendChild(el('td', null, v)) })
      body.appendChild(tr)
    })
    if (!body.children.length) { var tr = document.createElement('tr'); tr.appendChild(el('td', 'muted', 'Nincs találat.')); body.appendChild(tr) }
  }

  function renderThread() {
    var ol = document.getElementById('szal-timeline'); ol.innerHTML = ''
    DEMO.thread.forEach(function (m) {
      var li = el('li', 'msg ' + (m.dir === 'out' ? 'out' : 'in'))
      li.appendChild(el('div', 'meta', m.at + ' · ' + (m.dir === 'out' ? 'kimenő' : 'bejövő') + ' · ' + m.from))
      li.appendChild(el('div', 'body', m.text))
      ol.appendChild(li)
    })
  }

  function show(name) {
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.dataset.screen !== name })
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.screen === name)) })
    try { localStorage.setItem('crm.screen', name) } catch (e) { /* private mode */ }
  }

  document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.screen) }) })
  ;['filter-status', 'filter-origin', 'filter-text'].forEach(function (id) { document.getElementById(id).addEventListener('input', renderLeads) })
  document.getElementById('lead-form').addEventListener('submit', function (ev) {
    ev.preventDefault()
    document.getElementById('lead-form-hint').textContent = 'Ebben a vázban a felvétel még nem ment el: a POST /api/leads végpont a CRM1LEADKAPU922 kártyán készül.'
  })
  var d = document.querySelector('input[name=next_step_at]'); if (d && !d.value) d.value = today()

  fetch('/health').then(function (r) { return r.json() }).then(function (h) {
    document.getElementById('status').textContent = h.ok ? ('szolgáltatás él' + (h.claudeclawReadOnly ? ', flotta-tár olvasható' : ', flotta-tár nem elérhető')) : 'szolgáltatás hiba'
  }).catch(function () { document.getElementById('status').textContent = 'szolgáltatás nem válaszol' })

  renderMa(); renderLeads(); renderThread()
  var saved = null; try { saved = localStorage.getItem('crm.screen') } catch (e) { /* private mode */ }
  show(saved && document.querySelector('.screen[data-screen="' + saved + '"]') ? saved : 'ma')
})()
