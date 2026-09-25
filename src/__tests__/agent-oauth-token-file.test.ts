// Per-agent setup-token file (agent-config.json "oauthTokenFile", card 2fb86ef2).
// Every token below is a FAKE value with the setup-token prefix; no real token is
// read or written anywhere in this file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, linkSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveOauthTokenFileSetting,
  oauthTokenFileConflict,
  checkOauthTokenFile,
  ownOauthTokenExport,
  ownOauthExportMissing,
  ownOauthLaunchVerdict,
  decideOwnOauthToken,
  SETUP_TOKEN_PREFIX,
} from '../web/agent-oauth-token-file.js'

const FAKE_TOKEN = `${SETUP_TOKEN_PREFIX}01-FAKE-agent-token-for-tests-only_0123456789`
const FAKE_FLEET = `${SETUP_TOKEN_PREFIX}01-FAKE-fleet-token-for-tests-only_9876543210`
// An API-key-shaped fake, assembled so no secret-shaped literal sits in the source (secret-gate).
const FAKE_API_KEY = ['sk', 'ant', 'api03', 'FAKE-not-a-setup-token'].join('-')
const UID = typeof process.getuid === 'function' ? process.getuid() : -1

let tmp: string
let fleet: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oauth-token-file-'))
  fleet = join(tmp, 'fleet.token')
  writeFileSync(fleet, FAKE_FLEET + '\n', { mode: 0o600 })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function tokenFile(name: string, content: string, mode = 0o600): string {
  const p = join(tmp, name)
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}
const check = (path: string, uid: number | null = UID) => checkOauthTokenFile(path, { uid, fleetTokenPath: fleet })

describe('resolveOauthTokenFileSetting: only an ABSENT key is "unset"', () => {
  it('absent key, empty object, non-object and unparseable text without the key -> unset', () => {
    expect(resolveOauthTokenFileSetting('{}')).toEqual({ state: 'unset' })
    expect(resolveOauthTokenFileSetting('{"model":"claude-opus-5-5"}')).toEqual({ state: 'unset' })
    expect(resolveOauthTokenFileSetting('[]')).toEqual({ state: 'unset' })
    expect(resolveOauthTokenFileSetting('{broken')).toEqual({ state: 'unset' })
  })

  it('a valid absolute path -> set (trimmed)', () => {
    expect(resolveOauthTokenFileSetting('{"oauthTokenFile":" /home/u/.config/t/a.token "}'))
      .toEqual({ state: 'set', path: '/home/u/.config/t/a.token' })
  })

  it('a present but unusable value is INVALID, never unset (unset would mean the fleet token)', () => {
    const cases: [string, string][] = [
      ['{"oauthTokenFile":null}', 'not-a-string'],
      ['{"oauthTokenFile":42}', 'not-a-string'],
      ['{"oauthTokenFile":""}', 'blank'],
      ['{"oauthTokenFile":"   "}', 'blank'],
      ['{"oauthTokenFile":"tokens/a.token"}', 'not-absolute'],
      ['{"oauthTokenFile":"~/a.token"}', 'not-absolute'],
      [`{"oauthTokenFile":"/tmp/a'b.token"}`, 'path-bad-characters'],
      ['{"oauthTokenFile":"/tmp/a b.token"}', 'path-bad-characters'],
      ['{"oauthTokenFile":"/tmp/$(id).token"}', 'path-bad-characters'],
      ['{"oauthTokenFile":"/tmp/../etc/a.token"}', 'path-parent-traversal'],
      ['{"oauthTokenFile":"/tmp/x" broken', 'config-unparseable'],
    ]
    for (const [raw, reason] of cases) {
      expect(resolveOauthTokenFileSetting(raw), raw).toEqual({ state: 'invalid', reason })
    }
  })
})

describe('oauthTokenFileConflict: a setting the field cannot take effect under refuses', () => {
  const base = { isMainAgent: false, isRemote: false, isCustomProvider: false, isClaudeModel: true, authMode: 'shared' as const, hasExplicitConfigDir: false, hasClaudePlan: false }
  it('a plain shared-mode local sub-agent has no conflict', () => {
    expect(oauthTokenFileConflict(base)).toBeNull()
  })
  it('names each conflict', () => {
    expect(oauthTokenFileConflict({ ...base, isMainAgent: true })).toBe('main-agent')
    expect(oauthTokenFileConflict({ ...base, isRemote: true })).toBe('remote-agent')
    expect(oauthTokenFileConflict({ ...base, authMode: 'own_team' })).toBe('auth-mode-own_team')
    expect(oauthTokenFileConflict({ ...base, authMode: 'api' })).toBe('auth-mode-api')
    expect(oauthTokenFileConflict({ ...base, isCustomProvider: true })).toBe('custom-provider')
    expect(oauthTokenFileConflict({ ...base, isClaudeModel: false })).toBe('non-claude-model')
    // A custom provider refuses even with a claude- model id: customProvider wins over the pattern.
    expect(oauthTokenFileConflict({ ...base, isCustomProvider: true, isClaudeModel: true })).toBe('custom-provider')
    expect(oauthTokenFileConflict({ ...base, hasExplicitConfigDir: true })).toBe('explicit-config-dir')
    expect(oauthTokenFileConflict({ ...base, hasClaudePlan: true })).toBe('explicit-config-dir')
  })
})

describe('checkOauthTokenFile: the file itself', () => {
  it('POSITIVE: a valid 0600 file -> ok, with the path and an 8-char sha256 fingerprint of the exported value', () => {
    const p = tokenFile('agent.token', FAKE_TOKEN + '\n')
    const r = check(p)
    expect(r).toEqual({
      ok: true,
      path: p,
      fingerprint: createHash('sha256').update(FAKE_TOKEN).digest('hex').slice(0, 8),
    })
  })

  it('a stricter mode (0400) is accepted', () => {
    expect(check(tokenFile('ro.token', FAKE_TOKEN, 0o400)).ok).toBe(true)
  })

  it('NEGATIVE: missing file -> missing', () => {
    expect(check(join(tmp, 'nincs.token'))).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('NEGATIVE: 0644, 0640 and 0700 -> mode-too-open (0600 or stricter only)', () => {
    for (const mode of [0o644, 0o640, 0o700, 0o604]) {
      const r = check(tokenFile(`m${mode.toString(8)}.token`, FAKE_TOKEN, mode))
      expect(r, mode.toString(8)).toMatchObject({ ok: false, reason: 'mode-too-open' })
    }
  })

  it('NEGATIVE: empty content (also a bare newline) -> empty', () => {
    expect(check(tokenFile('e1.token', ''))).toMatchObject({ ok: false, reason: 'empty' })
    expect(check(tokenFile('e2.token', '\n'))).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('NEGATIVE: wrong prefix -> bad-prefix (an API key is not a setup-token)', () => {
    expect(check(tokenFile('api.token', FAKE_API_KEY))).toMatchObject({ ok: false, reason: 'bad-prefix' })
    expect(check(tokenFile('ws.token', ` ${FAKE_TOKEN}`))).toMatchObject({ ok: false, reason: 'bad-prefix' })
  })

  it('NEGATIVE: whitespace or control characters inside -> content-bad-characters', () => {
    expect(check(tokenFile('sp.token', `${FAKE_TOKEN} extra`))).toMatchObject({ ok: false, reason: 'content-bad-characters' })
    expect(check(tokenFile('cr.token', `${FAKE_TOKEN}\r\n`))).toMatchObject({ ok: false, reason: 'content-bad-characters' })
  })

  it('NEGATIVE: a symlink is not the agent own file -> not-regular-file', () => {
    const target = tokenFile('real.token', FAKE_TOKEN)
    const link = join(tmp, 'link.token')
    symlinkSync(target, link)
    expect(check(link)).toMatchObject({ ok: false, reason: 'not-regular-file' })
  })

  it('NEGATIVE: the fleet file itself, or a hard link to it -> is-fleet-file', () => {
    expect(check(fleet)).toMatchObject({ ok: false, reason: 'is-fleet-file' })
    const hard = join(tmp, 'hard.token')
    linkSync(fleet, hard)
    expect(check(hard)).toMatchObject({ ok: false, reason: 'is-fleet-file' })
  })

  it('NEGATIVE: a copy of the fleet token under another name -> same-as-fleet-token', () => {
    expect(check(tokenFile('copy.token', FAKE_FLEET + '\n'))).toMatchObject({ ok: false, reason: 'same-as-fleet-token' })
  })

  it('NEGATIVE: another owner -> wrong-owner; no POSIX owner check -> unsupported-platform', () => {
    const p = tokenFile('owner.token', FAKE_TOKEN)
    expect(check(p, UID + 1)).toMatchObject({ ok: false, reason: 'wrong-owner' })
    expect(check(p, null)).toMatchObject({ ok: false, reason: 'unsupported-platform' })
  })

  it('NO result carries the token value, not even a rejection detail', () => {
    const results = [
      check(tokenFile('v.token', FAKE_TOKEN)),
      check(tokenFile('v644.token', FAKE_TOKEN, 0o644)),
      check(tokenFile('vsp.token', `${FAKE_TOKEN} x`)),
      check(tokenFile('vcopy.token', FAKE_FLEET)),
      check(tokenFile('vown.token', FAKE_TOKEN), UID + 1),
    ]
    for (const r of results) {
      const s = JSON.stringify(r)
      expect(s).not.toContain(FAKE_TOKEN)
      expect(s).not.toContain(FAKE_FLEET)
      expect(s).not.toContain('FAKE-')
    }
  })
})

describe('decideOwnOauthToken: the whole decision', () => {
  const ctx = (raw: string, over: Partial<Parameters<typeof decideOwnOauthToken>[0]> = {}) => decideOwnOauthToken({
    rawConfigJson: raw, isMainAgent: false, isRemote: false, isCustomProvider: false, isClaudeModel: true, authMode: 'shared',
    hasExplicitConfigDir: false, hasClaudePlan: false, fleetTokenPath: fleet, uid: UID, ...over,
  })

  it('no field -> unset (the launcher then runs exactly as before)', () => {
    expect(ctx('{"model":"claude-opus-5-5"}')).toEqual({ kind: 'unset' })
  })

  it('a valid file -> ok with path and fingerprint', () => {
    const p = tokenFile('ok.token', FAKE_TOKEN)
    expect(ctx(JSON.stringify({ oauthTokenFile: p }))).toMatchObject({ kind: 'ok', path: p })
  })

  it('an invalid value, a conflict or a bad file -> refused, with the reason', () => {
    expect(ctx('{"oauthTokenFile":"rel/a.token"}')).toMatchObject({ kind: 'refused', reason: 'not-absolute' })
    const p = tokenFile('ok2.token', FAKE_TOKEN)
    expect(ctx(JSON.stringify({ oauthTokenFile: p }), { authMode: 'own_team' })).toMatchObject({ kind: 'refused', reason: 'auth-mode-own_team' })
    expect(ctx(JSON.stringify({ oauthTokenFile: join(tmp, 'missing.token') }))).toMatchObject({ kind: 'refused', reason: 'missing' })
  })

  // #1511 review (custom-provider path on develop): a valid own token on an agent
  // that is not a Claude OAuth agent refuses, and the refusal names why.
  it('a valid file on a custom-provider, non-Claude or api agent -> refused, never ok', () => {
    const p = tokenFile('ok3.token', FAKE_TOKEN)
    const raw = JSON.stringify({ oauthTokenFile: p })
    expect(ctx(raw)).toMatchObject({ kind: 'ok' })
    expect(ctx(raw, { isCustomProvider: true })).toMatchObject({ kind: 'refused', path: p, reason: 'custom-provider' })
    expect(ctx(raw, { isClaudeModel: false })).toMatchObject({ kind: 'refused', path: p, reason: 'non-claude-model' })
    expect(ctx(raw, { authMode: 'api' })).toMatchObject({ kind: 'refused', path: p, reason: 'auth-mode-api' })
  })
})

describe('ownOauthTokenExport: the fleet shape, only the file differs', () => {
  it('is the fleet export with the path swapped, and never names the fleet file', () => {
    const p = '/home/u/.config/marveen/tokens/a.token'
    const fleetShape = (file: string) => `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${file}')" && `
    expect(ownOauthTokenExport(p)).toBe(fleetShape(p))
    expect(ownOauthTokenExport(p)).not.toContain(fleet)
  })
})

describe('ownOauthExportMissing: an ok decision must reach the launch env', () => {
  const p = '/home/u/.config/marveen/tokens/a.token'
  const ok = { kind: 'ok' as const, path: p, fingerprint: 'abcd1234' }
  const fleetEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${fleet}')" && `
  it('ok + its own export -> not missing', () => {
    expect(ownOauthExportMissing(ok, ownOauthTokenExport(p))).toBe(false)
  })
  it('ok + the fleet export, an empty env or another file -> missing', () => {
    expect(ownOauthExportMissing(ok, fleetEnv)).toBe(true)
    expect(ownOauthExportMissing(ok, '')).toBe(true)
    expect(ownOauthExportMissing(ok, ownOauthTokenExport('/other/b.token'))).toBe(true)
  })
  it('unset and refused never mismatch (they carry no own export)', () => {
    expect(ownOauthExportMissing({ kind: 'unset' }, fleetEnv)).toBe(false)
    expect(ownOauthExportMissing({ kind: 'refused', path: p, reason: 'missing', detail: '' }, '')).toBe(false)
  })
})

// PR #1511 review: the link between the fail-closed decision and the export.
// The launcher acts on ownOauthLaunchVerdict(decision, oauthTokenEnv) for BOTH
// the refusal and the "own setup-token exported" log, so these cases are the
// launcher's behaviour for every decision/env pair it can end up with.
describe('ownOauthLaunchVerdict: the decision and the actual export cannot diverge', () => {
  const p = '/home/u/.config/marveen/tokens/a.token'
  const ok = { kind: 'ok' as const, path: p, fingerprint: 'abcd1234' }
  const fleetEnv = () => `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${fleet}')" && `
  const envs = () => ({
    own: ownOauthTokenExport(p),
    fleet: fleetEnv(),
    empty: '',
    other: ownOauthTokenExport('/other/b.token'),
  })

  it('ok + the own export in the env -> own, carrying the path and fingerprint for the log', () => {
    expect(ownOauthLaunchVerdict(ok, ownOauthTokenExport(p))).toEqual({ kind: 'own', path: p, fingerprint: 'abcd1234' })
  })

  it('ok + the FLEET export (the review mutant), an empty env or another file -> refuse, never own', () => {
    for (const env of [envs().fleet, envs().empty, envs().other]) {
      expect(ownOauthLaunchVerdict(ok, env)).toEqual({ kind: 'refuse', path: p })
    }
  })

  it('unset and refused decisions never claim the own token, whatever the env', () => {
    for (const env of Object.values(envs())) {
      expect(ownOauthLaunchVerdict({ kind: 'unset' }, env)).toEqual({ kind: 'not-own' })
      expect(ownOauthLaunchVerdict({ kind: 'refused', path: p, reason: 'missing', detail: '' }, env)).toEqual({ kind: 'not-own' })
    }
  })

  it('invariant over every pair: "own" only when the env is exactly the own export, and an ok decision never ends in "not-own"', () => {
    const decisions = [ok, { kind: 'unset' as const }, { kind: 'refused' as const, path: p, reason: 'missing', detail: '' }]
    for (const d of decisions) {
      for (const env of Object.values(envs())) {
        const v = ownOauthLaunchVerdict(d, env)
        if (v.kind === 'own') {
          expect(env).toBe(ownOauthTokenExport(v.path))
          expect(env).not.toContain(fleet)
        }
        if (d.kind === 'ok') expect(v.kind).not.toBe('not-own')
      }
    }
  })
})

// Source-level contract for the launcher wiring (startAgentProcess), in the
// style of isolated-channel-config.test.ts: the order of the steps is what
// makes the field fail-closed, and a refactor that reorders them would not
// break any unit above.
describe('launcher wiring (agent-process.ts)', () => {
  const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
  const start = SRC.indexOf('export async function startAgentProcess(')
  const end = SRC.indexOf('\nexport async function', start + 1)
  const FN = SRC.slice(start, end)
  const FLEET_EXPORT = 'oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat \'${FLEET_OAUTH_TOKEN_PATH}\')" && `'

  it('decides BEFORE the remote branch, the running check and any tmux call, and a refusal returns', () => {
    const decide = FN.indexOf('decideOwnOauthToken({')
    expect(decide).toBeGreaterThan(0)
    expect(decide).toBeLessThan(FN.indexOf('return startRemoteAgentProcess('))
    expect(decide).toBeLessThan(FN.indexOf('if (isAgentRunning(name))'))
    expect(decide).toBeLessThan(FN.indexOf('runTmux('))
    const refused = FN.slice(FN.indexOf("if (ownOauth.kind === 'refused') {"))
    expect(refused.slice(0, 400)).toMatch(/return \{ ok: false, error: `oauthTokenFile: /)
  })

  it('both export sites put the own file FIRST, and the fleet export only in the else-branch', () => {
    expect(FN).toMatch(/if \(ownTokenFile\) \{\n\s+\/\/ 2fb86ef2[^\n]*\n\s+oauthTokenEnv = ownOauthTokenExport\(ownTokenFile\)\n\s+\} else if \(!claudeConfigDir && hasFleetOauthToken\(\) && needsFleetOauth\) \{/)
    const ownBranch = FN.match(/\} else if \(ownTokenFile\) \{[\s\S]*?\n {6}\} else if \(hasFleetOauthToken\(\)\) \{/)?.[0] ?? ''
    expect(ownBranch).not.toBe('')
    expect(ownBranch).toContain('oauthTokenEnv = ownOauthTokenExport(ownTokenFile)')
    expect(ownBranch).not.toContain('FLEET_OAUTH_TOKEN_PATH')
    // Requirement 2: isolated exactly as in shared mode -- the SAME provisioning call as the fleet branch.
    const fleetBranch = FN.match(/\} else if \(hasFleetOauthToken\(\)\) \{[\s\S]*?\n {6}\} else \{/)?.[0] ?? ''
    const isolateCall = 'const isolated = ensureIsolatedChannelConfigDir(name, hasChannel ? agentProvider : null)'
    expect(fleetBranch).toContain(isolateCall)
    expect(ownBranch).toContain(isolateCall)
  })

  it('NO FIELD -> unchanged: the two fleet export statements are still there, byte for byte', () => {
    expect(FN.split(FLEET_EXPORT).length - 1).toBe(2)
  })

  it('the decision gets the launcher\'s own custom-provider and isClaude discriminators', () => {
    const call = FN.slice(FN.indexOf('decideOwnOauthToken({'), FN.indexOf('if (ownOauth.kind === \'refused\') {'))
    expect(call).toContain('isCustomProvider: readAgentCustomProvider(name) !== null,')
    expect(call).toContain("isClaudeModel: resolveOpenRouterModel(readAgentModel(name)).startsWith('claude-'),")
    // Same predicates the launcher uses further down.
    expect(FN).toContain('const isCustom = customProviderId !== null')
    expect(FN).toContain("const isClaude = !isCustom && model.startsWith('claude-')")
    expect(FN).toContain('const model = isCustom ? rawModel : resolveOpenRouterModel(rawModel)')
  })

  it('backstop: an own token on an agent the launcher sees as non-Claude refuses before any export', () => {
    const isClaudeAt = FN.indexOf("const isClaude = !isCustom && model.startsWith('claude-')")
    const guardAt = FN.indexOf('if (ownTokenFile && !isClaude) {')
    expect(guardAt).toBeGreaterThan(isClaudeAt)
    expect(guardAt).toBeLessThan(FN.indexOf('oauthTokenEnv = '))
    expect(FN.slice(guardAt, guardAt + 500)).toMatch(/return \{ ok: false, error: 'oauthTokenFile: not a Claude OAuth agent' \}/)
  })

  it('a Claude agent with its own token that could not be isolated refuses (shared root = host credential)', () => {
    const guard = FN.slice(FN.indexOf('if (ownTokenFile && isClaude && !claudeConfigDir) {'))
    expect(guard.length).toBeLessThan(FN.length)
    expect(guard.slice(0, 500)).toMatch(/return \{ ok: false, error: 'oauthTokenFile: isolated config dir could not be provisioned' \}/)
  })

  it('logs the path and the fingerprint only; the launcher never reads the token file itself', () => {
    expect(FN).toMatch(/\{ name, path: ownLaunch\.path, fingerprint: ownLaunch\.fingerprint \}/)
    expect(FN).not.toMatch(/readFileSync\(\s*own(TokenFile|Oauth)/)
  })

  // PR #1511 review mutant: `const ownTokenFile = ... ? ownOauth.path : null` -> `null`
  // left all tests green while the agent ran on the fleet token and the log still
  // claimed the own token. The link is pinned end to end: the ok path is handed to
  // the export sites, ONE verdict computed from the real oauthTokenEnv (after its
  // last write, before the launch command) drives the refusal and the log, and
  // nothing else in the launcher can emit the claim.
  it('decision -> export -> verdict -> log is one chain: an ok decision that misses the env refuses, and only the env can make the claim', () => {
    expect(FN).toContain("const ownTokenFile = ownOauth.kind === 'ok' ? ownOauth.path : null")
    const verdictAt = FN.indexOf('const ownLaunch = ownOauthLaunchVerdict(ownOauth, oauthTokenEnv)')
    expect(verdictAt).toBeGreaterThan(0)
    expect(FN.split('ownOauthLaunchVerdict(').length - 1).toBe(1)
    expect(verdictAt).toBeGreaterThan(FN.lastIndexOf('oauthTokenEnv = '))
    expect(verdictAt).toBeLessThan(FN.indexOf('const buildLaunchCmd'))
    const refuseAt = FN.indexOf("if (ownLaunch.kind === 'refuse') {", verdictAt)
    expect(refuseAt).toBeGreaterThan(verdictAt)
    expect(FN.slice(refuseAt, refuseAt + 500)).toMatch(/return \{ ok: false, error: 'oauthTokenFile: own token did not reach the launch env' \}/)
    const CLAIM = "'oauthTokenFile: own setup-token exported instead of the fleet token'"
    expect(FN.split(CLAIM).length - 1).toBe(1)
    const logAt = FN.indexOf(CLAIM)
    expect(logAt).toBeGreaterThan(refuseAt)
    const logGate = FN.lastIndexOf('if (', logAt)
    expect(FN.slice(logGate, logAt)).toMatch(/^if \(ownLaunch\.kind === 'own'\) \{\s+logger\.info\(\s+\{ name, path: ownLaunch\.path, fingerprint: ownLaunch\.fingerprint \},\s+$/)
    // The decision itself is read in exactly one place after the refusal return:
    // the ownTokenFile hand-off. A second `ownOauth.kind === 'ok'` would be a
    // claim or an export gated on the decision instead of the env.
    expect(FN.split("ownOauth.kind === 'ok'").length - 1).toBe(1)
  })

  it('the API cannot write the field (write path: manual agent-config edit only)', () => {
    const routes = readFileSync(join(__dirname, '../web/routes/agents.ts'), 'utf-8')
    expect(routes).not.toContain('oauthTokenFile')
  })
})
