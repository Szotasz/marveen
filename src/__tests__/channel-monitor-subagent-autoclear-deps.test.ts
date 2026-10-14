import { describe, it, expect, vi } from 'vitest'

// #1943 review, point 3: the DEFAULT deps of the Q045 auto-clear. The other
// suite drives autoclearStuckSubAgent with injected deps, so these choices were
// held by nothing: a 'deliver'-mode lock (waits for, then fails open past, a
// live delivery instead of skipping) or a fail-open attach probe passed it.

const lockCalls: Array<{ session: string; mode: unknown }> = []
vi.mock('../web/session-send-lock.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/session-send-lock.js')>()
  return {
    ...orig,
    withSessionSendLock: vi.fn(async (session: string, _host: unknown, mode: unknown, fn: () => Promise<void>) => {
      lockCalls.push({ session, mode })
      await fn()
      return { ran: true }
    }),
  }
})

const { defaultAutoclearDeps, tmuxSessionAttached } = await import('../web/channel-monitor.js')

describe('defaultAutoclearDeps', () => {
  it('takes the per-pane send lane in recover mode: skip a live delivery, never wait it out', async () => {
    let ran = false
    await defaultAutoclearDeps.withLock('agent-zz-autoclear-deps', async () => { ran = true })
    expect(ran).toBe(true)
    expect(lockCalls).toEqual([{ session: 'agent-zz-autoclear-deps', mode: 'recover' }])
  })

  // A session that cannot exist, through the real deps. Measured 2026-10-14:
  // depending on the host, tmux either errors or answers rc 0 with an empty
  // line -- both must read as "unmeasurable" (null), never "nobody attached".
  it('probes attachment fail-closed: a session that cannot exist is null, not false', () => {
    expect(defaultAutoclearDeps.isAttached('agent-zz-no-such-session-q045')).toBeNull()
  })
})

describe('tmuxSessionAttached', () => {
  // Unmeasurable must read as null -- which the guard counts as attached --
  // never as false ("nobody is typing"). Each failure shape pinned separately.
  it('tmux erroring is null, not false', () => {
    expect(tmuxSessionAttached('agent-x', () => { throw new Error("can't find session") })).toBeNull()
  })
  it('an answer without a number is null', () => {
    expect(tmuxSessionAttached('agent-x', () => '\n')).toBeNull()
  })
  it('reads the count: 0 is not attached, any client is attached', () => {
    expect(tmuxSessionAttached('agent-x', () => '0\n')).toBe(false)
    expect(tmuxSessionAttached('agent-x', () => '2\n')).toBe(true)
  })
  // The exact `=NAME:` target itself is held by tmux-exact-target.test.ts's
  // source pin, which covers every tmux -t under src/.
})
