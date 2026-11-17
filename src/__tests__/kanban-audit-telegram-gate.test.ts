// The kanban-audit task's step 7 decides when the main agent writes to the owner.
// Two of its conditions were prose only ("3+ stuck tasks", "waiting > 48h"), and both
// fired on the SAME cards in every round:
//   - the 3+ count included the main agent's own stuck cards, which step 4 never pings
//     and which typically wait on the owner, so the list never changes;
//   - "waiting > 48h" looked at the bare age, so every card past 48 hours was a "new
//     blocker" again four hours later.
// An alert that repeats every round stops being read. Step 7 now COUNTS both with its
// own block, and this file runs those shipped blocks (Hungarian source and English
// version) over real answers of the code behind the two endpoints they call.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, getStuckKanbanCards, listKanbanCards } from '../db.js'

const ROOT = join(__dirname, '..', '..')
const HU = readFileSync(join(ROOT, 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')
const EN = readFileSync(join(ROOT, 'i18n', 'en', 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')

const LANGS = [
  {
    lang: 'hu', skill: HU, counted: 'számít=', ownOld: 'fő-ágens régi=', reportOnly: 'csak jelentés:',
    examined: 'vizsgált=', over48: '48h felett=', fresh: 'új=', firstRun: 'első futás', yes: 'OWNER ALERT: yes', no: 'OWNER ALERT: no',
    oldStuck: /^\s*- 3\+ beakadt task van \(kritikus\)\s*$/m, oldWaiting: /^\s*- Új blokker \(waiting > 48h\)\s*$/m,
  },
  {
    lang: 'en', skill: EN, counted: 'counted=', ownOld: 'main agent old=', reportOnly: 'report only:',
    examined: 'examined=', over48: 'over 48h=', fresh: 'new=', firstRun: 'first run', yes: 'OWNER ALERT: yes', no: 'OWNER ALERT: no',
    oldStuck: /^\s*- there are 3\+ stuck tasks \(critical\)\s*$/m, oldWaiting: /^\s*- New blocker \(waiting > 48h\)\s*$/m,
  },
] as const

const MAIN = 'main'
const HOUR = 3600
const DAY = 86400

function step(skill: string, n: number): string {
  const start = skill.search(new RegExp(`^${n}\\. \\*\\*`, 'm'))
  if (start < 0) throw new Error(`step ${n} not found in kanban-audit SKILL.md`)
  const rest = skill.slice(start + 1)
  const end = rest.search(/^(\d+[a-z]?\. \*\*|## )/m)
  return skill.slice(start, end < 0 ? undefined : start + 1 + end)
}

/** The `curl ... "<url>" | python3 -c "<code>"` blocks of a step, in order. */
function blocks(text: string): Array<{ url: string; code: string }> {
  const rx = /^\s*curl -s [^\n]*"(http:\/\/localhost:\$PORT[^"\n]*)" \| python3 -c "\n([\s\S]*?)\n"\n/gm
  return [...text.matchAll(rx)].map((m) => ({ url: m[1], code: m[2] }))
}

/** Run a shipped block the way the task does: placeholders rendered, the state file in place. */
function run(code: string, answer: unknown, lastAuditAt: number | null | 'corrupt', mainId: string = MAIN): string {
  const install = mkdtempSync(join(tmpdir(), 'kanban-audit-gate-'))
  try {
    mkdirSync(join(install, 'store'))
    const state = join(install, 'store', 'kanban-audit-state.json')
    if (lastAuditAt === 'corrupt') writeFileSync(state, '{ not json')
    else if (lastAuditAt !== null) writeFileSync(state, JSON.stringify({ last_audit_at: lastAuditAt }))
    // the block is written for a shell double-quoted string: undo its \" escapes
    const py = code.replace(/\\"/g, '"').split('{{INSTALL_DIR}}').join(install).split('{{MAIN_AGENT_ID}}').join(mainId)
    const res = spawnSync('python3', ['-c', py], { input: JSON.stringify(answer), encoding: 'utf-8' })
    expect(res.stderr).toBe('')
    return res.stdout
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
}

function num(out: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = out.match(new RegExp(`${escaped}(\\d+)`))
  if (!m) throw new Error(`"${key}" not found in:\n${out}`)
  return Number(m[1])
}

const verdict = (out: string): string => out.trimEnd().split('\n').pop() ?? ''

for (const L of LANGS) {
  describe(`kanban-audit step 7 (${L.lang}): the two counted Telegram conditions`, () => {
    const s7 = step(L.skill, 7)
    const [stuckBlock, waitingBlock] = blocks(s7)
    let now = 0
    let last = 0

    beforeEach(() => {
      initDatabase(':memory:')
      now = Math.floor(Date.now() / 1000)
      last = now - 4 * HOUR // the previous audit
    })

    /** A started card whose last activity was `idleSec` ago. */
    function card(id: string, status: string, assignee: string | null, idleSec: number): void {
      const t = now - idleSec
      getDb().prepare(
        `INSERT INTO kanban_cards (id, title, status, priority, assignee, created_at, updated_at, dispatched_at, due_date)
         VALUES (?, ?, ?, 'normal', ?, ?, ?, ?, NULL)`).run(id, `card ${id}`, status, assignee, t, t, t)
    }
    const stuckAnswer = () => getStuckKanbanCards({ plannedDays: 7, activeDays: 3, creatorCommentWindowSec: 600 })
    const stuck = (lastAuditAt: number | null | 'corrupt' = last) => run(stuckBlock.code, stuckAnswer(), lastAuditAt)
    const waiting = (lastAuditAt: number | null | 'corrupt' = last) =>
      run(waitingBlock.code, listKanbanCards({ statuses: ['waiting'] }), lastAuditAt)

    // --- wiring: the rule is a block that runs, not a sentence ---

    it('counts with two blocks: the stuck endpoint with the thresholds of step 3, and the waiting cards', () => {
      expect(blocks(s7)).toHaveLength(2)
      const step3Url = blocks(step(L.skill, 3))[0].url
      expect(step3Url).toMatch(/\/api\/kanban\/stuck\?planned_days=\d+&active_days=\d+$/)
      expect(stuckBlock.url).toBe(step3Url)
      expect(waitingBlock.url).toBe('http://localhost:$PORT/api/kanban?status=waiting')
      // "became stuck since the previous audit" is computed from the same two thresholds the URL asks for
      const [, planned, active] = stuckBlock.url.match(/planned_days=(\d+)&active_days=(\d+)/) ?? []
      expect(stuckBlock.code).toMatch(new RegExp(`^PLANNED_DAYS,ACTIVE_DAYS=${planned},${active}\\b`, 'm'))
    })

    it('the two bare conditions that fired every round are gone', () => {
      expect(s7).not.toMatch(L.oldStuck)
      expect(s7).not.toMatch(L.oldWaiting)
    })

    // --- 3+ stuck ---

    it("the main agent's own old stuck cards do not trigger, and are listed for the report", () => {
      for (const id of ['own1', 'own2', 'own3']) card(id, 'in_progress', MAIN, 10 * DAY)
      const out = stuck()
      expect(num(out, L.counted)).toBe(0)
      expect(num(out, L.ownOld)).toBe(3)
      for (const id of ['own1', 'own2', 'own3']) expect(out).toMatch(new RegExp(`${L.reportOnly} ${id} \\| in_progress \\| 10 `))
      expect(verdict(out)).toBe(L.no)
    })

    it("the main agent is recognised whatever the letter case or padding of the assignee", () => {
      card('own1', 'in_progress', 'Main', 10 * DAY)
      card('own2', 'in_progress', ' MAIN ', 10 * DAY)
      card('own3', 'in_progress', MAIN, 10 * DAY)
      const out = stuck()
      expect(num(out, L.ownOld)).toBe(3)
      expect(verdict(out)).toBe(L.no)
    })

    it('the configured id is normalised too: an install whose main agent id is capitalised still matches', () => {
      for (const id of ['own1', 'own2', 'own3']) card(id, 'in_progress', MAIN, 10 * DAY)
      const out = run(stuckBlock.code, stuckAnswer(), last, 'Main')
      expect(num(out, L.ownOld)).toBe(3)
      expect(verdict(out)).toBe(L.no)
    })

    it('3+ stuck cards of other agents trigger, old ones included: their assignee can still act', () => {
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'research', 10 * DAY)
      card('c', 'planned', 'dev', 20 * DAY)
      const out = stuck()
      expect(num(out, L.counted)).toBe(3)
      expect(verdict(out).startsWith(L.yes)).toBe(true)
    })

    it('a stuck card with no assignee is nobody\'s own, so it counts', () => {
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      card('c', 'in_progress', null, 10 * DAY)
      expect(verdict(stuck()).startsWith(L.yes)).toBe(true)
    })

    it("two foreign stuck cards plus the main agent's old one stay below the threshold", () => {
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      card('own', 'in_progress', MAIN, 10 * DAY)
      const out = stuck()
      expect(num(out, L.counted)).toBe(2)
      expect(num(out, L.ownOld)).toBe(1)
      expect(verdict(out)).toBe(L.no)
    })

    it("the main agent's card counts in the round it BECAME stuck (in_progress: 3 days)", () => {
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      card('own', 'in_progress', MAIN, 3 * DAY + HOUR) // stuck for an hour, the previous audit was 4 hours ago
      const out = stuck()
      expect(num(out, L.counted)).toBe(3)
      expect(num(out, L.ownOld)).toBe(0)
      expect(verdict(out).startsWith(L.yes)).toBe(true)
    })

    it('"became stuck" uses the threshold of the card\'s own status (planned: 7 days)', () => {
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      // with the 3-day threshold this card would have been stuck for four days already
      card('own', 'planned', MAIN, 7 * DAY + HOUR)
      expect(verdict(stuck()).startsWith(L.yes)).toBe(true)
      // ...and a planned card of the main agent that crossed the 7 days long ago is old
      initDatabase(':memory:')
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      card('own', 'planned', MAIN, 20 * DAY)
      expect(verdict(stuck())).toBe(L.no)
    })

    it('a card that became stuck between the previous measurement and its state write is still new', () => {
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      card('own', 'in_progress', MAIN, 3 * DAY + 4 * HOUR + 300) // stuck 5 minutes before last_audit_at
      expect(verdict(stuck()).startsWith(L.yes)).toBe(true)
      initDatabase(':memory:')
      card('a', 'in_progress', 'dev', 10 * DAY)
      card('b', 'in_progress', 'dev', 10 * DAY)
      card('own', 'in_progress', MAIN, 3 * DAY + 6 * HOUR) // stuck 2 hours before it: old
      expect(verdict(stuck())).toBe(L.no)
    })

    it('first run or unreadable state: nothing is "new", and the output says it could not be measured', () => {
      card('own1', 'in_progress', MAIN, 3 * DAY + HOUR)
      card('own2', 'in_progress', MAIN, 10 * DAY)
      card('own3', 'in_progress', MAIN, 10 * DAY)
      for (const state of [null, 'corrupt'] as const) {
        const out = stuck(state)
        expect(num(out, L.counted)).toBe(0)
        expect(out).toContain(L.firstRun)
        expect(verdict(out)).toBe(L.no)
      }
      // the foreign cards do not depend on the state
      for (const id of ['a', 'b', 'c']) card(id, 'in_progress', 'dev', 10 * DAY)
      expect(verdict(stuck(null)).startsWith(L.yes)).toBe(true)
    })

    // --- waiting > 48h ---

    it('a card that has been waiting for days is not a new blocker again', () => {
      card('old', 'waiting', 'owner', 10 * DAY)
      const out = waiting()
      expect(num(out, L.over48)).toBe(1)
      expect(num(out, L.fresh)).toBe(0)
      expect(out).not.toMatch(/^\s+old \|/m)
      expect(verdict(out)).toBe(L.no)
    })

    it('a card that crossed the 48 hours since the previous audit is reported, once', () => {
      card('old', 'waiting', 'owner', 10 * DAY)
      card('crossed', 'waiting', 'owner', 49 * HOUR)
      card('young', 'waiting', 'owner', 5 * HOUR)
      const out = waiting()
      expect(num(out, L.over48)).toBe(2)
      expect(num(out, L.fresh)).toBe(1)
      expect(out).toMatch(/^\s+crossed \| owner \| 49\.0 h \| card crossed$/m)
      expect(verdict(out).startsWith(L.yes)).toBe(true)
      // the next round (its previous audit is this one): the same card is silent
      expect(verdict(waiting(now))).toBe(L.no)
    })

    it('the age is the time in the column: a comment on an old card does not make it new', () => {
      card('old', 'waiting', 'owner', 10 * DAY)
      getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now - HOUR, 'old')
      const out = waiting()
      expect(num(out, L.over48)).toBe(1)
      expect(num(out, L.fresh)).toBe(0)
      expect(verdict(out)).toBe(L.no)
    })

    it('the age starts at the move into waiting, not at the creation of the card', () => {
      card('moved', 'waiting', 'owner', 30 * DAY)
      getDb().prepare(
        `INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at)
         VALUES ('moved', 'in_progress', 'waiting', 'dev', ?)`).run(now - 49 * HOUR)
      const out = waiting()
      expect(num(out, L.fresh)).toBe(1)
      expect(verdict(out).startsWith(L.yes)).toBe(true)
    })

    it('a crossing between the previous measurement and its state write is not lost', () => {
      card('edge', 'waiting', 'owner', 48 * HOUR + 4 * HOUR + 300) // crossed 5 minutes before last_audit_at
      expect(verdict(waiting()).startsWith(L.yes)).toBe(true)
      initDatabase(':memory:')
      card('before', 'waiting', 'owner', 48 * HOUR + 6 * HOUR) // crossed 2 hours before it
      expect(verdict(waiting())).toBe(L.no)
    })

    it('only waiting cards are examined', () => {
      card('p', 'planned', 'owner', 49 * HOUR)
      card('i', 'in_progress', 'owner', 49 * HOUR)
      // the block filters by itself too: fed the whole board, it reads the same
      const out = run(waitingBlock.code, listKanbanCards(), last)
      expect(num(out, L.examined)).toBe(0)
      expect(num(out, L.fresh)).toBe(0)
      expect(verdict(out)).toBe(L.no)
    })

    it('an archived card is not a blocker, even if the answer carries it', () => {
      card('gone', 'waiting', 'owner', 49 * HOUR)
      getDb().prepare('UPDATE kanban_cards SET archived_at = ? WHERE id = ?').run(now - HOUR, 'gone')
      const out = run(waitingBlock.code, listKanbanCards({ includeArchived: true, statuses: ['waiting'] }), last)
      expect(num(out, L.examined)).toBe(0)
      expect(verdict(out)).toBe(L.no)
    })

    it('first run or unreadable state: no card is "new", and the output says it could not be measured', () => {
      card('crossed', 'waiting', 'owner', 49 * HOUR)
      for (const state of [null, 'corrupt'] as const) {
        const out = waiting(state)
        expect(num(out, L.over48)).toBe(1)
        expect(num(out, L.fresh)).toBe(0)
        expect(out).toContain(L.firstRun)
        expect(verdict(out)).toBe(L.no)
      }
    })
  })
}

// The verdict is read by whichever agent runs the task, on whichever channel the install
// has: the label says WHAT follows (the owner is alerted), not WHERE it is sent.
describe('kanban-audit step 7: the verdict label is channel-neutral and the same in both languages', () => {
  const verdictPrints = (skill: string) => blocks(step(skill, 7)).map((b) => b.code.trimEnd().split('\n').pop() ?? '')

  it('both blocks end in "OWNER ALERT: yes (...)" or "OWNER ALERT: no", in hu and en alike', () => {
    for (const skill of [HU, EN]) {
      const prints = verdictPrints(skill)
      expect(prints).toHaveLength(2)
      for (const p of prints) expect(p).toMatch(/^print\('OWNER ALERT: yes \([^']+\)' if .+ else 'OWNER ALERT: no'\)$/)
    }
  })

  it('no block of step 7 prints or names a channel', () => {
    for (const skill of [HU, EN]) {
      for (const b of blocks(step(skill, 7))) expect(b.code).not.toMatch(/telegram|slack|discord|teams/i)
    }
  })
})
