// AGENTCREATEPR3-1119: an agent_create approval on the owner's Gromzo app, through mxd's decisions verbs
// (GROMZODONTES1030). The server posts the stored spec's own text as an approval row; the owner answers it from a signed
// Gromzo device; a watcher here reads the answer from mxd's store and decides the approval through the core, bound to
// the content hash the posted row showed.
//
// The double spend (Samu's card): mxd spends an approval once (decision_consume), and the core decides once. The order:
//   1. our row pending -> consuming (compare-and-set: one watcher round owns it);
//   2. mxd decision_consume (kind agent_create, mxd's hash, gate agent_create);
//      a refusal or an error: back to pending, nothing decided, nothing created;
//   3. the core decides (approved, bound to the approval's content hash); decided -> done.
//      mxd spent it but the core did not decide: failed, the main agent is alerted, nothing created.
// A rejection decides through the core directly (mxd has nothing to spend for a rejection).
// Before every post, a capability probe (Samu 81756, 3): an mxd older than the decisions verbs leaves the adapter off,
// loudly; an mxd that cannot be reached now is "not available", never "old".
import { decideApproval, createAgentMessage, recordApprovalGromzoPost, pendingApprovalGromzoPosts, consumingApprovalGromzoPosts, moveApprovalGromzoPost, type Approval } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { renderAgentSpec } from './agent-create-spec.js'
import { verifiedAgentSpec } from './approval-teams-card.js'
import { probeDecisions, postDecision, getDecision, consumeDecision, mxdDashCall, type MxdDashCall } from './mxd-dash.js'
import type { ApprovalLang } from './approval-texts.js'

export const GROMZO_DECISION_KIND = 'agent_create'
export const GROMZO_DECISION_GATE = 'agent_create'
/** The consume answers that mean "mxd could not be asked now" (a socket error or timeout is reported as unreachable;
 *  unavailable is mxd's own "decisions not available"): retried. Every other code fails the row. */
export const GROMZO_TRANSIENT_CONSUME_CODES: ReadonlySet<string> = new Set(['unreachable', 'timeout', 'unavailable'])

export interface GromzoDecisionDeps {
  call: MxdDashCall
  alert: (text: string) => void
}
const defaultDeps: GromzoDecisionDeps = {
  call: (r) => mxdDashCall(r),
  alert: (text) => { try { createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.error({ err }, 'agent_create Gromzo alert failed') } },
}

export type GromzoPostOutcome = 'posted' | 'old_mxd' | 'unavailable' | 'not_verifiable' | 'refused'

/** Posts the approval to the owner's Gromzo app. Never throws; the outcome says why it did not go out. */
export async function postAgentCreateToGromzo(approval: Approval, lang: ApprovalLang, deps: GromzoDecisionDeps = defaultDeps): Promise<GromzoPostOutcome> {
  try {
    const spec = verifiedAgentSpec(approval)
    if (!spec || !approval.content_hash) return 'not_verifiable'
    const cap = await probeDecisions(deps.call)
    if (cap === 'old_mxd') {
      logger.error({ approvalId: approval.id }, 'agent_create: this mxd has no decisions verbs (older than 84ef8fe): the Gromzo approval is OFF, decide on the dashboard')
      deps.alert(`[agent_create] A Gromzo-jóváhagyás nem érhető el: a telepített mxd régebbi a döntés-igéknél (84ef8fe). A kérés (${approval.id}) a dashboardon dönthető el.`)
      return 'old_mxd'
    }
    if (cap === 'unavailable') {
      logger.warn({ approvalId: approval.id }, 'agent_create: mxd is not reachable now; the Gromzo approval was not posted (the dashboard decides)')
      return 'unavailable'
    }
    const r = await postDecision(deps.call, approval.id, GROMZO_DECISION_KIND, {
      text: renderAgentSpec(spec, approval.content_hash, lang),
      spec_hash: approval.content_hash,
    })
    if (!r.ok) {
      logger.warn({ approvalId: approval.id, code: r.code }, 'agent_create: mxd refused the Gromzo approval row (the dashboard decides)')
      return 'refused'
    }
    recordApprovalGromzoPost(approval.id, r.hash, approval.content_hash)
    logger.info({ approvalId: approval.id }, 'agent_create approval posted to the owner\'s Gromzo app')
    return 'posted'
  } catch (err) {
    logger.error({ approvalId: approval.id, err: err instanceof Error ? err.message : String(err) }, 'agent_create: the Gromzo post failed')
    return 'unavailable'
  }
}

export type GromzoTickResult = { approvalId: string; outcome: string }

/** One watcher round over the pending rows: reads each answer from mxd and decides (see the order above). */
export async function gromzoDecisionTick(deps: GromzoDecisionDeps = defaultDeps): Promise<GromzoTickResult[]> {
  const out: GromzoTickResult[] = []
  for (const row of pendingApprovalGromzoPosts()) {
    const id = row.approval_id
    let got
    try { got = await getDecision(deps.call, id) } catch { out.push({ approvalId: id, outcome: 'unreachable' }); continue }
    if (!got.ok) { out.push({ approvalId: id, outcome: `get_${got.code}` }); continue }
    if (got.state === 'open') { out.push({ approvalId: id, outcome: 'open' }); continue }
    if (got.hash !== row.mxd_hash) {
      // the row mxd answered is not the one we posted: never decide from it
      moveApprovalGromzoPost(id, 'pending', 'failed', 'hash_mismatch')
      deps.alert(`[agent_create] A Gromzo-válasz (${id}) nem az általunk kiküldött sorra jött (hash-eltérés); nem döntöttem.`)
      out.push({ approvalId: id, outcome: 'hash_mismatch' })
      continue
    }
    if (got.choice === 'reject') {
      const d = decideApproval({ approvalId: id, status: 'rejected', evidence: { channel: 'gromzo', mode: 'decision' } })
      moveApprovalGromzoPost(id, 'pending', 'done', `rejected:${d.outcome}`)
      out.push({ approvalId: id, outcome: `rejected:${d.outcome}` })
      continue
    }
    if (got.choice !== 'approve') { out.push({ approvalId: id, outcome: 'unknown_choice' }); continue }
    // 1. ours: pending -> consuming
    if (!moveApprovalGromzoPost(id, 'pending', 'consuming')) { out.push({ approvalId: id, outcome: 'taken' }); continue }
    // 2. mxd spends it
    let spent
    try { spent = await consumeDecision(deps.call, GROMZO_DECISION_KIND, row.mxd_hash, GROMZO_DECISION_GATE) } catch { spent = { ok: false as const, code: 'unreachable' } }
    if (!spent.ok) {
      // Dani N1 / Samu 81811: only a known transient answer is retried (back to pending); any other refusal
      // (already_consumed: mxd spent it and the reply was lost; expired; not_found; kind_mismatch; an unknown code) can
      // never succeed later, so it fails loudly instead of repeating every round in silence.
      if (GROMZO_TRANSIENT_CONSUME_CODES.has(spent.code)) {
        moveApprovalGromzoPost(id, 'consuming', 'pending', `consume_${spent.code}`)
        logger.warn({ approvalId: id, code: spent.code }, 'agent_create: mxd could not be asked to spend the Gromzo approval now; nothing decided, it stays pending')
      } else {
        moveApprovalGromzoPost(id, 'consuming', 'failed', `consume_${spent.code}`)
        deps.alert(`[agent_create] A Gromzo-jóváhagyást az mxd nem költötte el (${spent.code}), ezért a kérést (${id}) nem hagytam jóvá: ügynök NEM jött létre. Nézd meg a dashboardon, és ha kell, döntsd el ott.`)
      }
      out.push({ approvalId: id, outcome: `consume_${spent.code}` })
      continue
    }
    // 3. the core decides, bound to the content hash the posted row showed (never the approval's current one)
    let outcome = 'not_found'
    try {
      outcome = decideApproval({ approvalId: id, status: 'approved', evidence: { channel: 'gromzo', mode: 'decision' }, expectedContentHash: row.spec_hash }).outcome
    } catch (err) { outcome = `error:${err instanceof Error ? err.message : String(err)}` }
    if (outcome === 'decided') {
      moveApprovalGromzoPost(id, 'consuming', 'done', 'approved')
      out.push({ approvalId: id, outcome: 'approved' })
    } else {
      moveApprovalGromzoPost(id, 'consuming', 'failed', `commit_${outcome}`)
      // Samu 81801: a request the owner already decided elsewhere (the dashboard, another channel) is named as such
      deps.alert(outcome === 'not_pending'
        ? `[agent_create] A Gromzo-jóváhagyást az mxd elköltötte, de a kérésről (${id}) közben már máshol (dashboard vagy másik csatorna) döntöttek; ez a Gromzo-válasz nem hozott létre semmit.`
        : `[agent_create] A Gromzo-jóváhagyást az mxd elköltötte, de a kérést (${id}) nem tudtam jóváhagyni (${outcome}): ügynök NEM jött létre. Nézd meg a dashboardon.`)
      out.push({ approvalId: id, outcome: `commit_${outcome}` })
    }
  }
  return out
}

/** At the watcher's start (Samu 81801): a row left in "consuming" (the server stopped between mxd's consume and the
 *  commit) is never resumed: mxd may have spent the owner's answer already, and the request was not decided. It goes to
 *  failed (interrupted), and the main agent is alerted, as a failed commit is. Nothing is created. */
export function sweepGromzoConsumingOnStart(deps: GromzoDecisionDeps = defaultDeps): string[] {
  const swept: string[] = []
  for (const row of consumingApprovalGromzoPosts()) {
    if (!moveApprovalGromzoPost(row.approval_id, 'consuming', 'failed', 'interrupted')) continue
    swept.push(row.approval_id)
    deps.alert(`[agent_create] A Gromzo-jóváhagyás feldolgozása (${row.approval_id}) megszakadt (újraindulás az mxd-költés és a jóváhagyás között): ügynök NEM jött létre. Nézd meg a dashboardon, és ha kell, kérd újra.`)
  }
  return swept
}

const TICK_MS = 15_000
let timer: ReturnType<typeof setTimeout> | null = null
/** Starts the watcher (server start): one round every 15 s while the server runs; a round that throws is logged. */
export function startGromzoDecisionWatch(deps: GromzoDecisionDeps = defaultDeps): void {
  if (timer) return
  try { sweepGromzoConsumingOnStart(deps) } catch (err) { logger.error({ err: err instanceof Error ? err.message : String(err) }, 'agent_create Gromzo start-up sweep failed') }
  const loop = () => {
    timer = setTimeout(async () => {
      try { await gromzoDecisionTick(deps) } catch (err) { logger.error({ err: err instanceof Error ? err.message : String(err) }, 'agent_create Gromzo watcher round failed') }
      loop()
    }, TICK_MS)
    timer.unref?.()
  }
  loop()
}
export function stopGromzoDecisionWatchForTest(): void { if (timer) clearTimeout(timer); timer = null }
