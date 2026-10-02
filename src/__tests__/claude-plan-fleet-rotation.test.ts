// Fleet leg of a rotation (CLAUDE_ROTATION_FLEET). performFleetRotation is
// IO-injected: these tests never touch tmux, the vault or the real store.
// writeFleetTokenFile runs against a throwaway temp dir. Tokens are assembled
// at runtime (never a literal token-shaped string in the source).
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  agentUsesFleetToken,
  formatFleetLine,
  performFleetRotation,
  utcStamp,
  writeFleetTokenFile,
  type FleetRotationDeps,
} from '../claude-plan-fleet-rotation.js'
import { pendingFleetReport } from '../claude-plan-rotate-heartbeat.js'
import type { ClaudePlan } from '../web/claude-plans.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'

const NOW = Date.UTC(2026, 8, 24, 8, 30, 15)
const fakeToken = (tag: string) => ['fake', 'fleet', 'tok', tag].join('-')

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fleet-rotation-test-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

function tokenPlan(over: Partial<ClaudePlan> = {}): ClaudePlan {
  return { id: 'team', label: 'Team Seat', tokenSecretId: 'claude-plan-token-team', planType: 'team', channelsAllowed: true, ...over } as ClaudePlan
}

function deps(over: Partial<FleetRotationDeps> = {}): FleetRotationDeps & { writes: string[]; restarts: string[]; sleeps: number[] } {
  const writes: string[] = []
  const restarts: string[] = []
  const sleeps: number[] = []
  return {
    writes,
    restarts,
    sleeps,
    readPlanToken: () => fakeToken('team'),
    writeFleetToken: (t) => { writes.push(t); return { ok: true, changed: true, backupPath: null } },
    listAgents: () => ['shared-a', 'own-token', 'shared-b', 'stopped-shared'],
    usesFleetToken: (n) => n.startsWith('shared') || n === 'stopped-shared',
    isRunning: (n) => n !== 'stopped-shared',
    restart: async (n) => { restarts.push(n); return { ok: true } },
    sleep: async (ms) => { sleeps.push(ms) },
    nowMs: () => NOW,
    gapMs: 7,
    ...over,
  }
}

describe('agentUsesFleetToken (mirrors the launcher)', () => {
  const base = { name: 'dev', mainAgentId: 'main', model: 'claude-opus-5', authMode: 'shared', configuredConfigDir: null, remote: false }
  it('a plain Claude sub-agent on shared auth uses the fleet token', () => {
    expect(agentUsesFleetToken(base)).toBe(true)
  })
  it.each([
    ['the main agent', { name: 'main' }],
    ['an own API-key agent', { authMode: 'api' }],
    ['an own-team (own /login) agent', { authMode: 'own_team' }],
    ['an agent with its own config dir / plan', { configuredConfigDir: '/opt/claude-x' }],
    ['a non-Claude model', { model: 'deepseek-v4-pro' }],
    ['a remote agent', { remote: true }],
  ])('does not for %s', (_label, over) => {
    expect(agentUsesFleetToken({ ...base, ...over })).toBe(false)
  })
})

describe('performFleetRotation', () => {
  it('writes the plan token and restarts ONLY running shared-token agents, sequentially with a gap', async () => {
    const d = deps()
    const r = await performFleetRotation(tokenPlan(), d)
    expect(d.writes).toEqual([fakeToken('team')])
    expect(d.restarts).toEqual(['shared-a', 'shared-b'])
    expect(d.sleeps).toEqual([7]) // one gap between two restarts, none before the first
    expect(r).toMatchObject({ fleetPlanId: 'team', rotatedAt: NOW, outcome: 'rotated', restarted: ['shared-a', 'shared-b'], failed: [], notRunning: ['stopped-shared'] })
    expect(r.line).toBe('FLEET_ROTATE plan=team label=Team Seat tokenChanged=yes restarted=shared-a,shared-b failed=- notRunning=stopped-shared')
  })

  it('never puts the token into the record or the line', async () => {
    const r = await performFleetRotation(tokenPlan(), deps())
    expect(JSON.stringify(r)).not.toContain(fakeToken('team'))
  })

  it('configDir-mode target: skipped, nothing written, nothing restarted', async () => {
    const d = deps()
    const r = await performFleetRotation(tokenPlan({ tokenSecretId: undefined, configDir: '/opt/claude-team' } as Partial<ClaudePlan>), d)
    expect(d.writes).toEqual([])
    expect(d.restarts).toEqual([])
    expect(r.outcome).toBe('skipped')
    expect(r.line).toBe('FLEET_SKIPPED plan=team label=Team Seat reason=config-dir-plan-fleet-needs-token')
  })

  it('token missing from the vault: skipped, fleet file untouched', async () => {
    const d = deps({ readPlanToken: () => null })
    const r = await performFleetRotation(tokenPlan(), d)
    expect(d.writes).toEqual([])
    expect(d.restarts).toEqual([])
    expect(r.reason).toBe('token-missing-from-vault')
  })

  it('a failing or throwing restart is recorded and the others still restart', async () => {
    const d = deps({
      listAgents: () => ['shared-a', 'shared-b', 'shared-c'],
      restart: async (n) => {
        d.restarts.push(n)
        if (n === 'shared-a') return { ok: false, error: 'A restart is already in flight for this agent' }
        if (n === 'shared-b') throw new TypeError('kaboom')
        return { ok: true }
      },
    })
    const r = await performFleetRotation(tokenPlan(), d)
    expect(d.restarts).toEqual(['shared-a', 'shared-b', 'shared-c'])
    expect(r.restarted).toEqual(['shared-c'])
    expect(r.failed).toEqual([
      { agent: 'shared-a', error: 'A restart is already in flight for this agent' },
      { agent: 'shared-b', error: 'TypeError' },
    ])
    expect(r.line).toContain('failed=shared-a,shared-b')
  })

  it('a failed file write restarts nobody (they would only come back on the old token)', async () => {
    const d = deps({ writeFleetToken: () => ({ ok: false, error: 'fleet token write failed' }) })
    const r = await performFleetRotation(tokenPlan(), d)
    expect(d.restarts).toEqual([])
    expect(r.outcome).toBe('failed')
    expect(r.line).toBe('FLEET_FAILED plan=team label=Team Seat reason=fleet-token-write-failed')
  })

  it('fleet already on this token: no restarts', async () => {
    const d = deps({ writeFleetToken: () => ({ ok: true, changed: false }) })
    const r = await performFleetRotation(tokenPlan(), d)
    expect(d.restarts).toEqual([])
    expect(r.line).toContain('tokenChanged=no')
  })
})

describe('writeFleetTokenFile (real fs, temp dir)', () => {
  function freshDir(name: string) {
    const d = join(tmpRoot, name)
    mkdirSync(d, { recursive: true })
    return d
  }

  it('backs up the old token to .bak.rotation.<UTC>, writes the new one atomically at 0600', () => {
    const dir = freshDir('swap')
    const path = join(dir, '.claude-oauth-token')
    writeFileSync(path, fakeToken('old'))
    chmodSync(path, 0o600)
    const r = writeFleetTokenFile(path, fakeToken('new'), NOW)
    expect(r).toEqual({ ok: true, changed: true, backupPath: `${path}.bak.rotation.${utcStamp(NOW)}` })
    expect(utcStamp(NOW)).toBe('20260924T083015Z')
    expect(readFileSync(path, 'utf-8')).toBe(fakeToken('new'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const bak = `${path}.bak.rotation.20260924T083015Z`
    expect(readFileSync(bak, 'utf-8')).toBe(fakeToken('old'))
    expect(statSync(bak).mode & 0o777).toBe(0o600)
    // No stray tmp file left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('same token already there: nothing written, no backup', () => {
    const dir = freshDir('same')
    const path = join(dir, '.claude-oauth-token')
    writeFileSync(path, fakeToken('same') + '\n')
    expect(writeFleetTokenFile(path, fakeToken('same'), NOW)).toEqual({ ok: true, changed: false })
    expect(readdirSync(dir)).toEqual(['.claude-oauth-token'])
  })

  it('no existing file: written, no backup', () => {
    const dir = freshDir('none')
    const path = join(dir, '.claude-oauth-token')
    expect(writeFleetTokenFile(path, fakeToken('first'), NOW)).toEqual({ ok: true, changed: true, backupPath: null })
    expect(readFileSync(path, 'utf-8')).toBe(fakeToken('first'))
  })

  it('backup impossible: the live file is left exactly as it was', () => {
    const dir = freshDir('nobak')
    const path = join(dir, '.claude-oauth-token')
    writeFileSync(path, fakeToken('keep'))
    // A directory squatting on the backup name makes copyFileSync fail.
    mkdirSync(`${path}.bak.rotation.${utcStamp(NOW)}`)
    const r = writeFleetTokenFile(path, fakeToken('new'), NOW)
    expect(r).toEqual({ ok: false, error: 'fleet token backup failed' })
    expect(readFileSync(path, 'utf-8')).toBe(fakeToken('keep'))
  })
})

describe('pendingFleetReport (heartbeat prints the fleet line once)', () => {
  const rec = { fleetPlanId: 'team', rotatedAt: NOW, outcome: 'rotated' as const, restarted: ['a'], failed: [], notRunning: [] }
  const withFleet: ClaudePlansState = {
    activePlanByAgent: { main: 'team' },
    plans: {},
    fleet: { ...rec, line: formatFleetLine(rec, 'Team Seat') },
  }

  it('prints an unreported record and marks it reported', () => {
    const r = pendingFleetReport(withFleet, NOW + 60_000)
    expect(r?.printLine).toMatch(/^FLEET_ROTATE plan=team /)
    expect(r?.nextState.fleet?.reportedAt).toBe(NOW + 60_000)
    expect(r?.nextState.activePlanByAgent).toEqual({ main: 'team' })
  })

  it('stays silent once reported, and on installs that never ran a fleet leg', () => {
    const reported = pendingFleetReport(withFleet, NOW)!.nextState
    expect(pendingFleetReport(reported, NOW + 1)).toBeNull()
    expect(pendingFleetReport({ activePlanByAgent: {}, plans: {} }, NOW)).toBeNull()
  })
})

