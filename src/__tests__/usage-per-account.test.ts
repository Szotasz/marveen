import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// USAGEPERACCOUNT1123: every agent's statusLine wrote ONE shared file, so on an
// install with two subscriptions the collected Claude number jumped between the
// accounts (measured 2026-11-23: 80, 29, 0, 30, 1). These tests run the real
// writer, collector and monitor check on a fake install with two plans.

const REPO = join(__dirname, '..', '..')
const WEEK = 604800
const now = Math.floor(Date.now() / 1000)
// Two accounts: their seven-day resets differ modulo one week.
const MAX_RESET = now + 3 * 86400
const TEAM_RESET = now + 5 * 86400 + 3600
const OTHER_RESET = now + 1 * 86400 + 7200

let root: string

function payload(cwd: string, sevenReset: number, sevenPct: number, fivePct = 5) {
  return JSON.stringify({
    session_id: 's', cwd, model: { display_name: 'M' },
    rate_limits: {
      five_hour: { used_percentage: fivePct, resets_at: now + 3600 },
      seven_day: { used_percentage: sevenPct, resets_at: sevenReset },
    },
  })
}

function render(cwd: string, sevenReset: number, sevenPct: number, fivePct = 5) {
  const r = spawnSync('bash', [join(root, 'scripts', 'statusline-ratelimit.sh')], { input: payload(cwd, sevenReset, sevenPct, fivePct), encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

function py(code: string, env: Record<string, string> = {}) {
  const r = spawnSync('python3', ['-c', code, root], { encoding: 'utf-8', env: { ...process.env, MAIN_AGENT_ID: 'marveen', ...env } })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
}

const LOAD_UC = `
import importlib.util, json, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location("uc", root + "/scripts/usage-collect.py")
uc = importlib.util.module_from_spec(spec); spec.loader.exec_module(uc)
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-acct-'))
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'store'))
  for (const f of ['statusline-ratelimit.sh', 'usage-collect.py', 'lib/claude_accounts.py', 'lib/quota-check.py']) {
    copyFileSync(join(REPO, 'scripts', f), join(root, 'scripts', f))
  }
  writeFileSync(join(root, 'store', 'claude-plans.json'), JSON.stringify([
    { id: 'team-plan', label: 'Team', planType: 'team', tokenSecretId: 'X' },
    { id: 'max-plan', label: 'Max', planType: 'personal', tokenSecretId: 'Y' },
  ]))
  writeFileSync(join(root, 'store', 'claude-plans-state.json'), JSON.stringify({
    activePlanByAgent: { marveen: 'max-plan' },
    // An old probe (two weeks back) still names the account: same reset modulo one week.
    plans: { 'max-plan': { observedAt: (now - 14 * 86400) * 1000, windows: { seven_day: { usedPercent: 10, resetsAt: MAX_RESET - 2 * WEEK } } } },
  }))
  for (const [a, cfg] of [['grafit', { oauthTokenFile: join(root, 'store', '.claude-oauth-token-team-plan') }], ['prorab', {}]] as const) {
    mkdirSync(join(root, 'agents', a), { recursive: true })
    writeFileSync(join(root, 'agents', a, 'agent-config.json'), JSON.stringify(cfg))
  }
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('statusLine writer', () => {
  it('keeps the shared file and adds one file per account', () => {
    expect(render(join(root, 'agents', 'prorab'), MAX_RESET, 80)).toContain('7d 80%')
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 29)
    render(join(root, 'agents', 'prorab'), MAX_RESET, 81)
    const files = readdirSync(join(root, 'store', 'claude-rate-limits')).sort()
    expect(files).toEqual([`wk-${MAX_RESET % WEEK}.json`, `wk-${TEAM_RESET % WEEK}.json`].sort())
    const max = JSON.parse(readFileSync(join(root, 'store', 'claude-rate-limits', `wk-${MAX_RESET % WEEK}.json`), 'utf-8'))
    expect(max.rate_limits.seven_day.used_percentage).toBe(81)
    // The shared file is still the last writer's, as before.
    expect(JSON.parse(readFileSync(join(root, 'store', '.claude-rate-limits.json'), 'utf-8')).rate_limits.seven_day.used_percentage).toBe(81)
  })

  it('a payload without rate_limits writes nothing', () => {
    spawnSync('bash', [join(root, 'scripts', 'statusline-ratelimit.sh')], { input: JSON.stringify({ cwd: root }), encoding: 'utf-8' })
    expect(existsSync(join(root, 'store', 'claude-rate-limits'))).toBe(false)
  })
})

describe('collector: claude_accounts', () => {
  it('labels each account and never mixes them', () => {
    render(join(root, 'agents', 'prorab'), MAX_RESET, 80)
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 29)
    render(join(root, 'agents', 'prorab'), OTHER_RESET, 3)
    const out = JSON.parse(py(LOAD_UC + 'print(json.dumps(uc.collect_claude_accounts()))'))
    expect(out['team-plan']).toMatchObject({ plan: 'team-plan', label: 'Team', label_source: 'agent_token_file', writer_agent: 'grafit', source: 'statusline' })
    expect(out['team-plan'].windows.seven_day.used_percent).toBe(29)
    expect(out['max-plan']).toMatchObject({ plan: 'max-plan', label_source: 'probe_fingerprint', writer_agent: 'prorab' })
    expect(out['max-plan'].windows.seven_day.used_percent).toBe(80)
    // An account nothing names stays under its own fingerprint key.
    expect(out[`wk-${OTHER_RESET % WEEK}`]).toMatchObject({ plan: null, label_source: 'fingerprint_only' })
  })

  it('the single claude entry takes the main agent plan, even when another account wrote last', () => {
    render(join(root, 'agents', 'prorab'), MAX_RESET, 80)
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 29)
    const out = JSON.parse(py(LOAD_UC + 'w, a = uc._main_account_statusline(10); print(json.dumps(w))'))
    expect(out.seven_day.used_percent).toBe(80)
  })

  it('with plans configured and no reading of the main plan: nothing, not the other account', () => {
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 29)
    expect(py(LOAD_UC + 'w, a = uc._main_account_statusline(10); print(json.dumps(w))').trim()).toBe('null')
  })

  it('without claude-plans.json the shared file is used as before', () => {
    rmSync(join(root, 'store', 'claude-plans.json'))
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 29)
    expect(JSON.parse(py(LOAD_UC + 'w, a = uc._main_account_statusline(10); print(json.dumps(w))')).seven_day.used_percent).toBe(29)
  })

  it('a plan with only a probe reading is listed with source probe', () => {
    writeFileSync(join(root, 'store', 'claude-plans-state.json'), JSON.stringify({
      activePlanByAgent: { marveen: 'max-plan' },
      plans: { 'team-plan': { observedAt: (now - 600) * 1000, windows: { seven_day: { usedPercent: 31, resetsAt: TEAM_RESET } } } },
    }))
    const out = JSON.parse(py(LOAD_UC + 'print(json.dumps(uc.collect_claude_accounts()))'))
    expect(out['team-plan']).toMatchObject({ source: 'probe', label_source: 'probe' })
    expect(out['team-plan'].windows.seven_day.used_percent).toBe(31)
  })

  it('the pace alert names the account', () => {
    render(join(root, 'agents', 'grafit'), now + 3600, 99, 99)
    const out = py(LOAD_UC + `
snap = {"claude": {"ok": True, "source": "estimate"}, "codex": {}, "claude_accounts": uc.collect_claude_accounts()}
print("\\n".join(uc.compute_alerts(snap, {})))`)
    expect(out).toMatch(/weekly limit \[Team\] nearly exhausted \(99%\)/)
  })
})

describe('usage endpoint and the setup-token', () => {
  it('the .env setup-token is not sent to the usage endpoint', () => {
    const out = py(LOAD_UC + `
uc._read_claude_token = lambda: ("tok", "env_file")
def boom(*a, **k): raise AssertionError("usage endpoint called")
uc.urllib.request.urlopen = boom
print(json.dumps(uc._collect_claude_authoritative()))`)
    const [w, err, kind] = JSON.parse(out)
    expect(w).toBeNull()
    expect(err).toMatch(/setup-token/)
    expect(kind).toBe('permanent')
  })
})

describe('quota-check per account', () => {
  const run = (dir: boolean) => spawnSync('python3', [join(root, 'scripts', 'lib', 'quota-check.py')], {
    encoding: 'utf-8',
    env: { ...process.env, MAIN_AGENT_ID: 'marveen', QUOTA_FILE: join(root, 'store', '.claude-rate-limits.json'), QUOTA_WARN_PCT: '90', ...(dir ? { QUOTA_DIR: join(root, 'store', 'claude-rate-limits') } : {}) },
  }).stdout

  it('alerts the account that crossed, named, while the shared file holds the other one', () => {
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 95)
    render(join(root, 'agents', 'prorab'), MAX_RESET, 20)
    const out = run(true)
    expect(out).toMatch(/^HIT\tteam-plan\/seven_day:90:\d+\tTeam: heti keret: 95% elhasznalva/)
    // The old path, reading the shared file only, would have seen the 20% of Max.
    expect(run(false)).toBe('')
  })

  it('without per-account files the old single-file line is unchanged', () => {
    writeFileSync(join(root, 'store', '.claude-rate-limits.json'), JSON.stringify({
      written_at: now, rate_limits: { seven_day: { used_percentage: 95, resets_at: TEAM_RESET } },
    }))
    expect(run(true)).toMatch(/^HIT\tseven_day:90:\d+\theti keret: 95% elhasznalva/)
  })
})

// Revizor 5372: J1 (a claim about the writer must not override the measured
// fingerprint), J2 (per-account dedupe), J3/M3 (readings without a fingerprint).
describe('review fixes (5372)', () => {
  const accounts = () => JSON.parse(py(LOAD_UC + 'print(json.dumps(uc.collect_claude_accounts()))'))
  const qc = (env: Record<string, string> = {}) => spawnSync('python3', [join(root, 'scripts', 'lib', 'quota-check.py')], {
    encoding: 'utf-8',
    env: {
      ...process.env, MAIN_AGENT_ID: 'marveen', QUOTA_WARN_PCT: '90',
      QUOTA_FILE: join(root, 'store', '.claude-rate-limits.json'), QUOTA_DIR: join(root, 'store', 'claude-rate-limits'), ...env,
    },
  })
  const knowBoth = () => writeFileSync(join(root, 'store', 'claude-plans-state.json'), JSON.stringify({
    activePlanByAgent: { marveen: 'max-plan' },
    plans: {
      'max-plan': { observedAt: (now - 86400) * 1000, windows: { seven_day: { usedPercent: 10, resetsAt: MAX_RESET } } },
      'team-plan': { observedAt: (now - 86400) * 1000, windows: { seven_day: { usedPercent: 10, resetsAt: TEAM_RESET } } },
    },
  }))

  it('J1: a session in a worktree under the root is not the main agent', () => {
    render(join(root, 'agents', 'prorab'), MAX_RESET, 20)
    render(join(root, '.claude', 'worktrees', 'x'), TEAM_RESET, 95)
    const a = accounts()
    expect(a['max-plan'].windows.seven_day.used_percent).toBe(20)
    expect(a[`wk-${TEAM_RESET % WEEK}`]).toMatchObject({ plan: null, writer_agent: null })
    expect(JSON.parse(py(LOAD_UC + 'w, a = uc._main_account_statusline(10); print(json.dumps(w))')).seven_day.used_percent).toBe(20)
  })

  it('J1: the probe fingerprint beats a stale activePlanByAgent', () => {
    knowBoth()
    writeFileSync(join(root, 'store', 'claude-plans-state.json'), JSON.stringify({
      ...JSON.parse(readFileSync(join(root, 'store', 'claude-plans-state.json'), 'utf-8')), activePlanByAgent: { marveen: 'team-plan' },
    }))
    render(root, MAX_RESET, 21)
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 95)
    const a = accounts()
    expect(a['max-plan']).toMatchObject({ label_source: 'probe_fingerprint', label_conflict: true, writer_agent: 'marveen' })
    expect(a['max-plan'].windows.seven_day.used_percent).toBe(21)
    expect(a['team-plan'].windows.seven_day.used_percent).toBe(95)
  })

  it('J1: a claim contradicted by a probe of that plan stays under its fingerprint', () => {
    knowBoth()
    render(join(root, 'agents', 'grafit'), OTHER_RESET, 50)   // grafit's token file says team, the fingerprint is neither
    const a = accounts()
    expect(a[`wk-${OTHER_RESET % WEEK}`]).toMatchObject({ plan: null, label_conflict: true })
    expect(a['team-plan'].source).toBe('probe')
  })

  it('J1: two fingerprints under one claimed plan: neither gets the name', () => {
    rmSync(join(root, 'store', 'claude-plans-state.json'))
    writeFileSync(join(root, 'agents', 'prorab', 'agent-config.json'), JSON.stringify({ claudePlan: 'team-plan' }))
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 30)
    render(join(root, 'agents', 'prorab'), MAX_RESET, 80)
    const a = accounts()
    expect(a['team-plan']).toBeUndefined()
    expect(a[`wk-${TEAM_RESET % WEEK}`]).toMatchObject({ label_conflict: true })
    expect(a[`wk-${MAX_RESET % WEEK}`]).toMatchObject({ label_conflict: true })
  })

  it('J2: an account whose reading goes stale and comes back is not alerted twice', () => {
    knowBoth()
    const state = join(root, 'store', '.limit-monitor-quota-state')
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 95)
    render(join(root, 'agents', 'prorab'), MAX_RESET, 92)
    const t1 = qc({ QUOTA_STATE: state }).stdout
    expect(t1).toMatch(/^HIT\t/)
    expect(t1).toContain('Team: heti keret: 95%')
    expect(t1).toContain('Max: heti keret: 92%')
    writeFileSync(state, t1.split('\t')[1])                       // what limit-monitor.sh stores after a delivered send
    const maxFile = join(root, 'store', 'claude-rate-limits', `wk-${MAX_RESET % WEEK}.json`)
    const maxReading = readFileSync(maxFile, 'utf-8')
    rmSync(maxFile)                                               // Max agents idle: no reading
    expect(qc({ QUOTA_STATE: state }).stdout).toBe('')
    writeFileSync(maxFile, maxReading)                            // back again
    expect(qc({ QUOTA_STATE: state }).stdout).toBe('')
    render(join(root, 'agents', 'prorab'), MAX_RESET, 100)        // a NEW level is a new alert, and only that one is named
    const t4 = qc({ QUOTA_STATE: state }).stdout
    expect(t4).toContain('Max: heti keret: 100%')
    expect(t4).not.toContain('Team:')
  })

  it('J3/M3: readings without a weekly reset are checked, not skipped or fatal', () => {
    knowBoth()
    render(join(root, 'agents', 'grafit'), TEAM_RESET, 30)
    writeFileSync(join(root, 'store', 'claude-rate-limits', 'wk-1.json'), JSON.stringify({
      written_at: now, rate_limits: { five_hour: { used_percentage: 99, resets_at: now + 1800 } },
    }))
    const r = qc()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/ismeretlen fiok: 5 oras keret: 99%/)
    rmSync(join(root, 'store', 'claude-rate-limits', 'wk-1.json'))
    writeFileSync(join(root, 'store', '.claude-rate-limits.json'), JSON.stringify({
      written_at: now, rate_limits: { five_hour: { used_percentage: 97, resets_at: now + 1800 } },
    }))
    expect(qc().stdout).toMatch(/ismeretlen fiok: 5 oras keret: 97%/)
  })
})
