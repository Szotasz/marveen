import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'
import { renderTeamGraph } from '/js/pages/team.js'

// === Overview page ===
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

async function loadOverview() {
  try {
    const res = await fetch('/api/overview')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    // Stats
    document.getElementById('statAgents').textContent = d.agents.running
    document.getElementById('statAgentsSub').textContent = t('overview.stat.agents_sub', { n: d.agents.total })
    document.getElementById('statTasks').textContent = d.tasksToday
    const taskDiff = d.tasksToday - d.tasksYesterday
    document.getElementById('statTasksSub').textContent = taskDiff === 0 ? t('overview.stat.same_as_yesterday') : (taskDiff > 0 ? '+' + taskDiff + ' ' + t('overview.stat.change', { n: '' }).trim() : taskDiff + ' ' + t('overview.stat.change', { n: '' }).trim())
    document.getElementById('statMemories').textContent = d.memories.count.toLocaleString('hu-HU').replace(/,/g, ' ')
    document.getElementById('statMemoriesSub').textContent = `${t('overview.stat.sub.memories')} · ${d.memories.categories} category`
    document.getElementById('statSkills').textContent = d.skills.count
    document.getElementById('statSkillsSub').textContent = d.skills.today > 0 ? t('overview.stat.skills_today', { n: d.skills.today }) : ''
    // Team: reuse the hierarchy graph renderer so the overview card shows
    // exactly what the Csapat page does (avatars + reports-to tree).
    try {
      const tg = await fetch('/api/team/graph')
      if (tg.ok) {
        const graph = await tg.json()
        renderTeamGraph(document.getElementById('overviewTeamGrid'), graph)
      }
    } catch {}
    // Activity
    const act = document.getElementById('overviewActivity')
    act.innerHTML = ''
    if (!d.activity || d.activity.length === 0) {
      act.innerHTML = '<div style="color:var(--text-muted);font-size:13px">' + t('overview.no_activity') + '</div>'
    } else {
      for (const a of d.activity) {
        const icon = a.icon === 'delegate'
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3C7.5 3 4 6.5 4 11v4l-2 3h4v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2h4l-2-3v-4c0-4.5-3.5-8-8-8z"/></svg>'
        const item = document.createElement('div')
        item.className = 'overview-activity-item'
        item.innerHTML = `
          <div class="overview-activity-icon">${icon}</div>
          <div class="overview-activity-body">
            <div class="overview-activity-title">${escapeHtml(a.text)}</div>
            <div class="overview-activity-time">${formatRelative(a.at)}</div>
          </div>
        `
        act.appendChild(item)
      }
    }
  } catch (err) {
    document.getElementById('overviewActivity').innerHTML = '<div style="color:var(--text-muted);font-size:13px">' + t('overview.error', { msg: escapeHtml(String(err.message || err)) }) + '</div>'
  }
}

// Brand mark + product-brand chrome: pull the configured brand from
// /api/marveen and apply it to the dashboard chrome (tab title, mobile topbar,
// sidebar name, updates subtitle). brandName is the product/system name and is
// distinct from the main agent's display name; the backend defaults brandName to
// BOT_NAME, so a brand-unaware install keeps showing the agent name. If the
// field is absent (legacy backend) the existing HTML default text is kept.
async function initSidebarBrand() {
  try {
    const img = document.createElement('img')
    img.src = '/api/marveen/avatar?t=' + Date.now()
    img.onload = () => {
      const mark = document.getElementById('sidebarBrandMark')
      if (mark) { mark.textContent = ''; mark.appendChild(img) }
    }
    const res = await fetch('/api/marveen')
    if (res.ok) {
      const m = await res.json()
      const brand = m.brandName || m.name
      if (brand) {
        document.title = brand
        const topbar = document.getElementById('mobileTopbarTitle')
        if (topbar) topbar.textContent = brand
        const name = document.getElementById('sidebarBrandName')
        if (name) name.textContent = brand
        const subtitle = document.getElementById('updatesSubtitle')
        if (subtitle) subtitle.textContent = `${brand} ` + t('overview.updates_subtitle')
      }
    }
  } catch {}
}
initSidebarBrand()


export { loadOverview }
