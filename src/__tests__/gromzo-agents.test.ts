// GROMZOAGENTPICK1101: the rules of the owner's Gromzo agent switch (src/web/gromzo-agents.ts), against a fake
// dash.sock call. Never the real socket: agent_add asks the owner in the live app, agent_add_check spends an
// install_proof challenge.
import { describe, it, expect, beforeEach } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import {
  CHECK_GAP_MS, checkGromzoAgent, disableGromzoAgent, enableGromzoAgent, listGromzoAgents, resetPendingGromzoConsents,
  sendGromzoAvatar, slugRefusal, type GromzoAgentDeps,
} from '../web/gromzo-agents.js'
import type { MxdDashReply, MxdDashRequest } from '../web/mxd-dash.js'

const ID_A = 'consent-aaaaaaaaaaaa'
const ID_B = 'consent-bbbbbbbbbbbb'

interface World {
  deps: GromzoAgentDeps
  calls: MxdDashRequest[]
  flags: Map<string, boolean>
  writes: Array<[string, boolean]>
  restarted: string[]
  /** The next replies, by verb (shifted per call); a function throws or answers from the request. */
  replies: Record<string, Array<MxdDashReply | ((r: MxdDashRequest) => MxdDashReply)>>
  clock: { t: number }
  heldSet: Set<string>
  avatars: Map<string, Buffer>
}

function world(agents = ['abel', 'samu', 'zara']): World {
  const w: World = {
    calls: [], flags: new Map(), writes: [], restarted: [], replies: {}, clock: { t: 1_000_000 }, heldSet: new Set(), avatars: new Map(),
    deps: undefined as never,
  }
  w.deps = {
    call: async (req) => {
      w.calls.push(req)
      const next = w.replies[req.verb]?.shift()
      if (next === undefined) throw new Error(`unscripted ${req.verb}`)
      return typeof next === 'function' ? next(req) : next
    },
    agents: () => [...agents],
    readFlag: (s) => w.flags.get(s) ?? false,
    writeFlag: (s, on) => { w.writes.push([s, on]); w.flags.set(s, on) },
    displayName: (s) => s[0]!.toUpperCase() + s.slice(1),
    isRunning: () => true,
    held: async () => new Set(w.heldSet),
    readAvatar: (s) => (w.avatars.has(s) ? { ok: true, bytes: w.avatars.get(s)! } : { ok: false, code: 'no_avatar' }),
    avatarProblem: (s) => (w.avatars.has(s) ? null : 'no_avatar'),
    restartOne: (s) => { w.restarted.push(s) },
    now: () => w.clock.t,
  }
  return w
}

const addOk = (id = ID_A, exp = 600): MxdDashReply => ({ ok: true, consent_id: id, expires_in: exp })
const added = (slug: string): MxdDashReply => ({ ok: true, state: 'added', slug, restart: true })
const later = (w: World, ms = CHECK_GAP_MS) => { w.clock.t += ms }

beforeEach(() => resetPendingGromzoConsents())

describe('a slug is checked before any mxd call', () => {
  for (const [slug, code] of [
    ['Abel', 'bad_request'], ['../samu', 'bad_request'], ['', 'bad_request'], ['a'.repeat(33), 'bad_request'],
    [MAIN_AGENT_ID, 'main_agent'], ['nobody', 'unknown_agent'],
  ] as const) {
    it(`"${slug.slice(0, 12)}" -> ${code}, enable / check / disable make no call`, async () => {
      const w = world()
      for (const f of [enableGromzoAgent, checkGromzoAgent, disableGromzoAgent]) {
        expect(await f(slug, w.deps)).toEqual({ ok: false, code })
      }
      expect(w.calls).toEqual([])
      expect(w.writes).toEqual([])
      expect(w.restarted).toEqual([])
    })
  }

  it('slugRefusal passes a fleet member', () => {
    expect(slugRefusal('zara', world().deps)).toBeNull()
  })
})

describe('enable: the owner approves in the app first, the flag only after mxd added the agent', () => {
  it('agent_add carries the slug and the display name, nothing is written, the consent is pending', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'pending', expiresIn: 600 })
    expect(w.calls).toEqual([{ verb: 'agent_add', slug: 'zara', name: 'Zara' }])
    expect(w.writes).toEqual([])
    expect(w.restarted).toEqual([])
    expect((await listGromzoAgents(w.deps)).find((r) => r.slug === 'zara')?.pendingUntil).toBe(w.clock.t + 600_000)
  })

  it('a second enable while pending asks mxd nothing (one consent per slug)', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    later(w, 60_000)
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'pending', expiresIn: 540 })
    expect(w.calls).toHaveLength(1)
  })

  it('an agent already on: no call', async () => {
    const w = world()
    w.flags.set('zara', true)
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'on' })
    expect(w.calls).toEqual([])
  })

  it('mxd refuses (rate_limited / too_many_agents): the code, no pending consent', async () => {
    const w = world()
    w.replies.agent_add = [{ ok: false, error: 'too_many_agents' }]
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'too_many_agents' })
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
  })

  it('a malformed agent_add reply is bad_reply and keeps nothing', async () => {
    const w = world()
    w.replies.agent_add = [{ ok: true, consent_id: 'x y', expires_in: 600 }]
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'bad_reply' })
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
  })
})

describe('the consent id is the server\'s, bound to its slug (Dani 64126)', () => {
  it('check sends the id asked for THIS slug; approved -> flag on and only this agent restarted', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A), addOk(ID_B)]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'refused' }, added('samu')]
    await checkGromzoAgent('zara', w.deps)
    await enableGromzoAgent('samu', w.deps)
    later(w)
    expect(await checkGromzoAgent('samu', w.deps)).toEqual({ ok: true, state: 'added' })
    expect(w.calls.at(-1)).toEqual({ verb: 'agent_add_check', id: ID_B })
    expect(w.writes).toEqual([['samu', true]])
    expect(w.restarted).toEqual(['samu'])
  })

  it('an "added" naming another slug writes nothing and restarts nothing: consent_mismatch', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A)]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [added('samu')]
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'consent_mismatch', added: 'samu' })
    expect(w.writes).toEqual([])
    expect(w.restarted).toEqual([])
    expect(w.flags.get('samu')).toBeUndefined()
  })

  it('A approved never switches on B: B has no consent of its own, so its check asks nothing', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A)]
    await enableGromzoAgent('zara', w.deps)
    expect(await checkGromzoAgent('samu', w.deps)).toEqual({ ok: false, code: 'no_pending' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toEqual([])
    expect(w.writes).toEqual([])
  })

  it('refused / expired / used: the consent is dropped, no flag, no restart', async () => {
    for (const state of ['refused', 'expired', 'used'] as const) {
      resetPendingGromzoConsents()
      const w = world()
      w.replies.agent_add = [addOk()]
      await enableGromzoAgent('zara', w.deps)
      w.replies.agent_add_check = [{ ok: true, state }]
      expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state })
      expect(w.writes).toEqual([])
      expect(w.restarted).toEqual([])
      expect((await listGromzoAgents(w.deps)).find((r) => r.slug === 'zara')?.pendingUntil).toBeNull()
    }
  })

  it('a lapsed consent is forgotten without asking mxd', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A, 60)]
    await enableGromzoAgent('zara', w.deps)
    later(w, 60_000)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toEqual([])
  })
})

describe('agent_add_check pacing (mxd MIN_ADD_CHECK_S, one clock for every slug)', () => {
  it('pending -> a check within the gap answers pending without a call; after the gap it asks again', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'pending' }, added('zara')]
    expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    later(w, CHECK_GAP_MS - 1)
    expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toHaveLength(1)
    later(w, 1)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'added' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toHaveLength(2)
  })

  it('the gap is shared across slugs', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A), addOk(ID_B)]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'refused' }]
    await checkGromzoAgent('zara', w.deps)
    await enableGromzoAgent('samu', w.deps)
    expect(await checkGromzoAgent('samu', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toHaveLength(1)
  })

  it('mxd too_soon is still pending, the consent kept', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: false, error: 'too_soon' }, added('zara')]
    expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    later(w)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'added' })
  })

  it('a transport failure or rate_limited keeps the consent: the next check asks again', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [() => { throw new Error('ECONNREFUSED') }, { ok: false, error: 'rate_limited' }, added('zara')]
    await expect(checkGromzoAgent('zara', w.deps)).rejects.toThrow('ECONNREFUSED')
    later(w)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'rate_limited' })
    later(w)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'added' })
    expect(w.writes).toEqual([['zara', true]])
  })
})

describe('disable', () => {
  it('agent_remove ok: the flag goes, only this agent restarted', async () => {
    const w = world()
    w.flags.set('zara', true); w.flags.set('samu', true)
    w.replies.agent_remove = [{ ok: true, restart: true }]
    expect(await disableGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'removed' })
    expect(w.calls).toEqual([{ verb: 'agent_remove', slug: 'zara' }])
    expect(w.writes).toEqual([['zara', false]])
    expect(w.restarted).toEqual(['zara'])
    expect(w.flags.get('samu')).toBe(true)
  })

  it('unknown_agent: mxd does not list it, the flag follows (off)', async () => {
    const w = world()
    w.flags.set('zara', true)
    w.replies.agent_remove = [{ ok: false, error: 'unknown_agent' }]
    expect(await disableGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'removed' })
    expect(w.writes).toEqual([['zara', false]])
  })

  it('a refused remove keeps the flag and restarts nothing (Samu 64119 (c))', async () => {
    const w = world()
    w.flags.set('zara', true)
    w.replies.agent_remove = [{ ok: false, error: 'rate_limited' }]
    expect(await disableGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'rate_limited' })
    expect(w.writes).toEqual([])
    expect(w.restarted).toEqual([])
    expect(w.flags.get('zara')).toBe(true)
  })

  it('disable drops a pending consent', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_remove = [{ ok: false, error: 'unknown_agent' }]
    await disableGromzoAgent('zara', w.deps)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
  })
})

describe('the list', () => {
  it('the rows are built inside ONE batch (the route: withTmuxBatch, one tmux call per server), run state included', async () => {
    const w = world()
    let inBatch = false
    let batches = 0
    const runs: boolean[] = []
    w.deps.batch = <T>(fn: () => T): T => { batches++; inBatch = true; try { return fn() } finally { inBatch = false } }
    w.deps.isRunning = () => { runs.push(inBatch); return true }
    await listGromzoAgents(w.deps)
    expect(batches).toBe(1)
    expect(runs.length).toBe(4)
    expect(runs.every(Boolean)).toBe(true)
  })

  it('the main agent first, always on and never switchable; then the fleet sorted, with flags', async () => {
    const w = world(['zara', 'abel', MAIN_AGENT_ID])
    w.flags.set('zara', true)
    const rows = await listGromzoAgents(w.deps)
    expect(rows.map((r) => [r.slug, r.main, r.gromzo])).toEqual([[MAIN_AGENT_ID, true, true], ['abel', false, false], ['zara', false, true]])
  })
})

describe('one pending add at a time; a held agent may be asked again (Ábel 64168)', () => {
  it('a second slug while one is pending: add_in_progress, no call', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A)]
    await enableGromzoAgent('zara', w.deps)
    expect(await enableGromzoAgent('samu', w.deps)).toEqual({ ok: false, code: 'add_in_progress' })
    expect(w.calls.filter((c) => c.verb === 'agent_add')).toHaveLength(1)
  })

  it('once the first lapsed, the second may go', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A, 60), addOk(ID_B)]
    await enableGromzoAgent('zara', w.deps)
    later(w, 60_000)
    expect(await enableGromzoAgent('samu', w.deps)).toMatchObject({ ok: true, state: 'pending' })
  })

  it('flag on but held: enable asks mxd again; flag on and not held: no call', async () => {
    const w = world()
    w.flags.set('zara', true)
    w.heldSet.add('zara')
    w.replies.agent_add = [addOk()]
    expect(await enableGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    expect(w.calls).toEqual([{ verb: 'agent_add', slug: 'zara', name: 'Zara' }])
    w.flags.set('samu', true)
    expect(await enableGromzoAgent('samu', w.deps)).toEqual({ ok: true, state: 'on' })
    expect(w.calls).toHaveLength(1)
  })

  it('the list marks held agents', async () => {
    const w = world()
    w.flags.set('zara', true)
    w.heldSet.add('zara')
    const rows = await listGromzoAgents(w.deps)
    expect(rows.filter((r) => r.held).map((r) => r.slug)).toEqual(['zara'])
  })
})

describe('the agent picture (Samu 64526)', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)])

  it('sends the bytes as base64 with the slug; the answer says whether mxd applied it now', async () => {
    const w = world()
    w.avatars.set('zara', PNG)
    w.replies.agent_avatar = [{ ok: true, applied: true }]
    expect(await sendGromzoAvatar('zara', w.deps)).toEqual({ ok: true, state: 'avatar_sent', applied: true, pending: false, bytes: PNG.length })
    expect(w.calls).toEqual([{ verb: 'agent_avatar', slug: 'zara', image: PNG.toString('base64') }])
  })

  it('MXDAVATARAPPLY1101: pending is true only for applied=false with pending exactly true', async () => {
    const w = world()
    w.avatars.set('zara', PNG)
    w.replies.agent_avatar = [
      { ok: true, applied: false, pending: true },
      { ok: true, applied: false },
      { ok: true, applied: false, pending: 1 },
      { ok: true, applied: true, pending: true },
    ]
    const got = []
    for (let i = 0; i < 4; i++) {
      const o = await sendGromzoAvatar('zara', w.deps)
      got.push(o.ok && o.state === 'avatar_sent' ? [o.applied, o.pending] : null)
    }
    expect(got).toEqual([[false, true], [false, false], [false, false], [true, false]])
  })

  it('a refused slug reads no file and asks mxd nothing', async () => {
    const w = world()
    let reads = 0
    w.deps.readAvatar = () => { reads++; return { ok: true, bytes: PNG } }
    for (const slug of ['../x', MAIN_AGENT_ID, 'nobody']) expect((await sendGromzoAvatar(slug, w.deps)).ok).toBe(false)
    expect(reads).toBe(0)
    expect(w.calls).toEqual([])
  })

  it('a picture that cannot go (missing, too large, wrong format) is that code, and mxd is not asked', async () => {
    const w = world()
    w.deps.readAvatar = () => ({ ok: false, code: 'avatar_too_large' })
    expect(await sendGromzoAvatar('zara', w.deps)).toEqual({ ok: false, code: 'avatar_too_large' })
    expect(w.calls).toEqual([])
  })

  it('mxd refusing (rate_limited, bad_image) is passed on', async () => {
    const w = world()
    w.avatars.set('zara', PNG)
    w.replies.agent_avatar = [{ ok: false, error: 'rate_limited' }]
    expect(await sendGromzoAvatar('zara', w.deps)).toEqual({ ok: false, code: 'rate_limited' })
  })

  it('the list says per agent what would stop its picture; the main agent never', async () => {
    const w = world()
    w.avatars.set('zara', PNG)
    const rows = await listGromzoAgents(w.deps)
    expect(rows.map((r) => [r.slug, r.avatarProblem])).toEqual([[MAIN_AGENT_ID, null], ['abel', 'no_avatar'], ['samu', 'no_avatar'], ['zara', null]])
  })
})
