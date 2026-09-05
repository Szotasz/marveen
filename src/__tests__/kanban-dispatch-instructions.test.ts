import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { kanbanMoveInstructions } from '../web/routes/kanban.js'

// The one line of the dispatch that is a COMMAND rather than prose.
const probeLine = (out: string): string | undefined =>
  out.split('\n').find((l) => l.includes('/api/kanban |'))

// A card dispatched to an agent used to just say "drag it to done" -- but a
// headless agent cannot drag, and the run left no record on the card. The
// instructions now give the agent the exact curl to post a result summary and
// to mark the card done, so the dispatched task's RESULT lands on its own card
// (visible in the dashboard UI) -- the lightweight alternative to per-session
// cards.
describe('kanbanMoveInstructions', () => {
  it('gives the agent the curl to post a result comment AND to mark done', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // Step 1: a human-readable result comment lands on the card.
    expect(out).toContain('/api/kanban/abc123/comments')
    expect(out).toContain('"author":"cody"')
    // Step 2: mark the card done.
    expect(out).toContain('/api/kanban/abc123/move')
    expect(out).toContain('"status":"done"')
    // It must NOT rely on the agent "dragging" the card (a headless agent can't).
    expect(out).not.toContain('húzd "done"-ra')
  })

  // Without an actor the board cannot tell a self-pickup from an assignment, so
  // every move curl the agent is handed names the agent as the mover -- including
  // the in_progress self-pickup, which is the one the dispatcher used to echo back.
  it('names the agent as the actor on every move it is told to make', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('"status":"done","actor":"cody"')
    expect(out).toContain('"status":"in_progress","actor":"cody"')
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
    // Same token discipline as every other command in the message: read at run
    // time, never embedded.
    expect(probe).toContain('$(cat ')
    expect(probe).toContain('.dashboard-token')
  })

  // Text assertions cannot tell a working command from a plausible-looking one,
  // and this line's whole value is that the reader can paste it. So run the
  // program it emits: once against a board (the answer must be THIS card's status,
  // not a neighbour's) and once against the error object the endpoint returns when
  // the token cannot be read -- the shape that made the first draft die on a
  // Python TypeError, which is the one answer a pre-flight check must never give.
  const runProbeProgram = (out: string, stdin: string): string => {
    const probe = probeLine(out)!
    const program = probe.slice(probe.indexOf('python3 -c "') + 'python3 -c "'.length).replace(/"\s*$/, '')
    return execFileSync('python3', ['-c', program], { input: stdin, encoding: 'utf-8' }).trim()
  }

  it('the emitted program reports THIS card status and survives an error response', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const board = JSON.stringify([
      { id: 'zzz999', status: 'in_progress' },
      { id: 'abc123', status: 'testing' },
    ])
    expect(runProbeProgram(out, board)).toBe('testing')
    expect(runProbeProgram(out, JSON.stringify([{ id: 'zzz999', status: 'done' }]))).toBe('nincs ilyen kartya')
    const err = runProbeProgram(out, JSON.stringify({ error: 'Unauthorized' }))
    expect(err).toContain('Unauthorized')
    expect(err).not.toContain('Traceback')
  })

  it('puts the warning BEFORE the completion steps -- it is a pre-flight check', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out.indexOf('MIELŐTT NEKIKEZDESZ')).toBeLessThan(out.indexOf('Amikor VÉGEZTÉL'))
    // And it is the first thing in the block, not buried mid-message.
    expect(out.startsWith('MIELŐTT NEKIKEZDESZ')).toBe(true)
  })

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
  })
})
