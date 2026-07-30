import { escapeHtml } from './util.js'
import { t } from './i18n.js'


// ============================================================
// === Activity (live agent status) ===
// ============================================================

let activityTimer = null
let _openTerminalModalFn = null

const ACTIVITY_STATE_META = {
  working: { label: () => t('activity.state.working'), cls: 'act-working', tip: 'Élő állapot (a tmux pane tartalmából, 3 másodpercenként): éppen dolgozik / gondolkodik.' },
  idle: { label: () => t('activity.state.idle'), cls: 'act-idle', tip: 'Élő állapot (3 másodpercenként): fut, de épp nem csinál semmit.' },
  unknown: { label: () => t('activity.state.unknown'), cls: 'act-unknown', tip: 'Élő állapot: nem sikerült megállapítani a session pane tartalmából.' },
  error: { label: () => t('activity.state.error'), cls: 'act-error', tip: 'Élő állapot: hiba látszik az ágens session paneljén.' },
  stopped: { label: () => t('activity.state.stopped'), cls: 'act-stopped', tip: 'Élő állapot: az ágens session nem fut.' },
}

export function startActivityPoll() {
  loadActivity()
  if (activityTimer) clearInterval(activityTimer)
  activityTimer = setInterval(loadActivity, 3000)
}

export function stopActivityPoll() {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
}

export async function loadActivity() {
  try {
    const res = await fetch('/api/agents/activity')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const entries = await res.json()
    renderActivity(entries)
    const upd = document.getElementById('activityUpdated')
    if (upd) upd.textContent = t('activity.updated', { time: new Date().toLocaleTimeString('hu-HU') })
  } catch (e) {
    const list = document.getElementById('activityList')
    if (list) list.innerHTML = '<p class="activity-empty">' + t('activity.error_load') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
  }
}

function renderActivity(entries) {
  const list = document.getElementById('activityList')
  if (!list) return
  if (!Array.isArray(entries) || entries.length === 0) {
    list.innerHTML = '<p class="activity-empty">' + t('activity.empty') + '</p>'
    return
  }
  list.innerHTML = entries.map((a) => {
    const metaRaw = ACTIVITY_STATE_META[a.state] || ACTIVITY_STATE_META.unknown
    const meta = { ...metaRaw, label: typeof metaRaw.label === 'function' ? metaRaw.label() : metaRaw.label }
    const tail = (a.tail || []).map((l) => escapeHtml(l)).join('\n')
    const mainBadge = a.isMain ? '<span class="act-main-badge">' + t('activity.badge.main') + '</span>' : ''
    const canOpen = !!a.running
    const termIcon = canOpen
      ? '<svg class="act-term-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="' + t('activity.tooltip.terminal') + '"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
      : ''
    // Permission-mode chip. Shown for every mode EXCEPT the ones that let the
    // agent work on its own -- inverted on purpose: an unfamiliar mode is
    // exactly the one worth surfacing, so a future Claude Code mode shows up
    // here instead of hiding behind a list nobody remembered to extend.
    // Without this an agent parked in an ask-first mode renders as plain
    // 'idle', which is how one sat unusable for hours on 2026-07-27.
    const AUTONOMOUS_MODES = ['bypass permissions', 'accept edits', 'auto mode']
    const modeChip = a.mode && !AUTONOMOUS_MODES.includes(a.mode)
      ? '<span class="act-mode-badge" title="' + escapeHtml(t('activity.tooltip.mode', { mode: a.mode })) + '">' + escapeHtml(a.mode) + '</span>'
      : ''
    return (
      '<div class="activity-card ' + meta.cls + (canOpen ? ' act-clickable' : '') + '" data-agent="' + escapeHtml(a.name) + '">' +
        '<div class="activity-card-head">' +
          '<span class="activity-name">' + escapeHtml(a.name) + mainBadge + '</span>' +
          '<span style="display:flex;align-items:center;gap:8px">' +
            termIcon +
            modeChip +
            '<span class="activity-badge ' + meta.cls + '" title="' + escapeHtml(meta.tip || '') + '">' + meta.label + '</span>' +
          '</span>' +
        '</div>' +
        (tail
          ? '<pre class="activity-tail">' + tail + '</pre>'
          : '<p class="activity-tail-empty">' + (a.running ? 'nincs friss kimenet' : 'a session nem fut') + '</p>') +
      '</div>'
    )
  }).join('')
}

export function initActivity({ openTerminalModal }) {
  _openTerminalModalFn = openTerminalModal
  const actList = document.getElementById('activityList')
  if (actList) {
    actList.addEventListener('click', (e) => {
      const card = e.target.closest('.activity-card.act-clickable[data-agent]')
      if (card && _openTerminalModalFn) _openTerminalModalFn(card.dataset.agent)
    })
  }
}

// ============================================================
// === Overview page ===
// ============================================================

let _ovLoadGen = 0
let _ovActiveAgentFilter = null

function formatRelative(ts) {
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('common.time.now_abbr')
  if (min < 60) return t('common.time.min_abbr', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('common.time.hour_abbr', { h: hr })
  const day = Math.floor(hr / 24)
  return t('common.time.day_abbr', { n: day })
}

function fmtTokensShort(n) {
  if (!n || n === 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M'
  if (n >= 1_000) return Math.round(n / 1000) + 'k'
  return String(n)
}

function ovActivityIcon(type) {
  if (type === 'delegate') return '\u{1F4AC}'
  if (type === 'approval') return '\u{2705}'
  return '\u{1F4A1}'
}

function _ovRenderActivityFeed() {
  const feed = document.getElementById('ovActivityFeed')
  if (!feed) return
  feed.querySelectorAll('.ov-activity-row').forEach(r => {
    r.hidden = _ovActiveAgentFilter !== null && r.dataset.agent !== _ovActiveAgentFilter
  })
}

export async function loadOverview() {
  const gen = ++_ovLoadGen
  try {
    const res = await fetch('/api/overview')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    if (gen !== _ovLoadGen) return
    const d = await res.json()

    // === Zone 1: Fleet Health bar ===
    const running = d.agents.running
    const total = d.agents.total
    const pendingApprovals = d.pendingApprovals || 0
    const errors4h = d.errors4h || 0
    const unread = d.unreadMessages || 0
    const stuck = d.stuckTasks || 0

    document.getElementById('fhAgentsText').textContent = running + '/' + total
    document.getElementById('fhApprovalsText').textContent = pendingApprovals
    document.getElementById('fhCostText').textContent = d.costTodayUsd > 0 ? '$' + d.costTodayUsd.toFixed(2) : '—'
    document.getElementById('fhErrorsText').textContent = errors4h

    const bar = document.getElementById('fleetHealthBar')
    const dot = document.getElementById('fhDot')
    const alertLevel = errors4h > 0 || stuck > 0 ? 'danger' : pendingApprovals > 0 ? 'warn' : ''
    bar.className = 'fh-bar' + (alertLevel ? ' fh-' + alertLevel : '')
    dot.className = 'fh-dot' + (alertLevel ? ' ' + alertLevel : '')

    // === Zone 2: Attention Required ===
    const attSection = document.getElementById('attentionSection')
    const attBody = document.getElementById('attentionBody')
    const attBadge = document.getElementById('attentionBadge')
    const attItems = []

    if (pendingApprovals > 0) attItems.push({ icon: '⏳', text: pendingApprovals + ' üggő jóváhagyás vár', href: '#approvals', label: 'Megnyitás' })
    if (unread > 0) attItems.push({ icon: '\u{1F4AC}', text: unread + ' kézbesítetlen inter-agent üzenet', href: '#messages', label: 'Üzenetek' })
    if (stuck > 0) attItems.push({ icon: '⏰', text: stuck + ' ütemezett feladat elakadt', href: '#tasks', label: 'Feladatok' })
    if (errors4h > 0) attItems.push({ icon: '⚠', text: errors4h + ' hiba az elmúlt 4 órában', href: '#status', label: 'Státusz' })
    const stoppedAgents = (d.agents.list || []).filter(function(a) { return !a.running && a.role !== 'main' })
    if (stoppedAgents.length > 0) attItems.push({ icon: '\u{1F534}', text: stoppedAgents.length + ' ágens nem fut (' + stoppedAgents.map(function(a) { return a.label }).join(', ') + ')', href: '#agents', label: 'Ágensek' })

    if (attItems.length > 0) {
      attSection.hidden = false
      attBadge.textContent = attItems.length
      attBody.innerHTML = attItems.map(function(item) {
        return '<div class="attention-item"><span>' + escapeHtml(item.icon) + '</span><span>' + escapeHtml(item.text) + '</span><a href="' + escapeHtml(item.href) + '">' + escapeHtml(item.label) + '</a></div>'
      }).join('')
      const toggle = document.getElementById('attentionToggle')
      const header = document.getElementById('attentionHeader')
      header.onclick = function() {
        const collapsed = attBody.classList.toggle('collapsed')
        toggle.classList.toggle('collapsed', collapsed)
      }
    } else {
      attSection.hidden = true
    }

    // === Zone 3: Compact agents grid ===
    const grid = document.getElementById('agentsMiniGrid')
    if (grid && d.agents.list) {
      grid.innerHTML = ''
      for (const a of d.agents.list) {
        const card = document.createElement('div')
        card.className = 'agent-mini-card ' + (a.running ? 'running' : 'stopped')
        card.title = a.running ? 'Fut' : 'Nem fut'
        card.onclick = function() { location.hash = 'agents' }
        const lastActiveMs = a.lastActive ? a.lastActive * 1000 : null
        const lastActiveText = lastActiveMs ? formatRelative(lastActiveMs) : (a.running ? 'fut' : 'inaktív')
        card.innerHTML = '<div class="agent-mini-avatar"><img src="' + escapeHtml(a.avatarUrl) + '" alt="" onerror="this.style.display=\'none\'"></div>'
          + '<div class="agent-mini-info">'
          + '<div class="agent-mini-name">' + escapeHtml(a.label) + '</div>'
          + '<div class="agent-mini-meta ' + (a.running ? '' : 'stopped') + '"><span class="dot"></span>' + (a.running ? 'fut' : 'áll') + ' &middot; ' + escapeHtml(lastActiveText) + '</div>'
          + '</div>'
        grid.appendChild(card)
      }
    }

    // === Zone 4: Activity feed with agent filter pills ===
    const feed = document.getElementById('ovActivityFeed')
    const pillsEl = document.getElementById('ovActivityPills')
    _ovActiveAgentFilter = null
    if (feed) {
      feed.innerHTML = ''
      if (!d.activity || d.activity.length === 0) {
        feed.innerHTML = '<div class="ov-activity-empty">Nincs aktivitás az elmúlt 4 órában.</div>'
      } else {
        const agentSet = new Set()
        for (const a of d.activity) if (a.agent) agentSet.add(a.agent)
        const agentList = Array.from(agentSet)

        if (pillsEl && agentList.length > 1) {
          pillsEl.innerHTML = ''
          const allPill = document.createElement('button')
          allPill.className = 'ov-pill active'
          allPill.textContent = 'Mind'
          allPill.onclick = function() {
            _ovActiveAgentFilter = null
            pillsEl.querySelectorAll('.ov-pill').forEach(function(p) { p.classList.remove('active') })
            allPill.classList.add('active')
            _ovRenderActivityFeed()
          }
          pillsEl.appendChild(allPill)
          for (const ag of agentList) {
            const pill = document.createElement('button')
            pill.className = 'ov-pill'
            pill.textContent = ag
            pill.onclick = function() {
              _ovActiveAgentFilter = ag
              pillsEl.querySelectorAll('.ov-pill').forEach(function(p) { p.classList.remove('active') })
              pill.classList.add('active')
              _ovRenderActivityFeed()
            }
            pillsEl.appendChild(pill)
          }
        } else if (pillsEl) {
          pillsEl.innerHTML = ''
        }

        for (const a of d.activity) {
          const row = document.createElement('div')
          row.className = 'ov-activity-row'
          row.dataset.agent = a.agent || ''
          row.innerHTML = '<span class="ov-activity-icon">' + ovActivityIcon(a.icon) + '</span>'
            + '<span class="ov-activity-agent">' + escapeHtml(a.agent || '') + '</span>'
            + '<span class="ov-activity-text" title="' + escapeHtml(a.text) + '">' + escapeHtml(a.text) + '</span>'
            + '<span class="ov-activity-time">' + formatRelative(a.at) + '</span>'
          feed.appendChild(row)
        }
      }
    }

    // === Zone 5: KPI strip ===
    const taskDiff = d.tasksToday - d.tasksYesterday
    document.getElementById('kpiTasks').textContent = d.tasksToday
    const trendEl = document.getElementById('kpiTasksTrend')
    if (trendEl) {
      if (taskDiff > 0) { trendEl.textContent = '+' + taskDiff; trendEl.className = 'kpi-trend up' }
      else if (taskDiff < 0) { trendEl.textContent = String(taskDiff); trendEl.className = 'kpi-trend down' }
      else { trendEl.textContent = ''; trendEl.className = 'kpi-trend' }
    }
    document.getElementById('kpiCost').textContent = d.costTodayUsd > 0 ? '$' + d.costTodayUsd.toFixed(2) : '—'
    document.getElementById('kpiMemories').textContent = d.memories.count.toLocaleString('hu-HU').replace(/,/g, ' ')
    document.getElementById('kpiSkills').textContent = d.skills.count
    document.getElementById('kpiTokens').textContent = fmtTokensShort(d.tokensToday)

  } catch (err) {
    const feed = document.getElementById('ovActivityFeed')
    if (feed) feed.innerHTML = '<div class="ov-activity-empty" style="color:var(--danger)">Hiba: ' + escapeHtml(String(err.message || err)) + '</div>'
  }
}
