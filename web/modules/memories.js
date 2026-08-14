import { escapeHtml, highlightJson, mainAgentId } from './util.js'
import { renderMarkdown } from './docs-research.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'


let _openModal = null, _closeModal = null
export function initMemories({ openModal, closeModal } = {}) {
  _openModal = openModal; _closeModal = closeModal
}

// ============================================================
// ============================================================
// === Memories (Tier System + Daily Log) ===
// ============================================================

const memList = document.getElementById('memList')
const memEmpty = document.getElementById('memEmpty')
const memStats = document.getElementById('memStats')
const memSearchInput = document.getElementById('memSearchInput')
const memModalOverlay = document.getElementById('memModalOverlay')

let memSearchTimer = null
let currentMemTier = 'hot'
let currentLogDate = new Date().toISOString().split('T')[0]
let logDates = []

const tierLabels = { hot: '\u{1F525} Hot', warm: '\u{1F321}\uFE0F Warm', cold: '\u2744\uFE0F Cold', shared: '\u{1F517} Shared' }
const tierColors = { hot: '#dc3c3c', warm: '#d97757', cold: '#6a9bcc', shared: '#9a8a30' }

// Populate agent dropdowns from API
export async function loadMemAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('memAgentFilter')
    const memSel = document.getElementById('memAgent')
    sel.innerHTML = `<option value="">${t('memories.agent_all')}</option>`
    memSel.innerHTML = ''
    for (const a of agents) {
      sel.innerHTML += `<option value="${a.name}">${a.label}</option>`
      memSel.innerHTML += `<option value="${a.name}">${a.label}</option>`
    }
  } catch {}
}

// Node-limit slider
;(function() {
  const slider = document.getElementById('graphNodeLimit')
  const valEl = document.getElementById('graphNodeLimitVal')
  if (slider && valEl) {
    slider.addEventListener('input', () => {
      valEl.textContent = slider.value
    })
    slider.addEventListener('change', () => {
      valEl.textContent = slider.value
      if (currentMemTier === 'graph') loadMemoryGraph()
    })
  }
})()

// Agent filter change
document.getElementById('memAgentFilter')?.addEventListener('change', () => {
  if (currentMemTier === 'graph') {
    loadMemoryGraph()
  } else if (currentMemTier === 'log') {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Search with debounce
memSearchInput?.addEventListener('input', () => {
  clearTimeout(memSearchTimer)
  memSearchTimer = setTimeout(loadMemories, 300)
})

// Enter to search immediately
memSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(memSearchTimer)
    loadMemories()
  }
})

// Tab switching
document.getElementById('memTabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.mem-tab')
  if (!tab) return
  document.querySelectorAll('.mem-tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  currentMemTier = tab.dataset.tier

  const isLog   = currentMemTier === 'log'
  const isGraph = currentMemTier === 'graph'

  document.getElementById('memTierView').hidden  = isLog || isGraph
  document.getElementById('memLogView').hidden   = !isLog
  document.getElementById('memGraphView').hidden = !isGraph

  if (isGraph) {
    loadMemoryGraph()
  } else if (isLog) {
    loadDailyLog()
  } else {
    loadMemories()
  }
})

// Add memory button
document.getElementById('memAddBtn')?.addEventListener('click', () => {
  document.getElementById('memModalTitle').textContent = t('memories.modal.title_new')
  document.getElementById('memContent').value = ''
  document.getElementById('memTier').value = (currentMemTier === 'log' || currentMemTier === 'graph') ? 'warm' : currentMemTier
  document.getElementById('memKeywords').value = ''
  document.getElementById('memEditId').value = ''
  // New memory: hide Előzmények tab, reset to edit
  document.getElementById('memHistoryTabBtn').hidden = true
  switchMemModalTab('edit')
  _openModal?.(memModalOverlay)
  setTimeout(() => document.getElementById('memContent').focus(), 200)
})

// Close memory modal
document.getElementById('memModalClose')?.addEventListener('click', () => _closeModal?.(memModalOverlay))
memModalOverlay?.addEventListener('click', (e) => { if (e.target === memModalOverlay) _closeModal?.(memModalOverlay) })

// Save memory (create or edit)
document.getElementById('saveMemBtn')?.addEventListener('click', async () => {
  const content = document.getElementById('memContent').value.trim()
  if (!content) { document.getElementById('memContent').focus(); return }

  const editId = document.getElementById('memEditId').value
  const tier = document.getElementById('memTier').value
  const agentId = document.getElementById('memAgent').value
  const keywords = document.getElementById('memKeywords').value.trim()

  try {
    if (editId) {
      await fetch(`/api/memories/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, tier, agent_id: agentId, keywords }),
      })
      showToast(t('memories.toast.updated'))
    } else {
      await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, content, tier, keywords }),
      })
      showToast(t('memories.toast.created'))
    }
    _closeModal?.(memModalOverlay)
    loadMemories()
    loadMemStats()
  } catch {
    showToast(t('common.error_save'))
  }
})

export async function loadMemStats() {
  try {
    const [statsRes, ovRes] = await Promise.all([
      fetch('/api/memories/stats'),
      fetch('/api/overview'),
    ])
    const stats = await statsRes.json()
    const ov = await ovRes.json()
    const embCount = stats.withEmbedding || 0
    const embPct = stats.total > 0 ? Math.round(embCount / stats.total * 100) : 0
    const artifactCount = ov.artifacts?.count ?? 0
    memStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">${t('memories.stat.total')}</div></div>
      ${Object.entries(stats.byTier || {}).map(([tier, count]) =>
        `<div class="stat-card"><div class="stat-value" style="color:${tierColors[tier] || 'var(--accent)'}">${count}</div><div class="stat-label">${tierLabels[tier] || tier}</div></div>`
      ).join('')}
      <div class="stat-card"><div class="stat-value">${embCount}</div><div class="stat-label">${t('memories.stat.vectors_pct', { pct: embPct })}</div></div>
      <div class="stat-card"><div class="stat-value">${artifactCount}</div><div class="stat-label">${t('memories.stat.artifacts')}</div></div>
      <button class="btn-secondary btn-compact" id="memBackfillBtn" style="margin-left:auto;font-size:11px;padding:6px 12px;align-self:center">${t('memories.stat.vectors_btn')}</button>
    `
    document.getElementById('memBackfillBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('memBackfillBtn')
      if (btn) { btn.textContent = t('memories.stat.vectors_gen'); btn.disabled = true }
      try {
        const r = await fetch('/api/memories/backfill', { method: 'POST' })
        const data = await r.json()
        showToast(t('memories.toast.vector_count', { count: data.count }))
        loadMemStats()
      } catch { showToast(t('memories.toast.vector_error')) }
    })
  } catch (err) {
    console.error('Stats hiba:', err)
  }
}

export async function loadMemories() {
  if (currentMemTier === 'log' || currentMemTier === 'graph') return
  const q = memSearchInput.value.trim()
  const agent = document.getElementById('memAgentFilter').value
  const searchMode = document.getElementById('memSearchMode')?.value || 'hybrid'
  const params = new URLSearchParams()
  if (q) {
    params.set('q', q)
    params.set('mode', searchMode)
  }
  if (agent) params.set('agent', agent)
  if (currentMemTier) params.set('tier', currentMemTier)
  params.set('limit', '50')

  try {
    const [memoriesRes, staleRes] = await Promise.all([
      fetch(`/api/memories?${params}`),
      agent ? fetch(`/api/memories/stale?agent_id=${encodeURIComponent(agent)}`) : Promise.resolve(null),
    ])
    const memories = await memoriesRes.json()
    const staleIds = staleRes
      ? new Set((await staleRes.json()).map(m => m.id))
      : new Set()
    renderMemories(memories, staleIds)
  } catch (err) {
    console.error('Memória betöltés hiba:', err)
  }
}

function renderMemories(memories, staleIds = new Set()) {
  memList.innerHTML = ''
  memEmpty.hidden = memories.length > 0

  for (const mem of memories) {
    const item = document.createElement('div')
    item.className = 'mem-item'

    const tier = mem.tier || mem.category || 'warm'
    const tierBadge = tierLabels[tier] || tier
    const badgeClass = 'badge-' + tier
    const shortContent = mem.content.length > 120 ? mem.content.slice(0, 120) + '...' : mem.content
    const agentLabel = mem.agent_id || mainAgentId()
    const isStale = staleIds.has(mem.id)

    // Build keywords HTML
    let keywordsHtml = ''
    if (mem.keywords) {
      const kws = typeof mem.keywords === 'string' ? mem.keywords.split(',').map(k => k.trim()).filter(Boolean) : mem.keywords
      if (kws.length > 0) {
        keywordsHtml = `<div class="mem-keywords">${kws.map(k => `<span class="mem-keyword-tag">${escapeHtml(k)}</span>`).join('')}</div>`
      }
    }

    item.innerHTML = `
      <div class="mem-item-header">
        <span class="badge ${badgeClass}">${tierBadge}</span>
        <span class="mem-agent-badge">${escapeHtml(agentLabel)}</span>
        <span class="mem-date">${escapeHtml(mem.created_label || '')}</span>
        ${isStale ? '<span class="mem-stale-badge" title="Frissult mióta az ágens utoljára olvasta">elavult</span>' : ''}
        ${typeof mem.salience === 'number' ? `<span class="mem-salience" title="Relevancia ertek">S: ${mem.salience.toFixed(2)}</span>` : ''}
      </div>
      <div class="mem-content-short">${escapeHtml(shortContent)}</div>
      <div class="mem-content-full">${escapeHtml(mem.content)}</div>
      ${keywordsHtml}
      <div class="mem-item-footer">
        <button class="btn-secondary" data-edit-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">${t('common.btn.edit')}</button>
        <button class="btn-danger" data-memid="${mem.id}" style="padding:6px 14px; font-size:12px;">${t('common.btn.delete')}</button>
      </div>
    `

    // Toggle expand
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-danger') || e.target.closest('.btn-secondary')) return
      item.classList.toggle('expanded')
    })

    // Edit
    const editBtn = item.querySelector('[data-edit-memid]')
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openMemEditModal(mem, tier)
    })

    // Delete
    const delBtn = item.querySelector('.btn-danger')
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Biztosan torlod ezt az emleket?')) return
      try {
        await fetch(`/api/memories/${mem.id}`, { method: 'DELETE' })
        showToast(t('memories.toast.deleted'))
        loadMemories()
        loadMemStats()
      } catch {
        showToast(t('common.error_delete'))
      }
    })

    memList.appendChild(item)
  }
}

// === Memory modal tab management ===

function switchMemModalTab(tabName) {
  document.querySelectorAll('#memModalTabNav .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.memTab === tabName)
  })
  document.getElementById('memEditPanel').hidden = tabName !== 'edit'
  document.getElementById('memHistoryPanel').hidden = tabName !== 'history'
}

document.getElementById('memModalTabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn[data-mem-tab]')
  if (!btn) return
  const tab = btn.dataset.memTab
  switchMemModalTab(tab)
  if (tab === 'history') {
    const editId = document.getElementById('memEditId').value
    if (editId) loadMemVersions(parseInt(editId, 10))
  }
})

function openMemEditModal(mem, tier) {
  document.getElementById('memModalTitle').textContent = t('memories.modal.title_edit')
  document.getElementById('memContent').value = mem.content
  document.getElementById('memTier').value = tier
  document.getElementById('memKeywords').value = mem.keywords || ''
  document.getElementById('memEditId').value = mem.id
  if (mem.agent_id) document.getElementById('memAgent').value = mem.agent_id
  // Show Előzmények tab for existing memories
  document.getElementById('memHistoryTabBtn').hidden = false
  switchMemModalTab('edit')
  _openModal?.(memModalOverlay)
}

async function loadMemVersions(memId) {
  const list = document.getElementById('memVersionList')
  list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Betöltés...</p>'
  try {
    const res = await fetch(`/api/memories/${memId}/versions`)
    const versions = await res.json()
    if (!versions.length) {
      list.innerHTML = '<p class="mem-version-empty">Nincs korábbi verzió.</p>'
      return
    }
    list.innerHTML = versions.map((v, i) => {
      const date = new Date(v.changed_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
      const changeLabel = { update: 'tartalom', category_change: 'kategória', create: 'létrehozás' }[v.change_type] || v.change_type
      return `
        <div class="mem-version-item">
          <div class="mem-version-meta">
            <span class="mem-version-num">#${versions.length - i}</span>
            <span class="mem-version-date">${escapeHtml(date)}</span>
            <span class="mem-version-by">${escapeHtml(v.changed_by || '')}</span>
            <span class="mem-version-type">${escapeHtml(changeLabel)}</span>
          </div>
          <div class="mem-version-content">${escapeHtml(v.content)}</div>
          ${v.category ? `<div class="mem-version-cat"><span class="badge badge-${v.category}">${escapeHtml(v.category)}</span></div>` : ''}
        </div>
      `
    }).join('')
  } catch {
    list.innerHTML = '<p class="mem-version-empty">Nem sikerült betölteni az előzményeket.</p>'
  }
}

// === Memory Graph (Force-directed, Obsidian-style) ===

let graphNodes = []
let graphEdges = []
let graphSim = null
let graphCanvas = null
let graphCtx = null
let graphDragging = null
let graphHover = null
let graphSelectedNode = null
let graphSearchQuery = ''

// Zoom & pan state
let graphZoom = 1
let graphPanX = 0
let graphPanY = 0
let graphPanning = false
let graphPanStartX = 0
let graphPanStartY = 0
let graphZoomIndicatorTimer = null
let graphPanelHoverNeighborId = null  // mem.id of neighbor row being hovered in card
let graphCameraNudge = null           // {fromX, fromY, toX, toY, startMs, dur}
let graphNodePulseActive = null       // {node, startMs} for 600ms halo pulse on neighbor click

// Edge animation
let graphAnimFrame = 0

const GRAPH_TIER_COLORS = {
  hot: '#dc3c3c',
  warm: '#d97757',
  cold: '#6a9bcc',
  shared: '#b0a040',
}

// Poly spec: luminous dark-variants for ambient glow
const GRAPH_TIER_GLOW = {
  hot:    '#ff6b5e',
  warm:   '#ff9a70',
  cold:   '#8fc1ff',
  shared: '#e3cf5e',
}

const GRAPH_TIER_BG = {
  hot: 'rgba(220, 60, 60, 0.06)',
  warm: 'rgba(217, 119, 87, 0.06)',
  cold: 'rgba(106, 155, 204, 0.06)',
  shared: 'rgba(176, 160, 64, 0.06)',
}

// Offscreen glow sprites (pre-rendered at buildGraph time, reused every frame)
let graphGlowSprites = {}  // { [tier]: HTMLCanvasElement }
let graphParticleSprite = null
const GRAPH_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Idle animation state
let graphIdleRaf = null      // rAF handle for post-settle idle loop
let graphLastInteraction = Date.now()
let graphIdleSlowFrame = 0   // counts frames for 30fps throttle
let graphLastRenderTs = 0    // for delta-time based lerp

// Particle pool: up to 60 particles on active edges
let graphParticles = []  // [{ edgeIdx, t, speed }]

// Poly spec section 2: back-out easing for node pop-in (cubic-bezier(0.34,1.56,0.64,1))
function graphEaseOutBack(t) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function makeGlowSprite(hexColor, size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0.0, hexColor + '55')  // a=0.33
  grad.addColorStop(0.4, hexColor + '22')  // a=0.13
  grad.addColorStop(1.0, hexColor + '00')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}

function initGlowSprites() {
  const size = (window.devicePixelRatio || 1) >= 2 ? 256 : 128
  for (const tier of Object.keys(GRAPH_TIER_GLOW)) {
    graphGlowSprites[tier] = makeGlowSprite(GRAPH_TIER_GLOW[tier], size)
  }
  graphGlowSprites['white'] = makeGlowSprite('#ffffff', size)
  graphParticleSprite = makeGlowSprite('#ffffff', 32)
}

function screenToWorld(sx, sy) {
  return { x: (sx - graphPanX) / graphZoom, y: (sy - graphPanY) / graphZoom }
}

function worldToScreen(wx, wy) {
  return { x: wx * graphZoom + graphPanX, y: wy * graphZoom + graphPanY }
}

async function loadMemoryGraph() {
  const agent = document.getElementById('memAgentFilter').value
  const limitEl = document.getElementById('graphNodeLimit')
  const limit = limitEl ? parseInt(limitEl.value, 10) || 200 : 200
  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  params.set('limit', String(Math.min(500, Math.max(1, limit))))
  params.set('weight_min', '0.75')

  try {
    const res = await fetch(`/api/memories/graph?${params}`)
    const graphData = await res.json()

    const emptyEl = document.getElementById('graphEmpty')
    if (!graphData.nodes || graphData.nodes.length === 0) {
      emptyEl.hidden = false
      document.getElementById('memGraphCanvas').hidden = true
      return
    }
    emptyEl.hidden = true
    document.getElementById('memGraphCanvas').hidden = false

    graphZoom = 1
    graphPanX = 0
    graphPanY = 0
    graphSelectedNode = null
    hideGraphPanel()

    buildGraph(graphData)
    startGraphSimulation()
  } catch (err) {
    console.error('Gráf betöltés hiba:', err)
  }
}

function buildGraph(graphData) {
  graphNodes = []
  graphEdges = []

  const canvas = document.getElementById('memGraphCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  graphCanvas = canvas
  graphCtx = canvas.getContext('2d')
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const w = rect.width
  const h = rect.height

  // Build nodes from /api/memories/graph response
  for (const node of graphData.nodes) {
    graphNodes.push({
      id: node.id,
      x: w / 2 + (Math.random() - 0.5) * w * 0.6,
      y: h / 2 + (Math.random() - 0.5) * h * 0.6,
      vx: 0,
      vy: 0,
      radius: 6,
      connectionCount: 0,
      label: node.label.replace(/\n/g, ' '),
      tier: node.tier || 'warm',
      agent: node.agent || mainAgentId(),
      keywords: [],        // not in graph response; keyword fallback uses this
      degree: node.degree, // pre-computed by backend
      created_at: node.created_at,
      accessed_at: node.accessed_at,
      mem: node,
      searchMatch: true,
    })
  }

  // Build id -> node index map for fast lookup
  const idToIdx = new Map()
  graphNodes.forEach((node, idx) => idToIdx.set(node.id, idx))

  // Semantic edges from the graph endpoint (AND-filtered, both endpoints present)
  const semanticEdgeIds = new Set()
  for (const edge of (graphData.edges || [])) {
    const si = idToIdx.get(edge.src_id)
    const di = idToIdx.get(edge.dst_id)
    if (si === undefined || di === undefined) continue
    const a = graphNodes[si]
    const b = graphNodes[di]
    const strength = edge.weight || 0.5
    graphEdges.push({ source: si, target: di, strength, semantic: true })
    a.connectionCount += strength
    b.connectionCount += strength
    semanticEdgeIds.add(`${Math.min(si, di)}-${Math.max(si, di)}`)
  }

  // Keyword-based fallback for orphan nodes (no semantic links)
  for (let i = 0; i < graphNodes.length; i++) {
    for (let j = i + 1; j < graphNodes.length; j++) {
      if (semanticEdgeIds.has(`${i}-${j}`)) continue
      const a = graphNodes[i]
      const b = graphNodes[j]
      const shared = a.keywords.filter(k => b.keywords.includes(k))
      if (shared.length > 0) {
        graphEdges.push({ source: i, target: j, strength: shared.length * 0.3, semantic: false })
        a.connectionCount += shared.length * 0.3
        b.connectionCount += shared.length * 0.3
      }
    }
  }

  // Node radius uses backend degree; orphan/hub badges use same
  const HUB_THRESHOLD = 5
  for (const node of graphNodes) {
    node.radius = 5 + Math.min(Math.sqrt(node.connectionCount) * 2.5, 14)
    node.isOrphan = node.degree === 0
    node.isHub = node.degree >= HUB_THRESHOLD
    node.importance = node.connectionCount + (node.isHub ? 10 : 0) + (node.tier === 'hot' ? 2 : 0)
    node.labelAlpha = 0
  }

  // Pop-in animation: stagger entry by node index (Poly spec section 2)
  const popStagger = GRAPH_REDUCED_MOTION ? 0 : Math.min(10, 1200 / Math.max(graphNodes.length, 1))
  const nowInit = Date.now()
  for (let ni = 0; ni < graphNodes.length; ni++) {
    graphNodes[ni].birthMs = nowInit + ni * popStagger
    graphNodes[ni].renderedAlpha = 0  // lerp start value for hover-crossfade
  }
  graphLastRenderTs = 0  // reset delta tracker on new graph

  // Ensure controls hint and zoom indicator exist
  const graphView = document.getElementById('memGraphView')
  if (!graphView.querySelector('.graph-controls-hint')) {
    const hint = document.createElement('div')
    hint.className = 'graph-controls-hint'
    hint.innerHTML = 'Scroll: zoom | Drag: move nodes<br>Click: details | Dbl-click: edit'
    graphView.appendChild(hint)
  }
  if (!graphView.querySelector('.graph-zoom-indicator')) {
    const zi = document.createElement('div')
    zi.className = 'graph-zoom-indicator'
    zi.id = 'graphZoomIndicator'
    graphView.appendChild(zi)
  }
}

function simulateGraphStep(damping) {
  const w = graphCanvas.width / (window.devicePixelRatio || 1)
  const h = graphCanvas.height / (window.devicePixelRatio || 1)
  const nodes = graphNodes

  const tierCenters = {}
  for (const node of nodes) {
    if (!tierCenters[node.tier]) tierCenters[node.tier] = { x: 0, y: 0, count: 0 }
    tierCenters[node.tier].x += node.x
    tierCenters[node.tier].y += node.y
    tierCenters[node.tier].count++
  }
  for (const tier of Object.keys(tierCenters)) {
    tierCenters[tier].x /= tierCenters[tier].count
    tierCenters[tier].y /= tierCenters[tier].count
  }
  for (const node of nodes) {
    const tc = tierCenters[node.tier]
    if (tc) {
      node.vx += (tc.x - node.x) * 0.0035
      node.vy += (tc.y - node.y) * 0.0035
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[j].x - nodes[i].x
      let dy = nodes[j].y - nodes[i].y
      let dist = Math.sqrt(dx * dx + dy * dy) || 1
      let force = 2400 / (dist * dist)
      let fx = (dx / dist) * force
      let fy = (dy / dist) * force
      nodes[i].vx -= fx
      nodes[i].vy -= fy
      nodes[j].vx += fx
      nodes[j].vy += fy
    }
  }

  for (const edge of graphEdges) {
    const a = nodes[edge.source]
    const b = nodes[edge.target]
    let dx = b.x - a.x
    let dy = b.y - a.y
    let dist = Math.sqrt(dx * dx + dy * dy) || 1
    // Degree-weighted rest length: higher-degree nodes pull neighbors closer.
    // Clamp prevents hub collapse (min 40px) while preserving island separation.
    const degSum = (a.degree || 0) + (b.degree || 0)
    const restLength = Math.max(40, 140 - 10.0 * Math.min(degSum, 44))
    let force = (dist - restLength) * 0.005 * edge.strength
    // Cap force to prevent oscillation on very short edges
    force = Math.max(-4, Math.min(4, force))
    let fx = (dx / dist) * force
    let fy = (dy / dist) * force
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  for (const node of nodes) {
    node.vx += (w / 2 - node.x) * 0.001
    node.vy += (h / 2 - node.y) * 0.001
  }

  const maxV = 6
  for (const node of nodes) {
    if (node === graphDragging) continue
    node.vx *= damping
    node.vy *= damping
    if (node.vx > maxV) node.vx = maxV; else if (node.vx < -maxV) node.vx = -maxV
    if (node.vy > maxV) node.vy = maxV; else if (node.vy < -maxV) node.vy = -maxV
    node.x += node.vx
    node.y += node.vy
    node.x = Math.max(-200, Math.min(w + 200, node.x))
    node.y = Math.max(-200, Math.min(h + 200, node.y))
  }
}

function startGraphSimulation() {
  if (graphSim) cancelAnimationFrame(graphSim)
  if (graphIdleRaf) cancelAnimationFrame(graphIdleRaf)
  graphParticles = []
  initGlowSprites()

  for (const node of graphNodes) {
    node.vx = 0
    node.vy = 0
    // Randomize idle drift parameters per node (stable per session)
    node.driftF = 0.3 + (node.id % 13) * 0.015   // 0.3-0.495 rad/s
    node.driftP1 = (node.id * 2.39) % (Math.PI * 2)
    node.driftP2 = (node.id * 1.61) % (Math.PI * 2)
  }

  const preSettleIterations = Math.min(250, 40 + graphNodes.length * 2)
  for (let i = 0; i < preSettleIterations; i++) {
    simulateGraphStep(0.88)
  }

  let frame = 0
  const maxFrames = 60

  function tick() {
    if (document.hidden) { graphSim = requestAnimationFrame(tick); return }
    if (frame > maxFrames) {
      autoFitGraph()
      startIdleLoop()
      return
    }
    frame++
    graphAnimFrame = frame
    simulateGraphStep(0.94 + (frame / maxFrames) * 0.05)
    renderGraph()
    graphSim = requestAnimationFrame(tick)
  }

  tick()
}

function autoFitGraph() {
  if (!graphNodes.length || !graphCanvas) return
  const dpr = window.devicePixelRatio || 1
  const w = graphCanvas.width / dpr
  const h = graphCanvas.height / dpr
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const n of graphNodes) {
    if (n.x < minX) minX = n.x
    if (n.x > maxX) maxX = n.x
    if (n.y < minY) minY = n.y
    if (n.y > maxY) maxY = n.y
  }
  const pad = 60
  const contentW = maxX - minX + pad * 2
  const contentH = maxY - minY + pad * 2
  graphZoom = Math.max(0.4, Math.min(1.0, Math.min(w / contentW, h / contentH)))
  graphPanX = w / 2 - ((minX + maxX) / 2) * graphZoom
  graphPanY = h / 2 - ((minY + maxY) / 2) * graphZoom
}

function startIdleLoop() {
  if (graphIdleRaf) cancelAnimationFrame(graphIdleRaf)
  graphIdleSlowFrame = 0

  function idleTick() {
    if (document.hidden) { graphIdleRaf = requestAnimationFrame(idleTick); return }

    // Throttle to ~30fps after 5s of no interaction
    const idle5s = Date.now() - graphLastInteraction > 5000
    if (idle5s) {
      graphIdleSlowFrame++
      if (graphIdleSlowFrame % 2 !== 0) { graphIdleRaf = requestAnimationFrame(idleTick); return }
    }

    if (!GRAPH_REDUCED_MOTION) tickParticles()
    renderGraph()
    graphIdleRaf = requestAnimationFrame(idleTick)
  }

  graphIdleRaf = requestAnimationFrame(idleTick)
}

function tickParticles() {
  // Identify active edges (connected to hover/selected node), cap at 20
  const activeNode = graphHover || graphSelectedNode
  let activeEdges = []
  if (activeNode) {
    const activeIdx = graphNodes.indexOf(activeNode)
    activeEdges = graphEdges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.source === activeIdx || e.target === activeIdx)
      .sort((a, b) => b.e.strength - a.e.strength)
      .slice(0, 20)
  } else {
    // Ambient: top 20 edges by strength
    activeEdges = graphEdges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.semantic)
      .sort((a, b) => b.e.strength - a.e.strength)
      .slice(0, 20)
  }

  const activeEdgeSet = new Set(activeEdges.map(({ i }) => i))

  // Remove particles on edges that are no longer active
  graphParticles = graphParticles.filter(p => activeEdgeSet.has(p.edgeIdx))

  // Spawn up to 3 particles per active edge (cap total 60)
  for (const { i } of activeEdges) {
    const existing = graphParticles.filter(p => p.edgeIdx === i).length
    const toSpawn = Math.max(0, 3 - existing)
    for (let s = 0; s < toSpawn && graphParticles.length < 60; s++) {
      graphParticles.push({ edgeIdx: i, t: s / 3, speed: 0.35 })  // stagger start
    }
  }

  // Advance particles
  const dt = 1 / 60
  for (const p of graphParticles) {
    p.t += p.speed * dt
    if (p.t > 1) p.t -= 1
  }
}

function renderGraph() {
  const ctx = graphCtx
  const dpr = window.devicePixelRatio || 1
  const w = graphCanvas.width / dpr
  const h = graphCanvas.height / dpr

  // Dark-cinematic: always dark if no explicit light theme; light = reduced fallback
  const themeAttr = document.documentElement.getAttribute('data-theme')
  const isDark = themeAttr !== 'light'

  const cs = getComputedStyle(document.documentElement)
  const borderColor = cs.getPropertyValue('--border').trim() || (isDark ? '#3d3d3a' : '#d1cfc5')
  const textColor = cs.getPropertyValue('--text').trim() || (isDark ? '#e8e7e0' : '#141413')
  const textMuted = cs.getPropertyValue('--text-muted').trim() || (isDark ? '#73726c' : '#87867f')

  // Camera nudge animation (card open or neighbor click, spec §2 / §4.4)
  if (graphCameraNudge && !GRAPH_REDUCED_MOTION) {
    const { fromX, fromY = graphPanY, toX, toY = graphPanY, startMs, dur } = graphCameraNudge
    const elapsed = performance.now() - startMs
    const t = Math.min(1, elapsed / dur)
    // Ease-in-out cubic
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    graphPanX = fromX + (toX - fromX) * e
    graphPanY = fromY + (toY - fromY) * e
    if (t >= 1) graphCameraNudge = null
  }

  // === Background: dark-cinematic vignette OR light fallback ===
  ctx.clearRect(0, 0, w, h)
  if (isDark) {
    const vign = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75)
    vign.addColorStop(0.0, '#1c1b19')
    vign.addColorStop(0.6, '#151514')
    vign.addColorStop(1.0, '#0e0e0d')
    ctx.fillStyle = vign
  } else {
    const vign = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75)
    vign.addColorStop(0.0, '#ffffff')
    vign.addColorStop(1.0, '#f0eee6')
    ctx.globalAlpha = 0.6
    ctx.fillStyle = vign
  }
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 1

  // === Dot grid (screen space) ===
  const gridSize = 26
  ctx.fillStyle = borderColor
  ctx.globalAlpha = isDark ? 0.16 : 0.25
  const offsetX = ((graphPanX % (gridSize * graphZoom)) + gridSize * graphZoom) % (gridSize * graphZoom)
  const offsetY = ((graphPanY % (gridSize * graphZoom)) + gridSize * graphZoom) % (gridSize * graphZoom)
  const scaledGrid = gridSize * graphZoom
  if (scaledGrid > 4) {
    for (let x = offsetX; x < w; x += scaledGrid) {
      for (let y = offsetY; y < h; y += scaledGrid) {
        ctx.beginPath()
        ctx.arc(x, y, Math.max(0.5, 0.7 * graphZoom), 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1

  // === Apply zoom/pan transform ===
  ctx.save()
  ctx.translate(graphPanX, graphPanY)
  ctx.scale(graphZoom, graphZoom)

  const nowMs = Date.now()
  const time = nowMs * 0.001
  const dt = graphLastRenderTs > 0 ? Math.min(nowMs - graphLastRenderTs, 50) : 16.67
  graphLastRenderTs = nowMs
  // Poly spec section 2: 180ms crossfade via exponential lerp (tau=60ms -> 95% at ~180ms)
  const lerpFactor = 1 - Math.exp(-dt / 60)
  const hasSearch = graphSearchQuery.length > 0

  // === Tier cluster halos (lighter blend in dark; source-over in light) ===
  const tierGroups = {}
  for (const node of graphNodes) {
    if (!tierGroups[node.tier]) tierGroups[node.tier] = []
    tierGroups[node.tier].push(node)
  }
  const activeNode = graphHover || graphSelectedNode
  for (const [tier, tNodes] of Object.entries(tierGroups)) {
    if (tNodes.length < 2) continue
    let cx = 0, cy = 0
    for (const n of tNodes) { cx += n.x; cy += n.y }
    cx /= tNodes.length; cy /= tNodes.length
    let maxDist = 0
    for (const n of tNodes) {
      const d = Math.sqrt((n.x - cx) ** 2 + (n.y - cy) ** 2)
      if (d > maxDist) maxDist = d
    }
    const radius = maxDist + 110
    const glowCol = GRAPH_TIER_GLOW[tier] || GRAPH_TIER_COLORS[tier]
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    if (isDark) {
      grad.addColorStop(0.0, glowCol + '14')  // a=0.08
      grad.addColorStop(1.0, glowCol + '00')
      const isActiveTier = activeNode && activeNode.tier === tier
      ctx.globalAlpha = hasSearch ? 0.25 : (isActiveTier ? 0.9 : 0.85)
      ctx.globalCompositeOperation = 'lighter'
    } else {
      const baseCol = GRAPH_TIER_COLORS[tier]
      grad.addColorStop(0.0, baseCol + '1a')
      grad.addColorStop(1.0, baseCol + '00')
      ctx.globalAlpha = hasSearch ? 0.15 : 0.35
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  // Build connected set for hover/selected focus
  const connectedToActive = new Set()
  if (activeNode) {
    const activeIdx = graphNodes.indexOf(activeNode)
    for (const edge of graphEdges) {
      if (edge.source === activeIdx) connectedToActive.add(edge.target)
      if (edge.target === activeIdx) connectedToActive.add(edge.source)
    }
  }

  // === Draw edges ===
  for (let ei = 0; ei < graphEdges.length; ei++) {
    const edge = graphEdges[ei]
    const a = graphNodes[edge.source]
    const b = graphNodes[edge.target]

    const isActiveEdge = activeNode && (a === activeNode || b === activeNode)
    const isDimmed = activeNode && !isActiveEdge
    const searchFaded = hasSearch && (!a.searchMatch || !b.searchMatch)

    const baseWidth = edge.semantic
      ? 1.0 + Math.min(edge.strength * 1.2, 3)
      : 0.5 + Math.min(edge.strength * 0.3, 1.2)
    const pulse = GRAPH_REDUCED_MOTION ? 1 : (0.85 + 0.15 * Math.sin(time * (edge.semantic ? 2 : 1.5) + edge.source * 0.3 + edge.target * 0.7))

    ctx.lineWidth = isActiveEdge ? baseWidth * 1.8 : baseWidth * pulse

    // Edge color: linear gradient source->target tier glow in dark, base color in light
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const curvature = Math.min(dist * 0.15, 30)
    const cpx = mx + (-dy / dist) * curvature
    const cpy = my + (dx / dist) * curvature

    if (edge.semantic && isDark) {
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      const ca = GRAPH_TIER_GLOW[a.tier] || GRAPH_TIER_COLORS[a.tier]
      const cb = GRAPH_TIER_GLOW[b.tier] || GRAPH_TIER_COLORS[b.tier]
      grad.addColorStop(0, ca)
      grad.addColorStop(0.5, GRAPH_TIER_COLORS[a.tier] || ca)
      grad.addColorStop(1, cb)
      ctx.strokeStyle = grad
    } else {
      ctx.strokeStyle = edge.semantic ? (GRAPH_TIER_COLORS[a.tier] || borderColor) : borderColor
    }

    const baseAlpha = edge.semantic
      ? (0.25 + Math.min(edge.strength * 0.3, 0.55))
      : (0.08 + Math.min(edge.strength * 0.05, 0.12))
    const isNeighborHighlightEdge = graphPanelHoverNeighborId !== null && graphSelectedNode !== null
      && ((a === graphSelectedNode && b.mem && b.mem.id === graphPanelHoverNeighborId)
      ||  (b === graphSelectedNode && a.mem && a.mem.id === graphPanelHoverNeighborId))
    const edgeAlpha = searchFaded ? 0.04
      : isNeighborHighlightEdge ? Math.min(0.9, baseAlpha * 2.5)
      : (isActiveEdge ? 0.85 : (isDimmed ? 0.05 : baseAlpha * pulse))
    // Light theme: bump alpha for contrast
    ctx.globalAlpha = isDark ? edgeAlpha : Math.min(1, edgeAlpha + 0.10)

    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.quadraticCurveTo(cpx, cpy, b.x, b.y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // === Draw particles (active edges, no shadowBlur) ===
  if (!GRAPH_REDUCED_MOTION && graphParticleSprite) {
    const pSize = 7
    for (const p of graphParticles) {
      const edge = graphEdges[p.edgeIdx]
      if (!edge) continue
      const a = graphNodes[edge.source]
      const b = graphNodes[edge.target]
      if (!a || !b) continue
      // Quadratic bezier point at t
      const t = p.t
      const qx = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * ((a.x + b.x) / 2 + (-(b.y - a.y) / (Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2)||1)) * Math.min(Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2) * 0.15, 30)) + t * t * b.x
      const qy = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * ((a.y + b.y) / 2 + ((b.x - a.x) / (Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2)||1)) * Math.min(Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2) * 0.15, 30)) + t * t * b.y
      const tier = graphNodes[edge.source].tier
      const sprite = graphGlowSprites[tier] || graphParticleSprite
      ctx.globalAlpha = 0.9
      ctx.drawImage(sprite, qx - pSize, qy - pSize, pSize * 2, pSize * 2)
    }
    ctx.globalAlpha = 1
  }

  // === Label LOD: precompute eligibility + greedy collision (Poly spec section 6) ===
  {
    const z = graphZoom
    const dpr = window.devicePixelRatio || 1
    const screenW = graphCanvas.width / dpr
    const screenH = graphCanvas.height / dpr
    const focusNode = graphHover || graphSelectedNode
    const hasFocus = !!focusNode
    const VP_MARGIN = 40
    const truncLimit = z >= 2 ? 40 : 25

    // zoom ramps for P3 ambient labels
    const hubRamp = Math.min(1, Math.max(0, (z - 0.35) / 0.3))
    const ambientRamp = Math.min(1, Math.max(0, (z - 0.7) / 0.5))

    // P3 ambient cap based on zoom
    let p3Cap = 0
    if (z >= 1.5) p3Cap = 60
    else if (z >= 0.8) p3Cap = 20
    else if (z >= 0.5) p3Cap = 8

    // Neighbors of focusNode (by edge weight desc, cap 12) -> P1
    const neighborIdxSet = new Set()
    if (focusNode) {
      const focusIdx = graphNodes.indexOf(focusNode)
      graphEdges
        .filter(e => e.source === focusIdx || e.target === focusIdx)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 12)
        .forEach(e => neighborIdxSet.add(e.source === focusIdx ? e.target : e.source))
    }

    // Pre-populate placed rects with still-fading-out labels (anti-flicker)
    const lodPlacedRects = []
    for (const node of graphNodes) {
      if ((node._labelTargetAlpha || 0) === 0 && (node.labelAlpha || 0) > 0.15 && node._pillScreenRect) {
        lodPlacedRects.push(node._pillScreenRect)
      }
    }

    // Classify candidates
    const candidates = []
    for (let ni = 0; ni < graphNodes.length; ni++) {
      const node = graphNodes[ni]
      const driftX2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.sin(time * node.driftF + node.driftP1) : 0
      const driftY2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.cos(time * node.driftF * 0.8 + node.driftP2) : 0
      const wx = node.x + driftX2
      const wy = node.y + driftY2
      const sx = wx * z + graphPanX
      const sy = wy * z + graphPanY
      const inVP = sx >= -VP_MARGIN && sx <= screenW + VP_MARGIN && sy >= -VP_MARGIN && sy <= screenH + VP_MARGIN

      let priority = -1
      let alphaTarget = 0
      const isP0 = node === focusNode || node === graphSelectedNode
      if (isP0) {
        priority = 0; alphaTarget = 1
      } else if (hasFocus && neighborIdxSet.has(ni)) {
        priority = 1; alphaTarget = 1
      } else if (hasSearch && node.searchMatch) {
        priority = 2; alphaTarget = 1
      } else if (inVP && p3Cap > 0) {
        priority = 3
        // Focus active: P3 ambient participates in collision but wins only 8% dim;
        // non-winners get target=0 (see placement loop below).
        if (hasFocus) {
          alphaTarget = 0.08
        } else if (node.isHub) {
          alphaTarget = hubRamp
        } else {
          alphaTarget = ambientRamp
        }
      }

      node._labelTargetAlpha = 0  // default: hidden; set to real value if placed
      node._labelDisplayText = node.label.length > truncLimit ? node.label.slice(0, truncLimit) + '…' : node.label

      if (priority >= 0) {
        candidates.push({ node, ni, priority, alphaTarget, importance: node.importance || 0 })
      }
    }

    // Sort P0->P1->P2->P3, within class by importance desc
    candidates.sort((a, b) => a.priority - b.priority || b.importance - a.importance)

    let p1Count = 0, p2Count = 0, p3Count = 0
    const labelFontBase = Math.max(7, Math.min(11, 9 / Math.max(z * 0.7, 0.5)))
    ctx.font = `500 ${labelFontBase}px -apple-system, sans-serif`

    for (const c of candidates) {
      const { node, priority, alphaTarget } = c
      // Caps
      if (priority === 1 && p1Count >= 12) continue
      if (priority === 2 && p2Count >= 20) continue
      if (priority === 3) {
        if (p3Count >= p3Cap) continue
      }

      // Compute pill screen rect
      const driftX2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.sin(time * node.driftF + node.driftP1) : 0
      const driftY2 = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.cos(time * node.driftF * 0.8 + node.driftP2) : 0
      const wx = node.x + driftX2
      const wy = node.y + driftY2
      const r2 = node.isHub ? node.radius + 3 : node.radius
      const textW = ctx.measureText(node._labelDisplayText).width
      const pillW = textW + 10
      const pillH = labelFontBase + 6

      // Screen-space rect (world -> screen via zoom/pan)
      const psx = (wx - pillW / 2) * z + graphPanX
      const psy = (wy + r2 + 5) * z + graphPanY
      const psw = pillW * z
      const psh = pillH * z
      const padded = { x: psx - 4, y: psy - 4, w: psw + 8, h: psh + 8 }

      // Collision check
      let collides = false
      for (const rect of lodPlacedRects) {
        if (padded.x < rect.x + rect.w && padded.x + padded.w > rect.x &&
            padded.y < rect.y + rect.h && padded.y + padded.h > rect.y) {
          collides = true; break
        }
      }

      if (!collides) {
        node._labelTargetAlpha = alphaTarget
        node._pillScreenRect = padded
        lodPlacedRects.push(padded)
        if (priority === 1) p1Count++
        else if (priority === 2) p2Count++
        else if (priority === 3) p3Count++
      }
    }

    // Exp-lerp labelAlpha per node (fade-in 180ms tau=60, fade-out 240ms tau=80)
    for (const node of graphNodes) {
      const target = node._labelTargetAlpha || 0
      const current = node.labelAlpha || 0
      const tau = target > current ? 60 : 80
      node.labelAlpha = current + (target - current) * (1 - Math.exp(-dt / tau))
    }
  }

  // === Draw nodes: halo sprites + core gradient ===
  for (let ni = 0; ni < graphNodes.length; ni++) {
    const node = graphNodes[ni]
    const color = GRAPH_TIER_COLORS[node.tier] || '#d97757'
    const glowColor = GRAPH_TIER_GLOW[node.tier] || color
    const isHover = node === graphHover
    const isSelected = node === graphSelectedNode
    const isConnected = connectedToActive.has(ni)
    const searchFaded = hasSearch && !node.searchMatch
    const searchGlow = hasSearch && node.searchMatch

    const isPanelHoverNeighbor = graphPanelHoverNeighborId !== null && node.mem && node.mem.id === graphPanelHoverNeighborId
    let targetAlpha = 0.85
    if (searchFaded) targetAlpha = 0.12
    else if (searchGlow || isHover || isSelected || isPanelHoverNeighbor) targetAlpha = 1.0
    else if (activeNode && !isConnected) targetAlpha = 0.13

    // Hover-crossfade: exponential lerp toward targetAlpha (Poly spec section 2)
    if (node.renderedAlpha === undefined) node.renderedAlpha = targetAlpha
    node.renderedAlpha += (targetAlpha - node.renderedAlpha) * lerpFactor
    const displayAlpha = node.renderedAlpha

    // Pop-in scale: 0->1 back-out 300ms, staggered (Poly spec section 2)
    let popScale = 1
    if (!GRAPH_REDUCED_MOTION && node.birthMs && nowMs < node.birthMs + 300) {
      const t = Math.max(0, Math.min(1, (nowMs - node.birthMs) / 300))
      popScale = graphEaseOutBack(t)
    }

    // Idle drift offset (render only, NOT fed back into simulation)
    let driftX = 0, driftY = 0
    if (!GRAPH_REDUCED_MOTION && node.driftF) {
      const A = node.isHub ? 1.0 : 1.5
      driftX = A * Math.sin(time * node.driftF + node.driftP1)
      driftY = A * Math.cos(time * node.driftF * 0.8 + node.driftP2)
    }
    const rx = node.x + driftX
    const ry = node.y + driftY

    const r = isHover ? node.radius + 3 : (isSelected ? node.radius + 2 : node.radius)

    // Hub pulse: animated outer ring radius
    const hubPulseR = node.isHub && !GRAPH_REDUCED_MOTION
      ? r + 5 + 1.5 * Math.sin(time * 2.1 + node.id * 0.5)
      : r + 5

    // Pop-in: apply scale transform around node center
    if (popScale !== 1) {
      ctx.save()
      ctx.translate(rx, ry)
      ctx.scale(popScale, popScale)
      ctx.translate(-rx, -ry)
    }

    // Ambient halo via glow sprite (replaces shadowBlur in loop)
    if (!searchFaded) {
      const haloScale = isHover || isSelected ? 4.5 : (isConnected ? 4.0 : 3.6)
      const haloR = r * haloScale
      const haloAlpha = isDark ? (isHover || isSelected ? 1.0 : 0.75) : 0.35
      const sprite = graphGlowSprites[node.tier]
      if (sprite) {
        if (isDark) ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = searchFaded ? 0.04 : haloAlpha * displayAlpha
        ctx.drawImage(sprite, rx - haloR, ry - haloR, haloR * 2, haloR * 2)
        ctx.globalCompositeOperation = 'source-over'
      }
    }
    // Core alpha: dark mode uses displayAlpha; light mode bumps to ~0.9 ambient
    // so the halo's 0.35 multiplier doesn't drag the core down visually (Poly §4)
    ctx.globalAlpha = isDark ? displayAlpha : Math.min(displayAlpha * (0.9 / 0.85), 1.0)

    // Node core: radial gradient with highlight center offset
    const coreGrad = ctx.createRadialGradient(rx - r * 0.25, ry - r * 0.25, 0, rx, ry, r)
    if (isDark) {
      coreGrad.addColorStop(0.00, '#ffffff')
      coreGrad.addColorStop(0.25, glowColor)
      coreGrad.addColorStop(1.00, color)
    } else {
      coreGrad.addColorStop(0.00, '#ffffff')
      coreGrad.addColorStop(1.00, color)
    }
    ctx.fillStyle = coreGrad
    ctx.beginPath()
    ctx.arc(rx, ry, r, 0, Math.PI * 2)
    ctx.fill()

    // Selected node persistent ring (spec §2: radius+5, 1.5px, tierGlow@0.9)
    if (isSelected) {
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 1.5
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.arc(rx, ry, r + 5, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Neighbor click pulse: halo x2.2 decaying over 600ms
    if (graphNodePulseActive && graphNodePulseActive.node === node) {
      const pElapsed = performance.now() - graphNodePulseActive.startMs
      if (pElapsed < 600) {
        const pT = pElapsed / 600
        const pScale = 2.2 - 1.2 * pT  // 2.2 -> 1.0
        const sprite = graphGlowSprites[node.tier]
        if (sprite) {
          const pHaloR = r * 4.5 * pScale
          if (isDark) ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = displayAlpha * (1 - pT) * 0.7
          ctx.drawImage(sprite, rx - pHaloR, ry - pHaloR, pHaloR * 2, pHaloR * 2)
          ctx.globalCompositeOperation = 'source-over'
        }
      } else {
        graphNodePulseActive = null
      }
    }

    // Orphan dashed ring / hub pulsing ring
    if (node.isOrphan && !searchFaded) {
      ctx.globalAlpha = displayAlpha * 0.6
      ctx.strokeStyle = isDark ? '#888' : '#aaa'
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.arc(rx, ry, r + 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    } else if (node.isHub && !searchFaded) {
      ctx.globalAlpha = displayAlpha * 0.8
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(rx, ry, hubPulseR, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.globalAlpha = displayAlpha

    // Label pill (LOD-gated, Poly spec section 6)
    const labelA = node.labelAlpha || 0
    if (labelA > 0.015) {
      const labelFontSize = Math.max(7, Math.min(11, 9 / Math.max(graphZoom * 0.7, 0.5)))
      ctx.font = (isHover || isSelected) ? `600 ${labelFontSize + 1}px -apple-system, sans-serif` : `500 ${labelFontSize}px -apple-system, sans-serif`
      const displayLabel = node._labelDisplayText || node.label
      const textWidth = ctx.measureText(displayLabel).width
      const pillW = textWidth + 10
      const pillH = labelFontSize + 6
      const pillX = rx - pillW / 2
      const pillY = ry + r + 5

      ctx.globalAlpha = labelA * ((isHover || isSelected) ? 0.9 : 0.65)
      ctx.fillStyle = 'rgba(20,20,19,0.85)'
      graphRoundRect(ctx, pillX, pillY, pillW, pillH, 3)
      ctx.fill()

      ctx.fillStyle = '#faf9f5'
      ctx.globalAlpha = labelA * ((isHover || isSelected) ? 1 : 0.85)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(displayLabel, rx, pillY + pillH / 2)
    }

    ctx.globalAlpha = 1
    ctx.textBaseline = 'alphabetic'

    // Restore pop-in transform if applied
    if (popScale !== 1) ctx.restore()
  }

  // === Hover tooltip (shadowBlur allowed: one draw per frame max) ===
  if (graphHover && !graphSelectedNode) {
    const node = graphHover
    const driftX = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.sin(time * node.driftF + node.driftP1) : 0
    const driftY = !GRAPH_REDUCED_MOTION && node.driftF ? 1.5 * Math.cos(time * node.driftF * 0.8 + node.driftP2) : 0
    const rx = node.x + driftX
    const ry = node.y + driftY

    const tLabels = { hot: 'Hot', warm: 'Warm', cold: 'Cold', shared: 'Shared' }
    const text = `${node.label}`
    const sub = `${tLabels[node.tier] || node.tier} | ${node.agent}`
    const conns = `${node.degree} kapcsolat`

    ctx.font = 'bold 11px -apple-system, sans-serif'
    const tw = Math.max(ctx.measureText(text).width, ctx.measureText(sub).width, ctx.measureText(conns).width) + 24
    const th = 64
    const tx = Math.min(rx - tw / 2, (graphCanvas.width / (window.devicePixelRatio || 1)) / graphZoom - tw - 10)
    const ty = ry - node.radius - th - 12

    ctx.fillStyle = 'rgba(31,30,29,0.92)'
    ctx.strokeStyle = '#3d3d3a'
    ctx.lineWidth = 1
    ctx.shadowColor = 'rgba(0,0,0,0.25)'
    ctx.shadowBlur = 12
    graphRoundRect(ctx, tx, ty, tw, th, 8)
    ctx.fill()
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'

    ctx.fillStyle = '#faf9f5'
    ctx.font = '600 11px -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(text, tx + 12, ty + 18)
    ctx.font = '10px -apple-system, sans-serif'
    ctx.fillStyle = '#ff9a70'
    ctx.fillText(sub, tx + 12, ty + 34)
    ctx.fillStyle = '#73726c'
    ctx.fillText(conns, tx + 12, ty + 50)
  }

  ctx.restore()
}

function graphRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// === Graph detail card (Poly spec §1-§7) ===

function gcRelTime(ts) {
  const diff = Math.max(0, Date.now() / 1000 - ts)
  const min = Math.floor(diff / 60)
  if (min < 2) return 'most'
  if (min < 60) return min + ' perce'
  const hr = Math.floor(min / 60)
  if (hr < 24) return hr + ' órája'
  const day = Math.floor(hr / 24)
  if (day < 7) return day + ' napja'
  const wk = Math.floor(day / 7)
  if (wk < 5) return wk + ' hete'
  const mo = Math.floor(day / 30)
  if (mo < 12) return mo + ' hónapja'
  return Math.floor(mo / 12) + ' éve'
}

function gcAbsTime(ts) {
  return new Date(ts * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
}

function gcHexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function gcFreshnessInfo(accessedAt) {
  const daysSince = (Date.now() / 1000 - accessedAt) / 86400
  if (daysSince <= 30) return { cls: 'aktiv',   label: 'aktív',   color: '#7ddc8a' }
  if (daysSince <= 90) return { cls: 'alvo',    label: 'alvó',    color: 'rgba(255,255,255,0.35)' }
  return                      { cls: 'elavult', label: 'elavult', color: 'rgba(220,60,60,0.7)' }
}

function showGraphPanel(node, swapping) {
  const mem = node.mem
  const tier = node.tier
  const glowHex = GRAPH_TIER_GLOW[tier] || '#ffffff'
  const glowShadow = gcHexToRgba(glowHex, 0.14)
  const tierBg = gcHexToRgba(glowHex, 0.12)
  const tierLabels = { hot: 'HOT', warm: 'WARM', cold: 'COLD', shared: 'SHARED' }
  const fresh = gcFreshnessInfo(node.accessed_at || 0)

  let panel = document.getElementById('graphPanel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'graphPanel'
    panel.className = 'graph-panel'
    document.getElementById('memGraphView').appendChild(panel)
  }
  panel.style.setProperty('--gc-tier-accent', glowHex)
  panel.style.setProperty('--gc-tier-glow-shadow', glowShadow)

  const headerHtml = `
    <div class="graph-panel-drag-handle"></div>
    <div class="graph-panel-header">
      <span class="gc-tier-badge" style="background:${tierBg};color:${glowHex}">
        <span class="gc-tier-dot" style="background:${glowHex}"></span>
        ${escapeHtml(tierLabels[tier] || tier.toUpperCase())}
      </span>
      <span class="gc-agent-chip">@${escapeHtml(node.agent || '')}</span>
      ${node.isHub ? `<span class="gc-hub-badge">⬡ HUB · ${node.degree}</span>` : ''}
      <span class="gc-freshness">
        <span class="gc-freshness-dot ${fresh.cls}" style="background:${fresh.color}"></span>
        ${escapeHtml(fresh.label)}
      </span>
      <button class="graph-panel-close" id="graphPanelCloseBtn">&times;</button>
    </div>
    ${mem.created_label ? `<div class="gc-created-line">${escapeHtml(mem.created_label)}</div>` : ''}
  `

  const skeletonHtml = `
    <div class="gc-body">
      <div class="gc-content">
        <div class="gc-skeleton-bar" style="width:100%"></div>
        <div class="gc-skeleton-bar" style="width:92%"></div>
        <div class="gc-skeleton-bar" style="width:61%"></div>
      </div>
      <div class="gc-skeleton-neighbor"></div>
      <div class="gc-skeleton-neighbor"></div>
      <div class="gc-skeleton-neighbor"></div>
    </div>
    <div class="gc-footer">
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">✏</span>Szerkesztés</button>
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">⬡</span>Költöztetés</button>
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">◎</span>Fókusz</button>
      <button class="gc-footer-btn" disabled><span class="gc-footer-icon">⧉</span>Másolás</button>
    </div>
  `

  panel.innerHTML = headerHtml + skeletonHtml
  panel.hidden = false

  document.getElementById('graphPanelCloseBtn').addEventListener('click', () => {
    graphSelectedNode = null
    graphPanelHoverNeighborId = null
    panel.hidden = true
    renderGraph()
  })

  // Camera nudge on open (not on swap): pan left if node falls under card (spec §2)
  if (!swapping && !GRAPH_REDUCED_MOTION && graphCanvas) {
    const dpr = window.devicePixelRatio || 1
    const canvasW = graphCanvas.width / dpr
    const screenX = node.x * graphZoom + graphPanX
    const cardLeft = canvasW - 364
    if (screenX > cardLeft) {
      const nudgePx = (screenX - cardLeft) + 40
      graphCameraNudge = {
        fromX: graphPanX, fromY: graphPanY,
        toX: graphPanX - nudgePx, toY: graphPanY,
        startMs: performance.now(), dur: 350,
      }
    }
  }

  const capturedNode = node
  fetch('/api/memories/' + mem.id + '/detail')
    .then(r => r.ok ? r.json() : null)
    .then(detail => {
      if (!detail || graphSelectedNode !== capturedNode) return
      gcFillBody(panel, capturedNode, detail)
    })
    .catch(() => {})
}

function gcFillBody(panel, node, detail) {
  const mem = node.mem
  const glowHex = GRAPH_TIER_GLOW[node.tier] || '#ffffff'
  const tierLabels = { hot: 'HOT', warm: 'WARM', cold: 'COLD', shared: 'SHARED' }
  function tierPill(t) {
    const tc = GRAPH_TIER_GLOW[t] || '#fff'
    const bg = gcHexToRgba(tc, 0.12)
    return `<span class="gc-tier-pill" style="background:${bg};color:${tc}">${escapeHtml(tierLabels[t] || t)}</span>`
  }

  // 4.1 Full content
  const contentHtml = `<div class="gc-content">${escapeHtml(detail.content || mem.content || '')}</div>`

  // 4.2 Meta row
  const accessedAt = detail.accessed_at || node.accessed_at || 0
  const createdAt = detail.created_at || node.created_at || 0
  const readCount = detail.read_count || 0
  const readSuffix = readCount > 0 ? ` (${readCount}x)` : ''
  const metaHtml = `<div class="gc-meta" title="${escapeHtml(gcAbsTime(createdAt))}">létrehozva ${escapeHtml(gcRelTime(createdAt))} · olvasva ${escapeHtml(gcRelTime(accessedAt))}${readSuffix}</div>`

  // 4.3 Keywords
  const rawKw = detail.keywords || ''
  const keywords = rawKw ? rawKw.split(',').map(k => k.trim()).filter(Boolean) : []
  const kwHtml = keywords.length
    ? `<div class="gc-keywords" id="gcKwBox">${keywords.map(k => `<span class="gc-kw-chip">${escapeHtml(k)}</span>`).join('')}</div>`
    : ''

  // 4.4 Neighbors -- unified weight-desc list (spec: direction is a glyph, not a section)
  const neighbors = [...(detail.neighbors || [])].sort((a, b) => b.weight - a.weight)
  let neighborHtml = ''
  if (neighbors.length) {
    const rows = neighbors.map(n => {
      const nGlow = GRAPH_TIER_GLOW[n.tier] || '#fff'
      const fillPct = Math.round(((n.weight - 0.75) / 0.25) * 70 + 30)
      const dirGlyph = n.direction === 'outgoing' ? '→' : '←'
      const dirTitle = n.direction === 'outgoing' ? 'kimenő kapcsolat' : 'bejövő kapcsolat'
      return `<div class="gc-neighbor-row" data-nid="${n.id}">
        <span class="gc-neighbor-dot" style="background:${nGlow}"></span>
        <span class="gc-neighbor-dir" title="${dirTitle}">${dirGlyph}</span>
        <span class="gc-neighbor-label">${escapeHtml(n.label)}</span>
        <span class="gc-neighbor-bar-track"><span class="gc-neighbor-bar-fill" style="width:${fillPct}%;background:${nGlow}"></span></span>
        <span class="gc-neighbor-weight">${n.weight.toFixed(2)}</span>
      </div>`
    }).join('')
    const totalDeg = node.degree || neighbors.length
    const overflow = totalDeg > neighbors.length
      ? `<div class="gc-neighbor-overflow">a graf további ${totalDeg - neighbors.length} kapcsolatot mutat</div>`
      : ''
    neighborHtml = `
      <div class="gc-section-title">Kapcsolatok <span>${neighbors.length}</span></div>
      <div class="gc-neighbor-list">${rows}${overflow}</div>
    `
  }

  // 4.5 Tier history (omit section entirely if empty)
  const tierHistory = detail.tier_history || []
  let tierHistHtml = ''
  if (tierHistory.length) {
    const shown = tierHistory.length > 3 ? tierHistory.slice(-3) : tierHistory
    const hasMore = tierHistory.length > 3
    const steps = shown.map(h => {
      const dt = new Date(h.changed_at * 1000)
      const dateStr = String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
      return `<div class="gc-tier-step">
        <div class="gc-tier-pills">${tierPill(h.from_tier)}<span class="gc-tier-arrow">→</span>${tierPill(h.to_tier)}</div>
        <div class="gc-tier-date">${dateStr}</div>
      </div>`
    }).join('')
    tierHistHtml = `
      <div class="gc-section-title">Tier-történet</div>
      <div class="gc-tier-history">
        <div class="gc-tier-chain">${hasMore ? '<span class="gc-tier-more">…</span>' : ''}${steps}</div>
      </div>
    `
  }

  const bodyHtml = `<div class="gc-body gc-fade-in">${contentHtml}${metaHtml}${kwHtml}${neighborHtml}${tierHistHtml}</div>`
  const footerHtml = `
    <div class="gc-footer">
      <button class="gc-footer-btn" id="gcBtnEdit"><span class="gc-footer-icon">✏</span>Szerkesztés</button>
      <button class="gc-footer-btn" id="gcBtnMove"><span class="gc-footer-icon">⬡</span>Költöztetés</button>
      <button class="gc-footer-btn" id="gcBtnFocus"><span class="gc-footer-icon">◎</span>Fókusz</button>
      <button class="gc-footer-btn" id="gcBtnCopy"><span class="gc-footer-icon">⧉</span><span class="gc-copy-label">Másolás</span></button>
    </div>
  `

  const oldBody = panel.querySelector('.gc-body')
  if (oldBody) oldBody.remove()
  const oldFooter = panel.querySelector('.gc-footer')
  if (oldFooter) oldFooter.remove()
  panel.insertAdjacentHTML('beforeend', bodyHtml + footerHtml)

  // Keyword +N collapse
  const kwBox = panel.querySelector('#gcKwBox')
  if (kwBox) {
    setTimeout(() => {
      if (kwBox.scrollHeight > kwBox.offsetHeight + 4) {
        const chips = Array.from(kwBox.querySelectorAll('.gc-kw-chip'))
        const boxH = kwBox.offsetHeight
        // Use full chip bottom edge vs box height -- catches partial 3rd-row overflow reliably
        const hiddenChips = chips.filter(c => c.offsetTop + c.offsetHeight > boxH)
        if (hiddenChips.length) {
          const btn = document.createElement('span')
          btn.className = 'gc-kw-more'
          btn.textContent = '+' + hiddenChips.length
          btn.addEventListener('click', () => { kwBox.classList.add('expanded'); btn.remove() })
          kwBox.appendChild(btn)
        }
      }
    }, 0)
  }

  // Neighbor row events
  panel.querySelectorAll('.gc-neighbor-row').forEach(row => {
    const nid = parseInt(row.dataset.nid, 10)
    row.addEventListener('mouseenter', () => { graphPanelHoverNeighborId = nid; renderGraph() })
    row.addEventListener('mouseleave', () => { graphPanelHoverNeighborId = null; renderGraph() })
    row.addEventListener('click', () => {
      const targetNode = graphNodes.find(n => n.id === nid)
      if (!targetNode) return
      graphSelectedNode = targetNode
      graphPanelHoverNeighborId = null
      graphNodePulseActive = { node: targetNode, startMs: performance.now() }
      // Pan to neighbor (center-left, spec §4.4: 400ms ease-in-out)
      const dpr = window.devicePixelRatio || 1
      const cw = graphCanvas.width / dpr
      const ch = graphCanvas.height / dpr
      const newPanX = cw * 0.35 - targetNode.x * graphZoom
      const newPanY = ch * 0.5  - targetNode.y * graphZoom
      if (graphZoom < 0.8) graphZoom = Math.min(1.0, graphZoom * 1.25)
      graphCameraNudge = {
        fromX: graphPanX, fromY: graphPanY,
        toX: newPanX, toY: newPanY,
        startMs: performance.now(), dur: 400,
      }
      showGraphPanel(targetNode, true)
    })
  })

  // Footer actions
  const btnEdit = panel.querySelector('#gcBtnEdit')
  const btnMove = panel.querySelector('#gcBtnMove')
  const btnFocus = panel.querySelector('#gcBtnFocus')
  const btnCopy = panel.querySelector('#gcBtnCopy')
  if (btnEdit) btnEdit.addEventListener('click', () => openEditMemory(node.mem))
  if (btnMove) btnMove.addEventListener('click', () => openEditMemory(node.mem))
  if (btnFocus) btnFocus.addEventListener('click', () => {
    const dpr = window.devicePixelRatio || 1
    const cw = graphCanvas.width / dpr
    const ch = graphCanvas.height / dpr
    const z = Math.max(graphZoom, 1.1)
    graphCameraNudge = {
      fromX: graphPanX, fromY: graphPanY,
      toX: cw / 2 - node.x * z, toY: ch / 2 - node.y * z,
      startMs: performance.now(), dur: 400,
    }
    graphZoom = z
    renderGraph()
  })
  if (btnCopy) btnCopy.addEventListener('click', () => {
    const label = btnCopy.querySelector('.gc-copy-label')
    navigator.clipboard.writeText(detail.content || mem.content || '').then(() => {
      if (label) label.textContent = 'Másolva'
      setTimeout(() => { if (label) label.textContent = 'Másolás' }, 1200)
    })
  })
}

function hideGraphPanel() {
  const panel = document.getElementById('graphPanel')
  if (panel) panel.hidden = true
  graphPanelHoverNeighborId = null
}

export function openEditMemory(mem) {
  const tier = mem.tier || mem.category || 'warm'
  openMemEditModal({ ...mem, agent_id: mem.agent_id || mainAgentId() }, tier)
}

// === Graph search integration ===
function updateGraphSearch() {
  const q = memSearchInput.value.trim().toLowerCase()
  graphSearchQuery = q
  for (const node of graphNodes) {
    if (!q) {
      node.searchMatch = true
    } else {
      const content = (node.mem.content || '').toLowerCase()
      const kws = node.keywords.join(' ').toLowerCase()
      const agent = (node.agent || '').toLowerCase()
      node.searchMatch = content.includes(q) || kws.includes(q) || agent.includes(q)
    }
  }
  if (graphNodes.length > 0) renderGraph()
}

// === Zoom indicator ===
function showZoomIndicator() {
  const el = document.getElementById('graphZoomIndicator')
  if (!el) return
  el.textContent = `${Math.round(graphZoom * 100)}%`
  el.classList.add('visible')
  clearTimeout(graphZoomIndicatorTimer)
  graphZoomIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 1200)
}

// === Graph mouse interaction (with zoom/pan) ===
;(function initGraphInteraction() {
  const canvas = document.getElementById('memGraphCanvas')
  let wasDragging = false
  let wasPanning = false
  let mouseDownPos = { x: 0, y: 0 }

  // Mouse wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    // Zoom toward cursor
    const worldX = (mx - graphPanX) / graphZoom
    const worldY = (my - graphPanY) / graphZoom

    graphZoom = Math.max(0.3, Math.min(3.0, graphZoom * zoomFactor))

    graphPanX = mx - worldX * graphZoom
    graphPanY = my - worldY * graphZoom

    showZoomIndicator()
    if (graphNodes.length > 0) renderGraph()
  }, { passive: false })

  // Mouse move: hover detection + panning + dragging
  canvas.addEventListener('mousemove', (e) => {
    graphLastInteraction = Date.now()
    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    // Panning
    if (graphPanning) {
      const dx = sx - graphPanStartX
      const dy = sy - graphPanStartY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasPanning = true
      graphPanX += dx
      graphPanY += dy
      graphPanStartX = sx
      graphPanStartY = sy
      if (graphNodes.length > 0) renderGraph()
      return
    }

    // Dragging a node
    const world = screenToWorld(sx, sy)
    if (graphDragging) {
      const dx = sx - mouseDownPos.x
      const dy = sy - mouseDownPos.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDragging = true
      graphDragging.x = world.x
      graphDragging.y = world.y
      graphDragging.vx = 0
      graphDragging.vy = 0
      if (graphNodes.length > 0) renderGraph()
      return
    }

    // Hover detection in world space
    graphHover = null
    for (const node of graphNodes) {
      const ndx = world.x - node.x
      const ndy = world.y - node.y
      const hitRadius = (node.radius + 6) / Math.max(graphZoom, 0.5)
      if (ndx * ndx + ndy * ndy < hitRadius * hitRadius) {
        graphHover = node
        break
      }
    }
    canvas.style.cursor = graphHover ? 'pointer' : 'grab'
    if (graphNodes.length > 0) renderGraph()
  })

  // Mouse down: start drag on node, or start pan on empty space
  canvas.addEventListener('mousedown', (e) => {
    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    mouseDownPos = { x: sx, y: sy }
    wasDragging = false
    wasPanning = false

    if (graphHover) {
      // Drag node
      graphDragging = graphHover
      canvas.style.cursor = 'grabbing'
    } else {
      // Pan
      graphPanning = true
      graphPanStartX = sx
      graphPanStartY = sy
      canvas.style.cursor = 'grabbing'
    }
  })

  // Click: select node and show panel (only if not dragged/panned)
  canvas.addEventListener('click', (e) => {
    if (wasDragging || wasPanning) return

    const rect = e.target.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const world = screenToWorld(sx, sy)

    let clicked = null
    for (const node of graphNodes) {
      const dx = world.x - node.x
      const dy = world.y - node.y
      const hitRadius = (node.radius + 6) / Math.max(graphZoom, 0.5)
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        clicked = node
        break
      }
    }

    if (clicked) {
      graphSelectedNode = clicked
      showGraphPanel(clicked)
    } else {
      graphSelectedNode = null
      hideGraphPanel()
    }
    if (graphNodes.length > 0) renderGraph()
  })

  // Double click: open edit modal
  canvas.addEventListener('dblclick', (e) => {
    if (graphHover && graphHover.mem) {
      openEditMemory(graphHover.mem)
    }
  })

  // Mouse up: stop drag/pan
  document.addEventListener('mouseup', () => {
    if (graphDragging) {
      graphDragging = null
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = graphHover ? 'pointer' : 'grab'
    }
    if (graphPanning) {
      graphPanning = false
      const c = document.getElementById('memGraphCanvas')
      if (c) c.style.cursor = 'grab'
    }
  })

  // Search integration: listen to existing search input
  memSearchInput.addEventListener('input', () => {
    if (currentMemTier === 'graph') {
      updateGraphSearch()
    }
  })
  memSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && currentMemTier === 'graph') {
      updateGraphSearch()
    }
  })
})()

// === Daily Log ===

export async function loadDailyLog() {
  // "Minden ügynök" (empty value) falls back to the first agent in the
  // filter dropdown, which is the main agent on any BOT_NAME -- avoids a
  // hardcoded "marveen" slug that would 404 on zino/haver/etc installs.
  const sel = document.getElementById('memAgentFilter')
  const agent = sel.value || (sel.options[1] ? sel.options[1].value : '')
  if (!agent) {
    renderLogEntries([])
    return
  }

  try {
    const datesRes = await fetch(`/api/daily-log/dates?agent=${agent}`)
    logDates = await datesRes.json()
  } catch {
    logDates = []
  }

  document.getElementById('logCurrentDate').textContent = formatLogDate(currentLogDate)

  try {
    const res = await fetch(`/api/daily-log?agent=${agent}&date=${currentLogDate}`)
    const entries = await res.json()
    renderLogEntries(entries)
  } catch {
    renderLogEntries([])
  }
}

function renderLogEntries(entries) {
  const el = document.getElementById('logEntries')
  const empty = document.getElementById('logEmpty')
  el.innerHTML = ''
  empty.hidden = entries.length > 0

  for (const entry of entries) {
    const time = new Date(entry.created_at * 1000).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
    const div = document.createElement('div')
    div.className = 'log-entry'
    div.innerHTML = `
      <div class="log-entry-time">${time}</div>
      <div class="log-entry-content">${escapeHtml(entry.content)}</div>
    `
    el.appendChild(div)
  }
}

function formatLogDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

// Date navigation
document.getElementById('logPrevDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() - 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})
document.getElementById('logNextDate').addEventListener('click', () => {
  const d = new Date(currentLogDate)
  d.setDate(d.getDate() + 1)
  currentLogDate = d.toISOString().split('T')[0]
  loadDailyLog()
})


// ============================================================
// === Memory Import ===
// ============================================================

const memImportOverlay = document.getElementById('memImportOverlay')
const memImportFileInput = document.getElementById('memImportFile')
const memImportFileArea = document.getElementById('memImportFileArea')
const memImportFileNames = document.getElementById('memImportFileNames')
const memImportSaveBtn = document.getElementById('memImportSaveBtn')
const memImportProgress = document.getElementById('memImportProgress')
const memImportStatus = document.getElementById('memImportStatus')
const memImportResult = document.getElementById('memImportResult')
let memImportFiles = []

// Open import modal
document.getElementById('memImportOpenBtn').addEventListener('click', () => {
  memImportFiles = []
  memImportFileInput.value = ''
  memImportFileNames.textContent = ''
  memImportProgress.hidden = true
  memImportResult.hidden = true
  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false

  // Populate agent dropdown from existing agents
  const importAgentSel = document.getElementById('memImportAgent')
  const memAgentSel = document.getElementById('memAgent')
  importAgentSel.innerHTML = memAgentSel.innerHTML
  _openModal?.(memImportOverlay)
})

// Close import modal
document.getElementById('memImportClose').addEventListener('click', () => _closeModal?.(memImportOverlay))
memImportOverlay.addEventListener('click', (e) => { if (e.target === memImportOverlay) _closeModal?.(memImportOverlay) })

// File area click -> trigger file input
memImportFileArea.addEventListener('click', () => memImportFileInput.click())

// Drag and drop
memImportFileArea.addEventListener('dragover', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = 'var(--accent)'
})
memImportFileArea.addEventListener('dragleave', () => {
  memImportFileArea.style.borderColor = ''
})
memImportFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = ''
  const files = Array.from(e.dataTransfer.files).filter(f =>
    f.name.endsWith('.md') || f.name.endsWith('.txt') || f.name.endsWith('.json')
  )
  if (files.length) {
    memImportFiles = files
    memImportFileNames.textContent = files.map(f => f.name).join(', ')
  }
})

// File input change
memImportFileInput.addEventListener('change', () => {
  memImportFiles = Array.from(memImportFileInput.files)
  memImportFileNames.textContent = memImportFiles.map(f => f.name).join(', ')
})

// Parse file into chunks (client-side)
async function parseFileToChunks(file) {
  const text = await file.text()
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'json') {
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        return data.map(item => {
          if (typeof item === 'object' && item !== null) return item.content || item.text || item.value || JSON.stringify(item)
          return String(item)
        }).filter(s => s.length > 20).map(s => s.slice(0, 2000))
      }
      return Object.entries(data).map(([k, v]) => `${k}: ${v}`).filter(s => s.length > 20).map(s => s.slice(0, 2000))
    } catch { return [text.slice(0, 2000)] }
  }

  if (ext === 'md') {
    return text.split(/\n(?=##?\s)/).map(s => s.trim()).filter(s => s.length > 20).map(s => s.slice(0, 2000))
  }

  // txt: split by paragraphs
  return text.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 20).map(s => s.slice(0, 2000))
}

// Import button click
memImportSaveBtn.addEventListener('click', async () => {
  if (!memImportFiles.length) {
    showToast(t('memories.toast.select_files'))
    return
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = true
  memImportSaveBtn.querySelector('.btn-loading').hidden = false
  memImportSaveBtn.disabled = true
  memImportProgress.hidden = false
  memImportResult.hidden = true
  memImportStatus.textContent = t('memories.import.processing')

  try {
    // Parse all files into chunks
    let allChunks = []
    for (const file of memImportFiles) {
      const chunks = await parseFileToChunks(file)
      allChunks = allChunks.concat(chunks)
    }

    if (allChunks.length === 0) {
      memImportProgress.hidden = true
      memImportSaveBtn.querySelector('.btn-text').hidden = false
      memImportSaveBtn.querySelector('.btn-loading').hidden = true
      memImportSaveBtn.disabled = false
      showToast(t('memories.toast.no_content'))
      return
    }

    memImportStatus.textContent = t('memories.import.importing', { n: allChunks.length })

    const agentId = document.getElementById('memImportAgent').value || mainAgentId()
    const resp = await fetch('/api/memories/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, chunks: allChunks }),
    })
    const data = await resp.json()

    memImportProgress.hidden = true

    if (data.ok) {
      const s = data.stats || {}
      memImportResult.hidden = false
      memImportResult.innerHTML = `
        <div style="color:var(--text-primary);font-weight:600;margin-bottom:8px">${t('memories.import.done_title')}</div>
        <div style="font-size:13px;color:var(--text-secondary)">
          ${t('memories.import.done_sub', { n: `<strong>${data.imported}</strong>` })}<br>
          Hot: ${s.hot || 0} | Warm: ${s.warm || 0} | Cold: ${s.cold || 0} | Shared: ${s.shared || 0}
        </div>
      `
      showToast(t('memories.toast.imported', { n: data.imported }))
      loadMemories()
      loadMemStats()
    } else {
      showToast('Hiba: ' + (data.error || 'Ismeretlen'))
    }
  } catch (err) {
    memImportProgress.hidden = true
    showToast(t('memories.toast.import_error'))
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false
})

// (Artifacts tab removed -- redundant with the dedicated Artifacts sidebar page)

// === PHASE 2: Timeline Mode (Idővonal) ===

let tlMode = 'strukt'
let tlLayoutNodes = []   // nodes with geometry + animation state
let tlEvents = []        // sorted event stream [{type,nodeId,ts}]
let tlT0 = 0
let tlT1 = 0
let tlSimTime = 0
let tlPlaying = false
let tlLastWall = 0
let tlRaf = null
let tlParticles = []    // [{type:'limb'|'sub', tier, nodeIdx, t, speed, size, alpha}]
let tlBursts = []       // active burst animations
let tlBurstQueue = []   // pending burst fires [{node, wallTime}] for 90ms stagger
let tlRootX = 0
let tlRootY = 0
let tlScrubDragging = false
let tlScrubWasPlaying = false
let tlNodeMap = {}      // id -> tlLayoutNodes[i]
let tlPlaybackSpeed = 1  // (t1-t0)/30s computed at load
let tlRecording = false
let tlMediaRecorder = null
let tlRecordedChunks = []
let tlFpsSamples = []    // recent frame deltas (ms) for FPS guardrail, capped at 15

const TL_LIMB_ANGLES = { hot: -0.55, warm: 0.25, cold: 1.55, shared: 2.85 }
const TL_TIERS = ['hot', 'warm', 'cold', 'shared']
const HU_MONTHS = ['jan','feb','már','ápr','máj','jún','júl','aug','szep','okt','nov','dec']

// Deterministic hash for a node id - avoids Math.random() for layout stability
function tlIdHash(id, salt) {
  let h = ((id * 2654435761) ^ (salt * 40503)) >>> 0
  h = ((h ^ (h >>> 16)) * 2246822519) >>> 0
  h = ((h ^ (h >>> 13)) * 3266489917) >>> 0
  return (h >>> 0) / 4294967295
}

function stopGraphSimulation() {
  if (graphSim) { cancelAnimationFrame(graphSim); graphSim = null }
  if (graphIdleRaf) { cancelAnimationFrame(graphIdleRaf); graphIdleRaf = null }
}

async function loadTimeline() {
  const agent = document.getElementById('memAgentFilter').value
  const params = new URLSearchParams({ weight_min: '0.75' })
  if (agent) params.set('agent', agent)
  try {
    const res = await fetch(`/api/memories/graph/timeline?${params}`)
    const data = await res.json()
    if (data.error) { console.error('Timeline API error:', data.error); return }
    buildTimeline(data)
  } catch (err) {
    console.error('Timeline load error:', err)
  }
}

function tlQuadBezierPoint(t, x0, y0, cx, cy, x1, y1) {
  const u = 1 - t
  return { x: u*u*x0 + 2*u*t*cx + t*t*x1, y: u*u*y0 + 2*u*t*cy + t*t*y1 }
}

function buildTimeline(data) {
  initGlowSprites()

  const canvas = document.getElementById('memGraphCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  canvas.style.width = rect.width + 'px'
  canvas.style.height = rect.height + 'px'
  graphCanvas = canvas
  graphCtx = canvas.getContext('2d')
  graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const W = rect.width
  const H = rect.height
  tlRootX = W * 0.42
  tlRootY = H * 0.48
  const minDim = Math.min(W, H)

  // Group nodes by tier, sorted by created_at
  const byTier = {}
  for (const tier of TL_TIERS) byTier[tier] = []
  for (const n of data.nodes) {
    const tier = n.tier || 'warm'
    byTier[tier] ? byTier[tier].push({ ...n }) : (byTier[tier] = [{ ...n }])
  }
  for (const tier of TL_TIERS) {
    byTier[tier].sort((a, b) => a.created_at - b.created_at)
    byTier[tier].forEach((n, i) => { n._rankInTier = i; n._totalInTier = byTier[tier].length })
  }

  tlLayoutNodes = []
  tlNodeMap = {}

  for (const tier of TL_TIERS) {
    const group = byTier[tier]
    if (!group.length) continue
    const limbAngle = TL_LIMB_ANGLES[tier]
    const limbLength = Math.min(minDim * 0.45, 180 + 22 * Math.sqrt(group.length))

    for (const n of group) {
      const total = n._totalInTier
      const bt = 0.35 + 0.65 * (total > 1 ? n._rankInTier / (total - 1) : 0.5)
      const ax = tlRootX + Math.cos(limbAngle) * limbLength * bt
      const ay = tlRootY + Math.sin(limbAngle) * limbLength * bt

      const jitter = (tlIdHash(n.id, 1) - 0.5) * 2.2  // ±1.1 rad
      const subAngle = limbAngle + jitter
      const subLength = 70 + tlIdHash(n.id, 2) * 130   // 70-200px
      const tx = ax + Math.cos(subAngle) * subLength
      const ty = ay + Math.sin(subAngle) * subLength
      const cpAngle = subAngle + 0.4
      const cpDist = subLength * 0.5
      const cpx = ax + Math.cos(cpAngle) * cpDist
      const cpy = ay + Math.sin(cpAngle) * cpDist

      const node = {
        id: n.id, label: n.label, tier, created_at: n.created_at,
        _limbAngle: limbAngle, _limbLength: limbLength, _bt: bt,
        _ax: ax, _ay: ay, _cpx: cpx, _cpy: cpy, _tx: tx, _ty: ty,
        _subAngle: subAngle, _subLength: subLength,
        // animation state
        _phase: 'waiting',  // 'waiting'|'branching'|'popping'|'alive'
        _animStart: 0,
        _branchProgress: 0,
        _nodeScale: 0,
        _haloAlpha: 0,
        _halospikeT: 0,  // burst halo spike progress 0-1
        _halospikeStart: 0,
        // tier-change animation (§5.6)
        _tierChangeActive: false,
        _tierChangePrevTier: tier,
        _tierChangeStart: 0,
      }
      tlLayoutNodes.push(node)
      tlNodeMap[n.id] = node
    }
  }

  // 60-iteration collision relaxation (y-weight 0.7, min 46px)
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < tlLayoutNodes.length; i++) {
      for (let j = i + 1; j < tlLayoutNodes.length; j++) {
        const a = tlLayoutNodes[i], b = tlLayoutNodes[j]
        const dx = b._tx - a._tx
        const dy = b._ty - a._ty
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 46 && dist > 0.01) {
          const push = (46 - dist) / 2
          const nx = dx / dist, ny = dy / dist
          a._tx -= nx * push; a._ty -= ny * push * 0.7
          b._tx += nx * push; b._ty += ny * push * 0.7
        }
      }
    }
  }

  // Recompute control points after relaxation: tips moved, curves must follow
  for (const n of tlLayoutNodes) {
    const adx = n._tx - n._ax, ady = n._ty - n._ay
    const actualAngle = Math.atan2(ady, adx)
    const actualLen = Math.sqrt(adx * adx + ady * ady)
    n._cpx = n._ax + Math.cos(actualAngle + 0.6) * actualLen * 0.5
    n._cpy = n._ay + Math.sin(actualAngle + 0.6) * actualLen * 0.5
  }

  // Scale-to-fit: compute bounding box of the full tree, scale uniformly so
  // 40px of padding exists on every side, then center on the canvas. Never
  // scales up (scale capped at 1); only shrinks when tree exceeds safe area.
  if (tlLayoutNodes.length) {
    const PAD = 40
    let minX = tlRootX, maxX = tlRootX, minY = tlRootY, maxY = tlRootY
    for (const n of tlLayoutNodes) {
      if (n._tx < minX) minX = n._tx; if (n._tx > maxX) maxX = n._tx
      if (n._ty < minY) minY = n._ty; if (n._ty > maxY) maxY = n._ty
      if (n._ax < minX) minX = n._ax; if (n._ax > maxX) maxX = n._ax
      if (n._ay < minY) minY = n._ay; if (n._ay > maxY) maxY = n._ay
    }
    const treeW = maxX - minX || 1
    const treeH = maxY - minY || 1
    const safeW = W - 2 * PAD
    const safeH = H - 2 * PAD
    const scale = Math.min(1, safeW / treeW, safeH / treeH)
    // Bounding-box center → canvas center
    const bbCx = (minX + maxX) / 2
    const bbCy = (minY + maxY) / 2
    const canvasCx = W / 2
    const canvasCy = H / 2
    const applyFit = (px, py) => ({
      x: canvasCx + (px - bbCx) * scale,
      y: canvasCy + (py - bbCy) * scale,
    })
    const r = applyFit(tlRootX, tlRootY)
    tlRootX = r.x; tlRootY = r.y
    for (const n of tlLayoutNodes) {
      const a = applyFit(n._ax, n._ay); n._ax = a.x; n._ay = a.y
      const c = applyFit(n._cpx, n._cpy); n._cpx = c.x; n._cpy = c.y
      const t = applyFit(n._tx, n._ty); n._tx = t.x; n._ty = t.y
    }
  }

  // Build event stream
  tlEvents = (data.events || []).slice().sort((a, b) => a.ts - b.ts)

  // Edge animation states (§5.4b)
  tlEdgeStates = (data.edges || []).map(e => ({
    edge: e, _phase: 'waiting', _animStart: 0, _drawProgress: 0,
  }))

  tlT0 = data.time_range.min_ts || 0
  tlT1 = data.time_range.max_ts || (tlT0 + 1)
  const span = Math.max(1, tlT1 - tlT0)
  tlPlaybackSpeed = span / 30  // virtual seconds per wall second

  // Start paused at t1 (full tree visible)
  tlSimTime = tlT1
  tlPlaying = false
  tlParticles = []
  tlBursts = []
  tlBurstQueue = []

  // Rebuild all nodes as alive at t1
  tlRebuildAtTime(tlT1)

  updateScrubber()
  buildMonthAxis()
  startTimelineLoop()
}

function tlRebuildAtTime(targetSimTime) {
  // Instant state rebuild: no animations, just set alive/waiting
  for (const n of tlLayoutNodes) {
    if (n.created_at <= targetSimTime) {
      n._phase = 'alive'
      n._branchProgress = 1
      n._nodeScale = 1
      n._haloAlpha = 1
      n._halospikeT = 0
    } else {
      n._phase = 'waiting'
      n._branchProgress = 0
      n._nodeScale = 0
      n._haloAlpha = 0
      n._halospikeT = 0
    }
  }
  // Rebuild edge states instantly (§5.4b, scrub=no animation)
  let aliveEdgeCount = 0
  for (const es of tlEdgeStates) {
    const visible = es.edge.weight >= 0.80 && es.edge.created_at <= targetSimTime
    if (visible && aliveEdgeCount < 250) {
      es._phase = 'alive'; es._drawProgress = 1
      aliveEdgeCount++
    } else {
      es._phase = 'waiting'; es._drawProgress = 0
    }
  }
  tlParticles = []
  tlBursts = []
  tlBurstQueue = []
}

function startTimelineLoop() {
  if (tlRaf) cancelAnimationFrame(tlRaf)
  tlLastWall = performance.now()

  function tick(now) {
    tlRaf = requestAnimationFrame(tick)
    if (document.hidden) return

    const dt = Math.min(now - tlLastWall, 100)  // cap to 100ms
    tlLastWall = now

    // Collect FPS samples for video guardrail (uncapped dt excluded)
    if (dt > 0 && dt < 100) {
      tlFpsSamples.push(dt)
      if (tlFpsSamples.length > 15) tlFpsSamples.shift()
    }

    if (tlPlaying && !GRAPH_REDUCED_MOTION) {
      tlSimTime = Math.min(tlT1, tlSimTime + dt * 0.001 * tlPlaybackSpeed)
      if (tlSimTime >= tlT1) {
        tlSimTime = tlT1
        tlPlaying = false
        updatePlayBtn()
        // Stop recording when playback reaches the end
        if (tlRecording && tlMediaRecorder && tlMediaRecorder.state === 'recording') {
          tlMediaRecorder.stop()
        }
      }
      // Fire events that fall within the new simTime window
      tlCheckAndFireEvents(tlSimTime - dt * 0.001 * tlPlaybackSpeed, tlSimTime, now)
    }

    // Process burst stagger queue
    tlProcessBurstQueue(now)

    // Advance particles
    if (!GRAPH_REDUCED_MOTION) tlTickTimelineParticles(dt)

    renderTimeline(now, dt)
    updateScrubberFill()
  }

  tlRaf = requestAnimationFrame(tick)
}

function stopTimelineLoop() {
  if (tlRaf) { cancelAnimationFrame(tlRaf); tlRaf = null }
}

let tlLastFiredEventIdx = 0  // track which events have been fired
let tlEdgeStates = []       // [{edge, _phase, _animStart, _drawProgress}]

function tlCheckAndFireEvents(prevSim, curSim, wallNow) {
  for (let i = 0; i < tlEvents.length; i++) {
    const ev = tlEvents[i]
    if (ev.ts > prevSim && ev.ts <= curSim) {
      if (ev.type === 'created') {
        const n = tlNodeMap[ev.memory_id]
        if (n && n._phase === 'waiting') {
          n._phase = 'branching'
          n._animStart = wallNow
          n._branchProgress = 0
          n._nodeScale = 0
          n._haloAlpha = 0
          // Queue burst with stagger (cap 12)
          if (tlBurstQueue.length < 12) {
            tlBurstQueue.push({ node: n, wallTime: wallNow + tlBurstQueue.length * 90 })
          }
          // Event feed
          tlUpdateEventFeed(n, 'created')
        }
      }
      if (ev.type === 'tier_changed' && ev.to_tier) {
        const n = tlNodeMap[ev.memory_id]
        if (n && n._phase === 'alive') {
          n._tierChangePrevTier = n.tier
          n.tier = ev.to_tier
          n._tierChangeActive = true
          n._tierChangeStart = wallNow
          // Mini-burst at node position with new tier color
          tlFireBurst(n, wallNow)
        }
      }
    }
  }
  // Fire semantic edge animations (§5.4b): keyed by edge.created_at
  for (const es of tlEdgeStates) {
    if (es._phase !== 'waiting') continue
    if (es.edge.created_at <= prevSim || es.edge.created_at > curSim) continue
    const srcNode = tlNodeMap[es.edge.src_id]
    const dstNode = tlNodeMap[es.edge.dst_id]
    if (!srcNode || !dstNode) continue
    if (es.edge.weight < 0.80) {
      es._phase = 'flash'
      es._animStart = wallNow
      es._drawProgress = 0
    } else {
      const aliveCount = tlEdgeStates.filter(s => s._phase === 'alive').length
      if (aliveCount < 250) {
        es._phase = 'drawing'
        es._animStart = wallNow
        es._drawProgress = 0
      }
    }
    // Feed event: only weight >= 0.90
    if (es.edge.weight >= 0.90 && srcNode && dstNode) {
      tlUpdateEventFeed(srcNode, 'linked', dstNode, es.edge)
    }
  }
}

function tlProcessBurstQueue(wallNow) {
  const ready = tlBurstQueue.filter(q => wallNow >= q.wallTime)
  tlBurstQueue = tlBurstQueue.filter(q => wallNow < q.wallTime)
  for (const q of ready) {
    tlFireBurst(q.node, wallNow)
  }
}

function tlFireBurst(node, wallNow) {
  if (GRAPH_REDUCED_MOTION) return
  const rayCount = 10 + Math.floor(tlIdHash(node.id, 3) * 3)
  const sparkCount = 12 + Math.floor(tlIdHash(node.id, 4) * 3)
  const rays = []
  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2 + tlIdHash(node.id * 100 + i, 5) * 0.5
    rays.push({
      angle,
      length: 10 + tlIdHash(node.id + i * 37, 6) * 16,
      alpha: 0.35 + tlIdHash(node.id + i * 53, 7) * 0.4,
    })
  }
  const sparks = []
  const glowColor = GRAPH_TIER_GLOW[node.tier] || '#ffffff'
  for (let i = 0; i < sparkCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const vel = 40 + Math.random() * 50
    sparks.push({
      x: node._tx, y: node._ty,
      vx: Math.cos(angle) * vel,
      vy: Math.sin(angle) * vel,
      size: 2 + Math.random() * 2,
      life: 700,
      elapsed: 0,
    })
  }
  tlBursts.push({
    x: node._tx, y: node._ty,
    startWall: wallNow,
    rays,
    sparks,
    glowColor,
    tier: node.tier,
  })
  // Halo spike
  node._halospikeStart = wallNow
  node._halospikeT = 1
}

function tlTickTimelineParticles(dt) {
  const dtS = dt / 1000

  // Advance existing particles
  for (const p of tlParticles) {
    p.t += p.speed * dtS
    if (p.t >= 1) p.t -= 1  // respawn at root
  }

  // Update burst sparks
  for (const burst of tlBursts) {
    for (const sp of burst.sparks) {
      sp.elapsed += dt
      sp.x += sp.vx * dtS
      sp.y += sp.vy * dtS
    }
  }
  // Remove expired bursts
  tlBursts = tlBursts.filter(b => {
    const age = tlLastWall - b.startWall
    return age < 900
  })

  // Spawn particles: 7 per alive limb spine, 3 per alive sub-branch
  // Rebuild particle pool based on alive nodes
  if (tlParticles.length < 140) {
    // Limb particles: one pool per tier limb that has alive nodes
    const aliveTiers = new Set()
    for (const n of tlLayoutNodes) {
      if (n._phase === 'alive' || n._phase === 'popping') aliveTiers.add(n.tier)
    }
    for (const tier of aliveTiers) {
      const limbCount = tlParticles.filter(p => p.type === 'limb' && p.tier === tier).length
      for (let i = limbCount; i < 7 && tlParticles.length < 140; i++) {
        tlParticles.push({
          type: 'limb', tier,
          t: i / 7,
          speed: 0.22 * (0.85 + tlIdHash(tier.charCodeAt(0) + i * 17, 8) * 0.30),
          size: 2.5 + tlIdHash(tier.charCodeAt(0) + i, 9) * 4.5,
          alpha: 0.5 + tlIdHash(tier.charCodeAt(0) + i * 3, 10) * 0.5,
        })
      }
    }
    // Sub-branch particles
    const aliveNodes = tlLayoutNodes.filter(n => n._phase === 'alive' && tlParticles.length < 140)
    for (const n of aliveNodes) {
      const subCount = tlParticles.filter(p => p.type === 'sub' && p.nodeId === n.id).length
      for (let i = subCount; i < 3 && tlParticles.length < 140; i++) {
        tlParticles.push({
          type: 'sub', tier: n.tier, nodeId: n.id,
          nodeIdx: tlLayoutNodes.indexOf(n),
          t: i / 3,
          speed: 0.35 * (0.85 + Math.random() * 0.30),
          size: 2.5 + Math.random() * 4.5,
          alpha: 0.5 + Math.random() * 0.5,
        })
      }
    }
  }

  // Remove sub-branch particles for nodes no longer alive
  tlParticles = tlParticles.filter(p => {
    if (p.type !== 'sub') return true
    const n = tlLayoutNodes[p.nodeIdx]
    return n && (n._phase === 'alive' || n._phase === 'popping')
  })
}

function tlUpdateEventFeed(node, type, dstNode = null, edge = null) {
  const feed = document.getElementById('tlEventFeed')
  if (!feed) return

  // Determine timestamp and text for this event type
  let ts, text
  if (type === 'linked' && dstNode && edge) {
    ts = edge.created_at
    const lblA = (node.label || '').slice(0, 16)
    const lblB = (dstNode.label || '').slice(0, 16)
    text = `${lblA} <-> ${lblB}`
  } else {
    ts = node.created_at
    const lbl = (node.label || '').slice(0, 25)
    const tierWord = node.tier || 'warm'
    text = `+ ${lbl} (${tierWord})`
  }
  const d = new Date(ts * 1000)
  const dateStr = `${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

  // Cap total rows (live + fading) at 12 so dense playback can't pile up.
  // Oldest fading rows are removed immediately; oldest live rows start fading.
  feed.querySelectorAll('.tl-feed-row.newest').forEach(r => r.classList.remove('newest'))
  const allRows = Array.from(feed.querySelectorAll('.tl-feed-row'))
  allRows.slice(0, Math.max(0, allRows.length - 11)).forEach(r => {
    if (r.classList.contains('fading-out')) {
      r.remove()
    } else {
      r.classList.add('fading-out')
      setTimeout(() => r.remove(), 260)
    }
  })

  const row = document.createElement('div')
  row.className = 'tl-feed-row newest'
  const dateSpan = document.createElement('span')
  dateSpan.className = 'tl-feed-date'
  dateSpan.textContent = dateStr
  const textSpan = document.createElement('span')
  textSpan.className = 'tl-feed-text'
  textSpan.textContent = text
  row.appendChild(dateSpan)
  row.appendChild(textSpan)
  feed.appendChild(row)
}

function buildMonthAxis() {
  const axis = document.getElementById('tlMonthAxis')
  if (!axis || tlT1 <= tlT0) return
  axis.innerHTML = ''

  const span = tlT1 - tlT0
  // Collect month-start timestamps in range
  const d0 = new Date(tlT0 * 1000)
  const d1 = new Date(tlT1 * 1000)
  const ticks = []
  const cur = new Date(d0.getFullYear(), d0.getMonth(), 1)
  while (cur <= d1 && ticks.length < 8) {
    const ts = cur.getTime() / 1000
    if (ts >= tlT0) ticks.push({ ts, label: HU_MONTHS[cur.getMonth()] })
    cur.setMonth(cur.getMonth() + 1)
  }

  for (const tick of ticks) {
    const pct = (tick.ts - tlT0) / span * 100
    const el = document.createElement('span')
    el.className = 'tl-month-tick'
    el.style.left = pct + '%'
    el.textContent = tick.label
    axis.appendChild(el)
  }
}

function updateScrubber() {
  updateScrubberFill()
  const chip = document.getElementById('tlDateChip')
  if (chip) {
    const d = new Date(tlSimTime * 1000)
    chip.textContent = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }
}

function updateScrubberFill() {
  const span = Math.max(1, tlT1 - tlT0)
  const pct = Math.max(0, Math.min(100, (tlSimTime - tlT0) / span * 100))
  const fill = document.getElementById('tlTrackFill')
  const knob = document.getElementById('tlKnob')
  if (fill) fill.style.width = pct + '%'
  if (knob) knob.style.left = pct + '%'

  const chip = document.getElementById('tlDateChip')
  if (chip) {
    const d = new Date(tlSimTime * 1000)
    chip.textContent = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  }
}

function updatePlayBtn() {
  const btn = document.getElementById('tlPlayBtn')
  if (!btn) return
  btn.innerHTML = tlPlaying ? '&#9646;&#9646;' : '&#9654;'
  btn.setAttribute('aria-label', tlPlaying ? 'Szünet' : 'Lejátszás')
}

function updateRecordBtn() {
  const btn = document.getElementById('tlRecordBtn')
  if (!btn) return
  btn.disabled = tlRecording
  if (tlRecording) {
    btn.classList.add('recording')
    btn.innerHTML = '&#9679; Rögzítés...'
  } else {
    btn.classList.remove('recording')
    btn.innerHTML = '&#9210; Videó'
  }
}

function tlStartRecording() {
  if (tlRecording) return
  if (!graphCanvas) return

  // FPS guardrail: warn if recent average < 25 fps
  if (tlFpsSamples.length >= 5) {
    const avgDt = tlFpsSamples.reduce((a, b) => a + b, 0) / tlFpsSamples.length
    const fps = Math.round(1000 / avgDt)
    if (fps < 25) {
      const ok = confirm(`A renderelés jelenleg ~${fps} fps-sel fut (ajánlott min. 25 fps). A mentett videó akadozhat. Folytatod?`)
      if (!ok) return
    }
  }

  // Reset timeline to start
  tlSimTime = tlT0
  tlRebuildAtTime(tlT0)
  tlPlaying = false
  updatePlayBtn()

  // Init MediaRecorder on the canvas stream
  const stream = graphCanvas.captureStream(30)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
  tlRecordedChunks = []
  tlMediaRecorder = new MediaRecorder(stream, { mimeType })

  tlMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) tlRecordedChunks.push(e.data)
  }

  tlMediaRecorder.onstop = () => {
    const blob = new Blob(tlRecordedChunks, { type: 'video/webm' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    a.download = `memoria-fa-${dateStr}.webm`
    a.href = url
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    tlRecording = false
    tlMediaRecorder = null
    tlRecordedChunks = []
    updateRecordBtn()
  }

  tlMediaRecorder.onerror = () => {
    tlRecording = false
    tlMediaRecorder = null
    tlRecordedChunks = []
    updateRecordBtn()
  }

  tlRecording = true
  updateRecordBtn()
  tlMediaRecorder.start(250)  // emit chunks every 250ms

  // Start playback from the beginning
  tlLastWall = performance.now()
  tlPlaying = true
  updatePlayBtn()
}

function renderTimeline(wallNow, dt) {
  if (!graphCtx || !graphCanvas) return
  const ctx = graphCtx
  const dpr = window.devicePixelRatio || 1
  const W = graphCanvas.width / dpr
  const H = graphCanvas.height / dpr

  // Dark cinematic background (always, §5.10)
  ctx.fillStyle = '#0d0d0b'
  ctx.fillRect(0, 0, W, H)

  // Root halo (layered, blend 'lighter')
  const rootSprite = graphGlowSprites['white']
  if (rootSprite) {
    const haloRadius = 90
    const haloSize = haloRadius * 2
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = 0.8
    ctx.drawImage(rootSprite, tlRootX - haloRadius, tlRootY - haloRadius, haloSize, haloSize)
    ctx.globalAlpha = 0.53
    ctx.drawImage(rootSprite, tlRootX - haloRadius * 0.6, tlRootY - haloRadius * 0.6, haloSize * 0.6, haloSize * 0.6)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
  // Root core: white 7px circle
  ctx.beginPath()
  ctx.arc(tlRootX, tlRootY, 7, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // Limb spines
  for (const tier of TL_TIERS) {
    const hasAlive = tlLayoutNodes.some(n => n.tier === tier && (n._phase === 'alive' || n._phase === 'popping' || n._phase === 'branching'))
    if (!hasAlive) continue
    const angle = TL_LIMB_ANGLES[tier]
    const group = tlLayoutNodes.filter(n => n.tier === tier)
    if (!group.length) continue
    const limbLength = group[0]._limbLength
    const glowCol = GRAPH_TIER_GLOW[tier] || '#ffffff'
    const baseCol = GRAPH_TIER_COLORS[tier] || '#888'
    const lx = tlRootX + Math.cos(angle) * limbLength
    const ly = tlRootY + Math.sin(angle) * limbLength
    const grad = ctx.createLinearGradient(tlRootX, tlRootY, lx, ly)
    grad.addColorStop(0, baseCol + '30')
    grad.addColorStop(1, glowCol + '18')
    ctx.beginPath()
    ctx.moveTo(tlRootX, tlRootY)
    ctx.lineTo(lx, ly)
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.6
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Limb particles
  if (!GRAPH_REDUCED_MOTION) {
    for (const p of tlParticles) {
      if (p.type !== 'limb') continue
      const angle = TL_LIMB_ANGLES[p.tier]
      const group = tlLayoutNodes.filter(n => n.tier === p.tier)
      if (!group.length) continue
      const limbLength = group[0]._limbLength
      const px = tlRootX + Math.cos(angle) * limbLength * p.t
      const py = tlRootY + Math.sin(angle) * limbLength * p.t
      const sprite = graphGlowSprites[p.tier] || graphParticleSprite
      if (sprite) {
        const sz = p.size * 4
        ctx.globalAlpha = p.alpha * 0.7
        ctx.globalCompositeOperation = 'lighter'
        ctx.drawImage(sprite, px - sz / 2, py - sz / 2, sz, sz)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    }
  }

  // Semantic edge layer (§5.4b): whisper-web lines between alive nodes
  ctx.lineWidth = 0.7
  for (const es of tlEdgeStates) {
    if (es._phase === 'waiting') continue
    const srcNode = tlNodeMap[es.edge.src_id]
    const dstNode = tlNodeMap[es.edge.dst_id]
    if (!srcNode || !dstNode) continue
    if (srcNode._phase === 'waiting' || dstNode._phase === 'waiting') continue

    let drawProg = 0
    if (es._phase === 'alive') {
      drawProg = 1
    } else if (es._phase === 'drawing') {
      const elapsed = wallNow - es._animStart
      drawProg = Math.min(1, elapsed / 450)
      es._drawProgress = drawProg
      if (elapsed >= 450) es._phase = 'alive'
    } else if (es._phase === 'flash') {
      const elapsed = wallNow - es._animStart
      if (elapsed >= 350) { es._phase = 'waiting'; continue }
      // Triangle wave: rise 175ms, fall 175ms
      drawProg = elapsed < 175 ? elapsed / 175 : (350 - elapsed) / 175
    }
    if (drawProg < 0.005) continue

    const x0 = srcNode._tx, y0 = srcNode._ty
    const x1 = dstNode._tx, y1 = dstNode._ty
    // Partial line draw-in from src toward dst
    const ex = x0 + (x1 - x0) * drawProg
    const ey = y0 + (y1 - y0) * drawProg

    const w = es.edge.weight
    const baseAlpha = w >= 0.90 ? 0.12 + 0.25 * w : 0.08 + 0.15 * w
    const alpha = es._phase === 'flash'
      ? Math.min(1, baseAlpha * 4 * drawProg)  // flash: brighter, fades with wave
      : baseAlpha * drawProg
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(ex, ey)
    ctx.strokeStyle = '#ffffff'
    ctx.globalAlpha = Math.min(1, alpha)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Branches and nodes
  const now400 = wallNow
  for (const n of tlLayoutNodes) {
    if (n._phase === 'waiting') continue

    // Advance animation phase
    if (n._phase === 'branching') {
      const elapsed = now400 - n._animStart
      const branchDuration = 400
      const progress = Math.min(1, elapsed / branchDuration)
      // ease-out: 1 - (1-t)^2
      n._branchProgress = 1 - Math.pow(1 - progress, 2)
      if (elapsed >= branchDuration) {
        n._phase = 'popping'
        n._animStart = wallNow
      }
    } else if (n._phase === 'popping') {
      const elapsed = wallNow - n._animStart
      const popDuration = 300
      const haloDuration = 250
      const haloDelay = 80
      const popT = Math.min(1, elapsed / popDuration)
      n._nodeScale = graphEaseOutBack(popT)
      n._haloAlpha = elapsed >= haloDelay ? Math.min(1, (elapsed - haloDelay) / haloDuration) : 0
      n._branchProgress = 1
      if (elapsed >= popDuration + haloDelay) {
        n._phase = 'alive'
        n._nodeScale = 1
        n._haloAlpha = 1
      }
    }

    // Draw sub-branch (partial bezier with tapered gradient)
    const prog = n._branchProgress
    if (prog > 0.01) {
      const steps = Math.max(3, Math.ceil(prog * 20))
      const tipT = prog
      const tipPt = tlQuadBezierPoint(tipT, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
      const glowCol = GRAPH_TIER_GLOW[n.tier] || '#ffffff'
      const baseCol = GRAPH_TIER_COLORS[n.tier] || '#888'

      ctx.beginPath()
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * tipT
        const pt = tlQuadBezierPoint(t, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
        if (i === 0) ctx.moveTo(pt.x, pt.y)
        else ctx.lineTo(pt.x, pt.y)
      }
      // Glow underlay
      const grad = ctx.createLinearGradient(n._ax, n._ay, tipPt.x, tipPt.y)
      grad.addColorStop(0, baseCol + '30')
      grad.addColorStop(0.5, baseCol + '8F')
      grad.addColorStop(1, glowCol + 'DE')
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineWidth = 1.5 * 3.4
      ctx.strokeStyle = glowCol + '12'
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineWidth = 1.5
      ctx.strokeStyle = grad
      ctx.stroke()
    }

    // Draw node with fly-in (last 30% of sub-branch during pop)
    if (n._nodeScale > 0.01) {
      let nx = n._tx, ny = n._ty
      if (n._phase === 'popping') {
        const popT = Math.min(1, (wallNow - n._animStart) / 300)
        // fly from 70% of sub-branch to tip
        const flyT = 0.7 + popT * 0.3
        const flyPt = tlQuadBezierPoint(flyT, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
        nx = flyPt.x; ny = flyPt.y
      }

      const tier = n.tier

      // §5.6 tier-change crossfade: cross-fade glow from prev tier to new tier over 600ms
      let tcProg = 1  // 1 = fully new tier
      if (n._tierChangeActive) {
        const tcElapsed = wallNow - n._tierChangeStart
        if (tcElapsed >= 600) {
          n._tierChangeActive = false
        } else {
          tcProg = tcElapsed / 600  // 0→1 linear
        }
      }
      const glowCol = GRAPH_TIER_GLOW[tier] || '#ffffff'
      const baseCol = GRAPH_TIER_COLORS[tier] || '#888'

      const scale = n._nodeScale
      const baseRadius = 5

      // Burst halo spike
      let haloMult = 3.4
      if (n._halospikeT > 0) {
        const spikeElapsed = wallNow - n._halospikeStart
        const spikeProgress = Math.min(1, spikeElapsed / 900)
        const eased = 1 - Math.pow(1 - spikeProgress, 2)  // ease-out
        n._halospikeT = 1 - eased
        haloMult = 3.4 + n._halospikeT * (7 - 3.4)
      }

      // Halo sprite (with §5.6 crossfade: blend prev tier out while new tier fades in)
      if (n._haloAlpha > 0.01) {
        const haloRadius = baseRadius * haloMult * scale
        const sz = haloRadius * 2
        ctx.globalCompositeOperation = 'lighter'
        // Outgoing tier halo fades out (only during crossfade)
        if (tcProg < 1 && graphGlowSprites[n._tierChangePrevTier]) {
          ctx.globalAlpha = n._haloAlpha * (1 - tcProg)
          ctx.drawImage(graphGlowSprites[n._tierChangePrevTier], nx - haloRadius, ny - haloRadius, sz, sz)
        }
        // Incoming tier halo fades in
        if (graphGlowSprites[tier]) {
          ctx.globalAlpha = n._haloAlpha * (tcProg < 1 ? tcProg : 1)
          ctx.drawImage(graphGlowSprites[tier], nx - haloRadius, ny - haloRadius, sz, sz)
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }

      // Node core circle
      ctx.beginPath()
      ctx.arc(nx, ny, baseRadius * scale, 0, Math.PI * 2)
      ctx.fillStyle = baseCol
      ctx.fill()
      ctx.beginPath()
      ctx.arc(nx, ny, baseRadius * 0.4 * scale, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.globalAlpha = 0.8
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  // Sub-branch particles
  if (!GRAPH_REDUCED_MOTION) {
    for (const p of tlParticles) {
      if (p.type !== 'sub') continue
      const n = tlLayoutNodes[p.nodeIdx]
      if (!n || n._phase === 'waiting') continue
      const pt = tlQuadBezierPoint(p.t, n._ax, n._ay, n._cpx, n._cpy, n._tx, n._ty)
      const sprite = graphGlowSprites[p.tier] || graphParticleSprite
      if (sprite) {
        const sz = p.size * 4
        ctx.globalAlpha = p.alpha * 0.7
        ctx.globalCompositeOperation = 'lighter'
        ctx.drawImage(sprite, pt.x - sz / 2, pt.y - sz / 2, sz, sz)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    }
  }

  // Burst rays and sparks
  if (!GRAPH_REDUCED_MOTION) {
    for (const burst of tlBursts) {
      const elapsed = wallNow - burst.startWall
      // Rays (600ms)
      if (elapsed < 600) {
        const prog = elapsed / 600
        const eased = 1 - Math.pow(1 - prog, 2)
        ctx.globalCompositeOperation = 'lighter'
        for (const ray of burst.rays) {
          const curLen = ray.length * eased
          const curAlpha = ray.alpha * (1 - prog)
          ctx.beginPath()
          ctx.moveTo(burst.x, burst.y)
          ctx.lineTo(burst.x + Math.cos(ray.angle) * curLen, burst.y + Math.sin(ray.angle) * curLen)
          ctx.strokeStyle = burst.glowColor
          ctx.lineWidth = 1.1
          ctx.globalAlpha = curAlpha
          ctx.stroke()
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
      // Sparks (700ms)
      if (elapsed < 700) {
        ctx.globalCompositeOperation = 'lighter'
        for (const sp of burst.sparks) {
          const life = 700
          const t = sp.elapsed / life
          if (t >= 1) continue
          const alpha = Math.pow(1 - t, 2)
          const sprite = graphParticleSprite
          if (sprite) {
            const sz = sp.size * 4
            ctx.globalAlpha = alpha * 0.8
            ctx.drawImage(sprite, sp.x - sz / 2, sp.y - sz / 2, sz, sz)
          }
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
    }
  }
}

// === Mode toggle logic ===

const graphModeToggle = document.getElementById('graphModeToggle')
if (graphModeToggle) {
  graphModeToggle.addEventListener('click', (e) => {
    const seg = e.target.closest('.mode-seg')
    if (!seg) return
    const newMode = seg.dataset.mode
    if (newMode === tlMode) return
    switchGraphMode(newMode)
  })
}

function switchGraphMode(newMode) {
  const crossfade = document.getElementById('graphCrossfade')
  const scrubber = document.getElementById('tlScrubber')
  const feed = document.getElementById('tlEventFeed')
  const limitBar = document.getElementById('graphLimitBar')

  function applyModeSwitch() {
    tlMode = newMode
    document.querySelectorAll('.mode-seg').forEach(s => {
      s.classList.toggle('active', s.dataset.mode === newMode)
    })
    // Controls hint is strukt-only (Drag/Dbl-click don't apply in timeline)
    const hint = document.querySelector('.graph-controls-hint')
    if (hint) hint.hidden = newMode === 'timeline'
    if (newMode === 'timeline') {
      stopGraphSimulation()
      if (scrubber) scrubber.hidden = false
      if (feed) feed.hidden = false
      if (limitBar) limitBar.hidden = true
      loadTimeline()
    } else {
      stopTimelineLoop()
      if (scrubber) scrubber.hidden = true
      if (feed) feed.hidden = true
      if (limitBar) limitBar.hidden = false
      loadMemoryGraph()
    }
  }

  if (crossfade) {
    crossfade.classList.add('fading')
    setTimeout(() => {
      applyModeSwitch()
      setTimeout(() => { crossfade.classList.remove('fading') }, 130)
    }, 120)
  } else {
    applyModeSwitch()
  }
}

// === Scrubber play/pause ===
document.getElementById('tlPlayBtn')?.addEventListener('click', () => {
  if (tlSimTime >= tlT1 && !tlPlaying) {
    // Replay from start
    tlSimTime = tlT0
    tlRebuildAtTime(tlT0)
  }
  tlPlaying = !tlPlaying
  tlLastWall = performance.now()
  updatePlayBtn()
})

document.getElementById('tlRecordBtn')?.addEventListener('click', () => {
  tlStartRecording()
})

// === Scrubber drag and click ===
;(function () {
  const track = document.getElementById('tlTrack')
  const knob = document.getElementById('tlKnob')
  if (!track || !knob) return

  function scrubToX(clientX) {
    const rect = track.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const span = Math.max(1, tlT1 - tlT0)
    tlSimTime = tlT0 + frac * span
    tlRebuildAtTime(tlSimTime)
    updateScrubber()
  }

  track.addEventListener('mousedown', (e) => {
    tlScrubDragging = true
    tlScrubWasPlaying = tlPlaying
    tlPlaying = false
    updatePlayBtn()
    scrubToX(e.clientX)
  })
  knob.addEventListener('mousedown', (e) => {
    e.stopPropagation()
    tlScrubDragging = true
    tlScrubWasPlaying = tlPlaying
    tlPlaying = false
    updatePlayBtn()
  })
  document.addEventListener('mousemove', (e) => {
    if (!tlScrubDragging) return
    scrubToX(e.clientX)
  })
  document.addEventListener('mouseup', () => {
    if (!tlScrubDragging) return
    tlScrubDragging = false
    if (tlScrubWasPlaying) {
      tlPlaying = true
      tlLastWall = performance.now()
      updatePlayBtn()
    }
  })
})()

// === Keyboard shortcuts (Space, arrows) when graph view focused ===
document.getElementById('memGraphView')?.addEventListener('keydown', (e) => {
  if (tlMode !== 'timeline') return
  if (e.code === 'Space') {
    e.preventDefault()
    document.getElementById('tlPlayBtn')?.click()
  } else if (e.code === 'ArrowRight') {
    e.preventDefault()
    const days = e.shiftKey ? 7 : 1
    tlSimTime = Math.min(tlT1, tlSimTime + days * 86400)
    tlRebuildAtTime(tlSimTime)
    updateScrubber()
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault()
    const days = e.shiftKey ? 7 : 1
    tlSimTime = Math.max(tlT0, tlSimTime - days * 86400)
    tlRebuildAtTime(tlSimTime)
    updateScrubber()
  }
}, { passive: false })

// Make the graph view focusable for keyboard events
document.getElementById('memGraphView')?.setAttribute('tabindex', '0')
