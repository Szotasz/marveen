// VIDEOREVIEW1002: the review page. Same auth as the dashboard: the bearer token
// the dashboard stored after its ?token= bootstrap (localStorage), sent only to
// same-origin /api/ calls. The <video> elements get single-file tickets.
// Note text is always rendered with textContent, never as HTML.
(function () {
  'use strict'
  var TOKEN_KEY = 'marveen-dashboard-token'
  var PAGE_VERSION = '1.0.0'
  var $ = function (id) { return document.getElementById(id) }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || '' } catch (e) { return '' }
  }

  async function api(path, opts) {
    opts = opts || {}
    var headers = new Headers(opts.headers || {})
    var t = token()
    if (t) headers.set('Authorization', 'Bearer ' + t)
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    })
    var data = null
    try { data = await res.json() } catch (e) { data = null }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('http_' + res.status))
      err.status = res.status
      throw err
    }
    return data
  }

  var state = {
    agent: null,
    videos: [],
    video: '',
    compare: '',
    mode: 'side',
    fps: 25,
    notes: [],
    pending: null,      // { x, y, w?, h? } of the frame, 0..1
    showB: false,       // toggle mode: which version is visible
    saveTimer: null,
  }

  function msg(text, isErr) {
    var el = $('vr-msg')
    el.textContent = text || ''
    el.className = 'vr-msg' + (isErr ? ' err' : '')
  }

  function fmt(t) {
    var m = Math.floor(t / 60)
    var s = t - m * 60
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3)
  }

  function frameOf(t) { return Math.round(t * state.fps) }

  function v1() { return $('vr-v1') }
  function v2() { return $('vr-v2') }

  function updateNow() {
    var t = v1().currentTime || 0
    $('vr-now').textContent = fmt(t) + ' · ' + frameOf(t) + '. kocka'
    renderMarks()
  }

  function step(frames) {
    var v = v1()
    v.pause()
    var target = Math.max(0, Math.min(v.duration || Infinity, (frameOf(v.currentTime) + frames) / state.fps + 0.0001))
    v.currentTime = target
    if (state.compare) v2().currentTime = target
  }

  function seekSeconds(s) {
    var v = v1()
    v.pause()
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + s))
    if (state.compare) v2().currentTime = v.currentTime
  }

  function togglePlay() {
    var v = v1()
    if (v.paused) { v.play(); if (state.compare) v2().play() } else { v.pause(); if (state.compare) { v2().pause(); v2().currentTime = v.currentTime } }
  }

  async function loadVideo(el, rel) {
    if (!rel) { el.removeAttribute('src'); el.load(); return }
    var r = await api('/api/video-review/ticket', { method: 'POST', body: { path: rel } })
    el.src = r.url
  }

  function applyLayout() {
    var players = $('vr-players')
    var hasB = !!state.compare
    $('vr-p2').hidden = !hasB || (state.mode === 'toggle' && !state.showB)
    $('vr-p1').hidden = hasB && state.mode === 'toggle' && state.showB
    players.className = 'vr-players' + (hasB && state.mode === 'side' ? ' side' : '')
    $('vr-l1').textContent = state.video ? 'A: ' + state.video : ''
    $('vr-l2').textContent = state.compare ? 'B: ' + state.compare : ''
  }

  function currentVersion() {
    return state.compare && state.mode === 'toggle' && state.showB ? state.compare : state.video
  }

  // --- marks on the frame -------------------------------------------------
  function renderMarks() {
    var ov = $('vr-overlay')
    while (ov.firstChild) ov.removeChild(ov.firstChild)
    var t = v1().currentTime || 0
    var shown = state.notes.filter(function (n) { return n.x !== undefined && Math.abs(n.t - t) < 0.5 / state.fps + 0.0005 })
    if (state.pending) shown = shown.concat([state.pending])
    shown.forEach(function (n) {
      var d = document.createElement('div')
      if (n.w !== undefined) {
        d.className = 'vr-mark'
        d.style.left = (n.x * 100) + '%'; d.style.top = (n.y * 100) + '%'
        d.style.width = (n.w * 100) + '%'; d.style.height = (n.h * 100) + '%'
      } else {
        d.className = 'vr-mark point'
        d.style.left = (n.x * 100) + '%'; d.style.top = (n.y * 100) + '%'
      }
      ov.appendChild(d)
    })
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)) }

  function setupOverlay() {
    var ov = $('vr-overlay')
    var start = null
    ov.addEventListener('pointerdown', function (e) {
      var r = ov.getBoundingClientRect()
      start = { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
      v1().pause(); if (state.compare) v2().pause()
      ov.setPointerCapture(e.pointerId)
    })
    ov.addEventListener('pointerup', function (e) {
      if (!start) return
      var r = ov.getBoundingClientRect()
      var end = { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
      var w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y)
      state.pending = (w > 0.01 && h > 0.01)
        ? { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: w, h: h }
        : { x: start.x, y: start.y }
      start = null
      $('vr-pending').textContent = state.pending.w !== undefined ? 'téglalap kijelölve' : 'pont kijelölve'
      renderMarks()
      $('vr-text').focus()
    })
  }

  // --- notes -----------------------------------------------------------------
  function renderNotes() {
    var ul = $('vr-notes')
    while (ul.firstChild) ul.removeChild(ul.firstChild)
    state.notes.forEach(function (n) {
      var li = document.createElement('li')
      li.className = 'vr-note' + (n.status === 'done' ? ' done' : '')
      var t = document.createElement('button')
      t.type = 'button'; t.className = 't'; t.textContent = fmt(n.t)
      t.title = 'Ugrás ide'
      t.addEventListener('click', function () {
        if (n.version === state.compare && state.mode === 'toggle') { state.showB = true; applyLayout() }
        v1().pause(); v1().currentTime = n.t
        if (state.compare) { v2().pause(); v2().currentTime = n.t }
      })
      var txt = document.createElement('div')
      txt.className = 'txt'; txt.textContent = n.text
      var box = document.createElement('div')
      var done = document.createElement('input')
      done.type = 'checkbox'; done.checked = n.status === 'done'; done.title = 'Kész'
      done.addEventListener('change', function () { n.status = done.checked ? 'done' : 'open'; renderNotes(); scheduleSave() })
      var del = document.createElement('button')
      del.type = 'button'; del.className = 'vr-btn'; del.textContent = 'Törlés'
      del.addEventListener('click', function () {
        state.notes = state.notes.filter(function (x) { return x !== n }); renderNotes(); renderMarks(); scheduleSave()
      })
      box.appendChild(done); box.appendChild(del)
      var meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = frameOf(n.t) + '. kocka · ' + n.version + (n.x !== undefined ? (n.w !== undefined ? ' · téglalap' : ' · pont') : '')
      li.appendChild(t); li.appendChild(txt); li.appendChild(box); li.appendChild(meta)
      ul.appendChild(li)
    })
    $('vr-send').disabled = state.notes.length === 0
  }

  function addNote() {
    var text = $('vr-text').value.trim()
    if (!text || !state.video) return
    var note = {
      id: Math.random().toString(36).slice(2, 12),
      t: Math.round((v1().currentTime || 0) * 1000) / 1000,
      version: currentVersion(),
      text: text,
      status: 'open',
    }
    if (state.pending) {
      note.x = state.pending.x; note.y = state.pending.y
      if (state.pending.w !== undefined) { note.w = state.pending.w; note.h = state.pending.h }
    }
    state.notes.push(note)
    state.notes.sort(function (a, b) { return a.t - b.t })
    state.pending = null
    $('vr-pending').textContent = ''
    $('vr-text').value = ''
    renderNotes(); renderMarks(); scheduleSave()
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer)
    msg('Mentés...')
    state.saveTimer = setTimeout(save, 400)
  }

  async function save() {
    if (!state.video) return
    try {
      var r = await api('/api/video-review/review?path=' + encodeURIComponent(state.video), {
        method: 'PUT',
        body: { video: state.video, compare: state.compare || undefined, fps: state.fps, notes: state.notes },
      })
      msg('Mentve (' + r.notes + ' megjegyzés).')
    } catch (e) {
      msg('A mentés nem sikerült: ' + e.message, true)
    }
  }

  // The open video lives in the URL hash, so "Újratöltés" (and a Bridge tab
  // that was reopened) comes back to the same video, not to the newest one.
  function hashVideo() {
    var m = /(?:^|&)v=([^&]*)/.exec(location.hash.replace(/^#/, ''))
    return m ? decodeURIComponent(m[1]) : ''
  }

  async function openVideo(rel) {
    if (rel) history.replaceState(null, '', '#v=' + encodeURIComponent(rel))
    state.video = rel
    state.notes = []
    state.pending = null
    renderNotes()
    if (!rel) return
    try {
      var r = await api('/api/video-review/review?path=' + encodeURIComponent(rel))
      if (r.review) {
        state.notes = r.review.notes || []
        if (r.review.fps) { state.fps = r.review.fps; $('vr-fps').value = String(state.fps) }
        if (r.review.compare && state.videos.some(function (v) { return v.path === r.review.compare })) {
          state.compare = r.review.compare
          $('vr-compare').value = state.compare
          await loadVideo(v2(), state.compare)
        }
      }
      await loadVideo(v1(), rel)
      applyLayout(); renderNotes(); updateNow()
      msg(state.notes.length ? 'Betöltve (' + state.notes.length + ' megjegyzés).' : '')
    } catch (e) {
      msg('A videó nem nyitható meg: ' + e.message, true)
    }
  }

  async function send() {
    if (!state.video) return
    clearTimeout(state.saveTimer)
    await save()
    try {
      var r = await api('/api/video-review/send', { method: 'POST', body: { path: state.video } })
      msg('Elküldve ' + r.to + ' részére (üzenet #' + r.messageId + ').')
    } catch (e) {
      msg('A küldés nem sikerült: ' + e.message, true)
    }
  }

  function fillSelect(sel, keepFirst) {
    while (sel.options.length > (keepFirst ? 1 : 0)) sel.remove(sel.options.length - 1)
    state.videos.forEach(function (v) {
      var o = document.createElement('option')
      o.value = v.path
      o.textContent = v.path + (v.hasReview ? '  (van visszajelzés)' : '')
      sel.appendChild(o)
    })
  }

  async function init() {
    $('vr-version').textContent = 'v' + PAGE_VERSION
    $('vr-reload').addEventListener('click', function () { location.reload() })
    if (!token()) {
      $('vr-fatal').hidden = false
      $('vr-fatal').textContent = 'Nincs dashboard-belépés ebben a fülben. Nyisd meg a dashboardot, és onnan gyere vissza ide.'
    }
    var cfg
    try { cfg = await api('/api/video-review/config') } catch (e) {
      $('vr-fatal').hidden = false
      $('vr-fatal').textContent = 'A videó-visszajelzés nem érhető el: ' + e.message
      return
    }
    if (!cfg.enabled) {
      $('vr-fatal').hidden = false
      $('vr-fatal').textContent = 'A videó-visszajelzés nincs beállítva ezen a gépen (VIDEO_REVIEW_ROOT).'
      return
    }
    state.agent = cfg.agent
    if (state.agent) { $('vr-send').hidden = false; $('vr-send').textContent = 'Küldés: ' + state.agent }
    var list = await api('/api/video-review/videos')
    state.videos = list.videos || []
    fillSelect($('vr-video'), false)
    fillSelect($('vr-compare'), true)
    $('vr-video').addEventListener('change', function () { openVideo($('vr-video').value) })
    $('vr-compare').addEventListener('change', async function () {
      state.compare = $('vr-compare').value
      state.showB = false
      await loadVideo(v2(), state.compare)
      applyLayout(); scheduleSave()
    })
    $('vr-mode').addEventListener('change', function () { state.mode = $('vr-mode').value; state.showB = false; applyLayout() })
    $('vr-fps').addEventListener('change', function () {
      var f = Number($('vr-fps').value)
      if (f >= 1 && f <= 240) { state.fps = f; updateNow(); scheduleSave() }
    })
    $('vr-back1').addEventListener('click', function () { step(-1) })
    $('vr-fwd1').addEventListener('click', function () { step(1) })
    $('vr-play').addEventListener('click', togglePlay)
    $('vr-add').addEventListener('click', addNote)
    $('vr-send').addEventListener('click', send)
    $('vr-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote() }
    })
    v1().addEventListener('timeupdate', updateNow)
    v1().addEventListener('seeked', updateNow)
    v1().addEventListener('play', function () { $('vr-play').textContent = 'Szünet' })
    v1().addEventListener('pause', function () { $('vr-play').textContent = 'Lejátszás' })
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || ''
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? seekSeconds(-1) : step(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? seekSeconds(1) : step(1) }
      else if (e.key === ' ') { e.preventDefault(); togglePlay() }
      else if ((e.key === 'v' || e.key === 'V') && state.compare && state.mode === 'toggle') { state.showB = !state.showB; applyLayout() }
    })
    setupOverlay()
    if (state.videos.length) {
      var wanted = hashVideo()
      var first = state.videos.some(function (v) { return v.path === wanted }) ? wanted : state.videos[0].path
      $('vr-video').value = first
      await openVideo(first)
    } else {
      msg('Nincs videó a beállított mappában.')
    }
  }

  init()
})()
