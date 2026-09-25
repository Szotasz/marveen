import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  listKanbanCards, kanbanAssigneeExists, createKanbanCard, updateKanbanCard, KANBAN_WRITABLE_FIELDS,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard, unarchiveKanbanCard,
  getKanbanComments, addKanbanComment, getKanbanCardEvents, listKanbanProjects,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
  getKanbanSeqByIdPrefix,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForAllCards, getLabelsForCard,
  addCardBlocker, removeCardBlocker, getBlockersForCard, getBlockedByCard,
  getBlockersForAllCards, blockerWouldCycle, parentWouldCycle,
  listArchivedKanbanCards,
  revertIdeaFromKanban,
  getHeartbeatKanbanSummary,
  countNewHotMemories,
  countPlannedKanbanCards,
  getDbFileSizeMb,
  getTokenPruneLag,
  getStuckKanbanCards,
  type TokenPruneLag,
} from '../../db.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, STORE_DIR, WEB_HOST, WEB_PORT, KANBAN_LABEL_COLORS } from '../../config.js'
import { listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { resolveKanbanDispatch } from '../../kanban-dispatch.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json, jsonMaybeGzip, methodNotAllowed } from '../http-helpers.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

// #1023: keys a PUT /api/kanban/:id body may carry WITHOUT being a writable
// column -- the read-only card fields and the GET-embedded arrays the dashboard
// sends back when it PUTs a whole `{...card}` object (web/app.js assignee/parent
// edits). Accepted and ignored; anything neither here nor in
// KANBAN_WRITABLE_FIELDS is a caller mistake and gets a 400.
const KANBAN_READONLY_FIELDS = new Set<string>([
  'id', 'seq', 'created_at', 'updated_at', 'last_status_at', 'labels', 'blockers',
  // dispatched_at is a real column set by the dispatch path (markKanbanCardDispatched),
  // never by a PUT, but getKanbanCard's SELECT * returns it so the dashboard's
  // whole-card send carries it back. Accept-and-ignore, do not 400.
  'dispatched_at',
])

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
  // FIRST line on purpose: this dispatch is fired ONCE, at the moment the card
  // enters in_progress, and the status is correct then -- the `dispatched_at`
  // guard is right and is not what needs fixing. What can slip is DELIVERY: the
  // message rides the normal inter-agent queue, and a busy session may only read
  // it after finishing that round, by which time the card has moved on. Observed
  // on a live install, on more than one card.
  //
  // A status check at dispatch time therefore cannot help (the card is not yet
  // `testing` when the message is written), so the guard has to travel WITH the
  // message and be re-evaluated by the reader. The wasted round is the mild
  // outcome; the expensive one is a second attempt producing parallel work on the
  // same target -- a SECOND test file for one controller, with its own fixture,
  // maintained in two places. The receiving agent's own rules already forbid that,
  // but they cannot fire on a task the agent has no reason to think is finished.
  //
  // The check is handed over as a runnable command, like every other step here:
  // an instruction the reader has to compose is one it can skip. There is no
  // single-card GET endpoint, hence the board fetch plus a one-field extract.
  //
  // The isinstance(list) branch is not defensive padding: measured while writing
  // this, an unreadable token makes the endpoint answer with an error OBJECT, and
  // iterating that dict yields its KEYS, so the naive one-liner dies on a Python
  // TypeError. A traceback is the one answer this line must never give -- the
  // reader would have no status and no idea why, and the likeliest reaction to a
  // broken pre-flight check is to skip it. Echoing the server's own error keeps it
  // actionable.
  //
  // description is pulled alongside status, not left for a second look-up: a
  // program-specific closing-status override (see the ranking sentence below)
  // lives in the card's description, and a probe that prints only the status
  // gives the reader no reason to ever read it. Two agent incidents on one card
  // (2026-09-15, 7ed56208) confirmed the failure mode -- the reader ran exactly
  // this probe, saw a status, and never saw the override sitting one field over.
  const statusProbe =
    `  curl -s ${auth} ${base}/api/kanban | python3 -c "import sys,json;d=json.load(sys.stdin);c=(next((x for x in d if x.get('id')=='${id}'),None) if isinstance(d,list) else None);print(('status: '+str(c.get('status'))+chr(10)+'description: '+((c.get('description') or '').strip() or '(nincs)')) if c else ('nincs ilyen kartya' if isinstance(d,list) else 'ismeretlen -- a szerver nem kartya-listat adott: '+str(d)[:120]))"`
  return [
    'MIELŐTT NEKIKEZDESZ: nézd meg a kártya AKTUÁLIS státuszát ÉS leírását. Ez az üzenet egy foglalt session sorában KÉSHET, és közben a munka elkészülhetett -- a leírás pedig a kártya saját, ennél a sablonnál erősebb szabályait hordozhatja (lásd lent):',
    statusProbe,
    'Ha a "status:" sor már "testing" vagy "done", NE kezdj bele -- az üzenet későn ért ide, a munka már áll. Egy második nekifutás párhuzamos, két helyen karbantartott munkát szül (például egy MÁSODIK teszt-fájlt ugyanarra a vezérlőre). Ilyenkor jelezd a delegálódnak, és ne írj kódot.',
    'A "description:" sort is OLVASD EL, ne csak a státuszt: ha benne kártya-specifikus kikötés áll (pl. más záró-státusz, "nincs éles restart"), az felülírja ennek a sablonnak az alapértelmezését, lásd a 2) lépésnél.',
    '',
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
    `    -d '{"status":"done","actor":"${target}"}'`,
    '',
    // `done` is right for almost every card, so this template keeps it as the
    // default -- but not for every board PROGRAM. A program can give its cards
    // their own closing status (for example a review status, so the delegator
    // checks the work before the card closes), and that rule lives in the CARD
    // text. Two rules, no stated ranking: an agent either spends a round
    // deciding which one wins, or (worse) quietly follows this template and the
    // work closes unreviewed. One sentence fixes it; swapping the default
    // globally would break the close everywhere else.
    'Ha a KÁRTYA SZÖVEGE más záró-státuszt ír elő (például `testing`, hogy a delegálód átnézze a munkát), AZ az irányadó: a kártya program-specifikus szabálya erősebb ennél a sablonnál. Ilyenkor a fenti hívásban a "done" helyére azt a státuszt írd, az "actor" mezőt ugyanúgy küldve. Ha a kártya nem ír elő mást, a "done" az alapértelmezés.',
    '',
    // The "actor" field is not decoration: it is what tells the board WHO moved
    // the card. Without it a self-pickup (agent -> in_progress on its own card)
    // is indistinguishable from an assignment, and the dispatcher echoes the
    // task back at the agent that just started it.
    `Az "actor":"${target}" mezőt MINDEN mozgatásnál küldd el (ez mondja meg a táblának, hogy te mozgattad). Ha te magad veszed fel a kártyát in_progress-re, ott is:`,
    `  curl -s -X POST ${moveUrl} \\`,
    `    ${auth} \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"status":"in_progress","actor":"${target}"}'`,
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

// Option D: kanban -> agent dispatch. When a card moves to in_progress, wake the
// assigned agent once via the inter-agent message router (createAgentMessage),
// which gives retry / dedup / trust-wrapping / busy-receiver handling for free.
// dispatched_at is the once-only guard; errors never block the card move.
// `actor` is the mover reported by the caller: an agent that moves its own card
// to in_progress must not be woken with an assignment for work it just started.
function fireKanbanDispatch(id: string, actor?: string | null): void {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    const decision = resolveKanbanDispatch(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
      actor,
    })
    const target = decision.target
    if (!target) {
      // 'not-dispatchable' (no/unknown assignee, human owner) and 'self-move'
      // are DELIBERATE no-dispatch cases -- staying quiet is correct, and
      // alerting on them would bury the one case that matters.
      if (decision.reason === 'session-down') reportUndeliveredDispatch(id, decision.unreachable ?? String(card.assignee))
      return
    }
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\n${kanbanMoveInstructions(id, target)}`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
    reportUndeliveredDispatch(id, 'a kiosztás hibára futott')
  }
}

// A card that reached in_progress without its assignee being woken must never
// stay silent: the board shows it running, status-driven monitoring skips on
// exactly that status, and the false in_progress SUSTAINS ITSELF -- a single
// missed dispatch can hold a card open for hours behind a green log. So the
// failure is written where both readers look: a comment on
// the card (the board) and a notice in the main agent's inbox (the delegator,
// who triages and can put the card back).
//
// Best-effort by construction: this runs inside the move request, and the move
// itself has already succeeded. A throw here (db locked, inbox write failing)
// must not turn a completed move into a 500, so it is swallowed after a log --
// the same contract as the dispatch it reports on.
function reportUndeliveredDispatch(id: string, unreachable: string): void {
  logger.warn({ id, unreachable }, 'Kanban card is in_progress but its assignee was NOT woken')
  try {
    addKanbanComment(
      id,
      'system',
      `A kártya in_progress lett, de a kiosztott ügynök (${unreachable}) NEM kapott üzenetet -- a session nem fut, vagy a kiosztás hibára futott. ` +
      'A kártya NEM fut: tedd vissza planned-re, vagy indítsd el az ügynököt és húzd újra in_progress-re.',
    )
  } catch (err) {
    logger.warn({ err, id }, 'Undelivered-dispatch card comment failed')
  }
  try {
    createAgentMessage(
      'system',
      MAIN_AGENT_ID,
      `[kanban-dispatch] A(z) #${id} kártya in_progress lett, de a kiosztott ügynök (${unreachable}) NEM kapott üzenetet. ` +
      'A tábla futónak mutatja, közben senki nem dolgozik rajta. Tedd vissza planned-re, vagy indítsd el az ügynököt és aktiváld újra.',
    )
  } catch (err) {
    logger.warn({ err, id }, 'Undelivered-dispatch inbox notice failed')
  }
}

// HBKANBANDRIFT819: the heartbeat-summary payload, shaped so that TRUNCATED
// reads still carry the truth. Pure and exported so tests can pin all three
// properties without HTTP:
//   1. `counts` is the FIRST key -- JSON.stringify preserves insertion order,
//      so a reader that loses the tail loses list items, never the numbers;
//   2. every title is truncated server-side (board titles here run to 15KB);
//   3. the waiting LIST is capped to the most recently-updated few, while
//      counts.waiting always carries the FULL total -- the list names items,
//      the numbers only ever come from counts.
export const HEARTBEAT_SUMMARY_TITLE_MAX = 160
export const HEARTBEAT_SUMMARY_WAITING_CAP = 8

type HeartbeatSummaryCard = {
  id: string; title: string; status: string; priority: string;
  assignee?: string | null; updated_at?: number | null;
}

export function buildHeartbeatSummaryResponse(
  summary: { urgent: HeartbeatSummaryCard[]; in_progress: HeartbeatSummaryCard[]; waiting: HeartbeatSummaryCard[] },
  newHotMemories1h: number,
  plannedCount: number,
  dbSizeMb: number | null,
  tokenPrune: TokenPruneLag,
) {
  const trunc = (t: string) =>
    t.length > HEARTBEAT_SUMMARY_TITLE_MAX ? t.slice(0, HEARTBEAT_SUMMARY_TITLE_MAX) + '…' : t
  const slim = (c: HeartbeatSummaryCard) => ({
    id: c.id, title: trunc(c.title), status: c.status, priority: c.priority, assignee: c.assignee ?? null,
  })
  const waitingRecent = [...summary.waiting]
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, HEARTBEAT_SUMMARY_WAITING_CAP)
  return {
    counts: {
      urgent: summary.urgent.length,
      in_progress: summary.in_progress.length,
      // The FULL total, never the capped list length -- the 2026-08-04 lesson
      // (waiting: 10 reported against 130 real) in endpoint form.
      waiting: summary.waiting.length,
      // The report format asks for a planned line; without a sanctioned
      // source here the agent manufactured the value (planned: 0 against a
      // real 305, measured 2026-08-19 17:00). Count only, no list.
      planned: plannedCount,
      // HBMEMBLIND819: computed server-side with the MAIN agent's id so the
      // heartbeat agent copies a number instead of running (and rewriting)
      // a query -- see HEARTBEAT_NEW_HOT_MEMORIES_SQL in db.ts.
      new_hot_memories_1h: newHotMemories1h,
      // HBDBMERET822: without a sanctioned source the agent re-invented this
      // measurement every session (format drift `158 MB` -> `160M`, then a
      // false `0.0 MB` against a real 159 MB, 2026-08-22 15:00). null means
      // "could not measure" and renders as "nincs adat" -- never 0, because
      // for a growth signal a false zero looks like calm, not like failure.
      db_size_mb: dbSizeMb,
    },
    // HBDBKUSZOB823: placed immediately after `counts` and BEFORE the lists,
    // for the same reason counts comes first -- a truncated read must keep the
    // health signal and lose only the annotating card lists. The retired
    // `dbSize > 100 MB` warning could never go quiet (the DB is bounded by
    // design at ~480 MB); this one is quiet whenever the daily sweep runs.
    token_prune: tokenPrune,
    urgent: summary.urgent.map(slim),
    waiting: waitingRecent.map(slim),
    waiting_shown: Math.min(summary.waiting.length, HEARTBEAT_SUMMARY_WAITING_CAP),
  }
}

// The methods the single-card path actually serves. One source, so the Allow
// header can never drift from the branches above it -- advertising a method
// that is not routed would send the caller one step further into the same fog.
const KANBAN_CARD_METHODS = ['PUT', 'DELETE'] as const

/**
 * Parse the `includeArchived` query parameter.
 *
 * Three-valued on purpose: true / false / null-meaning-REJECT. The bug this replaces was
 * a two-valued read where every unrecognised input collapsed into "false" -- which is how
 * `?includeArchived=1` came back with the archived cards missing and no complaint.
 *
 * Bare presence (`?includeArchived` or `=`) reads as TRUE: that is the common URL idiom,
 * and it errs toward returning MORE rows, which is the safe direction here -- the failure
 * we are fixing was rows going missing.
 */
export function parseIncludeArchived(raw: string | null): boolean | null {
  if (raw === null) return false
  const v = raw.trim().toLowerCase()
  if (v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return null
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    // includeArchived is honoured or REFUSED -- never silently dropped. Ignoring it was
    // the actual defect: a caller had evidence it asked for archived cards, the response
    // had evidence it did not, and nothing reconciled the two.
    // ⛔ ISMERETLEN PARAM -> HANGOS 400, a /api/messages mintajara (sajat telepitesunkon mert
    // korabbi eset). Harom vegpont adott harom kulonbozo valaszt ugyanarra a hibara: az egyik
    // hangosan elutasitott, a masik ketto neman eldobta. A nema elfogadas TANITJA a
    // talalgatast -- merve: hat agens HAROM kulonbozo neven probalta ugyanazt (includeArchived
    // 16x, archived 6x, include_archived 6x), plusz ?id= 4x es ?limit= 1x. Egyik sem kapott
    // visszajelzest, ezert probaltak tovabb.
    // ⛔ SZIGORU halmaz, ALIAS NELKUL (sajat telepitesunkon hozott ugyvezetoi dontes): egy
    // alias eletben tartana a talalgatast; a hibauzenetbol viszont megtanulhato a helyes nev.
    const KNOWN_PARAMS = new Set(['agent', 'assignee', 'includeArchived'])
    const unknown = [...ctx.url.searchParams.keys()].filter((k) => !KNOWN_PARAMS.has(k))
    if (unknown.length) {
      json(res, {
        error: 'unknown query parameter',
        unknown,
        known: [...KNOWN_PARAMS],
        hint: 'a lapok szurese "agent" (vagy "assignee"); EGY lapot a /api/kanban/<id> utvonal ad, '
            + 'nem a ?id= parameter',
      }, 400)
      return true
    }
    const includeArchived = parseIncludeArchived(ctx.url.searchParams.get('includeArchived'))
    if (includeArchived === null) {
      json(res, {
        error: 'Az includeArchived értéke érvénytelen. Elfogadott: 1, true, yes, on, ' +
               '0, false, no, off (vagy érték nélkül = igaz).',
      }, 400)
      return true
    }
    // Embed each card's labels in one extra JOIN query (getLabelsForAllCards)
    // instead of an N+1 per-card lookup, so the footer-pill UI gets
    // everything it needs in a single round trip.
    // Az `assignee=` ugyanazt jelenti, mint az `agent=`: a dashboard es az agens-CLAUDE.md
    // kulonbozo nevet tanit ugyanarra, es a KETTO kozul egyik sem volt hibas -- csak nem
    // mukodott egyik sem.
    const agent = ctx.url.searchParams.get('agent')
      ?? ctx.url.searchParams.get('assignee')
      ?? undefined
    // An unrecognised agent name 400s naming the accepted set, rather than silently
    // matching everything (`assignee = ?` against a name nothing has would just return
    // an empty list with 200) -- the same silence-teaches-guessing argument as the
    // KNOWN_PARAMS check above, applied to the value instead of the key. Accepted: a
    // configured name (OWNER_NAME, BOT_NAME, fleet agents -- what /api/kanban/assignees
    // advertises) OR any assignee that already exists on the board (external contributors
    // get cards too). Both sides compare case-insensitively: configured names are
    // capitalised (BOT_NAME=Marveen) while stored assignees are usually lowercase
    // (`marveen`), and an exact compare rejected the bot's and owner's own names.
    if (agent !== undefined) {
      const wanted = agent.toLowerCase()
      const isConfigured = [OWNER_NAME, BOT_NAME, ...listAgentNames()]
        .some((n) => n.toLowerCase() === wanted)
      if (!isConfigured && !kanbanAssigneeExists(agent)) {
        json(res, {
          error: 'unknown agent',
          agent,
          hint: 'lásd GET /api/kanban/assignees az elfogadott nevekért, vagy egy a táblán már szereplő assignee (kis/nagybetű mindegy)',
        }, 400)
        return true
      }
    }
    const labelsByCard = getLabelsForAllCards()
    // Blockers ride along in the same round trip as labels: the board needs
    // them to mark a blocked card, and a per-card fetch would be an N+1 on
    // every poll.
    const blockersByCard = getBlockersForAllCards()
    const cards = listKanbanCards({ includeArchived, agent }).map((card) => ({
      ...card,
      labels: labelsByCard.get(card.id) ?? [],
      blockers: blockersByCard.get(card.id) ?? [],
    }))
    jsonMaybeGzip(req, res, cards)
    return true
  }

  // The heartbeat agent's kanban source. It exists so the agent does not have to
  // COMPOSE the filter every hour: on 2026-08-04 the 09:00 report listed five
  // items of which three were already `done`, even though its instructions had
  // said to exclude them since #680. A rule the model must re-apply each hour is
  // not a mechanism; an endpoint that cannot return a closed card is. It also
  // removes the sqlite3 CLI from that path, which does not exist on a stock
  // Linux install (#870).
  //
  // HBKANBANDRIFT819 (2026-08-19): the 16:42 heartbeat reported waiting:12
  // against a real 280 -- the endpoint's counts were CORRECT, but the payload
  // was ~31KB (card titles on this board run to 15KB EACH) and `counts` was
  // serialized LAST, after the huge arrays. An agent reading truncated output
  // lost exactly the numbers and counted the visible list instead. Fixes here:
  // counts serialize FIRST (truncation-resilient ordering), titles are
  // truncated server-side, and the waiting list is capped to the most recent
  // few -- while counts.* always carries the FULL totals. The list is for
  // naming items; the numbers ONLY ever come from counts.
  if (path === '/api/kanban/heartbeat-summary' && method === 'GET') {
    json(res, buildHeartbeatSummaryResponse(getHeartbeatKanbanSummary(), countNewHotMemories(MAIN_AGENT_ID), countPlannedKanbanCards(), getDbFileSizeMb(), getTokenPruneLag()))
    return true
  }

  // KANBANSTUCKURES916: replaces the kanban-audit skill's inline "status ==
  // in_progress" detector (structurally near-always empty on this board) with
  // a real "started, then went idle" measurement across all non-done statuses.
  // See getStuckKanbanCards in db.ts for the "started"/"last_activity"
  // definitions. `examined: 0` gets its own `empty_reason` -- the skill's
  // job is to report "could not measure" instead of a reassuring false zero.
  if (path === '/api/kanban/stuck' && method === 'GET') {
    const plannedDaysRaw = url.searchParams.get('planned_days') ?? '7'
    const activeDaysRaw = url.searchParams.get('active_days') ?? '3'
    const plannedDays = Number(plannedDaysRaw)
    const activeDays = Number(activeDaysRaw)
    if (!Number.isFinite(plannedDays) || plannedDays <= 0 || !Number.isFinite(activeDays) || activeDays <= 0) {
      json(res, { error: 'invalid planned_days/active_days: must be positive numbers' }, 400)
      return true
    }
    // 600s: the measured creator-comment window (D001, ELSOKOR922 Phase 0) --
    // an immediate comment on a fresh card is a description, not a work-trace.
    const result = getStuckKanbanCards({ plannedDays, activeDays, creatorCommentWindowSec: 600 })
    if (result.examined === 0) {
      json(res, { ...result, empty_reason: 'nincs megkezdett kártya' })
    } else {
      json(res, result)
    }
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

  // --- Blockers: "this card is blocked by that card" ---
  // GET returns both directions in one payload. The reverse list (what waits on
  // THIS card) is the half that changes behaviour: it is what tells the operator
  // that leaving a card open is holding up three others.
  const cardBlockersMatch = path.match(/^\/api\/kanban\/([^/]+)\/blockers$/)
  if (cardBlockersMatch && method === 'GET') {
    const cardId = decodeURIComponent(cardBlockersMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    json(res, { blockers: getBlockersForCard(cardId), blocking: getBlockedByCard(cardId) })
    return true
  }
  if (cardBlockersMatch && method === 'POST') {
    const cardId = decodeURIComponent(cardBlockersMatch[1])
    if (!getKanbanCard(cardId)) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const body = await readBody(req)
    // `id` is accepted as an alias for `blockerId` for the same reason the label
    // route accepts it: GET /api/kanban returns cards keyed by `id`.
    const parsed = JSON.parse(body.toString()) as { blockerId?: string; id?: string }
    const blockerId = parsed.blockerId ?? parsed.id
    if (!blockerId) { json(res, { error: 'blockerId mező kötelező' }, 400); return true }
    if (!getKanbanCard(blockerId)) { json(res, { error: 'A blokkoló kártya nem található' }, 404); return true }
    // A cycle is refused rather than stored: a block that can never clear is
    // not information, it is a deadlock the board would render as normal.
    if (blockerWouldCycle(cardId, blockerId)) {
      json(res, { error: blockerId === cardId
        ? 'Egy kártya nem blokkolhatja saját magát'
        : 'Ez a kapcsolat kört zárna be (a két kártya kölcsönösen egymásra várna)' }, 409)
      return true
    }
    addCardBlocker(cardId, blockerId)
    json(res, { ok: true })
    return true
  }

  const cardBlockerDeleteMatch = path.match(/^\/api\/kanban\/([^/]+)\/blockers\/([^/]+)$/)
  if (cardBlockerDeleteMatch && method === 'DELETE') {
    const cardId = decodeURIComponent(cardBlockerDeleteMatch[1])
    const blockerId = decodeURIComponent(cardBlockerDeleteMatch[2])
    if (removeCardBlocker(cardId, blockerId)) { json(res, { ok: true }); return true }
    json(res, { error: 'A kártyán nincs ilyen blokkoló' }, 404)
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
    // The caller may supply its own id (we use readable slugs for long-lived cards).
    // Resolve it BEFORE the spread so the stored id and the reported id are the same
    // value: `{ id, ...data }` let a caller-supplied id win in the row while the
    // response still echoed the generated one, so anything referencing the returned
    // id pointed at a card that does not exist -- with HTTP 200.
    const suppliedId = typeof data.id === 'string' ? data.id.trim() : ''
    const id = suppliedId || randomUUID().slice(0, 8)
    createKanbanCard({ ...data, id })
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    // `actor` is metadata for the audit event, not a card column -- keep it out
    // of the field set so it can never be mistaken for one. Same name the /move
    // route already accepts, so callers do not have to learn a second spelling.
    const { actor, ...data } = JSON.parse(body.toString()) as Record<string, unknown> & { actor?: string }
    // #1023: reject unknown fields loudly instead of dropping them silently.
    // updateKanbanCard writes only KANBAN_WRITABLE_FIELDS, so anything outside
    // the accepted set below was silently discarded while the write still
    // reported success and bumped updated_at -- twice a real closing note was
    // lost this way (#1023). A body that carries a key the writer cannot honour
    // is a caller bug, and a 400 that names the accepted fields is strictly
    // better than a 200 that did not do what the caller asked.
    //
    // KANBAN_READONLY_FIELDS are the columns and GET-embedded arrays the
    // dashboard round-trips: the UI sends the whole `{...card}` object on an
    // assignee or parent edit (web/app.js), so these must be accepted-and-
    // ignored rather than rejected, or every UI edit would 400.
    const unknown = Object.keys(data).filter(
      (k) => !(KANBAN_WRITABLE_FIELDS as readonly string[]).includes(k) && !KANBAN_READONLY_FIELDS.has(k),
    )
    if (unknown.length > 0) {
      json(res, {
        error: `Unknown field(s): ${unknown.join(', ')}. Accepted: ${KANBAN_WRITABLE_FIELDS.join(', ')}`,
      }, 400)
      return true
    }
    // A re-parent is refused rather than stored if it would close a loop, same reasoning as
    // the blocker check above: a parent chain that loops back on itself is not a hierarchy,
    // and touchAncestorChain (db.ts) only detects one after it already exists -- it cannot
    // prevent the write that creates it. Clearing the parent (null/omitted) needs no check:
    // there is nothing to walk.
    if (typeof data.parent_id === 'string' && data.parent_id) {
      if (!getKanbanCard(data.parent_id)) {
        json(res, { error: 'A szülő kártya nem található' }, 404)
        return true
      }
      if (parentWouldCycle(id, data.parent_id)) {
        json(res, {
          error: data.parent_id === id
            ? 'Egy kártya nem lehet a saját szülője'
            : 'Ez a szülő-kapcsolat kört zárna be',
        }, 409)
        return true
      }
    }
    if (updateKanbanCard(id, data, actor)) { json(res, { ok: true }); return true }
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
    if (moveKanbanCard(id, status, sort_order ?? 0, actor)) {
      // Wake the assigned agent once when the card enters in_progress -- unless
      // that agent is the one who moved it (self-pickup needs no wake-up).
      if (status === 'in_progress') fireKanbanDispatch(id, actor)
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
    if (archiveKanbanCard(id)) { json(res, { ok: true }); return true }
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
    // A comment for a card that does not exist used to be STORED, with HTTP 200:
    // `addKanbanComment` writes whatever card_id it is handed, and this branch
    // never looked the card up. The row then hangs off an id no board view
    // resolves -- the comment is invisible -- while the caller's only success
    // signal says it landed. The `/breakdown` branch below has always guarded
    // this way; the comment branch had not.
    //
    // This is not a hypothetical typo. `templates/CLAUDE.md.template` hands the
    // agent a curl with a literal `KARTYA_ID` to substitute; an agent that
    // forgets to substitute it gets a 200 and a comment on a card called
    // "KARTYA_ID". The same shape reaches the endpoint from a truncated id
    // column, or from a loop whose body kept its placeholder. Every one of
    // those is silent today.
    //
    // The lookup is exact, matching `getKanbanCard` everywhere else: no caller
    // in this repo constructs a prefix id (the dispatch instructions in
    // `kanbanMoveInstructions` interpolate the full id), so rejecting a
    // non-resolving id turns away only writes that were already lost.
    const card = getKanbanCard(cardId)
    if (!card) {
      json(res, { error: `Kártya nem található: ${cardId}. A komment NEM jött létre. Teljes azonosító kell, a rövidített (prefix) alak nem működik.` }, 404)
      return true
    }
    const body = await readBody(req)
    const { author, content, automated } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    // Code-side kanban-ref enforcement: rewrite `#<hex8>` references that map
    // to a real card into the human-facing `#<seq>` form before persistence
    // (#75 Cuzcoo dispatch). Random hex / non-matching tokens pass through.
    const normalizedContent = normalizeKanbanRefs(content, getKanbanSeqByIdPrefix)
    // `automated: true`: a bulk/machine writer marks its own comment, so the
    // stuck detector never reads it as a work-trace (KANBANSTUCKURES916).
    json(res, automated === true
      ? addKanbanComment(cardId, author, normalizedContent, { automated: true })
      : addKanbanComment(cardId, author, normalizedContent))
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

  // Last, deliberately: every other single-card matcher above has had its turn,
  // including the fixed paths that also happen to be one segment long
  // (/api/kanban/archived among them). Placing this earlier would answer 405
  // for those before their own handler ran.
  //
  // Reached only when the path IS a single-card path and the method is not one
  // this route serves. Without it the request falls through to the server's
  // catch-all 404, whose body cannot be told apart from "no such card" -- an
  // ambiguity that has twice pointed a caller at the wrong bug.
  if (path.match(/^\/api\/kanban\/([^/]+)$/)) {
    methodNotAllowed(res, method, KANBAN_CARD_METHODS)
    return true
  }

  return false
}
