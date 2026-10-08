import type { EngineInterface, Register } from 'claude-code'

// agent-state-observer -- an OBSERVE-ONLY Claude Code mod.
//
// What it does: on session, turn and tool events it writes this agent's state
// (starting / idle / working / awaiting_approval / ended), its last 200
// transitions and its rate-limit readings ($.session.usage()) to one JSON file.
// What it never does: every hook passes the event on with next(e) and returns
// next's result unchanged -- it never denies, rewrites or delays a call, and
// draws nothing. Writes are fire-and-forget; a failed write is swallowed, so
// the mod can never stall the agent.
//
// Identity and output come from the launcher, not from a path convention:
//   MARVEEN_AGENT_ID           the agent's name (letters, digits, "_" and "-")
//   MARVEEN_STATE_OBSERVER_DIR the folder it writes <agent>.json into
// Without both (or with a name that does not fit) it writes nothing at all.
// Kill switches, no restart needed: <dir>/DISABLE stops every agent,
// <dir>/DISABLE-<agent> stops that one; the hooks then only pass through.

const AGENT_NAME = /^[a-z0-9_-]+$/i
const HISTORY_MAX = 200

/** The agent name the launcher gave, or null when it is missing or malformed. */
export function validAgent(value: string | undefined): string | null {
  return value && AGENT_NAME.test(value) ? value : null
}
const TICK_MS = 60_000

type AgentState = 'starting' | 'idle' | 'working' | 'awaiting_approval' | 'ended'

type RateLimitReading = { kind: string; percentUsed: number; resetsAt?: string }

type Usage = {
  read_at: number
  rateLimits: RateLimitReading[]
  rateLimits_empty: boolean
  context_percent: number | null
  cost_usd: number | null
}

type Snapshot = {
  v: 1
  agent: string
  state: AgentState
  since: number
  updated_at: number
  alive_at: number
  session_id: string | null
  turn_id: string | null
  tool: string | null
  reason: string | null
  seq: number
  history: { ts: number; from: AgentState; to: AgentState; tool?: string; reason?: string }[]
  usage: Usage | null
  usage_history: Usage[]
  first_usage_probe: { at: number; rateLimits_empty: boolean } | null
}

const now = () => Date.now()
function freshSnapshot(): Snapshot {
  return {
  v: 1,
  agent: '',
  state: 'starting',
  since: now(),
  updated_at: now(),
  alive_at: now(),
  session_id: null,
  turn_id: null,
  tool: null,
  reason: null,
  seq: 0,
  history: [],
  usage: null,
  usage_history: [],
  first_usage_probe: null,
  }
}

// Module state starts over on every load; register() resets it explicitly too.
let snap: Snapshot = freshSnapshot()

// Writes are chained so two events never interleave their file writes.
let chain: Promise<void> = Promise.resolve()
let disabled = false
// Set by session.start from the launcher's environment; until then, and when
// either value is missing, nothing is written.
let agent: string | null = null
let stateDir: string | null = null

function flush($: EngineInterface): void {
  const name = agent
  const dir = stateDir
  if (!name || !dir) return
  const text = JSON.stringify(snap)
  chain = chain
    .then(async () => {
      disabled = (await $.fs.exists(`${dir}/DISABLE`)) || (await $.fs.exists(`${dir}/DISABLE-${name}`))
      if (!disabled) await $.fs.write(`${dir}/${name}.json`, text)
    })
    .catch(() => {})
}

function move($: EngineInterface, to: AgentState, extra: { tool?: string; reason?: string; turnId?: string } = {}): void {
  if (disabled) return
  const t = now()
  if (extra.turnId !== undefined) snap.turn_id = extra.turnId
  snap.tool = extra.tool ?? null
  snap.reason = extra.reason ?? null
  snap.updated_at = t
  snap.alive_at = t
  if (to === snap.state) {
    flush($)
    return
  }
  snap.history.push({ ts: t, from: snap.state, to, ...(extra.tool ? { tool: extra.tool } : {}), ...(extra.reason ? { reason: extra.reason } : {}) })
  if (snap.history.length > HISTORY_MAX) snap.history.splice(0, snap.history.length - HISTORY_MAX)
  snap.state = to
  snap.since = t
  snap.seq += 1
  flush($)
}

async function readUsage($: EngineInterface, probe: boolean): Promise<void> {
  if (disabled) return
  try {
    const u = await $.session.usage()
    const reading: Usage = {
      read_at: now(),
      rateLimits: (u.rateLimits ?? []).map((r: RateLimitReading) => ({
        kind: r.kind,
        percentUsed: r.percentUsed,
        ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}),
      })),
      rateLimits_empty: !(u.rateLimits && u.rateLimits.length > 0),
      context_percent: u.context?.percent ?? null,
      cost_usd: u.cost?.usd ?? null,
    }
    const prev = snap.usage
    const changed =
      !prev ||
      JSON.stringify(prev.rateLimits) !== JSON.stringify(reading.rateLimits) ||
      prev.context_percent !== reading.context_percent
    snap.usage = reading
    if (changed) {
      snap.usage_history.push(reading)
      if (snap.usage_history.length > HISTORY_MAX) snap.usage_history.splice(0, snap.usage_history.length - HISTORY_MAX)
    }
    if (probe && !snap.first_usage_probe) {
      snap.first_usage_probe = { at: reading.read_at, rateLimits_empty: reading.rateLimits_empty }
    }
    flush($)
  } catch {
    // A usage read failing must not touch the agent; the next tick retries.
  }
}

export const register: Register = on => {
  snap = freshSnapshot()
  chain = Promise.resolve()
  disabled = false
  agent = null
  stateDir = null

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      agent = validAgent(await $.env.get('MARVEEN_AGENT_ID'))
      stateDir = (await $.env.get('MARVEEN_STATE_OBSERVER_DIR'))?.replace(/\/+$/, '') || null
    } catch {
      agent = null
      stateDir = null
    }
    snap.agent = agent ?? ''
    try {
      snap.session_id = await $.session.id()
    } catch {}
    move($, 'idle', { reason: 'session.start' })
    $.clock.every(TICK_MS, () => {
      if (disabled) return
      snap.alive_at = now()
      flush($)
      void readUsage($, false)
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    move($, 'working', { turnId: e.turnId, reason: 'turn.start' })
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    // Only a real call carries tool_use_id; a $.tool.check query does not.
    if (e.tool_use_id && r.decision === 'ask') {
      move($, 'awaiting_approval', { tool: e.tool, reason: r.hook ?? r.rule ?? 'ask' })
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    move($, 'working', { tool: String(e.tool), reason: 'tool.call' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // A subagent's turn ending (agentId set) does not end the main loop's turn.
    if (e.agentId) return r
    move($, 'idle', { reason: `turn.complete:${e.reason}` })
    void readUsage($, true)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    void readUsage($, false)
    return r
  })

  on('session.end', async ($, e, next) => {
    move($, 'ended', { reason: `session.end:${String(e.reason)}` })
    return next(e)
  })
}
