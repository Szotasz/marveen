// Kanban drag-and-drop module (S-5, issue #3).
//
// Exports:
//   wireKanbanColumnDnD(col)         -- wire HTML5 drag/drop on a .kanban-col-body element
//   wireKanbanCardTouchDnD(el, card) -- wire touch drag on a .kanban-card element
//
// State: module-private (touchDrag). No reads from kanbanState -- DnD just
// POSTs /move and calls loadKanban() to refresh. Re-render is driven by
// loadKanban() which fires window._onKanbanRefresh when done.

import { loadKanban } from './kanban.js'
import { showToast } from './toast.js'
import { t } from './i18n.js'

// === Drag & Drop ===
// Wires the drag/drop handlers for one column-body element. Used for the
// 4 static flat-board columns at load time, and again for every swimlane
// column-body created dynamically in renderSwimlaneBoard (those elements
// don't exist yet when this module first runs).
export function wireKanbanColumnDnD(col) {
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

    // The dragover handler already moved the card element to its new position
    // via insertBefore, so the DOM reflects the desired visual order. Collect
    // all card ids in that order and send them as orderedIds so the backend
    // renumbers the full column in one transaction (fixes cards always landing
    // at the bottom when other cards have conflicting or negative sort_orders).
    const orderedIds = [...col.querySelectorAll('.kanban-card')].map(el => el.dataset.id)

    try {
      await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, sort_order: orderedIds.indexOf(cardId), orderedIds }),
      })
      loadKanban()
    } catch {
      showToast(t('kanban.toast.move_error'))
    }
  })
}

// === Touch drag & drop (mobile) ===
// HTML5 drag & drop above never fires on a touch screen -- no dragstart, no
// drop -- so on a phone the board could only be read, never rearranged. This
// is a parallel touch path over the same /move call.
//
// Why touch events and not Pointer Events + touch-action: a card fills most of
// the column, so making it permanently untouchable for scrolling (touch-action:
// none) would break scrolling the board. Instead the gesture stays ambiguous
// until it resolves: a long press (250ms) means "drag", any earlier movement
// means "scroll" and hands the gesture straight back to the browser. Only once
// dragging is committed does touchmove call preventDefault() to hold the page
// still -- which is why that listener MUST be non-passive.
const TOUCH_DRAG_DELAY_MS = 250
const TOUCH_DRAG_SLOP_PX = 10
let touchDrag = null

function kanbanColBodyAt(x, y) {
  const el = document.elementFromPoint(x, y)
  return el ? el.closest('.kanban-col-body') : null
}

// On a phone the columns stack vertically, so the next column starts ~2000px
// below the fold -- dragging a card "one column over" would mean dragging it
// at an invisible target while the page auto-scrolls for several seconds.
// Instead, committing to a drag raises a fixed bar of status targets over the
// bottom of the screen: the same gesture, with somewhere to drop. Column
// hit-testing stays active for viewports where the target column IS visible.
const KANBAN_TOUCH_STATUSES = ['planned', 'in_progress', 'waiting', 'testing', 'done']

function buildTouchDropBar(currentStatus) {
  const bar = document.createElement('div')
  bar.className = 'kanban-touch-dropbar'
  for (const s of KANBAN_TOUCH_STATUSES) {
    const chip = document.createElement('div')
    chip.className = 'kanban-drop-target'
    chip.dataset.status = s
    if (s === currentStatus) chip.classList.add('is-current')
    chip.textContent = t(`kanban.status.${s}`)
    bar.appendChild(chip)
  }
  document.body.appendChild(bar)
  return bar
}

function kanbanDropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y)
  return el ? el.closest('.kanban-drop-target') : null
}

function clearTouchDragHighlight() {
  document.querySelectorAll('.kanban-col-body.drag-over, .kanban-drop-target.drag-over')
    .forEach((c) => c.classList.remove('drag-over'))
}

function endTouchDrag() {
  if (!touchDrag) return
  clearTimeout(touchDrag.timer)
  touchDrag.ghost?.remove()
  touchDrag.dropBar?.remove()
  touchDrag.el.classList.remove('dragging')
  clearTouchDragHighlight()
  document.removeEventListener('touchmove', kanbanTouchMove)
  document.removeEventListener('touchend', kanbanTouchEnd)
  document.removeEventListener('touchcancel', endTouchDrag)
  touchDrag = null
}

// The ghost is deliberately NOT a full-size copy of the card: at full width it
// covered three of the five drop targets, so the user could not see what they
// were aiming at. It rides ABOVE the fingertip (see positionTouchGhost) for the
// same reason -- the target under the finger has to stay visible.
const TOUCH_GHOST_MAX_W = 200
const TOUCH_GHOST_LIFT = 28

function positionTouchGhost(x, y) {
  const g = touchDrag.ghost
  const gx = x - g.offsetWidth / 2
  const gy = y - g.offsetHeight - TOUCH_GHOST_LIFT
  g.style.transform = `translate(${Math.max(4, gx)}px, ${Math.max(4, gy)}px) rotate(2deg)`
}

function beginTouchDrag(x, y) {
  if (!touchDrag) return
  const el = touchDrag.el
  const box = el.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'kanban-card kanban-card-ghost'
  ghost.textContent = touchDrag.card.title
  ghost.style.cssText = `position:fixed; left:0; top:0; width:${Math.min(box.width, TOUCH_GHOST_MAX_W)}px; pointer-events:none; z-index:9999; opacity:.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; box-shadow:0 8px 24px rgba(0,0,0,.35)`
  document.body.appendChild(ghost)
  touchDrag.ghost = ghost
  positionTouchGhost(x, y)
  touchDrag.active = true
  touchDrag.dropBar = buildTouchDropBar(touchDrag.card.status)
  el.classList.add('dragging')
  // Confirm the mode switch on devices that support it -- without a cursor,
  // the only other signal that a long press "took" is the ghost appearing.
  navigator.vibrate?.(10)
}

function kanbanTouchMove(e) {
  if (!touchDrag || e.touches.length !== 1) return
  const p = e.touches[0]
  if (!touchDrag.active) {
    // Still ambiguous: movement beyond the slop means the user is scrolling.
    if (Math.abs(p.clientX - touchDrag.startX) > TOUCH_DRAG_SLOP_PX ||
        Math.abs(p.clientY - touchDrag.startY) > TOUCH_DRAG_SLOP_PX) {
      endTouchDrag()
    }
    return
  }
  e.preventDefault()
  positionTouchGhost(p.clientX, p.clientY)
  clearTouchDragHighlight()
  // The drop bar sits above everything, so test it first -- a chip and a
  // column body can overlap on screen.
  const chip = kanbanDropTargetAt(p.clientX, p.clientY)
  if (chip) { chip.classList.add('drag-over'); return }
  const col = kanbanColBodyAt(p.clientX, p.clientY)
  if (col) col.classList.add('drag-over')
}

async function kanbanTouchEnd(e) {
  if (!touchDrag) return
  if (!touchDrag.active) { endTouchDrag(); return }
  const p = e.changedTouches[0]
  const chip = kanbanDropTargetAt(p.clientX, p.clientY)
  const col = chip ? null : kanbanColBodyAt(p.clientX, p.clientY)
  const cardId = touchDrag.card.id
  // The release that ends a drag would otherwise also register as a tap and
  // open the detail modal on top of the board the user just rearranged.
  touchDrag.el.dataset.suppressClick = '1'
  // Read the drop position BEFORE endTouchDrag drops the .dragging class --
  // getDragAfterElement excludes .dragging, which is what keeps the card from
  // counting itself when it is dropped back into its own column.
  let newStatus = null
  let orderedIds = []
  if (chip) {
    // Dropped on the status bar: append the card to the end of the target column.
    newStatus = chip.dataset.status
    const existingIds = [...document.querySelectorAll(`.kanban-col-body[data-status="${newStatus}"] .kanban-card:not(.dragging)`)].map(el => el.dataset.id)
    orderedIds = [...existingIds, cardId]
  } else if (col) {
    // Dropped on a column body: compute the target position using the same helper
    // the desktop dragover uses, then build the ordered list with the card inserted.
    newStatus = col.dataset.status
    const after = getDragAfterElement(col, p.clientY)
    const others = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
    const othersIds = others.map(el => el.dataset.id)
    const insertPos = after ? others.indexOf(after) : others.length
    orderedIds = [...othersIds.slice(0, insertPos), cardId, ...othersIds.slice(insertPos)]
  }
  endTouchDrag()
  // Released outside any target: treat as a cancelled drag, not a move.
  // A drop inside a column always posts, even when the status is unchanged --
  // that is a reorder within the column, which is just as valid a move.
  if (!newStatus) return
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, sort_order: orderedIds.indexOf(cardId), orderedIds }),
    })
    if (!r.ok) throw new Error('move failed')
    loadKanban()
  } catch {
    showToast(t('kanban.toast.move_error'))
  }
}

export function wireKanbanCardTouchDnD(el, card) {
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    const p = e.touches[0]
    endTouchDrag()
    touchDrag = {
      card, el, ghost: null, active: false,
      startX: p.clientX, startY: p.clientY,
      timer: setTimeout(() => beginTouchDrag(p.clientX, p.clientY), TOUCH_DRAG_DELAY_MS),
    }
    document.addEventListener('touchmove', kanbanTouchMove, { passive: false })
    document.addEventListener('touchend', kanbanTouchEnd)
    document.addEventListener('touchcancel', endTouchDrag)
  }, { passive: true })

  // A long press that turned into a drag must not also open the detail modal
  // on release. The click listener in createCardEl fires after touchend, so
  // the guard flag is read there.
  el.addEventListener('click', (e) => {
    if (el.dataset.suppressClick === '1') {
      delete el.dataset.suppressClick
      e.stopImmediatePropagation()
      e.preventDefault()
    }
  }, true)
}

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
