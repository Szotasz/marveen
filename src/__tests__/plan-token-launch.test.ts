// SUBPLANTOKEN1110: a sub-agent on a TOKEN-mode Claude plan runs on that plan's token in its isolated
// dir, or does not start -- never on the fleet token in silence. The decision (plan-token-launch.ts), the
// resolution (claude-plans.ts resolveAgentConfigDir) and the launcher wiring (agent-process.ts, source level,
// in the style of agent-oauth-token-file.test.ts) are pinned here.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'plan-token-launch-test-'))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: tmpRoot }))

const {
  planTokenLaunchDecision, planTokenExport, writePlanTokenStatus, readPlanTokenStatus, clearPlanTokenStatus,
  planTokenStatusPath, waitPlanTokenOutcome, shouldAlertPlanToken, resetPlanTokenAlerts,
} = await import('../web/plan-token-launch.js')
const { resolveAgentConfigDir, resolveAgentConfigDirForRead, subAgentTokenPlanIds, CLAUDE_PLANS_PATH } = await import('../web/claude-plans.js')
const { selectPlansToProbe } = await import('../claude-plan-usage-probe.js')
const { agentUsesFleetToken } = await import('../claude-plan-fleet-rotation.js')

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const TOKEN_FIXTURE = 'test-fixture-not-a-real-plan-token-oat01'
const ok = {
  tokenSecretId: 'claude-plan-token-tok-b', isMainAgent: false, isClaudeModel: true, isCustomProvider: false,
  authMode: 'subscription', hasOwnTokenFile: false, secretPresent: true,
}

describe('planTokenLaunchDecision: the four branches', () => {
  it('no token plan -> none (every other launcher branch runs as before)', () => {
    expect(planTokenLaunchDecision({ ...ok, tokenSecretId: null })).toEqual({ kind: 'none' })
  })
  it('the main agent -> none (channels.sh / channel-monitor have their own token path)', () => {
    expect(planTokenLaunchDecision({ ...ok, isMainAgent: true })).toEqual({ kind: 'none' })
  })
  it('a usable plan token -> plan-token with the vault reference id', () => {
    expect(planTokenLaunchDecision(ok)).toEqual({ kind: 'plan-token', secretId: 'claude-plan-token-tok-b' })
  })
  it('missing from the vault -> refuse (not a fall-back)', () => {
    expect(planTokenLaunchDecision({ ...ok, secretPresent: false })).toEqual({ kind: 'refuse', reason: 'plan-token-missing-from-vault' })
  })
  it('a second token source (oauthTokenFile) -> refuse, fail closed', () => {
    expect(planTokenLaunchDecision({ ...ok, hasOwnTokenFile: true })).toEqual({ kind: 'refuse', reason: 'plan-token-conflicts-with-oauthTokenFile' })
  })
  it('authMode api / own_team -> refuse (the plan token would replace the key or the own login)', () => {
    expect(planTokenLaunchDecision({ ...ok, authMode: 'api' }).kind).toBe('refuse')
    expect(planTokenLaunchDecision({ ...ok, authMode: 'own_team' }).kind).toBe('refuse')
  })
  it('a custom provider or a non-Claude model -> refuse', () => {
    expect(planTokenLaunchDecision({ ...ok, isCustomProvider: true }).kind).toBe('refuse')
    expect(planTokenLaunchDecision({ ...ok, isClaudeModel: false }).kind).toBe('refuse')
  })
  it('the conflict outranks the vault check (a refusal names the conflict even when the secret is gone)', () => {
    expect(planTokenLaunchDecision({ ...ok, hasOwnTokenFile: true, secretPresent: false })).toEqual({ kind: 'refuse', reason: 'plan-token-conflicts-with-oauthTokenFile' })
  })
})

describe('planTokenExport: the launch piece', () => {
  const base = {
    secretId: 'claude-plan-token-tok-b', nodeBin: '/opt/node/bin/node', scriptPath: '/x/scripts/resolve-plan-token-env.mjs',
    fleetTokenPath: '/x/store/.claude-oauth-token', failuresLogPath: '/x/store/channels-failures.log', statusPath: '/x/store/plan-token-launch/devy.json',
  }
  it('a bare assignment, then the export; --strict and --status always; every path single-quoted', () => {
    expect(planTokenExport(base)).toBe(
      `_plan_token="$('/opt/node/bin/node' '/x/scripts/resolve-plan-token-env.mjs' 'claude-plan-token-tok-b' '/x/store/.claude-oauth-token' '/x/store/channels-failures.log' --strict --status '/x/store/plan-token-launch/devy.json')" && export CLAUDE_CODE_OAUTH_TOKEN="$_plan_token" && `,
    )
  })
  it('a quote in a path stays one inert word', () => {
    const s = planTokenExport({ ...base, scriptPath: "/x/it's/$(touch pwned)/r.mjs" })
    expect(s).toContain(`'/x/it'\\''s/$(touch pwned)/r.mjs'`)
  })
  it('carries the vault reference only, never a token value', () => {
    expect(planTokenExport(base)).not.toContain(TOKEN_FIXTURE)
    expect(planTokenExport(base)).not.toMatch(/sk-ant|oat01/)
  })
})

describe('the status file', () => {
  const dir = join(tmpRoot, 'status-unit')
  beforeEach(() => { rmSync(dir, { recursive: true, force: true }); resetPlanTokenAlerts() })

  it('round-trips, 0600, and clears', () => {
    writePlanTokenStatus('devy', { state: 'refused', secretId: 's', at: 5, planId: 'tok-b', reason: 'r' }, dir)
    expect(statSync(planTokenStatusPath('devy', dir)).mode & 0o777).toBe(0o600)
    expect(readPlanTokenStatus('devy', dir)).toEqual({ state: 'refused', secretId: 's', at: 5, planId: 'tok-b', reason: 'r' })
    clearPlanTokenStatus('devy', dir)
    expect(readPlanTokenStatus('devy', dir)).toBeNull()
  })
  it('a malformed or unknown-state file reads as null, not as a state', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(planTokenStatusPath('devy', dir), '{"state":"ok-trust-me","secretId":"s","at":1}')
    expect(readPlanTokenStatus('devy', dir)).toBeNull()
    writeFileSync(planTokenStatusPath('devy', dir), 'not json')
    expect(readPlanTokenStatus('devy', dir)).toBeNull()
  })
  it('waitPlanTokenOutcome ignores a status older than the restart and a pending one', async () => {
    writePlanTokenStatus('devy', { state: 'plan-token', secretId: 's', at: 100 }, dir)
    const stale = await waitPlanTokenOutcome('devy', 200, { dir, timeoutMs: 30, stepMs: 5 })
    expect(stale?.at).toBe(100) // timed out on the old record; the route reads this as 'unknown'
    writePlanTokenStatus('devy', { state: 'pending', secretId: 's', at: 300 }, dir)
    setTimeout(() => writePlanTokenStatus('devy', { state: 'failed', secretId: 's', at: 301, reason: 'x' }, dir), 20)
    const got = await waitPlanTokenOutcome('devy', 200, { dir, timeoutMs: 2000, stepMs: 5 })
    expect(got).toMatchObject({ state: 'failed', at: 301 })
  })
  it('the owner alert is throttled per agent and reason, one an hour', () => {
    expect(shouldAlertPlanToken('devy', 'r', 0)).toBe(true)
    expect(shouldAlertPlanToken('devy', 'r', 60_000)).toBe(false)
    expect(shouldAlertPlanToken('devy', 'other', 60_000)).toBe(true)
    expect(shouldAlertPlanToken('iris', 'r', 60_000)).toBe(true)
    expect(shouldAlertPlanToken('devy', 'r', 60 * 60 * 1000)).toBe(true)
  })
})

describe('resolveAgentConfigDir: a token plan resolves to the agent\'s own isolated dir', () => {
  const agentCfg = (name: string, cfg: Record<string, unknown>) => {
    mkdirSync(join(tmpRoot, 'agents', name), { recursive: true })
    writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), JSON.stringify(cfg))
  }
  beforeEach(() => {
    mkdirSync(join(tmpRoot, 'store'), { recursive: true })
    writeFileSync(CLAUDE_PLANS_PATH, JSON.stringify([
      { id: 'tok-b', label: 'Token B', tokenSecretId: 'claude-plan-token-tok-b', planType: 'personal', channelsAllowed: true },
      { id: 'team', label: 'Team', configDir: '/opt/claude-team', planType: 'team', channelsAllowed: true },
    ]))
  })

  it('token plan -> agents/<name>/.claude-config, resolved, with the vault reference', () => {
    agentCfg('devy', { claudePlan: 'tok-b' })
    expect(resolveAgentConfigDir('devy')).toEqual({
      configDir: join(tmpRoot, 'agents', 'devy', '.claude-config'), planUnresolved: false, tokenSecretId: 'claude-plan-token-tok-b',
    })
  })
  it('a raw claudeConfigDir next to a token plan loses (the named plan wins, as before)', () => {
    agentCfg('devy', { claudePlan: 'tok-b', claudeConfigDir: '/opt/other' })
    expect(resolveAgentConfigDir('devy').configDir).toBe(join(tmpRoot, 'agents', 'devy', '.claude-config'))
  })
  it('configDir plan, no plan, unknown plan: the old answers, tokenSecretId null', () => {
    agentCfg('a1', { claudePlan: 'team' })
    expect(resolveAgentConfigDir('a1')).toEqual({ configDir: '/opt/claude-team', planUnresolved: false, tokenSecretId: null })
    agentCfg('a2', {})
    expect(resolveAgentConfigDir('a2')).toEqual({ configDir: null, planUnresolved: false, tokenSecretId: null })
    agentCfg('a3', { claudePlan: 'gone' })
    expect(resolveAgentConfigDir('a3')).toEqual({ configDir: null, planUnresolved: true, tokenSecretId: null })
  })
  it('the reader gets the same isolated dir', () => {
    agentCfg('devy', { claudePlan: 'tok-b' })
    expect(resolveAgentConfigDirForRead('devy')).toBe(join(tmpRoot, 'agents', 'devy', '.claude-config'))
  })
  it('the fleet leg leaves a token-plan agent alone (its configured dir is non-null)', () => {
    agentCfg('devy', { claudePlan: 'tok-b' })
    expect(agentUsesFleetToken({
      name: 'devy', mainAgentId: 'marveen', model: 'claude-opus-5', authMode: 'subscription',
      configuredConfigDir: resolveAgentConfigDir('devy').configDir, remote: false, ownTokenFile: false,
    })).toBe(false)
  })
})

// Source-level contract for the launcher (agent-process.ts startAgentProcess): the ORDER is what makes the
// path fail-closed, and a reorder would not break any unit above.
describe('launcher wiring (agent-process.ts)', () => {
  const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
  const start = SRC.indexOf('export async function startAgentProcess(')
  const end = SRC.indexOf('\nexport async function', start + 1)
  const FN = SRC.slice(start, end)
  const block = FN.slice(FN.indexOf('if (planResolution.tokenSecretId) {'), FN.indexOf('const isOwnTeam = '))

  it('the vault check and the decision come before any export, and a refusal returns', () => {
    expect(block).not.toBe('')
    const check = block.indexOf('secretPresent = !!(getSecret(planResolution.tokenSecretId)')
    const decide = block.indexOf('planTokenLaunchDecision({')
    expect(check).toBeGreaterThan(0)
    expect(decide).toBeGreaterThan(check)
    expect(block.indexOf("if (decision.kind === 'refuse') {")).toBeGreaterThan(decide)
    expect(block).toMatch(/if \(decision\.kind === 'refuse'\) \{\s+return refusePlanTokenLaunch\(/)
  })
  it('the plan branch isolates with the SAME provisioning call, refuses when it fails, and never touches the fleet token file', () => {
    expect(block).toContain('const isolated = ensureIsolatedChannelConfigDir(name, hasChannel ? agentProvider : null, extraLaunch.pluginIds)')
    expect(block).toMatch(/if \(!isolated\) \{\s+return refusePlanTokenLaunch\(name, decision\.secretId, planId, 'plan-token-isolated-config-dir-not-provisioned'\)/)
    expect(block).toContain('oauthTokenEnv = planTokenExport({')
    expect(block).not.toContain('export CLAUDE_CODE_OAUTH_TOKEN="$(cat')
    expect(block).toContain('fleetTokenPath: FLEET_OAUTH_TOKEN_PATH,') // handed to --strict, which never reads it
  })
  it('the plan branch runs before the fleet export, so the configured dir keeps the fleet branches out', () => {
    expect(FN.indexOf('if (planResolution.tokenSecretId) {')).toBeLessThan(FN.indexOf('} else if (!claudeConfigDir && hasFleetOauthToken() && needsFleetOauth) {'))
  })
  it('the claim is checked against the real launch env after its last write, before the launch command', () => {
    const at = FN.indexOf('if (planToken && !oauthTokenEnv.includes(`--strict --status ${shSingleQuote(planToken.statusPath)}`)) {')
    expect(at).toBeGreaterThan(FN.lastIndexOf('oauthTokenEnv = '))
    expect(at).toBeLessThan(FN.indexOf('const buildLaunchCmd'))
    expect(FN.slice(at, at + 300)).toContain("'plan-token-not-in-launch-env'")
  })
  it('the refusal is loud: error log, status file, throttled owner alert, an error back to the caller', () => {
    const fn = SRC.slice(SRC.indexOf('function refusePlanTokenLaunch('), SRC.indexOf('export function planTokenPreflight('))
    expect(fn).toContain('logger.error(')
    expect(fn).toContain("writePlanTokenStatus(name, { state: 'refused'")
    expect(fn).toContain('if (shouldAlertPlanToken(name, reason, Date.now())) {')
    expect(fn).toContain('void notifyChannel(')
    expect(fn).toContain('return { ok: false, error: `claude-plan: ${reason}` }')
  })
  it('the log lines name the vault reference, never a token (no getSecret value is kept)', () => {
    expect(block).not.toMatch(/const \w+ = getSecret\(/)
    expect(block).toMatch(/logger\.info\(\{ name, plan: planId, secretId: decision\.secretId \}/)
  })
})


describe('subAgentTokenPlanIds + selectPlansToProbe: a sub-agent\'s token plan is reserved (SUBPLANTOKEN1110 (b))', () => {
  const plans = [
    { id: 'a', label: 'a', tokenSecretId: 'claude-plan-token-a', planType: 'personal', channelsAllowed: true },
    { id: 'b', label: 'b', tokenSecretId: 'claude-plan-token-b', planType: 'personal', channelsAllowed: true },
    { id: 'team', label: 'team', configDir: '/opt/team', planType: 'team', channelsAllowed: true },
  ] as Parameters<typeof subAgentTokenPlanIds>[0]
  const planOf: Record<string, string | null> = { marveen: 'a', iris: 'b', devy: 'team', zara: null, ghost: 'gone' }

  it('only a SUB-agent\'s TOKEN plan counts: not the main agent\'s, not a configDir plan, not an unknown id', () => {
    expect([...subAgentTokenPlanIds(plans, Object.keys(planOf), (n) => planOf[n] ?? null, 'marveen')]).toEqual(['b'])
  })
  it('a config read that throws is skipped, not fatal', () => {
    expect([...subAgentTokenPlanIds(plans, ['iris', 'broken'], (n) => { if (n === 'broken') throw new Error('x'); return planOf[n] ?? null }, 'marveen')]).toEqual(['b'])
  })
  it('selectPlansToProbe skips a reserved plan, and without the set behaves as before', () => {
    const state = { activePlanByAgent: { marveen: 'a' }, plans: {} }
    expect(selectPlansToProbe({ plans, state, activeAgentId: 'marveen', nowMs: 1e13 }).map((p) => p.id)).toEqual(['b'])
    expect(selectPlansToProbe({ plans, state, activeAgentId: 'marveen', nowMs: 1e13, reservedPlanIds: new Set(['b']) })).toEqual([])
  })
})

// SUBPLANTOKEN1110 follow-up (Dani 75495 (1)): a plan-token launch never carries an ANTHROPIC_API_KEY. The host key
// outranks the OAuth token, so it riding along would silently bill the key instead of the plan. Pinned on its own, not
// only through the configured dir (a resolveAgentConfigDir that one day answered null for a token plan must not
// reopen it).
describe('a plan-token launch unsets ANTHROPIC_API_KEY and never exports one', () => {
  const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
  const start = SRC.indexOf('export async function startAgentProcess(')
  const FN = SRC.slice(start, SRC.indexOf('\nexport async function', start + 1))

  it('the inherited-auth unset treats the plan token as an own token: both variables are unset, even with no configured dir', async () => {
    const { inheritedAuthUnset } = await import('../web/inherited-auth-unset.js')
    for (const keyMode of ['keyonly', 'subscription', 'none'] as const) {
      expect(inheritedAuthUnset({ needsFleetOauth: true, isOwnTeam: false, configuredConfigDir: false, ownTokenFile: true, keyMode }))
        .toBe('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ')
    }
    expect(FN).toContain('ownTokenFile: ownTokenFile !== null || planToken !== null, keyMode })')
  })
  it('the key-only host-key export excludes a plan-token launch by name', () => {
    const at = FN.indexOf("if (!stampKey && keyMode === 'keyonly' && needsFleetOauth")
    expect(at).toBeGreaterThan(0)
    expect(FN.slice(at, FN.indexOf('{', at))).toContain('&& !planToken)')
  })
  it('the per-agent API key export exists only on the authMode=api path, which a plan token refuses', () => {
    const exports = FN.split('apiKeyEnv = `export ANTHROPIC_API_KEY=').length - 1
    expect(exports).toBe(2) // the authMode=api key, and the key-only host key guarded above
    expect(planTokenLaunchDecision({ ...ok, authMode: 'api' }).kind).toBe('refuse')
  })
  it('in the launch command the unset comes before the plan token\'s export', () => {
    const cmd = FN.slice(FN.indexOf('const buildLaunchCmd'))
    expect(cmd.indexOf('${byoUnsetEnv}')).toBeGreaterThan(-1)
    expect(cmd.indexOf('${byoUnsetEnv}')).toBeLessThan(cmd.indexOf('${oauthTokenEnv}'))
  })
})
