import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'

// === Activity (live agent status) ===
// ============================================================

let activityTimer = null

const ACTIVITY_STATE_META = {
  working: { label: () => t('activity.state.working'), cls: 'act-working', tip: 'Élő állapot (a tmux pane tartalmából, 3 másodpercenként): éppen dolgozik / gondolkodik.' },
  idle: { label: () => t('activity.state.idle'), cls: 'act-idle', tip: 'Élő állapot (3 másodpercenként): fut, de épp nem csinál semmit.' },
  unknown: { label: () => t('activity.state.unknown'), cls: 'act-unknown', tip: 'Élő állapot: nem sikerült megállapítani a session pane tartalmából.' },
  error: { label: () => t('activity.state.error'), cls: 'act-error', tip: 'Élő állapot: hiba látszik az ágens session paneljén.' },
  stopped: { label: () => t('activity.state.stopped'), cls: 'act-stopped', tip: 'Élő állapot: az ágens session nem fut.' },
}

// visibilitychange: resume kanban auto-refresh when page becomes visible.
// Uses window bridges until kanban.js is fully wired.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    window.stopKanbanRefresh?.()
  } else if (!document.getElementById('kanbanPage').hidden) {
    window.loadKanban?.()
    window.startKanbanRefresh?.()
  }
})

function startActivityPoll() {
  loadActivity()
  if (activityTimer) clearInterval(activityTimer)
  activityTimer = setInterval(loadActivity, 3000)
}

function stopActivityPoll() {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
}

async function loadActivity() {
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
    return (
      '<div class="activity-card ' + meta.cls + (canOpen ? ' act-clickable' : '') + '" data-agent="' + escapeHtml(a.name) + '">' +
        '<div class="activity-card-head">' +
          '<span class="activity-name">' + escapeHtml(a.name) + mainBadge + '</span>' +
          '<span style="display:flex;align-items:center;gap:8px">' +
            termIcon +
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

// Event delegation: clicking a running activity-card opens the terminal modal
;(() => {
  const actList = document.getElementById('activityList')
  if (actList) {
    actList.addEventListener('click', (e) => {
      const card = e.target.closest('.activity-card.act-clickable[data-agent]')
      if (card) window.openTerminalModal?.(card.dataset.agent)  // bridge until agent-terminal is extracted
    })
  }
})()



export { loadActivity, startActivityPoll, stopActivityPoll }
