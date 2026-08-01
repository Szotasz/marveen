// CostOps -- shadow evaluation of the first eco-worker task.
//
// Moving reggeli-teteles-lista to the eco-worker is meant to be a methodology
// proof, not a saving: the task is 0.7% of fleet spend. What it has to prove is
// that a cheap, small-context worker still produces a CORRECT report, and that
// is checkable here because the task reads the kanban database and the database
// is still there to check against.
//
// Two halves, and the second is the one that matters:
//
//   cost      -- what the run cost on the worker, and what the same work would
//                have cost inherited into the main session
//   coverage  -- of the cards that actually moved, how many the report named
//
// Cost alone would be a trap. A worker that reports nothing is extremely cheap.

import type Database from 'better-sqlite3'

/** A card that genuinely changed in the window: the report should mention it. */
export interface MovedCard {
  id: string
  /**
   * The card's human-facing number (its sqlite rowid) -- what the fleet
   * actually writes: "#114", never the hex id. The repo normalises hex
   * references INTO this form (see normalizeKanbanRefs), so a matcher that
   * only knows the hex id is looking for the one spelling the codebase
   * removes.
   */
  seq: number | null
  title: string
  /** 'card' = the row itself changed, 'comment' = a comment was added. */
  via: 'card' | 'comment'
}

/**
 * Cards that moved in a window, from the same tables the task reads.
 *
 * Comments count as movement because the task explicitly reports "new comment"
 * as a change; a card whose only event was a comment is still something the
 * report was supposed to mention.
 */
export function groundTruthCards(db: Database.Database, start: number, end: number): MovedCard[] {
  const byId = new Map<string, MovedCard>()
  for (const r of db.prepare(`
    SELECT rowid AS seq, id, title FROM kanban_cards WHERE updated_at >= ? AND updated_at < ?
  `).all(start, end) as Array<{ seq: number; id: string; title: string }>) {
    byId.set(r.id, { id: r.id, seq: r.seq, title: r.title, via: 'card' })
  }
  for (const r of db.prepare(`
    SELECT c.rowid AS seq, c.id AS id, c.title AS title
    FROM kanban_comments m JOIN kanban_cards c ON c.id = m.card_id
    WHERE m.created_at >= ? AND m.created_at < ?
  `).all(start, end) as Array<{ seq: number; id: string; title: string }>) {
    if (!byId.has(r.id)) byId.set(r.id, { id: r.id, seq: r.seq, title: r.title, via: 'comment' })
  }
  return [...byId.values()]
}

/**
 * Pull the messages the worker actually sent.
 *
 * The eco-worker has no channel: its user-facing output goes through
 * scripts/notify.sh, so the sent text is the argument of those bash calls in
 * the transcript. Reading the transcript rather than a log is deliberate --
 * it is what was really sent, not what something claims was sent.
 */
export function extractNotifyMessages(transcriptLines: string[]): string[] {
  const out: string[] = []
  for (const line of transcriptLines) {
    if (!line.includes('notify.sh')) continue
    let obj: unknown
    try { obj = JSON.parse(line) } catch { continue }
    const content = (obj as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const b = block as { type?: string; input?: { command?: unknown } }
      if (b?.type !== 'tool_use') continue
      const cmd = b.input?.command
      if (typeof cmd !== 'string' || !cmd.includes('notify.sh')) continue
      const m = /notify\.sh\s+(['"])([\s\S]*?)\1/.exec(cmd)
      if (m) out.push(m[2])
    }
  }
  return out
}

export interface Coverage {
  moved: number
  mentioned: number
  missed: MovedCard[]
  /** moved-and-mentioned / moved. 1 when nothing moved (nothing to miss). */
  recall: number
  messages: number
}

/**
 * Did the report name the things that actually moved?
 *
 * Three ways a card can be named, because a prose report may use any of them:
 *
 *   #<seq>  the human-facing card number -- what the fleet actually writes.
 *           This was missing on the first real run (2026-08-01) and cost the
 *           measurement its meaning: the worker referenced 15 cards as "#114",
 *           "#157", ... and scored 1/21, because the matcher only knew the hex
 *           id and the full title. The repo's own normalizeKanbanRefs REWRITES
 *           hex references into #<seq>, so the matcher was looking for the one
 *           spelling the codebase deliberately removes.
 *   hex id  still accepted -- it appears in machine-written text.
 *   title   normalised (case, whitespace) and approximate by nature: a card
 *           whose title is a common phrase can match a sentence that was not
 *           about it.
 *
 * Title matching inflates recall, so this metric errs towards saying the worker
 * did FINE. Treat a low recall as solid evidence and a high recall as weak
 * evidence; the asymmetry is deliberate, because the failure we care about is a
 * report that quietly omits things.
 */
export function evaluateCoverage(messages: string[], moved: MovedCard[]): Coverage {
  const haystack = messages.join('\n').toLowerCase().replace(/\s+/g, ' ')
  const missed: MovedCard[] = []
  let mentioned = 0
  for (const card of moved) {
    const idHit = card.id.length >= 6 && haystack.includes(card.id.toLowerCase())
    // The negative lookahead keeps "#11" from matching "#114" -- otherwise a
    // low-numbered card would be credited by any higher number sharing its
    // prefix, and old cards would look permanently well covered.
    const seqHit = card.seq !== null && new RegExp(`#${card.seq}(?![0-9])`).test(haystack)
    const title = card.title.toLowerCase().replace(/\s+/g, ' ').trim()
    // Very short titles are not evidence of anything.
    const titleHit = title.length >= 12 && haystack.includes(title)
    if (idHit || seqHit || titleHit) mentioned++
    else missed.push(card)
  }
  return {
    moved: moved.length,
    mentioned,
    missed,
    recall: moved.length === 0 ? 1 : mentioned / moved.length,
    messages: messages.length,
  }
}

export type Verdict = 'pass' | 'suspect' | 'no_output' | 'no_data' | 'incomplete'

export interface ShadowEvaluation {
  window: { start: number; end: number }
  coverage: Coverage
  verdict: Verdict
  note: string
}

const NOTES: Record<Verdict, string> = {
  pass: 'The report named every card that moved. Note the metric is generous by construction: title matching can over-credit, so this is weak evidence of correctness and strong evidence only against gross omission.',
  suspect: 'The report omitted cards that actually moved. This is the failure mode the move to a cheap worker was meant to be tested for -- inspect the missed list before extending the rollout.',
  no_output: 'The worker sent nothing. A silent run is indistinguishable from a run that found nothing, EXCEPT that this task forbids silence: its own skill requires a line even when a thread had no activity. Treat as a failure, not as a quiet night.',
  no_data: 'Nothing moved in the window, so the run cannot be judged either way. Not a pass.',
  incomplete: 'The run had not finished when this was measured, so any verdict would be about the clock, not the worker. Re-measure once the transcript stops growing.',
}

/**
 * Verdict for one run.
 *
 * `no_output` is called out separately rather than folded into a recall of 0,
 * because the two have different causes and only one of them is ambiguous.
 *
 * `runComplete` exists because of the first real evaluation (2026-08-01): the
 * review fired while the worker was still mid-run, the transcript held no
 * notify calls YET, and the evaluator returned `no_output` -- whose note says
 * "treat as a failure". Measuring a running job and reporting it as a silent
 * one is the same mistake as calling a busy session stuck. A caller that
 * cannot tell (no way to check the transcript is settled) should pass nothing
 * and accept the old behaviour; a caller that CAN tell must say so.
 */
export function evaluateRun(
  messages: string[],
  moved: MovedCard[],
  window: { start: number; end: number },
  opts: { runComplete?: boolean } = {},
): ShadowEvaluation {
  const coverage = evaluateCoverage(messages, moved)
  let verdict: Verdict
  if (opts.runComplete === false) verdict = 'incomplete'
  else if (messages.length === 0) verdict = 'no_output'
  else if (moved.length === 0) verdict = 'no_data'
  else verdict = coverage.missed.length === 0 ? 'pass' : 'suspect'
  return { window, coverage, verdict, note: NOTES[verdict] }
}
