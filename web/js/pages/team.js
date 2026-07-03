import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'

// === Team page ===
async function loadTeamGraph() {
  const container = document.getElementById('teamGraph')
  if (!container) return
  container.innerHTML = '<div class="team-empty">' + t('team.loading') + '</div>'
  try {
    const res = await fetch('/api/team/graph')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    renderTeamGraph(container, data)
  } catch (err) {
    container.innerHTML = `<div class="team-empty">${t('team.error', { msg: err.message || err })}</div>`
  }
}

function renderTeamGraph(container, data) {
  const { nodes, edges, mainAgentId } = data
  container.innerHTML = ''
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = new Map()
  for (const n of nodes) childrenOf.set(n.id, [])
  for (const e of edges) {
    if (childrenOf.has(e.from)) childrenOf.get(e.from).push(e.to)
  }
  const renderNode = (node) => {
    const div = document.createElement('div')
    div.className = 'team-node'
    if (node.role === 'main') div.classList.add('main')
    else if (node.role === 'leader') div.classList.add('leader')
    const roleLabel = node.role === 'main' ? t('team.role.main') : (node.role === 'leader' ? t('team.role.leader') : t('team.role.member'))
    const running = node.running ? t('team.running') : t('team.stopped')
    const avatarUrl = node.id === mainAgentId
      ? `/api/marveen/avatar?t=${Date.now()}`
      : `/api/agents/${encodeURIComponent(node.id)}/avatar?t=${Date.now()}`
    div.innerHTML = `
      <div class="team-node-avatar"><img src="${avatarUrl}" alt="${escapeHtml(node.label || node.id)}" onerror="this.style.display='none'"></div>
      <div class="team-node-name">${escapeHtml(node.label || node.id)}</div>
      <div class="team-node-meta">${escapeHtml(roleLabel)}</div>
      <div class="team-node-meta">${running}</div>
    `
    if (node.id !== mainAgentId) {
      div.addEventListener('click', () => openAgentDetail(node.id))
    }
    return div
  }
  // Render as a nested tree so each report sits directly under its own
  // manager. A flat BFS-by-row layout made a leader's reports look like they
  // belonged to whichever node happened to be above them in the row.
  const seen = new Set([mainAgentId])
  const renderSubtree = (id) => {
    const node = byId.get(id)
    if (!node) return null
    const col = document.createElement('div')
    col.className = 'team-subtree'
    col.appendChild(renderNode(node))
    const kids = (childrenOf.get(id) || []).filter(c => !seen.has(c) && byId.has(c))
    for (const c of kids) seen.add(c)
    if (kids.length) {
      const conn = document.createElement('div')
      conn.className = 'team-connector'
      col.appendChild(conn)
      const row = document.createElement('div')
      row.className = 'team-children'
      for (const c of kids) {
        const sub = renderSubtree(c)
        if (sub) row.appendChild(sub)
      }
      col.appendChild(row)
    }
    return col
  }
  // Main on top, then a row of its direct reports (each carrying its own
  // subtree beneath it).
  const mainNode = byId.get(mainAgentId)
  if (mainNode) {
    const mainRow = document.createElement('div')
    mainRow.className = 'team-level'
    mainRow.appendChild(renderNode(mainNode))
    container.appendChild(mainRow)
  }
  const directs = (childrenOf.get(mainAgentId) || []).filter(c => !seen.has(c) && byId.has(c))
  for (const c of directs) seen.add(c)
  if (directs.length) {
    const conn = document.createElement('div')
    conn.className = 'team-connector'
    container.appendChild(conn)
    const row = document.createElement('div')
    row.className = 'team-children team-roots'
    for (const c of directs) {
      const sub = renderSubtree(c)
      if (sub) row.appendChild(sub)
    }
    container.appendChild(row)
  }
  // Orphans (nodes not reachable from main, shouldn't happen with the auto
  // fallback on the backend but guard just in case) go to a trailing row.
  const orphans = nodes.filter(n => !seen.has(n.id))
  if (orphans.length) {
    const row = document.createElement('div')
    row.className = 'team-level'
    for (const n of orphans) row.appendChild(renderNode(n))
    container.appendChild(row)
  }
  if (nodes.length === 1) {
    const empty = document.createElement('div')
    empty.className = 'team-empty'
    empty.textContent = t('team.empty')
    container.appendChild(empty)
  }
}

const refreshTeamBtn = document.getElementById('refreshTeamBtn')
if (refreshTeamBtn) refreshTeamBtn.addEventListener('click', loadTeamGraph)

export { loadTeamGraph, renderTeamGraph }
