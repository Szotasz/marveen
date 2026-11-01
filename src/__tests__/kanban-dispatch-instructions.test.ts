import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { kanbanMoveInstructions, DISPATCH_SAFE_CARD_ID_RE } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID, OWNER_NAME } from '../config.js'
import { recipeLine, runRecipeLine, RECIPE_TOKEN } from './helpers/kanban-recipe.js'
import { execFileSync as git } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// The status probe: the one line that pipes the board into a program.
const probeLine = (out: string): string | undefined =>
  out.split('\n').find((l) => l.includes('marveen-api.sh kanban-list |'))

// A card dispatched to an agent used to just say "drag it to done" -- but a
// headless agent cannot drag, and the run left no record on the card. The
// instructions now give the agent the exact curl to post a result summary and
// to mark the card done, so the dispatched task's RESULT lands on its own card
// (visible in the dashboard UI) -- the lightweight alternative to per-session
// cards.
describe('kanbanMoveInstructions', () => {
  it('gives the agent the command to post a result comment AND to mark done (run for real: what reaches the wire)', async () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // Step 1: a human-readable result comment lands on the card; the text comes from a file the agent writes.
    const c = await runRecipeLine(recipeLine(out, 'kanban-comment', 'abc123', 'cody'), { 'kanban-abc123-eredmeny.txt': 'Kész, a PR #1 nyitva.' })
    expect([c.method, c.url, c.body]).toEqual(['POST', '/api/kanban/abc123/comments', { author: 'cody', content: 'Kész, a PR #1 nyitva.' }])
    // Step 2: mark the card done, the evidence from a file, guarded by the expected status.
    const d = await runRecipeLine(recipeLine(out, 'kanban-move', 'abc123', 'done'), { 'kanban-abc123-bizonyitek.txt': 'suite 12/12' })
    expect([d.method, d.url, d.body]).toEqual(['POST', '/api/kanban/abc123/move', { status: 'done', expected_status: 'in_progress', evidence: 'suite 12/12', actor: 'cody' }])
    expect(d.headers.authorization).toBe(`Bearer ${RECIPE_TOKEN}`)
    // It must NOT rely on the agent "dragging" the card (a headless agent can't).
    expect(out).not.toContain('húzd "done"-ra')
  })

  // Without an actor the board cannot tell a self-pickup from an assignment, so
  // every move curl the agent is handed names the agent as the mover -- including
  // the in_progress self-pickup, which is the one the dispatcher used to echo back.
  it('names the agent as the actor on every move it is told to make', async () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    for (const status of ['done', 'in_progress', 'waiting']) {
      expect((await runRecipeLine(recipeLine(out, 'kanban-move', 'abc123', status))).body).toMatchObject({ status, actor: 'cody' })
    }
    expect((await runRecipeLine(recipeLine(out, 'kanban-move', 'abc123', 'waiting'))).body).toMatchObject({ expected_status: 'in_progress' })
  })

  // The hand-back: a sub-agent's card goes to the main agent, the main agent's to the owner (a name like "Szabolcs").
  it('hands the card back with kanban-assign: a PUT of the assignee, the agent as the actor', async () => {
    const sub = await runRecipeLine(recipeLine(kanbanMoveInstructions('abc123', 'cody'), 'kanban-assign', 'abc123', MAIN_AGENT_ID))
    expect([sub.method, sub.url, sub.body]).toEqual(['PUT', '/api/kanban/abc123', { assignee: MAIN_AGENT_ID, actor: 'cody' }])
    const main = await runRecipeLine(recipeLine(kanbanMoveInstructions('abc123', MAIN_AGENT_ID), 'kanban-assign', 'abc123', OWNER_NAME))
    expect(main.body).toEqual({ assignee: OWNER_NAME, actor: MAIN_AGENT_ID })
  })

  // VOICETOKENLEAK1101 round 2 (#2080 review 5727304277): no command in the message carries the token, not even
  // a $(cat ...) that would put its VALUE on the argv at run time: the helper reads it itself.
  it('carries no token and no token read: no $(cat, no .dashboard-token, no Authorization in the text', async () => {
    for (const target of ['cody', MAIN_AGENT_ID]) {
      const out = kanbanMoveInstructions('abc123', target)
      expect(out).not.toContain('$(cat')
      expect(out).not.toContain('.dashboard-token')
      expect(out).not.toContain('Authorization')
      expect(out).not.toContain('curl ')
    }
    const line = recipeLine(kanbanMoveInstructions('abc123', 'cody'), 'kanban-move', 'abc123', 'done')
    expect((await runRecipeLine(line)).argv.join(' ')).not.toContain(RECIPE_TOKEN)
  })

  // The dispatch fires once, when the card enters in_progress, and is correct at
  // that moment -- but the message rides the normal inter-agent queue and a busy
  // session may read it a round later, after the work is already done. The guard
  // cannot live at dispatch time (the card is not `testing` yet when the message
  // is written), so it has to be IN the message. These assert it is there, that it
  // is actionable, and that it is read BEFORE the work rather than after it.
  it('tells the reader to re-check the card status before starting', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('MIELŐTT NEKIKEZDESZ')
    expect(out).toContain('testing')
    expect(out).toContain('NE kezdj bele')
  })

  it('hands over the status check as a runnable command, not as an instruction to compose', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const probe = probeLine(out)
    expect(probe).toBeDefined()
    // The board comes through the helper, which reads the token itself.
    expect(probe!.trim().startsWith('bash ')).toBe(true)
    expect(probe).not.toContain('$(cat')
  })

  // Text assertions cannot tell a working command from a plausible-looking one,
  // and this line's whole value is that the reader can paste it. So run the
  // program it emits: once against a board (the answer must be THIS card's status
  // AND description, not a neighbour's) and once against the error object the
  // endpoint returns when the token cannot be read -- the shape that made the
  // first draft die on a Python TypeError, which is the one answer a pre-flight
  // check must never give.
  const runProbeProgram = (out: string, stdin: string): string => {
    const probe = probeLine(out)!
    const program = probe.slice(probe.indexOf('python3 -c "') + 'python3 -c "'.length).replace(/"\s*$/, '')
    return execFileSync('python3', ['-c', program], { input: stdin, encoding: 'utf-8' }).trim()
  }

  // 2026-09-15, 7ed56208: an agent that ran exactly this probe never saw a
  // card-specific closing-status override, because the probe printed only the
  // status field -- the override lived one field over, in description, which
  // the probe never fetched. The probe now prints both.
  it('the emitted program reports THIS card status and description, and survives an error response', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const board = JSON.stringify([
      { id: 'zzz999', status: 'in_progress', description: 'neighbour, must not leak' },
      { id: 'abc123', status: 'testing', description: 'zaro-statusz: review, nem done' },
    ])
    expect(runProbeProgram(out, board)).toBe('status: testing\ndescription: zaro-statusz: review, nem done')
    expect(runProbeProgram(out, JSON.stringify([{ id: 'zzz999', status: 'done' }]))).toBe('nincs ilyen kartya')
    const noDesc = runProbeProgram(out, JSON.stringify([{ id: 'abc123', status: 'planned', description: null }]))
    expect(noDesc).toBe('status: planned\ndescription: (nincs)')
    const err = runProbeProgram(out, JSON.stringify({ error: 'Unauthorized' }))
    expect(err).toContain('Unauthorized')
    expect(err).not.toContain('Traceback')
    // The helper's failure: its FAIL line goes to stderr and stdout stays empty. Still an answer, never a traceback.
    const none = runProbeProgram(out, '')
    expect(none).toContain('ismeretlen -- a kartya-lista nem jott meg')
    expect(none).not.toContain('Traceback')
  })

  it('puts the warning BEFORE the completion steps -- it is a pre-flight check', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out.indexOf('MIELŐTT NEKIKEZDESZ')).toBeLessThan(out.indexOf('Amikor VÉGEZTÉL'))
    // And it is the first thing in the block, not buried mid-message.
    expect(out.startsWith('MIELŐTT NEKIKEZDESZ')).toBe(true)
  })


  // The template closes every card with `done`, but a board program can give a
  // card its OWN closing status -- for example a review status, so the delegator
  // checks the work before the card closes. Without a stated ranking the two
  // rules collide on every such card: the agent either burns a round deciding
  // which to follow, or silently follows the template and the work closes
  // unreviewed. The fix is one sentence, not a global swap: for every other
  // program `done` IS the right close, so the template keeps it as the default
  // and only names the card as the stronger rule when the card says otherwise.
  it('says the card own closing status outranks the template default', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('a kártya program-specifikus szabálya erősebb')
    expect(out).toContain('záró-státuszt ír elő')
    // `testing` is named as the concrete case, so the reader does not have to
    // recognise the abstraction in the middle of a task.
    expect(out).toContain('testing')
    // ...and `done` stays the default: the sentence is an exception, not a swap.
    expect(out).toContain('kanban-move abc123 done --actor cody')
    expect(out).toContain('a "done" az alapértelmezés')
  })

  // Placement is part of the fix: the ranking has to be read WITH step 2 (the
  // done curl it modifies), not after the escalation block where a reader who
  // already ran the curl would meet it too late.
  it('puts the ranking sentence with step 2, before the escalation block', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const step2 = out.indexOf('2) Állítsd a kártyát done-ra')
    const ranking = out.indexOf('a kártya program-specifikus szabálya erősebb')
    const escalation = out.indexOf('Ha elakadtál')
    expect(step2).toBeGreaterThan(-1)
    expect(escalation).toBeGreaterThan(-1)
    expect(ranking).toBeGreaterThan(step2)
    expect(ranking).toBeLessThan(escalation)
  })

  // Dani 64894 (2): only an id the helper takes is dispatched, so a recipe step never fails on the id, and a '..' never
  // reaches a path. (3): the main agent's payload files land in the project root, where git must ignore them.
  it('dispatches only the helper\'s card-id shape: no dot, at most 64 characters', () => {
    for (const ok of ['abc123', 'A_b-9', 'x'.repeat(64)]) expect(DISPATCH_SAFE_CARD_ID_RE.test(ok), ok).toBe(true)
    for (const bad of ['a.b', '..', 'x'.repeat(65), 'a b', 'a/b', '']) expect(DISPATCH_SAFE_CARD_ID_RE.test(bad), bad).toBe(false)
  })

  it("the main agent's payload files are ignored by git", () => {
    for (const f of ['kanban-abc123-eredmeny.txt', 'kanban-abc123-bizonyitek.txt', 'kanban-abc123-kerdes.txt']) {
      const r = git('git', ['-C', PROJECT_ROOT, 'check-ignore', '-q', join(PROJECT_ROOT, f)], { stdio: 'pipe' })
      expect(r).toBeDefined() // check-ignore exits 0 only when ignored (a non-zero exit throws)
    }
  })
})
