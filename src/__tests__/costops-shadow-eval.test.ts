import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  groundTruthCards,
  extractNotifyMessages,
  evaluateCoverage,
  evaluateRun,
} from '../costops/shadow-eval.js'

/**
 * Shadow evaluation of the first eco-worker task.
 *
 * The move is a methodology proof, not a saving: reggeli-teteles-lista is 0.7%
 * of fleet spend. What has to be proved is that a cheap, small-context worker
 * still produces a CORRECT report -- which is checkable, because the task reads
 * the kanban database and the database is still there to check against.
 *
 * Cost alone would be a trap: a worker that reports nothing is very cheap.
 */

const T0 = 1_785_000_000
const WINDOW = { start: T0 - 10 * 3600, end: T0 }

function freshDb() {
  initDatabase(':memory:')
  getDb().exec('DELETE FROM kanban_cards; DELETE FROM kanban_comments;')
}

function card(id: string, title: string, updated: number) {
  getDb().prepare(`INSERT INTO kanban_cards (id,title,status,assignee,created_at,updated_at)
    VALUES (?,?,'in_progress','marveen',?,?)`).run(id, title, updated, updated)
}

function comment(id: number, cardId: string, created: number) {
  getDb().prepare(`INSERT INTO kanban_comments (id,card_id,author,content,created_at)
    VALUES (?,?,'marveen','x',?)`).run(id, cardId, created)
}

function toolLine(command: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
}

describe('what actually moved', () => {
  beforeEach(freshDb)

  it('collects cards changed in the window', () => {
    card('aaaa1111', 'Lightweight shipping calculator', T0 - 3600)
    card('bbbb2222', 'Outside the window entirely', T0 - 40 * 3600)
    const moved = groundTruthCards(getDb(), WINDOW.start, WINDOW.end)
    expect(moved.map(m => m.id)).toEqual(['aaaa1111'])
  })

  it('counts a card whose only event was a comment', () => {
    // The task reports "new comment" as movement, so a card with nothing but a
    // comment is still something the report was supposed to mention.
    card('cccc3333', 'Quiet card with a fresh comment', T0 - 40 * 3600)
    comment(1, 'cccc3333', T0 - 1800)
    const moved = groundTruthCards(getDb(), WINDOW.start, WINDOW.end)
    // seq is the card's rowid -- carried along so the matcher can credit the
    // "#<seq>" form the fleet writes.
    expect(moved).toEqual([{ id: 'cccc3333', seq: expect.any(Number), title: 'Quiet card with a fresh comment', via: 'comment' }])
  })

  it('does not count the same card twice', () => {
    card('dddd4444', 'Moved and commented', T0 - 3600)
    comment(2, 'dddd4444', T0 - 1800)
    expect(groundTruthCards(getDb(), WINDOW.start, WINDOW.end)).toHaveLength(1)
  })
})

describe('what the worker actually sent', () => {
  it('recovers the message from a notify.sh call', () => {
    const lines = [toolLine(`/home/viktor/Projects/marveen/scripts/notify.sh "Attekinto: 3 kartya mozdult"`)]
    expect(extractNotifyMessages(lines)).toEqual(['Attekinto: 3 kartya mozdult'])
  })

  it('recovers one message per call, which is the per-topic format', () => {
    const lines = [
      toolLine(`scripts/notify.sh 'elso tema'`),
      toolLine(`scripts/notify.sh 'masodik tema'`),
    ]
    expect(extractNotifyMessages(lines)).toEqual(['elso tema', 'masodik tema'])
  })

  it('ignores unrelated tool calls and unparseable lines', () => {
    const lines = [toolLine('git status'), 'not json at all', toolLine('sqlite3 db "SELECT 1"')]
    expect(extractNotifyMessages(lines)).toEqual([])
  })

  it('reads what was sent, not what was planned', () => {
    // A line that merely mentions notify.sh in prose is not a send.
    const lines = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will use notify.sh next' }] } })]
    expect(extractNotifyMessages(lines)).toEqual([])
  })
})

describe('coverage', () => {
  const moved = [
    { id: 'aaaa1111', seq: 41, title: 'Lightweight shipping calculator', via: 'card' as const },
    { id: 'bbbb2222', seq: 42, title: 'GDPR data request review', via: 'card' as const },
  ]

  it('credits a card named by title', () => {
    const c = evaluateCoverage(['Mozdult: Lightweight shipping calculator', 'GDPR data request review lezarva'], moved)
    expect(c.recall).toBe(1)
    expect(c.missed).toEqual([])
  })

  it('credits a card named by id', () => {
    const c = evaluateCoverage(['aaaa1111 status valtozott', 'bbbb2222 komment'], moved)
    expect(c.mentioned).toBe(2)
  })

  it('reports what was omitted, which is the whole point', () => {
    const c = evaluateCoverage(['Csak a Lightweight shipping calculator mozdult'], moved)
    expect(c.recall).toBe(0.5)
    expect(c.missed.map(m => m.id)).toEqual(['bbbb2222'])
  })

  it('does not credit a title too short to be evidence', () => {
    const short = [{ id: 'x', seq: null, title: 'fix', via: 'card' as const }]
    expect(evaluateCoverage(['we fixed things'], short).missed).toHaveLength(1)
  })

  it('treats an empty window as nothing to miss', () => {
    expect(evaluateCoverage(['anything'], []).recall).toBe(1)
  })
})

describe('the verdict', () => {
  const moved = [{ id: 'aaaa1111', seq: 41, title: 'Lightweight shipping calculator', via: 'card' as const }]

  it('passes when everything that moved was named', () => {
    const e = evaluateRun(['Lightweight shipping calculator mozdult'], moved, WINDOW)
    expect(e.verdict).toBe('pass')
    expect(e.note).toContain('weak evidence')
  })

  it('flags omissions as suspect and points at the missed list', () => {
    const e = evaluateRun(['semmi erdemi'], moved, WINDOW)
    expect(e.verdict).toBe('suspect')
    expect(e.coverage.missed).toHaveLength(1)
    expect(e.note).toContain('inspect the missed list')
  })

  it('calls silence a failure, not a quiet night', () => {
    // This task's own skill forbids silence: it must print a line even when a
    // thread had no activity. So no output is a failure, and folding it into a
    // recall of 0 would hide that it has a different cause.
    const e = evaluateRun([], moved, WINDOW)
    expect(e.verdict).toBe('no_output')
    expect(e.note).toContain('forbids silence')
  })

  it('refuses to call an empty window a pass', () => {
    const e = evaluateRun(['attekinto'], [], WINDOW)
    expect(e.verdict).toBe('no_data')
    expect(e.note).toContain('Not a pass')
  })

  it('says out loud that the metric is generous', () => {
    // Title substring matching over-credits. A high recall must not be read as
    // proof the worker did well; a low one is solid evidence it did not.
    expect(evaluateRun(['Lightweight shipping calculator'], moved, WINDOW).note).toContain('over-credit')
  })
})

// Both of these come from the first real evaluation (2026-08-01, the vesta
// eco-worker's first live run). Neither was a worker failure: both were the
// evaluator measuring the wrong thing and being confident about it.
describe('what the first real run taught the evaluator', () => {
  const moved = [
    { id: '7f99df1b', seq: 114, title: 'projekt koltsegek nyilvantartasa', via: 'comment' as const },
    { id: '805c7b5b', seq: 134, title: 'Feladat-eloszuro / modell-router R&D', via: 'card' as const },
  ]

  it('credits the #<seq> reference the fleet actually writes', () => {
    // The worker wrote "#114 projekt koltseg-nyilvantartas -> done". Under the
    // id/title-only matcher that scored ZERO: the report never contains a hex
    // id, because normalizeKanbanRefs rewrites hex refs into exactly this form.
    // Measured on the real run: recall went 1/21 -> 15/21 once #<seq> counted.
    const c = evaluateCoverage(['#114 projekt koltseg-nyilvantartas -> done', 'router: #134 halad'], moved)
    expect(c.recall).toBe(1)
    expect(c.missed).toEqual([])
  })

  it('does not let #11 be credited by a mention of #114', () => {
    // Without the digit boundary every low-numbered card is permanently
    // "covered" by any higher number sharing its prefix.
    const eleven = [{ id: 'cccc3333', seq: 11, title: 'valami regi kartya', via: 'card' as const }]
    expect(evaluateCoverage(['csak a #114 mozdult'], eleven).missed).toHaveLength(1)
  })

  it('refuses to judge a run that has not finished', () => {
    // The review fired mid-run: the transcript held no notify calls YET, and
    // the old code returned no_output, whose note says "treat as a failure".
    // Reporting a running job as a silent one is the same error as calling a
    // busy session stuck.
    const e = evaluateRun([], moved, WINDOW, { runComplete: false })
    expect(e.verdict).toBe('incomplete')
    expect(e.note).toContain('Re-measure')
  })

  it('still calls a finished, silent run a failure', () => {
    // The guard must not become an excuse: complete + nothing sent is exactly
    // the failure the no_output verdict exists for.
    expect(evaluateRun([], moved, WINDOW, { runComplete: true }).verdict).toBe('no_output')
    expect(evaluateRun([], moved, WINDOW).verdict).toBe('no_output')
  })
})
