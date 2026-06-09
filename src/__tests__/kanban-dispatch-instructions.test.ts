import { describe, expect, it } from 'vitest'
import { kanbanMoveInstructions } from '../web/routes/kanban.js'

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

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
  })
})
