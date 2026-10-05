// DASHOPERATOR1005: the IT operator's page. Talks to /api/operator/* only and
// relies on the HttpOnly operator cookie the login sets; nothing is kept in
// browser storage. Every value from the server goes in through textContent.
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let me = null
  let paneSource = null

  async function api(method, path, body) {
    const opts = { method, headers: {} }
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

  function show(id, on) { $(id).hidden = !on }

  function msg(id, text, kind) {
    const m = $(id)
    m.textContent = text || ''
    m.className = 'op-msg' + (kind ? ' ' + kind : '')
    m.hidden = !text
  }

  function fmtTime(sec) {
    if (!sec) return '–'
    return new Date(sec * 1000).toLocaleString('hu-HU')
  }

  function fmtDuration(sinceSec) {
    if (!sinceSec) return '–'
    let s = Math.max(0, Math.floor(Date.now() / 1000) - sinceSec)
    const d = Math.floor(s / 86400); s -= d * 86400
    const h = Math.floor(s / 3600); s -= h * 3600
    const m = Math.floor(s / 60)
    return (d ? d + ' nap ' : '') + (h ? h + ' óra ' : '') + m + ' perc'
  }

  function kv(target, pairs) {
    const dl = $(target)
    dl.replaceChildren()
    for (const [k, v] of pairs) {
      dl.append(el('dt', k), el('dd', v === null || v === undefined || v === '' ? '–' : v))
    }
  }

  // --- login --------------------------------------------------------------

  function showLogin(text) {
    show('op-app', false)
    show('op-login', true)
    msg('op-login-msg', text || '', text ? 'err' : '')
  }

  $('op-login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const input = $('op-login-key')
    const r = await api('POST', '/api/operator/login', { key: input.value })
    input.value = ''
    if (r.ok) { await boot(); return }
    if (r.status === 429) showLogin('Túl sok próbálkozás. Várj egy kicsit, és próbáld újra.')
    else if (r.status === 403) showLogin('Az üzemeltetői hozzáférést a tulajdonos kikapcsolta.')
    else showLogin('Érvénytelen kulcs.')
  })

  $('op-logout').addEventListener('click', async () => {
    stopPane()
    await api('POST', '/api/operator/logout')
    showLogin('')
  })

  // --- agents -------------------------------------------------------------

  function stateBadge(a) {
    if (a.runState === 'running') return el('span', 'fut', 'op-badge ok')
    if (a.runState === 'unreachable') return el('span', 'nem elérhető', 'op-badge warn')
    return el('span', 'leállítva', 'op-badge off')
  }

  function actionButton(label, onClick, cls) {
    const b = el('button', label, 'op-btn' + (cls ? ' ' + cls : ''))
    b.type = 'button'
    b.addEventListener('click', async () => {
      b.disabled = true
      try { await onClick() } finally { b.disabled = false }
    })
    return b
  }

  async function agentAction(name, path, label) {
    msg('op-agents-msg', label + ': ' + name + '…')
    const r = await api('POST', path)
    if (r.ok) msg('op-agents-msg', label + ': ' + name + ' kész.', 'ok')
    else msg('op-agents-msg', label + ' sikertelen (' + name + '): ' + ((r.data && r.data.error) || r.status), 'err')
    setTimeout(refresh, 1500)
  }

  function renderAgents(agents) {
    const body = $('op-agents')
    body.replaceChildren()
    const caps = me.capabilities
    for (const a of agents) {
      const tr = document.createElement('tr')
      const nameCell = el('td', a.displayName || a.name)
      if (a.displayName && a.displayName !== a.name) nameCell.append(el('div', a.name, 'op-muted'))
      const state = document.createElement('td'); state.append(stateBadge(a))
      const reauth = document.createElement('td')
      reauth.append(a.needsReauth ? el('span', 'újra be kell lépni', 'op-badge warn') : el('span', 'rendben', 'op-badge ok'))
      const actions = document.createElement('td')
      const row = el('div', null, 'op-row')
      const enc = encodeURIComponent(a.name)
      if (a.isMain) {
        if (caps.mainAgentRestart && a.running) {
          row.append(actionButton('Újraindítás', () => {
            if (!confirm('A fő ágens újraindítása a gazda csatornáját is újraindítja. Folytatod?')) return Promise.resolve()
            return agentAction(a.name, `/api/operator/agents/${enc}/restart`, 'Újraindítás')
          }))
        }
      } else if (caps.agentControl) {
        if (a.running) {
          row.append(actionButton('Újraindítás', () => agentAction(a.name, `/api/operator/agents/${enc}/restart`, 'Újraindítás')))
          row.append(actionButton('Leállítás', () => {
            if (!confirm(a.name + ' leállítása?')) return Promise.resolve()
            return agentAction(a.name, `/api/operator/agents/${enc}/stop`, 'Leállítás')
          }, 'danger'))
        } else {
          row.append(actionButton('Indítás', () => agentAction(a.name, `/api/operator/agents/${enc}/start`, 'Indítás')))
        }
      }
      if (caps.commands && a.running) {
        for (const cmd of me.commands) {
          row.append(actionButton('/' + cmd, () => agentAction(a.name, `/api/operator/agents/${enc}/commands/${encodeURIComponent(cmd)}`, '/' + cmd)))
        }
      }
      if (caps.paneView && a.running) {
        row.append(actionButton('Panel', () => { openPane(a.name); return Promise.resolve() }))
      }
      actions.append(row)
      tr.append(
        nameCell,
        state,
        el('td', a.activeModel || a.model || '–'),
        el('td', a.contextTokens === null ? '–' : Math.round(a.contextTokens / 1000) + 'k token'),
        el('td', a.running ? fmtDuration(a.runningSince) : '–'),
        reauth,
        actions,
      )
      body.append(tr)
    }
  }

  // --- pane view (read-only) ---------------------------------------------

  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g

  function stopPane() {
    if (paneSource) { paneSource.close(); paneSource = null }
    show('op-pane-card', false)
  }

  function openPane(name) {
    stopPane()
    $('op-pane-name').textContent = name
    $('op-pane').textContent = ''
    show('op-pane-card', true)
    paneSource = new EventSource(`/api/operator/agents/${encodeURIComponent(name)}/pane/stream`)
    paneSource.onmessage = (ev) => {
      let d
      try { d = JSON.parse(ev.data) } catch { return }
      const pre = $('op-pane')
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8
      pre.textContent = d.running ? String(d.pane || '').replace(ANSI, '') : '(a session nem fut)'
      if (atBottom) pre.scrollTop = pre.scrollHeight
    }
    paneSource.onerror = () => { $('op-pane').textContent += '\n(a kapcsolat megszakadt)' }
  }

  $('op-pane-close').addEventListener('click', stopPane)

  // --- status blocks ------------------------------------------------------

  function renderUpdate(u) {
    kv('op-update', [
      ['Verzió', u.version || u.current],
      ['Ág', u.branch],
      ['Lemaradás', u.behind ? u.behind + ' commit' : 'naprakész'],
      ['Utolsó ellenőrzés', fmtTime(u.lastChecked ? Math.floor(u.lastChecked / 1000) : 0)],
      ['Ellenőrzés', u.checkFailed ? 'sikertelen' : 'rendben'],
    ])
    show('op-update-actions', !!me.capabilities.update)
  }

  function quotaLine(w) {
    if (!w) return null
    return Math.round(w.usedPercentage) + '%' + (w.resetsAt ? ', visszaáll ' + fmtTime(w.resetsAt) : '')
  }

  function renderQuota(q) {
    kv('op-quota', [
      ['Állapot', q.status === 'ok' ? 'friss' : q.status === 'stale' ? 'elavult' : 'nincs adat'],
      ['5 órás', quotaLine(q.fiveHour)],
      ['Heti', quotaLine(q.sevenDay)],
      ['Forrás', q.source],
    ])
  }

  function renderHost(h) {
    kv('op-host', [
      ['Rendszer', h.platform + ' / ' + h.arch],
      ['CPU', h.cpus + ' mag, terhelés ' + h.loadAvg.join(' / ')],
      ['Memória', h.freeMemMb + ' MB szabad / ' + h.totalMemMb + ' MB'],
      ['Gép fut', fmtDuration(Math.floor(Date.now() / 1000) - h.uptimeSec)],
    ])
  }

  function renderNetwork(n) {
    kv('op-network', [
      ['Kötés', n.bindHost],
      ['LAN IP', n.lanIp],
      ['Nyilvános URL', n.publicUrlConfigured ? 'beállítva' : 'nincs'],
      ['Tailscale', n.tailscale === 'not-measured' ? 'nem mérve' : n.tailscale],
    ])
  }

  function renderHealth(health) {
    const root = $('op-health')
    root.replaceChildren()
    if (!Array.isArray(health)) {
      root.append(el('p', 'Nem mérhető: ' + ((health && health.error) || 'ismeretlen hiba'), 'op-msg err'))
      return
    }
    for (const block of health) {
      root.append(el('h3', block.title, 'op-muted'))
      const dl = document.createElement('dl')
      dl.className = 'op-kv'
      for (const r of block.rows) dl.append(el('dt', r.label), el('dd', r.error ? 'hiba: ' + r.error : r.value))
      root.append(dl)
    }
  }

  // --- vault (write-only) -------------------------------------------------

  async function loadVault() {
    const r = await api('GET', '/api/operator/vault')
    const body = $('op-vault')
    body.replaceChildren()
    if (!r.ok) { msg('op-vault-msg', 'A titok-lista nem tölthető be.', 'err'); return }
    for (const s of r.data.secrets) {
      const tr = document.createElement('tr')
      tr.append(el('td', s.id), el('td', s.label), el('td', s.updatedAt || s.createdAt))
      if (me.capabilities.vaultOverwrite) {
        tr.style.cursor = 'pointer'
        tr.title = 'Kattints az érték felülírásához'
        tr.addEventListener('click', () => { $('op-vault-id').value = s.id; $('op-vault-value').focus() })
      }
      body.append(tr)
    }
  }

  $('op-vault-form').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const id = $('op-vault-id').value.trim()
    const valueInput = $('op-vault-value')
    const label = $('op-vault-label').value.trim()
    const body = { value: valueInput.value }
    if (label) body.label = label
    const r = await api('PUT', '/api/operator/vault/' + encodeURIComponent(id), body)
    valueInput.value = ''
    if (r.status === 403 && r.data && r.data.capability === 'vaultOverwrite') {
      msg('op-vault-msg', 'Ez a titok már létezik, és felülírni a tulajdonos nem engedte.', 'err')
      return
    }
    if (r.ok) {
      msg('op-vault-msg', (r.data.created ? 'Létrehozva: ' : 'Felülírva: ') + id + '. A tulajdonos értesítést kapott.', 'ok')
      loadVault()
    } else {
      msg('op-vault-msg', 'Mentés sikertelen: ' + ((r.data && r.data.error) || r.status), 'err')
    }
  })

  // --- updates ------------------------------------------------------------

  $('op-update-check').addEventListener('click', async () => {
    msg('op-update-msg', 'Ellenőrzés…')
    const r = await api('POST', '/api/operator/updates/check')
    if (r.ok) { renderUpdate(r.data); msg('op-update-msg', r.data.behind ? 'Elérhető frissítés.' : 'Naprakész.', 'ok') }
    else msg('op-update-msg', 'Az ellenőrzés sikertelen.', 'err')
  })

  $('op-update-apply').addEventListener('click', async () => {
    if (!confirm('Frissítés telepítése? A dashboard közben újraindul, utána újra be kell lépni.')) return
    msg('op-update-msg', 'Telepítés elindítva…')
    const r = await api('POST', '/api/operator/updates/apply')
    if (r.ok) msg('op-update-msg', 'A frissítés fut. Pár perc múlva lépj be újra.', 'ok')
    else msg('op-update-msg', 'A frissítés nem indult el: ' + ((r.data && r.data.error) || r.status), 'err')
  })

  // --- boot ---------------------------------------------------------------

  async function refresh() {
    const r = await api('GET', '/api/operator/status')
    if (r.status === 401 || r.status === 403) { showLogin(''); return }
    if (!r.ok) { msg('op-fatal', 'Az állapot nem tölthető be (' + r.status + ').', 'err'); return }
    msg('op-fatal', '')
    renderAgents(r.data.agents)
    renderUpdate(r.data.update)
    renderQuota(r.data.quota)
    renderHost(r.data.host)
    renderNetwork(r.data.network)
    renderHealth(r.data.health)
  }

  $('op-refresh').addEventListener('click', refresh)

  async function boot() {
    const r = await api('GET', '/api/operator/me')
    if (!r.ok) { showLogin(''); return }
    me = r.data
    show('op-login', false)
    show('op-app', true)
    $('op-who').textContent = me.device + (me.expires_at ? ' · a kulcs lejár: ' + fmtTime(me.expires_at) : '')
    show('op-vault-card', !!me.capabilities.vaultWrite)
    await refresh()
    if (me.capabilities.vaultWrite) await loadVault()
  }

  boot()
  setInterval(() => { if (me && !$('op-app').hidden) refresh() }, 30000)
})()
