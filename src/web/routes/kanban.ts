import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  listKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard, unarchiveKanbanCard,
  getKanbanComments, addKanbanComment, getKanbanCardEvents, listKanbanProjects,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
  getKanbanSeqByIdPrefix,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForAllCards, getLabelsForCard,
  listArchivedKanbanCards,
  revertIdeaFromKanban,
  getBlockersForCard, getBlockersForAllCards, getCardsBlockedBy,
  addKanbanBlocker, removeKanbanBlocker, countOpenBlockers, resolveKanbanCardRef,
} from '../../db.js'
import { decideRelease, releaseMessage } from '../../kanban-release.js'
import type { ReleasableCard, ClosedBlocker } from '../../kanban-release.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { resolveCardProject } from '../kanban-project-guard.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, STORE_DIR, WEB_HOST, WEB_PORT, KANBAN_LABEL_COLORS, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID } from '../../config.js'
import { sendTelegramMessage } from '../telegram.js'
import { listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { resolveKanbanDispatchTarget } from '../../kanban-dispatch.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

// A headless agent cannot "drag" a card to done, so the dispatch hands it the
// exact curl commands to (1) post a short, human-readable result summary as a
// comment -- so the finished task's result lands on its OWN card, visible in the
// dashboard UI -- and (2) mark the card done. This is the lightweight
// alternative to spawning a separate per-session card for every agent run: the
// result goes where the work was asked for, with zero extra board clutter. The
// token is read from the store at call time (never embedded in the message).
export function kanbanMoveInstructions(id: string, target: string): string {
  const tokenPath = join(STORE_DIR, '.dashboard-token')
  const base = `http://${WEB_HOST}:${WEB_PORT}`
  const auth = `-H "Authorization: Bearer $(cat ${tokenPath})"`
  const moveUrl = `${base}/api/kanban/${id}/move`
  const commentUrl = `${base}/api/kanban/${id}/comments`
  const cardUrl = `${base}/api/kanban/${id}`
  // Escalation target when blocked: sub-agents hand back to the main agent
  // (their delegator), who triages and only escalates to the operator when
  // the block genuinely needs a human decision. Only the main agent itself
  // escalates directly to OWNER_NAME -- sub-agent completions/blocks route
  // through the main agent, not straight to the operator (operator feedback,
  // 2026-07-02: a finished/blocked delegated card goes back to the delegator,
  // not to the human).
  const isMainAgent = target === MAIN_AGENT_ID
  const escalateTo = isMainAgent ? OWNER_NAME : MAIN_AGENT_ID
  return [
    'A kártyát in_progress-re húzták. Amikor VÉGEZTÉL, két lépés (mindkettő a kártyára kerül, a web UI-ban látszik):',
    '',
    '1) Írj egy rövid eredmény-összefoglalót kommentként (1-2 mondat: mi lett a vége):',
    `  curl -s -X POST ${commentUrl} \\`,
    `    ${auth} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"author":"${target}","content":"AZ EREDMENY ROVIDEN"}'`,
    '',
    '2) Állítsd a kártyát done-ra:',
    `  curl -s -X POST ${moveUrl} \\`,
    `    ${auth} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"status":"done"}'`,
    '',
    `Ha elakadtál / ${escalateTo} döntésére/lépésére vársz: NE csak status="waiting"-et állíts be. HÁROM lépés kell EGYÜTT:`,
    `  a) Írj egy kommentet ami KÖZVETLENÜL ${escalateTo}-hez szól, egyértelműen megfogalmazva mit kell eldöntenie/megtennie (NE a saját belső elemzésedet írd oda) -- ugyanaz a comments hívás mint fent, "content" mezőben.`,
    `  b) Told át a kártyát ${escalateTo}-re, hogy egyértelmű legyen a felelősség (a te neved NE maradjon rajta, ha nem te vagy a blokkoló):`,
    `     curl -s -X PUT ${cardUrl} \\`,
    `       ${auth} \\`,
    `       -H 'Content-Type: application/json' \\`,
    `       -d '{"assignee":"${escalateTo}"}'`,
    `  c) Csak EZUTÁN állítsd a kártyát status="waiting"-re (a fenti move-hívással, "waiting" értékkel "done" helyett).`,
    isMainAgent
      ? `Ez azért kritikus, mert ${OWNER_NAME} nem tudja kitalálni a dashboardon hogy egy nála maradt/rossz-assignee-jű, homályos kártya rá vár -- explicit átadás + explicit kérdés nélkül a felelősség-váltás elvész.`
      : `FONTOS: ${OWNER_NAME}-hez (az operátorhoz) EGYENESEN NE told át a kártyát, még ha a blokk végül tőle igényel is döntést -- ${MAIN_AGENT_ID} a delegálód, ő triázsol és ő dönti el, hogy tovább kell-e ${OWNER_NAME}-hez eszkalálnia. Ez azért kritikus, mert ${MAIN_AGENT_ID} nem tudja kitalálni a dashboardon hogy egy nála maradt/rossz-assignee-jű kártya rá vár -- explicit átadás + explicit kérdés nélkül a felelősség-váltás elvész.`,
    'A "done"-t mindenképp te jelezd — a dashboard csak az in_progress/waiting állapotot követi automatikusan a session aktivitásából. Az eredmény-kommentet (1) ne hagyd ki: az a kártyán a látható eredmény.',
  ].join('\n')
}

// The curl an agent runs to start a card itself. Same endpoint and auth shape
// as kanbanMoveInstructions -- the token is read from the store at call time,
// never embedded in the message.
function moveToInProgressCommand(id: string): string {
  const tokenPath = join(STORE_DIR, '.dashboard-token')
  return [
    `  curl -s -X POST http://${WEB_HOST}:${WEB_PORT}/api/kanban/${id}/move \\`,
    `    -H "Authorization: Bearer $(cat ${tokenPath})" \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"status":"in_progress"}'`,
  ].join('\n')
}

// Option D: kanban -> agent dispatch. When a card moves to in_progress, wake the
// assigned agent once via the inter-agent message router (createAgentMessage),
// which gives retry / dedup / trust-wrapping / busy-receiver handling for free.
// dispatched_at is the once-only guard; errors never block the card move.
export function fireKanbanDispatch(id: string): void {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    // A card with an open blocker is not startable work. The move itself is
    // allowed (a human may well be staging the board), but waking an agent for
    // it would hand out a task whose precondition is missing -- so the reason
    // goes on the card instead, and the agent is woken by the release path
    // when the last blocker closes.
    const open = getBlockersForCard(id).filter(b => b.open)
    if (open.length > 0) {
      const list = open.map(b => `#${b.seq}`).join(', ')
      addKanbanComment(id, BOT_NAME, `A kártya in_progress-be került, de még blokkolt (nyitott blokkoló: ${list}) -- az assignee-t NEM ébresztettem fel. A blokkoló lezárásakor automatikus értesítés megy ki.`)
      logger.info({ context: { action: 'kanban_dispatch_suppressed_blocked', card: id, blockers: open.map(b => b.id) } }, 'Kanban dispatch suppressed: card still blocked')
      return
    }
    const target = resolveKanbanDispatchTarget(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
    })
    if (!target) return
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\n${kanbanMoveInstructions(id, target)}`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
  }
}

/**
 * Release whatever was waiting for the card that just closed (#185).
 *
 * The system event (a blocker reaching done) has to produce the wake-up,
 * because the gate lived in prose before and closing the blocker woke nobody:
 * #148 and #151 both sat there until the owner asked. Every released card gets
 * a comment (so the board carries the reason), an assignee notification, and
 * -- if it was parked in `waiting` -- a move back to `planned`.
 *
 * Best-effort throughout: a failed notification must never fail the card move
 * that triggered it.
 */
export function fireBlockerRelease(blockerId: string): string[] {
  const released: string[] = []
  try {
    const blocker = getKanbanCard(blockerId)
    if (!blocker) return released
    for (const card of getCardsBlockedBy(blockerId)) {
      // countOpenBlockers reads the CURRENT state, which already has this
      // blocker closed -- so what it returns is what remains.
      const decision = decideRelease(card, blocker, countOpenBlockers(card.id), { ownerName: OWNER_NAME })
      if (!decision) continue
      addKanbanComment(card.id, BOT_NAME, decision.comment)
      if (decision.moveToPlanned) moveKanbanCard(card.id, 'planned', card.sort_order, BOT_NAME)
      notifyReleasedAssignee(card, blocker, decision.ownerHeld)
      released.push(card.id)
      logger.info(
        { context: { action: 'kanban_blocker_released', card: card.id, blocker: blockerId, moved: decision.moveToPlanned } },
        'Blocked card released by its blocker closing',
      )
    }
  } catch (err) {
    logger.warn({ err, blocker: blockerId }, 'Blocker release failed (the card move still succeeded)')
  }
  return released
}

/**
 * Who hears about a released card.
 *
 * An agent assignee is woken through the inter-agent router (retry / dedup /
 * trust-wrapping for free). Everything else -- the owner's own cards, an
 * unassigned card, an agent whose session is down -- goes to the main agent
 * instead of straight to the human: they triage and carry it into the digest.
 * That routing is deliberate (orchestrator's call, 2026-08-02); it is also
 * what keeps the guarantee this whole feature exists for, that a release
 * always reaches someone rather than sitting on a board nobody is reading.
 */
function notifyReleasedAssignee(card: ReleasableCard, blocker: ClosedBlocker, ownerHeld: boolean): void {
  const target = resolveKanbanDispatchTarget(card.assignee, {
    ownerName: OWNER_NAME,
    botName: BOT_NAME,
    mainAgentId: MAIN_AGENT_ID,
    agentNames: listAgentNames(),
    isRunning: isAgentRunning,
  })
  if (target) {
    createAgentMessage(MAIN_AGENT_ID, target, releaseMessage(card, blocker, moveToInProgressCommand(card.id)))
    return
  }
  const reason = ownerHeld
    ? `A kártya ${OWNER_NAME}-nál van, ezért a státuszát NEM állítottam át -- digest-tétel.`
    : `A kártyát nem tudtam agensnek átadni (assignee: ${card.assignee ?? 'nincs'}), ezért nálad landol.`
  createAgentMessage(MAIN_AGENT_ID, MAIN_AGENT_ID, `${releaseMessage(card, blocker, moveToInProgressCommand(card.id))}\n\n${reason}`)
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    // Embed each card's labels in one extra JOIN query (getLabelsForAllCards)
    // instead of an N+1 per-card lookup, so the footer-pill UI gets
    // everything it needs in a single round trip.
    const labelsByCard = getLabelsForAllCards()
    // Same one-query treatment for the dependency edges, so the board can draw
    // the blocked marker without asking per card.
    const blockersByCard = getBlockersForAllCards()
    const cards = listKanbanCards().map((card) => ({
      ...card,
      labels: labelsByCard.get(card.id) ?? [],
      blockers: blockersByCard.get(card.id) ?? [],
    }))
    jsonMaybeGzip(req, res, cards)
    return true
  }

  if (path === '/api/kanban/labels' && method === 'GET') {
    json(res, listLabels())
    return true
  }

  if (path === '/api/kanban/labels' && method === 'POST') {
    const body = await readBody(req)
    const { name, color } = JSON.parse(body.toString()) as { name?: string; color?: string }
    if (!name || !name.trim()) { json(res, { error: 'Címke neve kötelező' }, 400); return true }
    // Colour is validated against the configured palette (KANBAN_LABEL_COLORS)
    // rather than accepted as free-text, so every label's colour traces back
    // to the single configurable source instead of an arbitrary per-request value.
    const resolvedColor = color && KANBAN_LABEL_COLORS.includes(color) ? color : KANBAN_LABEL_COLORS[0]
    const id = randomUUID().slice(0, 8)
    const label = createLabel({ id, name: name.trim(), color: resolvedColor })
    json(res, label)
    return true
  }

  const labelMatch = path.match(/^\/api\/kanban\/labels\/([^/]+)$/)
  if (labelMatch && method === 'PUT') {
    const id = decodeURIComponent(labelMatch[1])
    const body = await readBody(req)
    const { name, color } = JSON.parse(body.toString()) as { name?: string; color?: string }
    const fields: { name?: string; color?: string } = {}
    if (name !== undefined) {
      if (!name.trim()) { json(res, { error: 'Címke neve kötelező' }, 400); return true }
      fields.name = name.trim()
    }
    if (color !== undefined) {
      fields.color = KANBAN_LABEL_COLORS.includes(color) ? color : KANBAN_LABEL_COLORS[0]
    }
    if (updateLabel(id, fields)) { json(res, { ok: true }); return true }
    json(res, { error: 'Címke nem található' }, 404)
    return true
  }
  if (labelMatch && method === 'DELETE') {
    const id = decodeURIComponent(labelMatch[1])
    if (deleteLabel(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Címke nem található' }, 404)
    return true
  }

  const cardLabelsMatch = path.match(/^\/api\/kanban\/([^/]+)\/labels$/)
  if (cardLabelsMatch && method === 'GET') {
    const cardId = decodeURIComponent(cardLabelsMatch[1])
    json(res, getLabelsForCard(cardId))
    return true
  }
  if (cardLabelsMatch && method === 'POST') {
    const cardId = decodeURIComponent(cardLabelsMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    // Accept `id` as an alias for `labelId` -- API callers reasonably send either,
    // since GET /api/kanban/labels returns objects keyed by `id`, not `labelId`.
    const parsed = JSON.parse(body.toString()) as { labelId?: string; id?: string }
    const labelId = parsed.labelId ?? parsed.id
    if (!labelId) { json(res, { error: 'labelId mező kötelező' }, 400); return true }
    if (!getLabel(labelId)) {
      // Common mistake: sending the label's `name` where an `id` is expected -- GET
      // /api/kanban/labels lists both, so this is an easy mix-up. Point at the real id
      // instead of a bare "not found" that reads as if the label doesn't exist at all.
      const byName = listLabels().find((l) => l.name === labelId)
      if (byName) {
        json(res, { error: `Címke nem található id alapján -- a "${labelId}" egy név, nem id. Használd az id-t: ${byName.id}` }, 404)
        return true
      }
      json(res, { error: 'Címke nem található' }, 404)
      return true
    }
    addLabelToCard(cardId, labelId)
    json(res, { ok: true })
    return true
  }

  const cardLabelDeleteMatch = path.match(/^\/api\/kanban\/([^/]+)\/labels\/([^/]+)$/)
  if (cardLabelDeleteMatch && method === 'DELETE') {
    const cardId = decodeURIComponent(cardLabelDeleteMatch[1])
    const labelId = decodeURIComponent(cardLabelDeleteMatch[2])
    if (removeLabelFromCard(cardId, labelId)) { json(res, { ok: true }); return true }
    json(res, { error: 'A kártyán nincs ilyen címke' }, 404)
    return true
  }

  // --- Card dependencies (blocked_by) -------------------------------------
  // GET returns both directions: what this card waits for, and what waits for
  // it. One call, because the card detail shows the chain in both directions
  // and a caller asking "is this startable" needs the same two answers.
  const blockersMatch = path.match(/^\/api\/kanban\/([^/]+)\/blockers$/)
  if (blockersMatch && method === 'GET') {
    const cardId = decodeURIComponent(blockersMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const blockers = getBlockersForCard(cardId)
    json(res, {
      blockers,
      blocking: getCardsBlockedBy(cardId).map(c => ({ id: c.id, seq: c.seq, title: c.title, status: c.status, assignee: c.assignee })),
      open: blockers.filter(b => b.open).length,
    })
    return true
  }

  if (blockersMatch && method === 'POST') {
    const cardId = decodeURIComponent(blockersMatch[1])
    const body = await readBody(req)
    // `blocker` accepts every form the fleet writes a card reference in:
    // "#185", "185" or the hex id. Anything unresolvable is a 404 rather than
    // a silently created edge to nowhere.
    const { blocker, actor } = JSON.parse(body.toString()) as { blocker?: string | number; actor?: string }
    if (blocker === undefined || blocker === null || String(blocker).trim() === '') {
      json(res, { error: 'blocker mező kötelező (#sorszám vagy kártya-id)' }, 400)
      return true
    }
    const blockerId = resolveKanbanCardRef(String(blocker))
    if (!blockerId) { json(res, { error: `Nincs ilyen kártya: ${blocker}` }, 404); return true }
    const result = addKanbanBlocker(cardId, blockerId, actor)
    if (result === 'added' || result === 'exists') {
      json(res, { ok: true, result, blockers: getBlockersForCard(cardId) })
      return true
    }
    const errors: Record<string, [string, number]> = {
      'self': ['Egy kártya nem függhet önmagától', 400],
      'cycle': ['Ez körkörös függőséget hozna létre -- a lánc mindkét vége örökre blokkolt maradna', 409],
      'unknown-card': ['Kártya nem található', 404],
      'unknown-blocker': ['Blokkoló kártya nem található', 404],
    }
    const [message, status] = errors[result]
    json(res, { error: message, result }, status)
    return true
  }

  const blockerDeleteMatch = path.match(/^\/api\/kanban\/([^/]+)\/blockers\/([^/]+)$/)
  if (blockerDeleteMatch && method === 'DELETE') {
    const cardId = decodeURIComponent(blockerDeleteMatch[1])
    const blockerId = resolveKanbanCardRef(decodeURIComponent(blockerDeleteMatch[2]))
    if (blockerId && removeKanbanBlocker(cardId, blockerId)) {
      json(res, { ok: true, blockers: getBlockersForCard(cardId) })
      return true
    }
    json(res, { error: 'A kártyán nincs ilyen függőség' }, 404)
    return true
  }

  if (path === '/api/kanban-projects' && method === 'GET') {
    json(res, listKanbanProjects())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    const agents = listAgentNames().map((name) => ({ name, type: 'agent', displayName: readAgentDisplayName(name) || name }))
    json(res, [
      { name: OWNER_NAME, type: 'owner' },
      { name: BOT_NAME, type: 'bot' },
      ...agents,
    ])
    return true
  }

  if (path === '/api/kanban' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())

    // Every card carries a project, or it is not created: the cost report
    // attributes spend by project, so a card without one is work whose cost
    // cannot be traced (Viktor's house rule, 2026-08-08). The rule used to
    // live in a prompt, which binds only the sessions that read it.
    const parentProject = data.parent_id ? getKanbanCard(String(data.parent_id))?.project ?? null : null
    const resolved = resolveCardProject(data, { parentProject, knownProjects: listKanbanProjects() })
    if (!resolved.ok) {
      json(res, { error: resolved.error }, 400)
      return true
    }

    const id = randomUUID().slice(0, 8)
    createKanbanCard({ id, ...data, project: resolved.project })
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    // `actor` and `reassign` steer the update, they are not card columns:
    // `reassign` is the caller stating that taking the card off the owner is
    // the point of the call (see the owner guard in updateKanbanCard), and
    // `actor` names who did it on the audit row. Same `actor` convention as
    // the move endpoint below.
    const { actor, reassign, ...data } = JSON.parse(body.toString())
    // A card can also be closed through a plain field update, not just the
    // move endpoint -- the release has to hang off the transition, not off the
    // route that happened to cause it.
    const before = getKanbanCard(id)?.status
    if (updateKanbanCard(id, data, { actor, reassign: reassign === true })) {
      if (before !== 'done' && getKanbanCard(id)?.status === 'done') fireBlockerRelease(id)
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (kanbanCardMatch && method === 'DELETE') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    revertIdeaFromKanban(id)
    if (deleteKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanMoveMatch = path.match(/^\/api\/kanban\/([^/]+)\/move$/)
  if (kanbanMoveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanMoveMatch[1])
    const body = await readBody(req)
    const { status, sort_order, actor } = JSON.parse(body.toString())
    const previous = getKanbanCard(id)?.status
    if (moveKanbanCard(id, status, sort_order ?? 0, actor)) {
      // Wake the assigned agent once when the card enters in_progress.
      if (status === 'in_progress') fireKanbanDispatch(id)
      // Closing a card releases whatever was waiting for it. Guarded on the
      // transition so a re-drag inside the done column does not re-announce.
      if (status === 'done' && previous !== 'done') fireBlockerRelease(id)
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanArchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/archive$/)
  if (kanbanArchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanArchiveMatch[1])
    revertIdeaFromKanban(id)
    if (archiveKanbanCard(id)) {
      // An archived blocker will never reach done, so it stops counting as
      // open -- which means its dependents are free and have to hear about it
      // through the same path a closed blocker uses.
      fireBlockerRelease(id)
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (path === '/api/kanban/archived' && method === 'GET') {
    const sp      = ctx.url.searchParams
    const q       = sp.get('q')?.trim() || undefined
    const project = sp.get('project')?.trim() || undefined
    const label   = sp.get('label')?.trim() || undefined
    const from    = sp.get('from')  ? Number(sp.get('from'))  : undefined
    const to      = sp.get('to')    ? Number(sp.get('to'))    : undefined
    const limit   = Math.min(Number(sp.get('limit') ?? 0) || Number(getEffectiveSettingValue('KANBAN_ARCHIVED_MAX_ROWS')), 5000)
    const labelsByCard = getLabelsForAllCards()
    const cards = listArchivedKanbanCards({ q, project, label, from, to, limit })
      .map(card => ({ ...card, labels: labelsByCard.get(card.id) ?? [] }))
    json(res, { cards, total: cards.length, limit })
    return true
  }

  const kanbanUnarchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/unarchive$/)
  if (kanbanUnarchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanUnarchiveMatch[1])
    if (unarchiveKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található vagy nincs archiválva' }, 404)
    return true
  }

  const kanbanCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/comments$/)
  if (kanbanCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    json(res, getKanbanComments(cardId))
    return true
  }
  if (kanbanCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    // Code-side kanban-ref enforcement: rewrite `#<hex8>` references that map
    // to a real card into the human-facing `#<seq>` form before persistence
    // (#75 Cuzcoo dispatch). Random hex / non-matching tokens pass through.
    const normalizedContent = normalizeKanbanRefs(content, getKanbanSeqByIdPrefix)
    const comment = addKanbanComment(cardId, author, normalizedContent)
    const card = getKanbanCard(cardId)
    if (card) notifyOwnerOfAgentComment(card, author, normalizedContent)
    json(res, comment)
    return true
  }

  const kanbanEventsMatch = path.match(/^\/api\/kanban\/([^/]+)\/events$/)
  if (kanbanEventsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanEventsMatch[1])
    json(res, getKanbanCardEvents(cardId))
    return true
  }

  const breakdownMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const cardId = decodeURIComponent(breakdownMatch[1])
    const card = getKanbanCard(cardId)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const existing = getChildCards(cardId)
    if (existing.length > 0) { json(res, { error: 'A kártya már rendelkezik subtask-okkal' }, 409); return true }
    try {
      const result = await generateBreakdown(card.title, card.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, cardId }, 'Breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  const acceptMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown\/accept$/)
  if (acceptMatch && method === 'POST') {
    const parentId = decodeURIComponent(acceptMatch[1])
    const parent = getKanbanCard(parentId)
    if (!parent) { json(res, { error: 'Szülő kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Subtask lista kötelező' }, 400)
      return true
    }
    const db = getDb()
    const created = db.transaction(() => {
      const ids: string[] = []
      for (const st of subtasks) {
        const id = randomUUID().slice(0, 8).toUpperCase()
        createKanbanCard({
          id,
          title: st.title,
          description: st.description,
          assignee: st.assignee ?? undefined,
          priority: (st.priority as any) ?? 'normal',
          project: parent.project ?? undefined,
          parent_id: parentId,
        })
        ids.push(id)
      }
      addKanbanComment(parentId, BOT_NAME, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`)
      return ids
    })()
    json(res, { ok: true, created })
    return true
  }

  const childrenMatch = path.match(/^\/api\/kanban\/([^/]+)\/children$/)
  if (childrenMatch && method === 'GET') {
    const parentId = decodeURIComponent(childrenMatch[1])
    json(res, getChildCards(parentId))
    return true
  }

  return false
}

/**
 * Tell the owner when an agent comments on one of their cards.
 *
 * A card assigned to the owner is one THEY are expected to act on. An agent
 * answering there is usually a question or a handback, and until now it landed
 * silently: the comment appeared on a board nobody was looking at, and the
 * thread stalled waiting for a reply the owner never knew was expected.
 *
 * The owner is identified from OWNER_NAME rather than a literal name, so this
 * stays correct in an install configured for someone else.
 *
 * Best-effort and fire-and-forget: adding a comment must not fail because a
 * notification could not go out, and the caller is an API request.
 */
export function notifyOwnerOfAgentComment(
  card: { id: string; title: string; assignee: string | null; seq?: number },
  author: string,
  content: string,
  send?: (text: string) => Promise<void>,
): boolean {
  const owner = OWNER_NAME.trim().toLowerCase()
  const assignee = (card.assignee ?? '').trim().toLowerCase()
  // Only cards the owner is holding, and only when someone else wrote.
  if (!owner || assignee !== owner) return false
  if (author.trim().toLowerCase() === owner) return false

  // The channel check gates the DEFAULT sender only. An injected sender is the
  // caller's own transport, and refusing it because the global Telegram config
  // happens to be empty would make the function untestable and would silently
  // disable a perfectly working alternative delivery path.
  let deliver = send
  if (!deliver) {
    if (!TELEGRAM_BOT_TOKEN.trim() || !ALLOWED_CHAT_ID.trim()) return false
    deliver = (text: string) => sendTelegramMessage(TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, text)
  }

  // The ellipsis has to judge the text that was actually cut. Measuring the
  // raw content instead put "..." on comments that fit whole -- a short
  // comment padded with newlines is long raw and short flattened.
  const flat = content.replace(/\s+/g, ' ').trim()
  const excerpt = flat.slice(0, 180)
  // The ℹ️ prefix is the owner's visual anchor: it separates board-generated
  // notifications from the agent's own replies when scrolling the chat
  // (Viktor's request, 2026-08-02, Telegram 1630).
  // The #seq in the tag is what lets the owner answer "which card is this
  // about" without opening the board (Viktor, 2026-08-09). Guarded: a caller
  // without seq degrades to the numberless tag, never "#undefined".
  const tag = card.seq != null ? `[kanban #${card.seq}]` : '[kanban]'
  const text = `ℹ️ ${tag} ${author} kommentelt a kartyadon: "${card.title}"\n${excerpt}${flat.length > 180 ? '...' : ''}`
  void deliver(text)
    .then(() => recordOwnerNudge(text))
    .catch((err: unknown) => {
      logger.warn(
        { context: { action: 'owner_comment_nudge_failed', card: card.id }, err: err instanceof Error ? err.message : 'unknown' },
        'Owner comment nudge could not be delivered',
      )
    })
  return true
}

/**
 * Put a delivered nudge into the main agent's conversation log.
 *
 * The nudge leaves through the bot directly, bypassing the agent's session --
 * the same invisibility that made the scheduler deny sending an alert it had
 * sent (see recordSchedulerAlert). Without this row the agent has no record
 * that the owner was pinged at all.
 *
 * Called only after a successful send, and best-effort: a nudge that went out
 * must not be undone by a ledger write, and the caller is an API request.
 */
function recordOwnerNudge(text: string, now = Math.floor(Date.now() / 1000)): void {
  try {
    // `ts` is an ISO-8601 UTC string and `created_at` epoch seconds -- the
    // shape every other row in this table has. An epoch in both would store
    // a number under TEXT affinity and break anything parsing ts as a date.
    getDb().prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
       VALUES (?, ?, 'out', NULL, ?, ?, ?)`,
    ).run(MAIN_AGENT_ID, ALLOWED_CHAT_ID, text, new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), now)
  } catch (err) {
    logger.warn(
      { context: { action: 'owner_comment_nudge_log_failed' }, err: err instanceof Error ? err.message : 'unknown' },
      'Owner comment nudge could not be written to the conversation log',
    )
  }
}
