// GROMZOAGENTPICK1101: the rules of the owner's Gromzo agent switch (src/web/gromzo-agents.ts), against a fake
// dash.sock call. Never the real socket: agent_add asks the owner in the live app, agent_add_check spends an
// install_proof challenge.
import { describe, it, expect, beforeEach } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import {
  CHECK_GAP_MS, checkGromzoAgent, disableGromzoAgent, enableGromzoAgent, FAST_CHECK_WINDOW_MS, LAST_RESULT_TTL_MS, listGromzoAgents,
  listGromzoAgentsWithStatus, pendingGromzoConsentSlug, protectionOf, resetPendingGromzoConsents, resetProtectionClockForTest,
  restorePendingGromzoConsents, sendGromzoAvatar, setPendingConsentStore, slugRefusal, SLOW_CHECK_GAP_MS, statusFactsOf,
  UNPROTECTED_AFTER_MS, USED_VERIFY_MS, watcherDelayMs, type GromzoAgentDeps, type MxdProtection, type PendingConsentStore,
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
    ['nobody', 'unknown_agent'],
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

  // GROMZOBRIDGEWIZARD1107 D1: "used" is no longer final at once (it is verified in mxd's status, below).
  it('refused / expired: the consent is dropped, no flag, no restart', async () => {
    for (const state of ['refused', 'expired'] as const) {
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

  // D1: the lapse is a final answer the panel shows ("expired"), no longer a silent no_pending.
  it('a lapsed consent is forgotten without asking mxd, and answers expired', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A, 60)]
    await enableGromzoAgent('zara', w.deps)
    later(w, 60_000)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'expired' })
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

  it('the main agent first, its switch read like any other (GROMZOMAINAGENT1106: no fixed "always on"); then the fleet sorted', async () => {
    const w = world(['zara', 'abel', MAIN_AGENT_ID])
    w.flags.set('zara', true)
    let rows = await listGromzoAgents(w.deps)
    expect(rows.map((r) => [r.slug, r.main, r.gromzo])).toEqual([[MAIN_AGENT_ID, true, false], ['abel', false, false], ['zara', false, true]])
    expect(rows[0]!.mainLaunch).toBe('idle')
    expect(rows[1]!.mainLaunch).toBeNull()
    w.flags.set(MAIN_AGENT_ID, true)
    w.heldSet.add(MAIN_AGENT_ID)
    rows = await listGromzoAgents({ ...w.deps, mainLaunchState: () => 'restart_waiting' })
    expect(rows[0]).toMatchObject({ slug: MAIN_AGENT_ID, gromzo: true, held: true, mainLaunch: 'restart_waiting' })
  })
})

// GROMZOMAINAGENT1106: the main agent joins Gromzo through the same owner consent as every agent.
describe('the main agent (GROMZOMAINAGENT1106)', () => {
  it('switch on asks the owner first; only the added check writes its flag and restarts it', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A)]
    expect(await enableGromzoAgent(MAIN_AGENT_ID, w.deps)).toMatchObject({ ok: true, state: 'pending' })
    expect(w.calls).toEqual([{ verb: 'agent_add', slug: MAIN_AGENT_ID, name: MAIN_AGENT_ID[0]!.toUpperCase() + MAIN_AGENT_ID.slice(1) }])
    expect(w.writes).toEqual([])
    later(w)
    w.replies.agent_add_check = [added(MAIN_AGENT_ID)]
    expect(await checkGromzoAgent(MAIN_AGENT_ID, w.deps)).toEqual({ ok: true, state: 'added' })
    expect(w.writes).toEqual([[MAIN_AGENT_ID, true]])
    expect(w.restarted).toEqual([MAIN_AGENT_ID])
  })

  it('already in mxd (agent_exists): no second consent, the launch side runs again', async () => {
    const w = world()
    w.replies.agent_add = [{ ok: false, error: 'agent_exists' }]
    expect(await enableGromzoAgent(MAIN_AGENT_ID, w.deps)).toEqual({ ok: true, state: 'added' })
    expect(w.writes).toEqual([[MAIN_AGENT_ID, true]])
    expect(w.restarted).toEqual([MAIN_AGENT_ID])
  })

  it('agent_exists with a name the owner typed stays an error: mxd keeps its listed name (Dani 71877)', async () => {
    const w = world()
    w.replies.agent_add = [{ ok: false, error: 'agent_exists' }]
    expect(await enableGromzoAgent(MAIN_AGENT_ID, w.deps, 'Új Név')).toEqual({ ok: false, code: 'agent_exists' })
    expect(w.writes).toEqual([])
    expect(w.restarted).toEqual([])
  })

  it('agent_exists for a SUB-agent stays an error (the shortcut is the main agent\'s only)', async () => {
    const w = world()
    w.replies.agent_add = [{ ok: false, error: 'agent_exists' }]
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'agent_exists' })
    expect(w.writes).toEqual([])
    expect(w.restarted).toEqual([])
  })

  it('switch off takes only the launch side back: no agent_remove, the flag off, a restart', async () => {
    const w = world()
    w.flags.set(MAIN_AGENT_ID, true)
    expect(await disableGromzoAgent(MAIN_AGENT_ID, w.deps)).toEqual({ ok: true, state: 'removed' })
    expect(w.calls).toEqual([])
    expect(w.writes).toEqual([[MAIN_AGENT_ID, false]])
    expect(w.restarted).toEqual([MAIN_AGENT_ID])
  })

  it('its picture is still not sent (main_agent), no call', async () => {
    const w = world()
    w.avatars.set(MAIN_AGENT_ID, Buffer.from('x'))
    expect(await sendGromzoAvatar(MAIN_AGENT_ID, w.deps)).toEqual({ ok: false, code: 'main_agent' })
    expect(w.calls).toEqual([])
  })

  it('its pending consent shows on its row, and blocks a second add like any other', async () => {
    const w = world()
    w.replies.agent_add = [addOk(ID_A, 300)]
    await enableGromzoAgent(MAIN_AGENT_ID, w.deps)
    const rows = await listGromzoAgents(w.deps)
    expect(rows[0]!.pendingUntil).toBe(w.clock.t + 300_000)
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'add_in_progress' })
  })
})

// GROMZONAMETAKEN1106: the controller refuses a name another member of the team wears (name_taken), so the owner
// may send another name with the switch; the main agent goes by its configured bot name (the owner, Samu 71820).
describe('the name on Gromzo (GROMZONAMETAKEN1106)', () => {
  it('the main agent goes by the name the route gives it (the configured bot name), not by its slug', async () => {
    const w = world()
    w.deps.gromzoName = (s) => (s === MAIN_AGENT_ID ? 'Marvin' : s.toUpperCase())
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent(MAIN_AGENT_ID, w.deps)
    expect(w.calls).toEqual([{ verb: 'agent_add', slug: MAIN_AGENT_ID, name: 'Marvin' }])
  })

  it('the row carries the name the switch would send', async () => {
    const w = world()
    const rows = await listGromzoAgents(w.deps)
    expect(rows.find((r) => r.slug === MAIN_AGENT_ID)!.gromzoName).toBe(MAIN_AGENT_ID[0]!.toUpperCase() + MAIN_AGENT_ID.slice(1))
    expect(rows.find((r) => r.slug === 'zara')!.gromzoName).toBe('Zara')
    const named = await listGromzoAgents({ ...w.deps, gromzoName: (s) => `${s}-x` })
    expect(named.find((r) => r.slug === 'zara')!.gromzoName).toBe('zara-x')
  })

  it('the owner\'s name goes to agent_add as given (trimmed)', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    expect(await enableGromzoAgent('zara', w.deps, '  Zara Segéd ')).toMatchObject({ ok: true, state: 'pending' })
    expect(w.calls).toEqual([{ verb: 'agent_add', slug: 'zara', name: 'Zara Segéd' }])
  })

  it('a name outside the controller\'s rule: bad_display_name, no mxd call, nothing pending', async () => {
    for (const bad of ['', '   ', '-Zara', 'Za/ra', 'x'.repeat(65), 'a\nb']) {
      const w = world()
      expect(await enableGromzoAgent('zara', w.deps, bad)).toEqual({ ok: false, code: 'bad_display_name' })
      expect(w.calls).toEqual([])
      expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
    }
  })

  it('name_taken from mxd comes back as the code, nothing pending, so the owner can retry with another name', async () => {
    const w = world()
    w.replies.agent_add = [{ ok: false, error: 'name_taken' }, addOk()]
    expect(await enableGromzoAgent(MAIN_AGENT_ID, w.deps)).toEqual({ ok: false, code: 'name_taken' })
    expect(await enableGromzoAgent(MAIN_AGENT_ID, w.deps, 'Főnök Marveen')).toMatchObject({ ok: true, state: 'pending' })
    expect(w.calls.map((c) => (c as { name?: string }).name)).toEqual([MAIN_AGENT_ID[0]!.toUpperCase() + MAIN_AGENT_ID.slice(1), 'Főnök Marveen'])
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


// MXDAGENTSOCKID1106: the agents' agent.sock protection on the list (Samu 71321, 71344 (1), 71418).
describe('the token protection on the list', () => {
  const P = (o: Partial<MxdProtection> = {}): MxdProtection => ({ protected: new Set(), refused: new Set(), running: new Set(), ratchetUnreadable: false, ...o })
  beforeEach(() => resetProtectionClockForTest())

  it('refused wins; protected; unprotected only after 10 minutes running without a token; nothing when off or unknown', () => {
    const t0 = 5_000_000
    expect(protectionOf('samu', true, P({ refused: new Set(['samu']), protected: new Set(['samu']) }), t0)).toBe('refused')
    expect(protectionOf('samu', true, P({ protected: new Set(['samu']) }), t0)).toBe('protected')
    expect(protectionOf('samu', false, P({ refused: new Set(['samu']) }), t0), 'Gromzo off: nothing').toBeNull()
    expect(protectionOf('samu', true, null, t0), 'an older mxd: nothing').toBeNull()
    const run = P({ running: new Set(['zara']) })
    expect(protectionOf('zara', true, run, t0), 'first seen running').toBeNull()
    expect(protectionOf('zara', true, run, t0 + UNPROTECTED_AFTER_MS - 1)).toBeNull()
    expect(protectionOf('zara', true, run, t0 + UNPROTECTED_AFTER_MS)).toBe('unprotected')
    // Not running any more resets the clock; protected resets it too.
    expect(protectionOf('zara', true, P({ running: new Set() }), t0 + UNPROTECTED_AFTER_MS + 1)).toBeNull()
    expect(protectionOf('zara', true, run, t0 + 2 * UNPROTECTED_AFTER_MS), 'seen again: a new 10 minutes').toBeNull()
    // While mxd's agents are still starting (running null), no clock runs.
    expect(protectionOf('abel', true, P({ running: null }), t0)).toBeNull()
  })

  it('an unreadable ratchet: every agent counts as protected, and the list says so', async () => {
    expect(protectionOf('zara', true, P({ ratchetUnreadable: true, running: new Set(['zara']) }), 1)).toBe('protected')
    const w = world()
    w.flags.set('samu', true)
    w.deps.statusFacts = async () => ({ held: new Set(), protection: P({ ratchetUnreadable: true, running: new Set(['samu']) }) })
    const r = await listGromzoAgentsWithStatus(w.deps)
    expect(r.ratchetUnreadable).toBe(true)
    expect(r.agents.find((x) => x.slug === 'samu')!.protection).toBe('protected')
  })

  it('statusFacts replaces held: one status answer gives both, and only slugs pass', async () => {
    const f = statusFactsOf({ ok: true, held_agents: ['zara', '../x', 7], agents: { running: ['samu', 'zara', 'Bad'], held: ['zara'], protected: ['samu'], refused: ['abel', '$x'] }, ratchet_unreadable: false })
    expect([...f.held]).toEqual(['zara'])
    expect(f.protection).toEqual({ protected: new Set(['samu']), refused: new Set(['abel']), running: new Set(['samu', 'zara']), ratchetUnreadable: false })
    expect(statusFactsOf({ ok: true, agents: { running: [], held: [] } }).protection, 'an mxd before the tokens').toBeNull()
    const w = world()
    for (const s of ['samu', 'abel']) w.flags.set(s, true)
    let heldCalls = 0
    w.deps.held = async () => { heldCalls++; return new Set() }
    w.deps.statusFacts = async () => f
    const r = await listGromzoAgentsWithStatus(w.deps)
    expect(heldCalls, 'the list asks mxd once').toBe(0)
    expect(r.agents.find((x) => x.slug === 'samu')!.protection).toBe('protected')
    expect(r.agents.find((x) => x.slug === 'abel')!.protection).toBe('refused')
    expect(r.agents.find((x) => x.slug === 'zara')!).toMatchObject({ held: true, protection: null })
    expect(r.ratchetUnreadable).toBe(false)
    expect(await listGromzoAgents(w.deps)).toEqual(r.agents)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// GROMZOBRIDGEWIZARD1107 D1 (Samu 72469 (2), 72485): the server sees an approval through without the panel.
// ---------------------------------------------------------------------------------------------------------------
function memStore(initial: unknown = []): PendingConsentStore & { saved: unknown[] } {
  const st = { data: initial as unknown, saved: [] as unknown[] }
  return {
    saved: st.saved,
    read: () => st.data,
    write: (entries) => { st.data = entries; st.saved.push(JSON.parse(JSON.stringify(entries))) },
  }
}
const running = (slugs: string[], held: string[] = []) => async () => ({
  held: new Set(held),
  protection: { protected: new Set<string>(), refused: new Set<string>(), running: new Set(slugs), ratchetUnreadable: false },
})

describe('D1: the final answer is kept for the panel; a new switch clears it', () => {
  it('refused, read by one caller (the watcher), is what the next check answers (the panel); later no_pending', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'refused' }]
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'refused' })
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'refused' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toHaveLength(1)
    later(w, LAST_RESULT_TTL_MS)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
  })
  it('added once: the flag is on, so the panel reads "on"', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [added('zara')]
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'added' })
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'on' })
    expect(w.restarted).toEqual(['zara'])
  })
  it('a new enable and a disable both clear the old answer', async () => {
    const w = world()
    w.replies.agent_add = [addOk(), addOk(ID_B)]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'refused' }]
    await checkGromzoAgent('zara', w.deps)
    await enableGromzoAgent('zara', w.deps)
    expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    w.replies.agent_remove = [{ ok: true }]
    await disableGromzoAgent('zara', w.deps)
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
  })
})

describe('D1: an old answer never stands for a new switch', () => {
  it('refused, then a new switch mxd refuses at once (rate_limited): the panel reads no_pending, not the old refusal', async () => {
    const w = world()
    w.replies.agent_add = [addOk(), { ok: false, error: 'rate_limited' }]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'refused' }]
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'refused' })
    expect(await enableGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'rate_limited' })
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: false, code: 'no_pending' })
  })
})

describe('D1: "used" is verified in mxd\'s status, never with a second agent_add', () => {
  async function usedWorld(facts?: GromzoAgentDeps['statusFacts']) {
    const w = world()
    if (facts) w.deps.statusFacts = facts
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    w.replies.agent_add_check = [{ ok: true, state: 'used' }]
    expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    return w
  }
  it('mxd runs it and did not hold it back: added, the flag on, only this agent restarted', async () => {
    const w = await usedWorld(running(['zara']))
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'added' })
    expect(w.writes).toEqual([['zara', true]])
    expect(w.restarted).toEqual(['zara'])
    expect(w.calls.filter((c) => c.verb === 'agent_add')).toHaveLength(1)
  })
  it('not running yet: still pending; held: never added; past the window: used, nothing written', async () => {
    for (const facts of [running([]), running(['zara'], ['zara']), undefined]) {
      resetPendingGromzoConsents()
      const w = await usedWorld(facts)
      expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
      later(w, USED_VERIFY_MS + 1)
      expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'used' })
      expect(w.writes).toEqual([])
      expect(w.restarted).toEqual([])
      expect(w.calls.filter((c) => c.verb === 'agent_add')).toHaveLength(1)
    }
  })
})

describe('D1: one check at a time', () => {
  it('two checks at once (the panel and the watcher): one agent_add_check', async () => {
    const w = world()
    w.replies.agent_add = [addOk()]
    await enableGromzoAgent('zara', w.deps)
    let release: (r: unknown) => void = () => {}
    w.replies.agent_add_check = [() => new Promise((r) => { release = r }) as never]
    const first = checkGromzoAgent('zara', w.deps)
    later(w)
    expect(await checkGromzoAgent('zara', w.deps)).toMatchObject({ ok: true, state: 'pending' })
    release(added('zara'))
    expect(await first).toEqual({ ok: true, state: 'added' })
    expect(w.calls.filter((c) => c.verb === 'agent_add_check')).toHaveLength(1)
  })
})

describe('D1: the watcher\'s pace', () => {
  it('11 s for the first minutes, then a minute; while verifying "used" 11 s; nothing pending: null', async () => {
    const w = world()
    expect(watcherDelayMs(w.clock.t)).toBeNull()
    w.replies.agent_add = [addOk(ID_A, 3600)]
    await enableGromzoAgent('zara', w.deps)
    expect(pendingGromzoConsentSlug()).toBe('zara')
    expect(watcherDelayMs(w.clock.t)).toBe(CHECK_GAP_MS)
    later(w, FAST_CHECK_WINDOW_MS)
    expect(watcherDelayMs(w.clock.t)).toBe(SLOW_CHECK_GAP_MS)
    w.replies.agent_add_check = [{ ok: true, state: 'used' }]
    await checkGromzoAgent('zara', w.deps)
    expect(watcherDelayMs(w.clock.t)).toBe(CHECK_GAP_MS)
  })
})

describe('D1: the pending consent survives a dashboard restart', () => {
  it('saved on enable (slug, id, times only), emptied on the final answer', async () => {
    const w = world()
    const st = memStore()
    setPendingConsentStore(st)
    w.replies.agent_add = [addOk(ID_A, 600)]
    await enableGromzoAgent('zara', w.deps)
    expect(st.saved.at(-1)).toEqual([{ slug: 'zara', consentId: ID_A, expiresAt: w.clock.t + 600_000, startedAt: w.clock.t }])
    w.replies.agent_add_check = [added('zara')]
    await checkGromzoAgent('zara', w.deps)
    expect(st.saved.at(-1)).toEqual([])
  })
  it('restored after a restart: the next check asks mxd with the saved id, and finishes', async () => {
    const w = world()
    const st = memStore([{ slug: 'zara', consentId: ID_A, expiresAt: w.clock.t + 300_000, startedAt: w.clock.t - 60_000 }])
    setPendingConsentStore(st)
    expect(restorePendingGromzoConsents(w.deps)).toBe('zara')
    w.replies.agent_add_check = [(r) => { expect(r).toEqual({ verb: 'agent_add_check', id: ID_A }); return added('zara') }]
    expect(await checkGromzoAgent('zara', w.deps)).toEqual({ ok: true, state: 'added' })
  })
  it('only a well-formed, unexpired entry for an agent of this fleet comes back, and only one', () => {
    const w = world()
    const t = w.clock.t
    for (const [entries, want] of [
      [[{ slug: 'zara', consentId: ID_A, expiresAt: t - 1, startedAt: t - 9 }], null],
      [[{ slug: 'nobody', consentId: ID_A, expiresAt: t + 9, startedAt: t }], null],
      [[{ slug: '../x', consentId: ID_A, expiresAt: t + 9, startedAt: t }], null],
      [[{ slug: 'zara', consentId: 'bad id!', expiresAt: t + 9, startedAt: t }], null],
      [[{ slug: 'zara', consentId: ID_A, expiresAt: '9', startedAt: t }], null],
      [[{ slug: 'zara', consentId: ID_A, expiresAt: t + 9, startedAt: t + 5 }], null],
      ['not an array', null],
      [[{ slug: 'zara', consentId: ID_A, expiresAt: t + 9, startedAt: t }, { slug: 'samu', consentId: ID_B, expiresAt: t + 9, startedAt: t }], 'zara'],
      [[{ slug: MAIN_AGENT_ID, consentId: ID_A, expiresAt: t + 9, startedAt: t }], MAIN_AGENT_ID],
    ] as const) {
      resetPendingGromzoConsents()
      setPendingConsentStore(memStore(entries))
      expect(restorePendingGromzoConsents(w.deps), JSON.stringify(entries)).toBe(want)
      expect(pendingGromzoConsentSlug()).toBe(want)
    }
  })
})
