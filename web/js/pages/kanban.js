import { t } from '/js/core/i18n.js'
import { escapeHtml } from '/js/core/dom.js'
import { openModal, closeModal, showToast } from '/js/core/ui.js'
import { loadIdeasPage } from '/js/pages/ideas.js'

// === Kanban auto-refresh ===
let kanbanRefreshTimer = null

function startKanbanRefresh() {
  if (kanbanRefreshTimer) clearInterval(kanbanRefreshTimer)
  kanbanRefreshTimer = setInterval(loadKanban, 30000)
}

function stopKanbanRefresh() {
  if (kanbanRefreshTimer) {
    clearInterval(kanbanRefreshTimer)
    kanbanRefreshTimer = null
  }
}

// === Kanban ===
// ============================================================

let kanbanCards = []
let kanbanAssignees = []
let kanbanProjects = []
// Label registry (id/name/color), independent of which cards currently carry
// which labels -- card.labels (embedded by GET /api/kanban) holds that link.
let kanbanAllLabels = []
// Active label-filter ids -- the quick-filter chip row AND the per-card
// footer label pills both toggle this same set (two entry points, one
// filter dimension). OR-combined within itself (any active label matches),
// AND-combined with the existing project/assignee filters. Persisted in
// localStorage alongside the swimlane groupBy choice.
let kanbanLabelFilter = new Set()
let kanbanProjectFilter = ''
// Assignee filter for the kanban board. '' = show all. Set via the
// assignee dropdown / "Csak Gábor" toggle injected by setupAssigneeFilter().
// Matched case-insensitively against card.assignee so a casing mismatch
// (e.g. card "gorcsevivan" vs list "GorcsevIvan") still filters correctly.
let kanbanAssigneeFilter = ''
// Swimlane grouping: 'none' (flat board, default) | 'assignee' | 'priority'.
// The initial value is pulled from window._marveen.kanbanSwimlanes.defaultGroup
// the first time loadKanban() runs (see kanbanGroupByInitialized below), then
// fully user-controlled via the toolbar dropdown.
let kanbanGroupBy = 'none'
let kanbanGroupByInitialized = false
// Which swimlane keys (assignee name or priority value) are collapsed. Lives
// for the page session only -- intentionally not persisted across reloads.
const kanbanCollapsedLanes = new Set()

const cardModalOverlay = document.getElementById('cardModalOverlay')
const cardDetailOverlay = document.getElementById('cardDetailOverlay')
const breakdownOverlay = document.getElementById('breakdownOverlay')
let breakdownCardId = null
let breakdownSubtasks = []
// Breakdown modal is shared between kanban-card breakdown and idea promote.
let breakdownMode = 'kanban' // 'kanban' | 'idea'
let breakdownIdeaId = null
const columns = document.querySelectorAll('.kanban-col-body')

// Modal wiring
document.getElementById('cardModalClose').addEventListener('click', () => closeModal(cardModalOverlay))
document.getElementById('cardDetailClose').addEventListener('click', () => closeModal(cardDetailOverlay))
cardModalOverlay.addEventListener('click', (e) => { if (e.target === cardModalOverlay) closeModal(cardModalOverlay) })
cardDetailOverlay.addEventListener('click', (e) => { if (e.target === cardDetailOverlay) closeModal(cardDetailOverlay) })

// Add card buttons per column
document.querySelectorAll('.kanban-add-btn').forEach((btn) => {
  btn.addEventListener('click', () => openNewCardModal(btn.dataset.status))
})

async function loadKanban() {
  try {
    // Always refresh the marveen config so values changed on the Settings page
    // (e.g. WIP limits) show up on the board on the next Kanban open, without a
    // hard reload. The full /api/marveen payload includes kanbanAging, kanbanWip,
    // kanbanSwimlanes and kanbanLabels, so the labels (from the labels feature)
    // stay populated too. Also covers opening the Kanban page first, before the
    // Agents page populated window._marveen.
    try {
      const mr = await fetch('/api/marveen')
      if (mr.ok) window._marveen = { ...(window._marveen || {}), ...(await mr.json()) }
    } catch { /* ignore -- aging/WIP/swimlanes/labels just won't render until _marveen loads */ }
    if (!kanbanGroupByInitialized) {
      kanbanGroupByInitialized = true
      // A user's own past choice (saved to localStorage) wins over the
      // server-configured default, so switching the grouping sticks across
      // page reloads instead of resetting every time.
      const stored = localStorage.getItem('marveen.kanbanGroupBy')
      const defaultGroup = window._marveen?.kanbanSwimlanes?.defaultGroup
      const initialGroup = (stored === 'assignee' || stored === 'priority' || stored === 'none')
        ? stored
        : (defaultGroup === 'assignee' || defaultGroup === 'priority' ? defaultGroup : 'none')
      if (initialGroup !== 'none') {
        kanbanGroupBy = initialGroup
        const sel = document.getElementById('kanbanGroupBy')
        if (sel) sel.value = initialGroup
      }
      // Active label-filter selection, restored the same way as the groupBy
      // choice -- a fresh page load should not lose the filters set up.
      try {
        const storedLabels = JSON.parse(localStorage.getItem('marveen.kanbanLabelFilter') || '[]')
        if (Array.isArray(storedLabels)) kanbanLabelFilter = new Set(storedLabels)
      } catch { /* ignore malformed storage */ }
    }
    const [cardsRes, assigneesRes, projectsRes, labelsRes] = await Promise.all([
      fetch('/api/kanban'),
      fetch('/api/kanban/assignees'),
      fetch('/api/kanban-projects'),
      fetch('/api/kanban/labels'),
    ])
    kanbanCards = await cardsRes.json()
    kanbanAssignees = await assigneesRes.json()
    kanbanProjects = await projectsRes.json()
    kanbanAllLabels = await labelsRes.json()
    populateProjectFilter()
    populateProjectSuggestions()
    setupAssigneeFilter()
    renderKanban()
  } catch (err) {
    console.error('Kanban betöltés hiba:', err)
  }
}

document.getElementById('kanbanGroupBy').addEventListener('change', (e) => {
  kanbanGroupBy = e.target.value
  localStorage.setItem('marveen.kanbanGroupBy', kanbanGroupBy)
  renderKanban()
})

function populateProjectFilter() {
  const sel = document.getElementById('kanbanProjectFilter')
  const prev = sel.value
  sel.innerHTML = '<option value="">Mind</option>'
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p
    if (p === prev) opt.selected = true
    sel.appendChild(opt)
  }
  if (prev && !kanbanProjects.includes(prev)) kanbanProjectFilter = ''
}

function populateProjectSuggestions() {
  const dl = document.getElementById('projectSuggestions')
  if (!dl) return
  dl.innerHTML = ''
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    dl.appendChild(opt)
  }
}

document.getElementById('kanbanProjectFilter').addEventListener('change', (e) => {
  kanbanProjectFilter = e.target.value
  renderKanban()
})

// The kanban "owner" is the assignee whose type is 'owner' -- the person the
// board is primarily run for, on any deployment. Identified by type, never by
// a hard-coded display name, so the quick "show what's on me" view is generic.
// Returns null when no owner-type assignee exists (then the quick button is
// hidden and only the general per-assignee dropdown is shown).
function ownerAssigneeName() {
  const owner = kanbanAssignees.find((a) => a.type === 'owner')
  return owner ? owner.name : null
}

// Reflect the active state of the owner quick-toggle button (hidden when there
// is no owner-type assignee).
function syncOwnerFilterBtn() {
  const btn = document.getElementById('kanbanOwnerBtn')
  if (!btn) return
  const owner = ownerAssigneeName()
  if (!owner) { btn.style.display = 'none'; return }
  btn.style.display = ''
  const on = !!kanbanAssigneeFilter && kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
  btn.style.background = on ? 'var(--accent)' : 'var(--bg)'
  btn.style.color = on ? '#081a2d' : 'var(--fg)'
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
}

// Inject the assignee filter (per-assignee dropdown + an owner "Rám vár" quick
// toggle) into the kanban toolbar. Built in JS rather than as static markup so
// the toolbar stays self-contained. Idempotent: the controls are created once;
// later calls only refresh the <option>s from the current assignee list.
function setupAssigneeFilter() {
  const projectSel = document.getElementById('kanbanProjectFilter')
  if (!projectSel) return
  const toolbar = projectSel.parentElement
  let sel = document.getElementById('kanbanAssigneeFilter')
  if (!sel) {
    const label = document.createElement('label')
    label.setAttribute('for', 'kanbanAssigneeFilter')
    label.textContent = t('kanban.filter.assignee_label')
    label.style.cssText = 'font-size:13px;color:var(--muted);white-space:nowrap;margin-left:8px;'

    sel = document.createElement('select')
    sel.id = 'kanbanAssigneeFilter'
    sel.style.cssText = 'font-size:13px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);min-width:140px;'
    sel.addEventListener('change', (e) => {
      kanbanAssigneeFilter = e.target.value
      syncOwnerFilterBtn()
      renderKanban()
    })

    const ownerBtn = document.createElement('button')
    ownerBtn.id = 'kanbanOwnerBtn'
    ownerBtn.type = 'button'
    ownerBtn.textContent = t('kanban.filter.owner_btn')
    ownerBtn.title = t('kanban.owner_filter')
    ownerBtn.style.cssText = 'font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer;'
    ownerBtn.addEventListener('click', () => {
      const owner = ownerAssigneeName()
      if (!owner) return
      const on = kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
      kanbanAssigneeFilter = on ? '' : owner
      // Keep the dropdown in sync (only selectable if the owner is a known assignee).
      sel.value = kanbanAssignees.some((a) => a.name === kanbanAssigneeFilter) ? kanbanAssigneeFilter : ''
      syncOwnerFilterBtn()
      renderKanban()
    })

    toolbar.appendChild(label)
    toolbar.appendChild(sel)
    toolbar.appendChild(ownerBtn)
  }

  // (Re)populate options from the current assignee list, preserving selection.
  const prev = kanbanAssigneeFilter
  sel.innerHTML = '<option value="">Mind</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    // Show the persona displayName (id as fallback), matching #216; the
    // option value / filter key stays the agent id.
    opt.textContent = a.displayName || a.name
    if (a.name === prev) opt.selected = true
    sel.appendChild(opt)
  }
  // syncOwnerFilterBtn shows/hides the owner quick-button based on whether an
  // owner-type assignee exists in the freshly loaded list.
  syncOwnerFilterBtn()
}

// Project + assignee + label filters, independent of the priority quick-filter
// Project + assignee filters only -- the baseline the label quick-filter
// chip counts are computed against, independent of which labels are
// currently active, so a chip's count stays meaningful whether it's the one
// being toggled or not.
function kanbanCardMatchesBaseFilters(card) {
  if (kanbanProjectFilter && (card.project || '') !== kanbanProjectFilter) return false
  const assigneeFilter = kanbanAssigneeFilter.toLowerCase()
  if (assigneeFilter && String(card.assignee || '').trim().toLowerCase() !== assigneeFilter) return false
  return true
}

// The label-filter dimension itself: a card matches when no label filter is
// active, or when it carries at least one of the active labels (OR within
// the dimension).
function kanbanCardMatchesLabelFilter(card) {
  if (kanbanLabelFilter.size === 0) return true
  const cardLabelIds = (card.labels || []).map((l) => l.id)
  return cardLabelIds.some((id) => kanbanLabelFilter.has(id))
}

// Shared by both the header quick-filter chips and the per-card footer label
// pills -- one filter dimension, two entry points into the same toggle.
function toggleKanbanLabelFilter(labelId) {
  if (kanbanLabelFilter.has(labelId)) kanbanLabelFilter.delete(labelId)
  else kanbanLabelFilter.add(labelId)
  persistKanbanFilters()
  renderKanban()
}

function clearKanbanQuickFilters() {
  kanbanLabelFilter.clear()
  persistKanbanFilters()
  renderKanban()
}

function persistKanbanFilters() {
  localStorage.setItem('marveen.kanbanLabelFilter', JSON.stringify([...kanbanLabelFilter]))
}

// Quick-filter chip row: one chip per defined label (not per priority), tinted
// with that label's own colour. Clicking toggles the same kanbanLabelFilter
// set the footer pills use.
function renderKanbanQuickFilters() {
  const row = document.getElementById('kanbanQuickFilters')
  if (!row) return
  row.innerHTML = ''
  for (const label of kanbanAllLabels) {
    const count = kanbanCards.filter((c) =>
      kanbanCardMatchesBaseFilters(c) && (c.labels || []).some((l) => l.id === label.id)
    ).length
    const active = kanbanLabelFilter.has(label.id)
    const chip = document.createElement('span')
    chip.className = 'kanban-quick-filter-chip' + (active ? ' active' : '')
    chip.dataset.labelId = label.id
    chip.style.setProperty('--chip-color', label.color)
    chip.innerHTML = `#${escapeHtml(label.name)} <span class="kanban-quick-filter-count">${count}</span>${active ? '<span class="kanban-quick-filter-clear">&times;</span>' : ''}`
    chip.addEventListener('click', () => toggleKanbanLabelFilter(label.id))
    row.appendChild(chip)
  }
  if (kanbanLabelFilter.size > 0) {
    const clearAll = document.createElement('button')
    clearAll.className = 'kanban-quick-filter-clear-all'
    clearAll.textContent = t('kanban.filter.clear')
    clearAll.addEventListener('click', clearKanbanQuickFilters)
    row.appendChild(clearAll)
  }
}

function renderKanban() {
  const cardById = new Map(kanbanCards.map(c => [c.id, c]))

  renderKanbanQuickFilters()

  // Determine which top-level cards are visible under current filters.
  const visibleCardIds = new Set()
  for (const card of kanbanCards) {
    if (!kanbanCardMatchesBaseFilters(card)) continue
    if (!kanbanCardMatchesLabelFilter(card)) continue
    visibleCardIds.add(card.id)
  }

  // A subtask is "embedded" when its parent is visible AND both share the same
  // column. Embedded subtasks are hidden as standalone cards and rendered
  // inside the parent card instead. Filter state of the subtask itself is
  // intentionally ignored so it always shows under its visible parent.
  const embeddedSubtaskIds = new Set()
  for (const card of kanbanCards) {
    if (!card.parent_id) continue
    const parent = cardById.get(card.parent_id)
    if (!parent || !visibleCardIds.has(parent.id)) continue
    if (parent.status === card.status) embeddedSubtaskIds.add(card.id)
  }

  const grouped = { planned: [], in_progress: [], waiting: [], done: [] }
  for (const card of kanbanCards) {
    if (embeddedSubtaskIds.has(card.id)) continue
    if (!visibleCardIds.has(card.id)) continue
    if (grouped[card.status]) grouped[card.status].push(card)
  }

  // Update counts (embedded subtasks don't count as separate cards)
  document.getElementById('countPlanned').textContent = grouped.planned.length
  document.getElementById('countInProgress').textContent = grouped.in_progress.length
  document.getElementById('countWaiting').textContent = grouped.waiting.length
  document.getElementById('countDone').textContent = grouped.done.length

  const flatBoard = document.getElementById('kanbanBoard')
  const swimlaneBoard = document.getElementById('kanbanSwimlaneBoard')

  if (kanbanGroupBy === 'none') {
    swimlaneBoard.hidden = true
    flatBoard.hidden = false
    for (const [status, cards] of Object.entries(grouped)) {
      const col = document.querySelector(`#kanbanBoard .kanban-col-body[data-status="${status}"]`)
      col.innerHTML = ''
      cards.sort((a, b) => a.sort_order - b.sort_order)

      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        col.appendChild(createCardEl(card, embeddedChildren))
      }
    }
    // Badge: only count subtasks that are in a different column (not embedded here)
    updateSubtaskBadges(embeddedSubtaskIds)
    // WIP limit badges (count/limit + colour) on the flat board too -- previously
    // only the swimlane view updated these, so a configured limit never showed
    // on the default flat board.
    updateWipBadges(grouped)
  } else {
    flatBoard.hidden = true
    swimlaneBoard.hidden = false
    renderSwimlaneBoard(grouped, embeddedSubtaskIds)
  }
}

const KANBAN_STATUS_DEFS = [
  { status: 'planned', title: () => t('kanban.col.planned') },
  { status: 'in_progress', title: () => t('kanban.col.in_progress') },
  { status: 'waiting', title: () => t('kanban.col.waiting') },
  { status: 'done', title: () => t('kanban.col.done') },
]
const KANBAN_PRIORITY_LABELS = { urgent: () => t('kanban.priority.urgent'), high: () => t('kanban.priority.high'), normal: () => t('kanban.priority.normal'), low: () => t('kanban.priority.low') }
const KANBAN_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

// Which swimlane a card belongs to under the current grouping. Returns a
// stable string key: the matched assignee's canonical name, '__unassigned__'
// for cards with no/unmatched assignee, or the priority value.
function kanbanSwimlaneKeyFor(card) {
  if (kanbanGroupBy === 'priority') return card.priority || 'normal'
  const raw = card.assignee ? String(card.assignee).trim() : ''
  if (!raw) return '__unassigned__'
  const match = kanbanAssignees.find(a => a.name.toLowerCase() === raw.toLowerCase())
  return match ? match.name : raw
}

// Display metadata (label + avatar styling) for a swimlane key.
function kanbanSwimlaneMeta(key) {
  if (kanbanGroupBy === 'priority') {
    const _rawPL = KANBAN_PRIORITY_LABELS[key]; const label = _rawPL ? (typeof _rawPL === 'function' ? _rawPL() : _rawPL) : key
    return { label, avatarClass: `priority-${key}`, avatarChar: '' }
  }
  if (key === '__unassigned__') return { label: t('kanban.unassigned'), avatarClass: 'unknown', avatarChar: '?' }
  const match = kanbanAssignees.find(a => a.name === key)
  const label = match ? (match.displayName || match.name) : key
  return { label, avatarClass: match ? match.type : 'unknown', avatarChar: (label[0] || '?').toUpperCase() }
}

function renderSwimlaneBoard(grouped, embeddedSubtaskIds) {
  const board = document.getElementById('kanbanSwimlaneBoard')
  board.innerHTML = ''

  const presentKeys = new Set()
  for (const cards of Object.values(grouped)) {
    for (const c of cards) presentKeys.add(kanbanSwimlaneKeyFor(c))
  }

  const canonicalOrder = kanbanGroupBy === 'priority'
    ? KANBAN_PRIORITY_ORDER
    : [...kanbanAssignees.map(a => a.name), '__unassigned__']
  const orderedKeys = canonicalOrder.filter(k => presentKeys.has(k))
  const leftoverKeys = [...presentKeys].filter(k => !orderedKeys.includes(k)).sort((a, b) => a.localeCompare(b))
  const keys = [...orderedKeys, ...leftoverKeys]

  const separatorColor = window._marveen?.kanbanSwimlanes?.separatorColor

  for (const key of keys) {
    const meta = kanbanSwimlaneMeta(key)
    const collapsed = kanbanCollapsedLanes.has(key)

    const laneCardsByStatus = {}
    let totalCount = 0
    for (const def of KANBAN_STATUS_DEFS) {
      const cards = grouped[def.status].filter(c => kanbanSwimlaneKeyFor(c) === key)
      laneCardsByStatus[def.status] = cards
      totalCount += cards.length
    }

    const lane = document.createElement('div')
    lane.className = 'kanban-swimlane' + (collapsed ? ' collapsed' : '')
    lane.dataset.group = key
    if (separatorColor) lane.style.borderBottomColor = separatorColor

    const header = document.createElement('div')
    header.className = 'kanban-swimlane-header'
    header.innerHTML = `
      <span class="kanban-swimlane-avatar ${meta.avatarClass}">${escapeHtml(meta.avatarChar)}</span>
      <span class="kanban-swimlane-name">${escapeHtml(meta.label)}</span>
      <span class="kanban-swimlane-count">${totalCount}</span>
      <button class="kanban-swimlane-toggle" type="button" aria-expanded="${!collapsed}" title="${collapsed ? t('kanban.swimlane.expand') : t('kanban.swimlane.collapse')}">${collapsed ? '▶' : '▼'}</button>
    `
    header.querySelector('.kanban-swimlane-toggle').addEventListener('click', (e) => {
      e.stopPropagation()
      if (kanbanCollapsedLanes.has(key)) kanbanCollapsedLanes.delete(key)
      else kanbanCollapsedLanes.add(key)
      renderKanban()
    })
    lane.appendChild(header)

    const body = document.createElement('div')
    body.className = 'kanban-swimlane-body'
    for (const def of KANBAN_STATUS_DEFS) {
      const col = document.createElement('div')
      col.className = 'kanban-swimlane-col'

      const colHeader = document.createElement('div')
      colHeader.className = 'kanban-swimlane-col-header'
      colHeader.textContent = typeof def.title === 'function' ? def.title() : def.title

      const colBody = document.createElement('div')
      colBody.className = 'kanban-col-body kanban-swimlane-col-body'
      colBody.dataset.status = def.status

      const cards = laneCardsByStatus[def.status].sort((a, b) => a.sort_order - b.sort_order)
      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        colBody.appendChild(createCardEl(card, embeddedChildren))
      }
      wireKanbanColumnDnD(colBody)

      col.appendChild(colHeader)
      col.appendChild(colBody)
      body.appendChild(col)
    }
    lane.appendChild(body)
    board.appendChild(lane)
  }

  updateSubtaskBadges(embeddedSubtaskIds)

  // WIP limit badges: update column-header count spans with "count/limit" when configured
  updateWipBadges(grouped)
}

// Map column status keys to their count-span IDs
const WIP_COUNT_IDS = {
  planned: 'countPlanned',
  in_progress: 'countInProgress',
  waiting: 'countWaiting',
  done: 'countDone',
}

function updateWipBadges(grouped) {
  const cfg = window._marveen?.kanbanWip
  for (const [status, cards] of Object.entries(grouped)) {
    const el = document.getElementById(WIP_COUNT_IDS[status])
    if (!el) continue
    const limit = cfg?.limits?.[status] || 0
    if (!limit) {
      // No limit configured: restore plain count and clear WIP styling
      el.textContent = cards.length
      delete el.dataset.wip
      el.style.color = ''
      el.style.borderColor = ''
      continue
    }
    const count = cards.length
    el.textContent = `${count}/${limit}`
    let state, color
    if (count > limit) {
      state = 'over'; color = cfg.overColor
    } else if (count === limit) {
      state = 'full'; color = cfg.fullColor
    } else if ((count / limit) * 100 >= cfg.warnPct) {
      state = 'warn'; color = cfg.warnColor
    } else {
      state = 'ok'; color = cfg.okColor
    }
    el.dataset.wip = state
    el.style.color = color
    el.style.borderColor = color
  }
}

function updateSubtaskBadges(embeddedSubtaskIds) {
  for (const el of document.querySelectorAll('.kanban-card[data-id]')) {
    const id = el.dataset.id
    const badge = el.querySelector('.kanban-subtask-badge')
    if (!badge) continue
    const nonEmbedded = kanbanCards.filter(c => c.parent_id === id && !embeddedSubtaskIds.has(c.id))
    if (nonEmbedded.length > 0) {
      badge.textContent = `${nonEmbedded.length} subtask`
      badge.style.display = ''
      badge.onclick = (e) => {
        e.stopPropagation()
        const card = kanbanCards.find(c => c.id === id)
        if (card) showCardDetail(card)
      }
    } else {
      badge.style.display = 'none'
    }
  }
}

function createCardEl(card, embeddedChildren = []) {
  const el = document.createElement('div')
  el.className = 'kanban-card'
  el.dataset.id = card.id
  el.dataset.priority = card.priority
  el.draggable = true

  // Assignee chip. Match the card's assignee against the known list
  // case-insensitively (a card stored as "gorcsevivan" must still match the
  // list entry "GorcsevIvan"). When the assignee is set but not in the list
  // at all, still render a fallback chip with the raw name + a neutral dot,
  // so a card never silently loses its assignee chip on a name mismatch.
  const rawAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawAssignee.toLowerCase())
    : null
  // Display the persona displayName (falling back to the id) per #216, while
  // keeping the robust match above and the raw-name fallback chip below.
  const assigneeLabel = assignee ? (assignee.displayName || assignee.name) : ''
  const assigneeHtml = assignee
    ? `<span class="kanban-card-assignee"><span class="assignee-dot ${assignee.type}">${escapeHtml(assigneeLabel[0])}</span>${escapeHtml(assigneeLabel)}</span>`
    : rawAssignee
      ? `<span class="kanban-card-assignee"><span class="assignee-dot unknown">${escapeHtml(rawAssignee[0])}</span>${escapeHtml(rawAssignee)}</span>`
      : ''

  let dueHtml = ''
  if (card.due_date) {
    const d = new Date(card.due_date * 1000)
    const now = new Date()
    const overdue = d < now && card.status !== 'done'
    const label = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
    dueHtml = `<span class="kanban-card-due ${overdue ? 'overdue' : ''}">${label}</span>`
  }

  const projectHtml = card.project
    ? `<span class="kanban-card-project">${escapeHtml(card.project)}</span>`
    : ''

  // Label footer pills: at most 3 shown + a "+N" overflow indicator. Each pill
  // (except the overflow one) toggles that label into the active label-filter
  // when clicked, mirroring the priority quick-filter chips above the board.
  let labelsHtml = ''
  if (Array.isArray(card.labels) && card.labels.length > 0) {
    const shown = card.labels.slice(0, 3)
    const overflow = card.labels.length - shown.length
    const pills = shown.map((l) =>
      `<span class="kanban-card-label-pill" data-label-id="${escapeHtml(l.id)}" style="--label-color:${escapeHtml(l.color)}" title="${t('kanban.label.filter_tooltip', { name: escapeHtml(l.name) })}">#${escapeHtml(l.name)}</span>`
    ).join('')
    const overflowHtml = overflow > 0
      ? `<span class="kanban-card-label-pill kanban-card-label-overflow" title="${t('kanban.label.overflow_tooltip', { n: overflow })}">+${overflow}</span>`
      : ''
    labelsHtml = `<div class="kanban-card-labels">${pills}${overflowHtml}</div>`
  }

  const seqHtml = card.seq != null
    ? `<span class="kanban-card-seq" style="font-family:monospace;font-size:11px;color:var(--muted);margin-right:5px">#${card.seq}</span>`
    : ''

  // Card aging: left stripe + top-right badge based on hours since last update.
  // Skipped for done cards. Config thresholds and colours come from window._marveen.kanbanAging.
  let agingBadgeHtml = ''
  const agingCfg = window._marveen?.kanbanAging
  if (agingCfg && card.updated_at && card.status !== 'done') {
    const hoursOld = (Date.now() / 1000 - card.updated_at) / 3600
    let agingLevel = null
    let agingColor = null
    if (hoursOld >= agingCfg.criticalH) {
      agingLevel = 'critical'; agingColor = agingCfg.criticalColor
    } else if (hoursOld >= agingCfg.cautionH) {
      agingLevel = 'caution'; agingColor = agingCfg.cautionColor
    } else if (hoursOld >= agingCfg.warnH) {
      agingLevel = 'warn'; agingColor = agingCfg.warnColor
    }
    if (agingLevel) {
      const days = Math.floor(hoursOld / 24)
      const ageLabel = days >= 1 ? `${days}d` : `${Math.floor(hoursOld)}h`
      const exact = new Date(card.updated_at * 1000).toLocaleString('hu-HU')
      agingBadgeHtml = `<span class="kanban-card-aging-badge kanban-card-aging-${agingLevel}" style="color:${agingColor}" title="${t('kanban.aging.tooltip', { exact })}">⏳ ${ageLabel}</span>`
      el.dataset.aging = agingLevel
      el.style.setProperty('--card-aging-color', agingColor)
    }
  }

  // Embedded subtasks: rendered as mini-cards below a divider when the subtask
  // shares the same column as this parent card.
  let embeddedHtml = ''
  if (embeddedChildren.length > 0) {
    const items = embeddedChildren.map(c => {
      const rawCa = c.assignee ? String(c.assignee).trim() : ''
      const ca = rawCa ? kanbanAssignees.find(a => a.name.toLowerCase() === rawCa.toLowerCase()) : null
      const caLabel = ca ? (ca.displayName || ca.name) : rawCa
      const caHtml = caLabel ? `<span class="kanban-embedded-assignee">${escapeHtml(caLabel)}</span>` : ''
      const cSeq = c.seq != null ? `<span class="kanban-embedded-seq">#${c.seq}</span> ` : ''
      return `<div class="kanban-embedded-subtask" data-id="${escapeHtml(c.id)}">${cSeq}${escapeHtml(c.title)}${caHtml}</div>`
    }).join('')
    embeddedHtml = `<div class="kanban-embedded-subtasks">${items}</div>`
  }

  el.innerHTML = `
    ${projectHtml}
    <div class="kanban-card-title">${seqHtml}${escapeHtml(card.title)}</div>
    <div class="kanban-card-footer">${assigneeHtml}${dueHtml}</div>
    ${labelsHtml}
    <div class="kanban-card-actions">
      <button class="card-breakdown-btn" title="${t('kanban.btn.breakdown')}" aria-label="${t('kanban.btn.breakdown')}">⚡</button>
    </div>
    ${agingBadgeHtml}
    <div class="kanban-subtask-badge" style="display:none"></div>
    ${embeddedHtml}
  `

  // "AI szétbont" gomb – ne nyissa meg a detail modalt
  el.querySelector('.card-breakdown-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    triggerBreakdown(card)
  })

  // Label pills -> toggle that label into the active filter (don't open detail)
  el.querySelectorAll('.kanban-card-label-pill[data-label-id]').forEach((pillEl) => {
    pillEl.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleKanbanLabelFilter(pillEl.dataset.labelId)
    })
  })

  // Click on embedded subtask -> open that subtask's detail (don't bubble to parent)
  el.querySelectorAll('.kanban-embedded-subtask').forEach(subEl => {
    subEl.addEventListener('click', (e) => {
      e.stopPropagation()
      const child = kanbanCards.find(c => c.id === subEl.dataset.id)
      if (child) showCardDetail(child)
    })
  })

  // Drag events
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging')
    e.dataTransfer.setData('text/plain', card.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragend', () => el.classList.remove('dragging'))

  // Click -> detail
  el.addEventListener('click', () => showCardDetail(card))

  return el
}

// === Drag & Drop ===
// Wires the drag/drop handlers for one column-body element. Used for the
// 4 static flat-board columns at load time, and again for every swimlane
// column-body created dynamically in renderSwimlaneBoard (those elements
// don't exist yet when this module first runs).
function wireKanbanColumnDnD(col) {
  col.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    col.classList.add('drag-over')

    // Insert indicator position
    const afterEl = getDragAfterElement(col, e.clientY)
    const dragging = document.querySelector('.kanban-card.dragging')
    if (!dragging) return
    if (afterEl) {
      col.insertBefore(dragging, afterEl)
    } else {
      col.appendChild(dragging)
    }
  })

  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over')
  })

  col.addEventListener('drop', async (e) => {
    e.preventDefault()
    col.classList.remove('drag-over')
    const cardId = e.dataTransfer.getData('text/plain')
    const newStatus = col.dataset.status

    // Calculate sort_order based on position
    const cards = [...col.querySelectorAll('.kanban-card')]
    const idx = cards.findIndex((c) => c.dataset.id === cardId)
    let sortOrder = idx

    try {
      await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, sort_order: sortOrder }),
      })
      loadKanban()
    } catch {
      showToast(t('kanban.toast.move_error'))
    }
  })
}
columns.forEach(wireKanbanColumnDnD)

function getDragAfterElement(col, y) {
  const els = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
  let closest = null
  let closestOffset = Number.NEGATIVE_INFINITY

  for (const el of els) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset
      closest = el
    }
  }
  return closest
}

// === New card modal ===
function openNewCardModal(status) {
  document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_new')
  document.getElementById('cardTitle').value = ''
  document.getElementById('cardDesc').value = ''
  document.getElementById('cardPriority').value = 'normal'
  document.getElementById('cardProject').value = ''
  document.getElementById('cardDue').value = ''
  document.getElementById('cardEditId').value = ''
  document.getElementById('cardEditStatus').value = status || 'planned'
  populateAssigneeSelect('cardAssignee')
  populateProjectSuggestions()
  openModal(cardModalOverlay)
  setTimeout(() => document.getElementById('cardTitle').focus(), 200)
}

function populateAssigneeSelect(selectId, selected) {
  const sel = document.getElementById(selectId)
  sel.innerHTML = '<option value="">-- Nincs --</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    opt.textContent = a.displayName || a.name
    if (selected && a.name === selected) opt.selected = true
    sel.appendChild(opt)
  }
}

// Save card (create or update)
document.getElementById('saveCardBtn').addEventListener('click', async () => {
  const title = document.getElementById('cardTitle').value.trim()
  if (!title) { document.getElementById('cardTitle').focus(); return }

  const data = {
    title,
    description: document.getElementById('cardDesc').value.trim() || null,
    assignee: document.getElementById('cardAssignee').value || null,
    priority: document.getElementById('cardPriority').value,
    project: document.getElementById('cardProject').value.trim() || null,
    due_date: document.getElementById('cardDue').value
      ? Math.floor(new Date(document.getElementById('cardDue').value).getTime() / 1000)
      : null,
  }

  const editId = document.getElementById('cardEditId').value

  try {
    if (editId) {
      const res = await fetch(`/api/kanban/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_updated'))
    } else {
      data.status = document.getElementById('cardEditStatus').value
      const res = await fetch('/api/kanban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_created'))
    }
    closeModal(cardModalOverlay)
    loadKanban()
  } catch (err) {
    showToast(t('kanban.toast.save_error_msg', { msg: err.message }))
  }
})

// === Card labels (in the detail modal) ===
// Always re-fetches the card's own labels via the dedicated endpoint instead
// of trusting card.labels -- callers that pass a card object sourced from
// /api/kanban/:id/children (subtask list) don't have labels embedded, only
// the bulk board listing (/api/kanban) does.
async function renderCardLabelsSection(card) {
  const listEl = document.getElementById('cardLabelList')
  const addSelect = document.getElementById('cardLabelAdd')
  const newBtn = document.getElementById('cardLabelNewBtn')
  const newForm = document.getElementById('cardLabelNewForm')
  const newNameInput = document.getElementById('cardLabelNewName')
  const newColorsEl = document.getElementById('cardLabelNewColors')
  const newSaveBtn = document.getElementById('cardLabelNewSaveBtn')

  let attached = []
  try {
    attached = await (await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`)).json()
  } catch { /* leave empty -- pill list just stays blank */ }

  listEl.innerHTML = ''
  for (const label of attached) {
    const pill = document.createElement('span')
    pill.className = 'label-pill'
    pill.style.setProperty('--label-color', label.color)
    pill.innerHTML = `#${escapeHtml(label.name)} <button class="label-pill-remove" title="${t('kanban.label.remove_btn')}" aria-label="${t('kanban.label.remove_btn')}">&times;</button>`
    pill.querySelector('.label-pill-remove').addEventListener('click', async () => {
      try {
        await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels/${encodeURIComponent(label.id)}`, { method: 'DELETE' })
        renderCardLabelsSection(card)
        loadKanban()
      } catch { showToast(t('kanban.toast.label_remove_error')) }
    })
    listEl.appendChild(pill)
  }

  const attachedIds = new Set(attached.map((l) => l.id))
  addSelect.innerHTML = `<option value="">-- ${t('kanban.label.add_placeholder')} --</option>`
  for (const label of kanbanAllLabels) {
    if (attachedIds.has(label.id)) continue
    const opt = document.createElement('option')
    opt.value = label.id
    opt.textContent = label.name
    addSelect.appendChild(opt)
  }
  addSelect.onchange = async () => {
    const labelId = addSelect.value
    if (!labelId) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId }),
      })
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_add_error')) }
  }

  newForm.style.display = 'none'
  newBtn.onclick = () => {
    newForm.style.display = newForm.style.display === 'none' ? '' : 'none'
    newNameInput.value = ''
  }

  const palette = window._marveen?.kanbanLabels?.colors || ['#64748b']
  newColorsEl.innerHTML = ''
  let selectedColor = palette[0]
  palette.forEach((color, i) => {
    const sw = document.createElement('span')
    sw.className = 'label-color-swatch' + (i === 0 ? ' selected' : '')
    sw.style.background = color
    sw.addEventListener('click', () => {
      selectedColor = color
      newColorsEl.querySelectorAll('.label-color-swatch').forEach((s) => s.classList.remove('selected'))
      sw.classList.add('selected')
    })
    newColorsEl.appendChild(sw)
  })

  newSaveBtn.onclick = async () => {
    const name = newNameInput.value.trim()
    if (!name) { newNameInput.focus(); return }
    try {
      const r = await fetch('/api/kanban/labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: selectedColor }),
      })
      if (!r.ok) { showToast(t('kanban.toast.label_create_error')); return }
      const newLabel = await r.json()
      kanbanAllLabels.push(newLabel)
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId: newLabel.id }),
      })
      newForm.style.display = 'none'
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_create_error')) }
  }
}

// === Card detail ===
async function showCardDetail(card) {
  // Running number (#N) in the title bar, plus the stable hex id in the meta.
  const seqPrefix = card.seq != null ? `#${card.seq} ` : ''
  document.getElementById('cardDetailTitle').textContent = `${seqPrefix}${card.title}`

  // Case-insensitive match; fall back to the raw stored name so a casing
  // mismatch (or an unregistered assignee) shows the actual name, not "nincs".
  const rawDetailAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawDetailAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawDetailAssignee.toLowerCase())
    : null
  const assigneeDisplay = assignee ? (assignee.displayName || assignee.name) : (rawDetailAssignee || '-- nincs --')
  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const statusLabels = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), waiting: t('kanban.status.waiting'), done: t('kanban.status.done') }

  const meta = document.getElementById('cardDetailMeta')
  const idLabel = (card.seq != null ? `#${card.seq} · ` : '') + card.id
  meta.innerHTML = `
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.id')}</span>
      <span class="meta-value" style="font-family:monospace" title="${t('kanban.meta.id_tooltip')}">${escapeHtml(idLabel)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.status')}</span>
      <span class="meta-value">${statusLabels[card.status] || card.status}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.assignee')}</span>
      <span class="meta-value meta-value-editable" id="metaAssigneeValue" data-card-id="${card.id}" title="${t('kanban.meta.edit_tooltip')}">${escapeHtml(assigneeDisplay)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.priority')}</span>
      <span class="meta-value">${priorityLabels[card.priority]}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.project')}</span>
      <span class="meta-value">${card.project ? escapeHtml(card.project) : t('kanban.meta.none')}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.deadline')}</span>
      <span class="meta-value">${card.due_date ? new Date(card.due_date * 1000).toLocaleDateString(_lang === 'en' ? 'en-US' : 'hu-HU') : t('kanban.meta.none')}</span>
    </div>
  `

  // Inline edit for assignee on detail view
  const assigneeValueEl = document.getElementById('metaAssigneeValue')
  assigneeValueEl.addEventListener('click', () => {
    if (assigneeValueEl.querySelector('select')) return
    const current = card.assignee || ''
    const sel = document.createElement('select')
    sel.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:inherit'
    sel.innerHTML = '<option value="">-- Nincs --</option>'
    for (const a of kanbanAssignees) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.displayName || a.name
      if (a.name === current) opt.selected = true
      sel.appendChild(opt)
    }
    assigneeValueEl.innerHTML = ''
    assigneeValueEl.appendChild(sel)
    sel.focus()
    const save = async () => {
      const newVal = sel.value || null
      if (newVal === current || (newVal === null && !current)) {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        return
      }
      try {
        const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...card, assignee: newVal }),
        })
        if (!r.ok) throw new Error('PUT failed')
        card.assignee = newVal
        assigneeValueEl.textContent = newVal ? newVal : '-- nincs --'
        showToast(t('kanban.toast.assignee_updated'))
        loadKanban && loadKanban()
      } catch {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        showToast(t('kanban.toast.save_error'))
      }
    }
    sel.addEventListener('change', save)
    sel.addEventListener('blur', () => {
      if (assigneeValueEl.querySelector('select')) {
        assigneeValueEl.textContent = card.assignee ? card.assignee : '-- nincs --'
      }
    })
  })

  document.getElementById('cardDetailDesc').textContent = card.description || ''

  renderCardLabelsSection(card)

  // #115: Parent meta row — dropdown replaces the old read-only display; shown only when editable
  const parentMetaItem = document.getElementById('parentMetaItem')
  const parentSelect = document.getElementById('parentSelect')
  const canModifyParent = card.status === 'planned' || card.status === 'waiting'
  if (card.parent_id && canModifyParent) {
    // Build the parent-select dropdown: null option + all top-level non-done tasks
    parentSelect.innerHTML = `<option value="">${t('kanban.parent.empty')}</option>`
    const availableParents = kanbanCards.filter(c =>
      !c.parent_id && c.id !== card.id && !c.archived_at &&
      (c.status === 'planned' || c.status === 'in_progress' || c.status === 'waiting')
    )
    for (const p of availableParents) {
      const opt = document.createElement('option')
      opt.value = p.id
      const fullLabel = (p.seq != null ? `#${p.seq} ` : '') + p.title
      opt.title = fullLabel
      opt.textContent = fullLabel.length > 33 ? fullLabel.slice(0, 32) + '…' : fullLabel
      if (p.id === card.parent_id) opt.selected = true
      parentSelect.appendChild(opt)
    }
    parentSelect.onchange = async () => {
      const newParentId = parentSelect.value || null
      const label = newParentId ? t('kanban.toast.parent_updated') : t('kanban.toast.parent_unset')
      const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...card, parent_id: newParentId }),
      })
      if (r.ok) { card.parent_id = newParentId; showToast(label); loadKanban(); showCardDetail(card) }
      else showToast(t('kanban.toast.save_error'))
    }
    parentMetaItem.style.display = ''
  } else {
    parentMetaItem.style.display = 'none'
  }

  // Load comments
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
    const comments = await res.json()
    const list = document.getElementById('commentsList')
    list.innerHTML = ''
    for (const c of comments) {
      const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
      const div = document.createElement('div')
      div.className = 'comment-item'
      div.innerHTML = `
        <div><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-date">${date}</span></div>
        <div class="comment-body">${escapeHtml(c.content)}</div>
      `
      list.appendChild(div)
    }
  } catch { /* ignore */ }

  // Author select for new comment. Default to the bot assignee resolved by
  // type (never a hard-coded display name -- BOT_NAME differs per deployment),
  // falling back to the first assignee. The old literal 'Marveen' never matched
  // on non-Marveen installs, so the select stayed on "-- Nincs --" and the
  // comment submit silently no-opped (addCommentBtn returns when !author).
  // (Resolution of the #254/#241 overlap: keep #241's type-resolved default
  // over #254's hard-coded "Gábor" -- same deployment-agnostic reasoning.)
  const defaultCommentAuthor =
    (kanbanAssignees.find((a) => a.type === 'owner') || kanbanAssignees[0] || {}).name || ''
  populateAssigneeSelect('commentAuthor', defaultCommentAuthor)

  // Add comment
  document.getElementById('addCommentBtn').onclick = async () => {
    const content = document.getElementById('commentContent').value.trim()
    const author = document.getElementById('commentAuthor').value
    if (!content) { document.getElementById('commentContent').focus(); return }
    if (!author) { showToast(t('kanban.toast.comment_no_author')); return }
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, content }),
      })
      // Without this check an HTTP error (e.g. 400) still cleared the textarea
      // and "refreshed", so the comment looked sent but was never saved.
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { msg = (await res.json()).error || msg } catch {}
        showToast(t('kanban.toast.comment_failed', { msg }))
        return
      }
      document.getElementById('commentContent').value = ''
      showCardDetail(card) // refresh
    } catch {
      showToast(t('kanban.toast.comment_error'))
    }
  }

  // Edit button
  document.getElementById('cardEditBtn').onclick = () => {
    closeModal(cardDetailOverlay)
    document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_edit')
    document.getElementById('cardTitle').value = card.title
    document.getElementById('cardDesc').value = card.description || ''
    document.getElementById('cardPriority').value = card.priority
    document.getElementById('cardProject').value = card.project || ''
    document.getElementById('cardDue').value = card.due_date
      ? new Date(card.due_date * 1000).toISOString().split('T')[0]
      : ''
    document.getElementById('cardEditId').value = card.id
    document.getElementById('cardEditStatus').value = card.status
    populateAssigneeSelect('cardAssignee', card.assignee)
    populateProjectSuggestions()
    openModal(cardModalOverlay)
  }

  // Archive
  document.getElementById('cardArchiveBtn').onclick = async () => {
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/archive`, { method: 'POST' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_archived'))
      loadKanban()
    } catch {
      showToast(t('kanban.toast.archive_error'))
    }
  }

  // Delete
  document.getElementById('cardDeleteBtn').onclick = async () => {
    if (!confirm(t('kanban.confirm.delete'))) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_deleted'))
      loadKanban()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Load children (subtasks) — only top-level tasks have children (no subtask of subtask)
  try {
    const childRes = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/children`)
    const children = await childRes.json()
    const section = document.getElementById('cardChildrenSection')
    const list = document.getElementById('cardChildrenList')
    const addSubtaskSection = document.getElementById('cardAddSubtaskSection')
    const isTask = !card.parent_id

    // #113: Show add-subtask form only for top-level tasks that are not done
    if (isTask && card.status !== 'done') {
      addSubtaskSection.style.display = ''
      const titleInput = document.getElementById('newSubtaskTitle')
      titleInput.value = ''
      document.getElementById('addSubtaskBtn').onclick = async () => {
        const title = titleInput.value.trim()
        if (!title) { titleInput.focus(); return }
        try {
          const r = await fetch('/api/kanban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, parent_id: card.id, status: card.status, priority: card.priority, project: card.project || null, assignee: null }),
          })
          if (!r.ok) { showToast(t('kanban.toast.subtask_error')); return }
          showToast(t('kanban.toast.subtask_created'))
          loadKanban()
          showCardDetail(card)
        } catch { showToast(t('kanban.toast.subtask_error')) }
      }
    } else {
      addSubtaskSection.style.display = 'none'
    }

    const statusLabelsShort = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), waiting: t('kanban.status.waiting_short'), done: t('kanban.status.done') }
    if (children.length > 0 || isTask) {
      section.style.display = ''
      list.innerHTML = ''
      // #114: Delete button per subtask — only shown when the parent card is not done
      const canDeleteChild = card.status !== 'done'
      for (const ch of children) {
        const div = document.createElement('div')
        div.className = 'comment-item'
        div.style.cssText = 'cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:8px'
        const info = document.createElement('div')
        info.style.flex = '1'
        info.innerHTML = `<div><strong>${escapeHtml(ch.title)}</strong> <span style="color:var(--text-muted)">[${statusLabelsShort[ch.status] || ch.status}]</span></div>
          <div style="font-size:0.85em;color:var(--text-muted)">${ch.assignee ? escapeHtml(ch.assignee) : ''}${ch.description ? ' -- ' + escapeHtml(ch.description).slice(0, 80) : ''}</div>`
        info.onclick = () => { closeModal(cardDetailOverlay); showCardDetail(ch) }
        div.appendChild(info)
        if (canDeleteChild) {
          const delBtn = document.createElement('button')
          delBtn.className = 'btn-danger btn-compact'
          delBtn.style.flexShrink = '0'
          delBtn.textContent = t('kanban.modal.delete_btn')
          delBtn.onclick = async (e) => {
            e.stopPropagation()
            if (!confirm(t('kanban.confirm.delete_subtask', { title: ch.title }))) return
            try {
              const r = await fetch(`/api/kanban/${encodeURIComponent(ch.id)}`, { method: 'DELETE' })
              if (!r.ok) { showToast(t('common.error_delete')); return }
              showToast(t('kanban.toast.subtask_deleted'))
              loadKanban()
              showCardDetail(card)
            } catch { showToast(t('common.error_delete')) }
          }
          div.appendChild(delBtn)
        }
        list.appendChild(div)
      }
    } else {
      section.style.display = 'none'
    }
  } catch {
    document.getElementById('cardChildrenSection').style.display = 'none'
    document.getElementById('cardAddSubtaskSection').style.display = 'none'
  }

  // Breakdown button
  document.getElementById('cardBreakdownBtn').onclick = async () => {
    const btn = document.getElementById('cardBreakdownBtn')
    btn.disabled = true
    btn.textContent = t('kanban.breakdown.generating')
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); btn.disabled = false; btn.textContent = 'Breakdown'; return }
      breakdownMode = 'kanban'
      breakdownCardId = card.id
      breakdownSubtasks = data.subtasks
      showBreakdownModal(data.subtasks, card)
      const dodSec = document.getElementById('breakdownDoDSection')
      if (dodSec) dodSec.style.display = 'none'
    } catch (err) {
      showToast('Breakdown hiba')
    } finally {
      btn.disabled = false
      btn.textContent = 'Breakdown'
    }
  }

  openModal(cardDetailOverlay)
}

async function triggerBreakdown(card) {
  const btn = document.querySelector(`.kanban-card[data-id="${card.id}"] .card-breakdown-btn`)
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Breakdown hiba'); return }
    breakdownMode = 'kanban'
    breakdownCardId = card.id
    breakdownSubtasks = data.subtasks
    showBreakdownModal(data.subtasks, card)
  } catch {
    showToast('Breakdown hiba')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡' }
  }
}

function showBreakdownModal(subtasks, parentCard) {
  document.getElementById('breakdownProvider').textContent = t('kanban.breakdown.parent_label', { title: escapeHtml(parentCard.title) })
  const list = document.getElementById('breakdownList')
  list.innerHTML = ''

  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const assigneeOptions = kanbanAssignees
    .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.displayName || a.name)}</option>`)
    .join('')

  subtasks.forEach((st, i) => {
    const div = document.createElement('div')
    div.className = 'comment-item breakdown-subtask-item'
    div.dataset.idx = i
    div.style.borderLeft = '3px solid var(--accent)'
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px">
        <label style="font-size:0.8em; color:var(--text-muted); white-space:nowrap">${i + 1}.</label>
        <input type="text" class="breakdown-title-input" value="${escapeHtml(st.title)}"
          style="flex:1; padding:5px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.9em">
        <label style="font-size:0.8em; white-space:nowrap">
          <input type="checkbox" class="breakdown-check" data-idx="${i}" checked> Bele
        </label>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <select class="breakdown-assignee-select" style="padding:4px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.85em">
          <option value="">-- nincs --</option>
          ${assigneeOptions}
        </select>
        <span class="priority-badge priority-${st.priority}">${priorityLabels[st.priority] || st.priority}</span>
      </div>
    `
    // Set assignee select value after insert
    const sel = div.querySelector('.breakdown-assignee-select')
    if (st.assignee) sel.value = st.assignee
    list.appendChild(div)
  })
  openModal(breakdownOverlay)
}

document.getElementById('breakdownAcceptBtn').addEventListener('click', async () => {
  const items = document.querySelectorAll('.breakdown-subtask-item')
  const accepted = []
  items.forEach((item) => {
    const idx = parseInt(item.dataset.idx, 10)
    const checked = item.querySelector('.breakdown-check')?.checked
    if (!checked) return
    const title = item.querySelector('.breakdown-title-input')?.value.trim() || breakdownSubtasks[idx]?.title
    const assignee = item.querySelector('.breakdown-assignee-select')?.value || breakdownSubtasks[idx]?.assignee
    const priority = breakdownSubtasks[idx]?.priority || 'normal'
    const description = breakdownSubtasks[idx]?.description || ''
    accepted.push({ title, assignee, priority, description })
  })
  if (accepted.length === 0) { showToast(t('kanban.breakdown.select_one')); return }
  try {
    if (breakdownMode === 'idea') {
      const successCriteria = document.getElementById('breakdownSuccessCriteria')?.value.trim() || undefined
      const res = await fetch(`/api/ideas/${encodeURIComponent(breakdownIdeaId)}/promote-breakdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: accepted, success_criteria: successCriteria }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); return }
      closeModal(breakdownOverlay)
      showToast(t('kanban.breakdown.promoted', { count: data.child_count }))
      loadIdeasPage()
      return
    }
    const res = await fetch(`/api/kanban/${encodeURIComponent(breakdownCardId)}/breakdown/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtasks: accepted }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Hiba'); return }
    closeModal(breakdownOverlay)
    closeModal(cardDetailOverlay)
    showToast(t('kanban.breakdown.created_count', { count: data.created.length }))
    loadKanban()
  } catch {
    showToast(t('common.error_save'))
  }
})

document.getElementById('breakdownRejectBtn').addEventListener('click', () => {
  closeModal(breakdownOverlay)
  showToast(t('kanban.toast.breakdown_rejected'))
})

document.getElementById('breakdownClose').addEventListener('click', () => closeModal(breakdownOverlay))


export { loadKanban, startKanbanRefresh, stopKanbanRefresh }

// Window bridges for switchPage in app.js (until main.js is wired)
window.loadKanban = loadKanban
window.startKanbanRefresh = startKanbanRefresh
window.stopKanbanRefresh = stopKanbanRefresh
