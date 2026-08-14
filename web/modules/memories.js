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
document.getElementById('memAgentFilter').addEventListener('change', () => {
  if (currentMemTier === 'graph') {
    loadMemoryGraph()
  } else if (currentMemTier === 'log') {
    loadDailyLog()
  } else if (currentMemTier === 'artifacts') {
    loadArtifactsTab()
  } else {
    loadMemories()
  }
})

// Search with debounce
memSearchInput.addEventListener('input', () => {
  clearTimeout(memSearchTimer)
  if (currentMemTier === 'artifacts') {
    memSearchTimer = setTimeout(loadArtifactsTab, 300)
  } else {
    memSearchTimer = setTimeout(loadMemories, 300)
  }
})

// Enter to search immediately
memSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(memSearchTimer)
    if (currentMemTier === 'artifacts') {
      loadArtifactsTab()
    } else {
      loadMemories()
    }
  }
})

// Tab switching
document.getElementById('memTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.mem-tab')
  if (!tab) return
  document.querySelectorAll('.mem-tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  currentMemTier = tab.dataset.tier

  const isLog       = currentMemTier === 'log'
  const isGraph     = currentMemTier === 'graph'
  const isArtifacts = currentMemTier === 'artifacts'

  document.getElementById('memTierView').hidden      = isLog || isGraph || isArtifacts
  document.getElementById('memLogView').hidden       = !isLog
  document.getElementById('memGraphView').hidden     = !isGraph
  document.getElementById('memArtifactsView').hidden = !isArtifacts
  document.getElementById('memArtKindFilter').style.display = isArtifacts ? '' : 'none'

  if (isGraph) {
    loadMemoryGraph()
  } else if (isLog) {
    loadDailyLog()
  } else if (isArtifacts) {
    loadArtifactsTab()
  } else {
    loadMemories()
  }
})

// Add memory button
document.getElementById('memAddBtn').addEventListener('click', () => {
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
document.getElementById('memModalClose').addEventListener('click', () => _closeModal?.(memModalOverlay))
memModalOverlay.addEventListener('click', (e) => { if (e.target === memModalOverlay) _closeModal?.(memModalOverlay) })

// Save memory (create or edit)
document.getElementById('saveMemBtn').addEventListener('click', async () => {
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
      node.vx += (tc.x - node.x) * 0.0005
      node.vy += (tc.y - node.y) * 0.0005
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let dx = nodes[j].x - nodes[i].x
      let dy = nodes[j].y - nodes[i].y
      let dist = Math.sqrt(dx * dx + dy * dy) || 1
      let force = 800 / (dist * dist)
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
    let force = (dist - 80) * 0.005 * edge.strength
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
    const edgeAlpha = searchFaded ? 0.04 : (isActiveEdge ? 0.85 : (isDimmed ? 0.05 : baseAlpha * pulse))
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

    let targetAlpha = 0.85
    if (searchFaded) targetAlpha = 0.12
    else if (searchGlow || isHover || isSelected) targetAlpha = 1.0
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
    ctx.globalAlpha = displayAlpha

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

    // Selected ring
    if (isSelected) {
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.arc(rx, ry, r + 4, 0, Math.PI * 2)
      ctx.stroke()
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

    // Label pill
    if (!searchFaded || displayAlpha > 0.15) {
      const labelText = node.label
      const labelFontSize = Math.max(7, Math.min(11, 9 / Math.max(graphZoom * 0.7, 0.5)))
      ctx.font = (isHover || isSelected) ? `600 ${labelFontSize + 1}px -apple-system, sans-serif` : `500 ${labelFontSize}px -apple-system, sans-serif`
      const textWidth = ctx.measureText(labelText).width
      const pillW = textWidth + 10
      const pillH = labelFontSize + 6
      const pillX = rx - pillW / 2
      const pillY = ry + r + 5

      ctx.globalAlpha = searchFaded ? 0.08 : ((isHover || isSelected) ? 0.9 : 0.65)
      ctx.fillStyle = 'rgba(20,20,19,0.85)'
      graphRoundRect(ctx, pillX, pillY, pillW, pillH, 3)
      ctx.fill()

      ctx.fillStyle = '#faf9f5'
      ctx.globalAlpha = searchFaded ? 0.1 : ((isHover || isSelected) ? 1 : 0.85)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(labelText, rx, pillY + pillH / 2)
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

// === Graph detail panel ===
function showGraphPanel(node) {
  let panel = document.getElementById('graphPanel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'graphPanel'
    panel.className = 'graph-panel'
    document.getElementById('memGraphView').appendChild(panel)
  }
  const tierLabelsMap = { hot: 'Hot', warm: 'Warm', cold: 'Cold', shared: 'Shared' }
  const created = node.mem.created_label || ''
  panel.innerHTML = `
    <div class="graph-panel-header">
      <span class="badge badge-${node.tier}">${tierLabelsMap[node.tier] || node.tier}</span>
      <span class="graph-panel-agent">${escapeHtml(node.agent)}</span>
      <button class="graph-panel-close" id="graphPanelCloseBtn">&times;</button>
    </div>
    ${created ? `<div class="graph-panel-date">${escapeHtml(created)}</div>` : ''}
    <div class="graph-panel-content">${escapeHtml(node.mem.content)}</div>
    <div class="graph-panel-meta">
      ${node.keywords.length ? '<div class="graph-panel-keywords">' + node.keywords.map(k => '<span class="mem-keyword-tag">' + escapeHtml(k) + '</span>').join('') + '</div>' : ''}
    </div>
  `
  panel.hidden = false
  document.getElementById('graphPanelCloseBtn').addEventListener('click', () => {
    graphSelectedNode = null
    panel.hidden = true
    renderGraph()
  })
}

function hideGraphPanel() {
  const panel = document.getElementById('graphPanel')
  if (panel) panel.hidden = true
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

// ============================================================
// === Artifacts Tab (on Memories screen) ===
// ============================================================

let _artPreviewArtifactId = null

export async function loadArtifactsTab() {
  const listEl   = document.getElementById('memArtifactsList')
  const emptyEl  = document.getElementById('memArtifactsEmpty')
  const previewEl = document.getElementById('memArtifactsPreview')

  if (!listEl) return
  listEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">' + t('memories.artifacts.loading') + '</div>'
  if (emptyEl)  emptyEl.hidden = true
  if (previewEl) previewEl.hidden = true

  const agent = document.getElementById('memAgentFilter').value
  const q     = document.getElementById('memSearchInput').value.trim()
  const kind  = document.getElementById('memArtKindFilter').value

  const params = new URLSearchParams()
  if (agent) params.set('agent', agent)
  if (q)     params.set('q', q)
  if (kind)  params.set('kind', kind)
  params.set('limit', '50')

  try {
    const res  = await fetch('/api/artifacts?' + params.toString())
    const rows = await res.json()

    if (!rows.length) {
      listEl.innerHTML = ''
      if (emptyEl) emptyEl.hidden = false
      return
    }

    listEl.innerHTML = `
      <table class="art-tab-table">
        <thead>
          <tr>
            <th>${t('memories.artifacts.col.agent')}</th>
            <th>${t('memories.artifacts.col.title')}</th>
            <th>${t('memories.artifacts.col.kind')}</th>
            <th>${t('memories.artifacts.col.date')}</th>
            <th>${t('memories.artifacts.col.actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.agent_id)}</td>
              <td title="${escapeHtml(r.title)}">${escapeHtml(r.title.length > 48 ? r.title.slice(0, 48) + '…' : r.title)}</td>
              <td><span class="badge">${escapeHtml(r.kind)}</span></td>
              <td>${new Date(r.created_at * 1000).toLocaleDateString('hu-HU')}</td>
              <td class="art-tab-actions">
                <button class="btn-sm art-preview-btn" data-id="${escapeHtml(r.id)}">${t('memories.artifacts.btn.preview')}</button>
                <button class="btn-sm art-open-btn" data-id="${escapeHtml(r.id)}">${t('memories.artifacts.btn.open')}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
  } catch {
    listEl.innerHTML = '<div style="padding:16px;color:var(--danger)">' + t('memories.artifacts.load_error') + '</div>'
  }
}

// Delegated click handler for the artifacts tab list
document.getElementById('memArtifactsList').addEventListener('click', async (e) => {
  const previewBtn = e.target.closest('.art-preview-btn')
  const openBtn    = e.target.closest('.art-open-btn')
  if (!previewBtn && !openBtn) return

  const id = (previewBtn || openBtn).dataset.id
  if (!id) return

  if (previewBtn) {
    const previewEl = document.getElementById('memArtifactsPreview')
    if (_artPreviewArtifactId === id && !previewEl.hidden) {
      previewEl.hidden = true
      _artPreviewArtifactId = null
      return
    }
    _artPreviewArtifactId = id
    previewEl.hidden = false
    previewEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary)">' + t('memories.artifacts.loading') + '</div>'

    try {
      const res  = await fetch(`/api/artifacts/${id}`)
      const art  = await res.json()
      const isText = ['html', 'markdown', 'json', 'text'].includes(art.kind)

      if (art.kind === 'html') {
        // sandbox=allow-scripts, NO allow-same-origin -- script runs in a null origin
        previewEl.innerHTML = `<iframe class="art-preview-frame" sandbox="allow-scripts"
          srcdoc="${escapeHtml(art.content)}"></iframe>`
      } else if (art.kind === 'markdown') {
        // renderMarkdown escapes all user content via escapeHtml/mdInline -- safe for innerHTML
        previewEl.innerHTML = `<div class="markdown-body md-rendered" style="padding:12px;overflow-y:auto">${renderMarkdown(art.content)}</div>`
      } else if (art.kind === 'json') {
        // highlightJson HTML-escapes all string values via escapeHtml -- safe for innerHTML
        previewEl.innerHTML = `<pre class="art-preview-pre">${highlightJson(art.content)}</pre>`
      } else if (isText) {
        previewEl.innerHTML = `<pre class="art-preview-pre">${escapeHtml(art.content)}</pre>`
      } else {
        const bytes   = atob(art.content)
        const bArr    = new Uint8Array(bytes.length)
        for (let i = 0; i < bytes.length; i++) bArr[i] = bytes.charCodeAt(i)
        const blob    = new Blob([bArr], { type: art.mime })
        const url     = URL.createObjectURL(blob)
        previewEl.innerHTML = `<a class="btn" href="${url}" download="${escapeHtml(art.title)}">${t('memories.artifacts.btn.download')}</a>`
      }
    } catch {
      previewEl.innerHTML = '<div style="padding:16px;color:var(--danger)">' + t('memories.artifacts.load_error') + '</div>'
    }
  }

  if (openBtn) {
    try {
      const res  = await fetch(`/api/artifacts/${id}/view-token`, { method: 'POST' })
      const data = await res.json()
      // Guard: only open same-origin paths; reject protocol-relative (//evil.com)
      // and any non-relative URL by parsing against the current origin.
      if (data.url) {
        try {
          const parsed = new URL(data.url, window.location.origin)
          if (parsed.origin === window.location.origin) {
            window.open(parsed.pathname + parsed.search + parsed.hash, '_blank', 'noopener,noreferrer')
          } else {
            showToast(t('memories.artifacts.load_error'))
          }
        } catch {
          showToast(t('memories.artifacts.load_error'))
        }
      }
      else showToast(t('memories.artifacts.load_error'))
    } catch {
      showToast(t('memories.artifacts.load_error'))
    }
  }
})

// Close artifacts preview on click-outside or Escape
document.getElementById('memArtifactsPreview')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.hidden = true
    _artPreviewArtifactId = null
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const previewEl = document.getElementById('memArtifactsPreview')
    if (previewEl && !previewEl.hidden) {
      previewEl.hidden = true
      _artPreviewArtifactId = null
    }
  }
})
