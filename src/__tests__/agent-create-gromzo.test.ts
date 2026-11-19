// AGENTCREATEPR3-1119: an agent_create approval on the owner's Gromzo app (mxd's decisions verbs). The capability probe
// (old mxd / not reachable / ready), the post (the stored spec's own text), and the watcher's double-spend order with
// all three branches: mxd spends and the core decides (done); mxd refuses (back to pending, nothing decided); mxd spends
// but the core does not decide (failed, alerted, nothing decided). A rejection, a hash mismatch, an open row. The DB is
// in memory; mxd is a fake call.
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initDatabase, createApproval, getApproval, getDb, getApprovalGromzoPost, moveApprovalGromzoPost, type Approval } from '../db.js'
import { postAgentCreateToGromzo, gromzoDecisionTick, sweepGromzoConsumingOnStart, startGromzoDecisionWatch, stopGromzoDecisionWatchForTest, type GromzoDecisionDeps } from '../web/agent-create-gromzo.js'
import { canonicalJson, renderAgentSpec, type AgentSpecV1 } from '../web/agent-create-spec.js'
import type { MxdDashRequest, MxdDashReply } from '../web/mxd-dash.js'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const MXD_HASH = 'd'.repeat(64)
const SPEC: AgentSpecV1 = {
  spec_version: 1, name: 'kutato', display_name: 'Kutató', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default',
  custom_provider: null, channel: null,
}
let n = 0
function request(spec: AgentSpecV1 | null = SPEC): Approval {
  const id = `ac-gromzo-${String(n++).padStart(4, '0')}`
  const json = spec ? canonicalJson(spec) : null
  const a = createApproval({ id, agent_id: 'samu', category: 'agent_create', action_description: 'AZ ÜGYNÖK SAJÁT LEÍRÁSA', action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: json ? sha(json) : 'a'.repeat(64) })
  if (json) getDb().prepare('INSERT INTO agent_create_specs (approval_id, spec_json, content_hash, requested_by, requested_at) VALUES (?, ?, ?, ?, ?)').run(id, json, sha(json), 'samu', Math.floor(Date.now() / 1000))
  return a
}

type Script = (r: MxdDashRequest) => MxdDashReply | Error
function fake(script: Script) {
  const calls: MxdDashRequest[] = []
  const alerts: string[] = []
  const deps: GromzoDecisionDeps = {
    call: async (r) => { calls.push(r); const x = script(r); if (x instanceof Error) throw x; return x },
    alert: (t) => { alerts.push(t) },
  }
  return { deps, calls, alerts }
}
const ready: Script = (r) => (r.verb === 'decision_get' && String(r.id).startsWith('probe-') ? { ok: false, error: 'unknown_id' } : r.verb === 'decision_post' ? { ok: true, id: r.id, hash: MXD_HASH } : { ok: false, error: 'unexpected' })
async function posted() {
  const a = request()
  const f = fake(ready)
  expect(await postAgentCreateToGromzo(a, 'hu', f.deps)).toBe('posted')
  return a
}

beforeEach(() => { initDatabase(':memory:') })

describe('the capability probe, before every post', () => {
  it('unknown_verb: an mxd older than the decisions verbs; the adapter stays off, loudly; no row', async () => {
    const a = request()
    const f = fake(() => ({ ok: false, error: 'unknown_verb' }))
    expect(await postAgentCreateToGromzo(a, 'hu', f.deps)).toBe('old_mxd')
    expect(f.alerts).toHaveLength(1)
    expect(f.calls.map((c) => c.verb)).toEqual(['decision_get'])
    expect(getApprovalGromzoPost(a.id)).toBeUndefined()
  })
  it('a socket error, a timeout or "unavailable": not reachable now, never "old"; no alert, no row', async () => {
    for (const script of [(() => new Error('timeout')) as Script, (() => ({ ok: false, error: 'unavailable' })) as Script]) {
      const a = request()
      const f = fake(script)
      expect(await postAgentCreateToGromzo(a, 'hu', f.deps)).toBe('unavailable')
      expect(f.alerts).toEqual([])
      expect(getApprovalGromzoPost(a.id)).toBeUndefined()
    }
  })
  it('ready: the row is posted with the stored spec\'s own text and the spec hash; ours records mxd\'s hash, pending', async () => {
    const a = request()
    const f = fake(ready)
    expect(await postAgentCreateToGromzo(a, 'en', f.deps)).toBe('posted')
    const post = f.calls.find((c) => c.verb === 'decision_post')!
    expect(post).toEqual({ verb: 'decision_post', id: a.id, row: 'approval', kind: 'agent_create', fields: { text: renderAgentSpec(SPEC, a.content_hash!, 'en'), spec_hash: a.content_hash } })
    expect(JSON.stringify(post)).not.toContain('AZ ÜGYNÖK SAJÁT LEÍRÁSA')
    expect(getApprovalGromzoPost(a.id)).toMatchObject({ mxd_hash: MXD_HASH, state: 'pending' })
  })
  it('a spec that no longer hashes to the approval: not posted, not even probed', async () => {
    const a = request()
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('c'.repeat(64), a.id)
    const f = fake(ready)
    expect(await postAgentCreateToGromzo(getApproval(a.id)!, 'hu', f.deps)).toBe('not_verifiable')
    expect(f.calls).toEqual([])
  })
})

describe('the watcher: the owner\'s answer and the double-spend order', () => {
  const answered = (choice: string, hash = MXD_HASH): MxdDashReply => ({ ok: true, state: 'answered', choice, note: '', hash, consumed: false })
  it('open: nothing changes', async () => {
    const a = await posted()
    const f = fake(() => ({ ok: true, state: 'open', hash: MXD_HASH }))
    expect(await gromzoDecisionTick(f.deps)).toEqual([{ approvalId: a.id, outcome: 'open' }])
    expect(getApproval(a.id)!.status).toBe('pending')
  })
  it('approve: ours to consuming, mxd spends it, the core approves (bound to the hash); done', async () => {
    const a = await posted()
    const f = fake((r) => (r.verb === 'decision_get' ? answered('approve') : r.verb === 'decision_consume' ? { ok: true } : { ok: false, error: 'x' }))
    expect(await gromzoDecisionTick(f.deps)).toEqual([{ approvalId: a.id, outcome: 'approved' }])
    expect(f.calls.map((c) => c.verb)).toEqual(['decision_get', 'decision_consume'])
    expect(f.calls[1]).toEqual({ verb: 'decision_consume', kind: 'agent_create', hash: MXD_HASH, gate: 'agent_create' })
    expect(getApproval(a.id)!.status).toBe('approved')
    expect(getApprovalGromzoPost(a.id)!.state).toBe('done')
  })
  // Dani N1 / Samu 81811: only a known transient answer is retried; any other refusal fails loudly, once
  it('approve, but mxd cannot be asked now (a thrown socket error or timeout, or "unavailable"): back to pending, no alert, nothing decided', async () => {
    for (const consume of [new Error('timeout'), { ok: false, error: 'unavailable' }] as Array<MxdDashReply | Error>) {
      initDatabase(':memory:')
      const a = await posted()
      const f = fake((r) => (r.verb === 'decision_get' ? answered('approve') : consume))
      await gromzoDecisionTick(f.deps)
      expect(getApproval(a.id)!.status).toBe('pending')
      expect(getApprovalGromzoPost(a.id)!.state).toBe('pending')
      expect(f.alerts).toEqual([])
    }
  })
  it('approve, but mxd refuses to spend it (already_consumed, expired, not_found, kind_mismatch, an unknown code): failed, one alert, nothing decided', async () => {
    for (const code of ['already_consumed', 'expired', 'not_found', 'kind_mismatch', 'some_new_code']) {
      initDatabase(':memory:')
      const a = await posted()
      const f = fake((r) => (r.verb === 'decision_get' ? answered('approve') : { ok: false, error: code }))
      await gromzoDecisionTick(f.deps)
      expect(getApproval(a.id)!.status).toBe('pending')
      expect(getApprovalGromzoPost(a.id)).toMatchObject({ state: 'failed', note: `consume_${code}` })
      expect(f.alerts).toHaveLength(1)
      expect(f.alerts[0]).toContain(code)
      // the next round does not read it again
      expect(await gromzoDecisionTick(f.deps)).toEqual([])
      expect(f.alerts).toHaveLength(1)
    }
  })
  it('approve, mxd spends it, but the core does not decide (the hash changed): failed, alerted, nothing decided', async () => {
    const a = await posted()
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('c'.repeat(64), a.id)
    const f = fake((r) => (r.verb === 'decision_get' ? answered('approve') : { ok: true }))
    const res = await gromzoDecisionTick(f.deps)
    expect(res[0].outcome).toBe('commit_content_changed')
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalGromzoPost(a.id)!.state).toBe('failed')
    expect(f.alerts).toHaveLength(1)
  })
  it('two watcher rounds at once: only one owns the row (compare-and-set), mxd is asked to spend it once', async () => {
    const a = await posted()
    let consumes = 0
    const deps: GromzoDecisionDeps = {
      call: async (r) => {
        if (r.verb === 'decision_get') return answered('approve')
        consumes++
        await new Promise((res) => setTimeout(res, 20))
        return { ok: true }
      },
      alert: () => {},
    }
    const [x, y] = await Promise.all([gromzoDecisionTick(deps), gromzoDecisionTick(deps)])
    expect(consumes).toBe(1)
    expect([...x, ...y].map((o) => o.outcome).sort()).toEqual(['approved', 'taken'])
    expect(getApproval(a.id)!.status).toBe('approved')
  })
  it('decided elsewhere while mxd spent it (the dashboard): failed, and the alert names that it was decided elsewhere', async () => {
    const a = await posted()
    const f = fake((r) => {
      if (r.verb === 'decision_get') return answered('approve')
      getDb().prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(a.id)
      return { ok: true }
    })
    const res = await gromzoDecisionTick(f.deps)
    expect(res[0].outcome).toBe('commit_not_pending')
    expect(getApprovalGromzoPost(a.id)!.state).toBe('failed')
    expect(f.alerts).toHaveLength(1)
    expect(f.alerts[0]).toContain('közben már máshol')
  })
  it('reject: the core rejects it; mxd spends nothing', async () => {
    const a = await posted()
    const f = fake((r) => (r.verb === 'decision_get' ? answered('reject') : { ok: false, error: 'x' }))
    await gromzoDecisionTick(f.deps)
    expect(f.calls.map((c) => c.verb)).toEqual(['decision_get'])
    expect(getApproval(a.id)!.status).toBe('rejected')
    expect(getApprovalGromzoPost(a.id)!.state).toBe('done')
  })
  it('an answer on a row with another hash: never decided from, failed, alerted', async () => {
    const a = await posted()
    const f = fake((r) => (r.verb === 'decision_get' ? answered('approve', 'e'.repeat(64)) : { ok: true }))
    await gromzoDecisionTick(f.deps)
    expect(f.calls.map((c) => c.verb)).toEqual(['decision_get'])
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalGromzoPost(a.id)!.state).toBe('failed')
    expect(f.alerts).toHaveLength(1)
  })
})

// Samu 81801: a stop between mxd's consume and the commit left the row in "consuming", which nobody read again.
describe('the start-up sweep of interrupted rows', () => {
  it('a row left in consuming goes to failed (interrupted), alerted; a pending row is left alone; nothing decided', async () => {
    const stuck = await posted()
    const waiting = await posted()
    expect(moveApprovalGromzoPost(stuck.id, 'pending', 'consuming')).toBe(true)
    const f = fake(() => ({ ok: false, error: 'x' }))
    expect(sweepGromzoConsumingOnStart(f.deps)).toEqual([stuck.id])
    expect(getApprovalGromzoPost(stuck.id)).toMatchObject({ state: 'failed', note: 'interrupted' })
    expect(getApprovalGromzoPost(waiting.id)!.state).toBe('pending')
    expect(f.alerts).toHaveLength(1)
    expect(f.alerts[0]).toContain(stuck.id)
    expect(getApproval(stuck.id)!.status).toBe('pending')
    expect(f.calls).toEqual([])
    expect(sweepGromzoConsumingOnStart(f.deps)).toEqual([])
  })
  it('the watcher\'s start runs the sweep', async () => {
    const stuck = await posted()
    moveApprovalGromzoPost(stuck.id, 'pending', 'consuming')
    const f = fake(() => ({ ok: false, error: 'x' }))
    try { startGromzoDecisionWatch(f.deps) } finally { stopGromzoDecisionWatchForTest() }
    expect(getApprovalGromzoPost(stuck.id)!.state).toBe('failed')
    expect(f.alerts).toHaveLength(1)
  })
})
