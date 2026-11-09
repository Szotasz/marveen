// MAINAUTH1107 (APIKULCSINDITAS1004 A): the main agent's credential, decided once and applied by every launch path.
// Fake credentials only; every file lives in a throwaway dir.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMainAuth, cfgKindFromDecision, cfgKindFromHelperMode, decideMainAuth, mainAuthPaths, readMainOauthToken,
  type MainAuthInputs,
} from '../web/main-auth.js'

const KEY = 'fake-main-api-key-value-0123456789abcdef' // no vendor prefix: the logic never looks at it
const ENV_KEY = 'fake-env-api-key-value-9876543210fedcba'
const TOKEN = 'fake-oauth-token-value'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (p = 'mauth-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }

const base = (o: Partial<MainAuthInputs> = {}): MainAuthInputs => ({
  authMode: 'shared', installMode: 'subscription', vaultKey: '', envKey: '', oauthToken: TOKEN,
  cfgKind: 'shared', cfgDir: null, customProvider: false, home: '/home/test', ...o,
})

describe('decideMainAuth', () => {
  it('shared on a subscription install: the token, NO key (even with one in .env and the vault), the key unset after CFG_ENV', () => {
    const d = decideMainAuth(base({ envKey: ENV_KEY, vaultKey: KEY }))
    expect(d).toMatchObject({ configured: 'shared', effective: 'subscription', key: '', token: TOKEN, postUnset: ['ANTHROPIC_API_KEY'], stampTarget: null, conflict: null })
  })
  it('shared on a key-only install: the .env key, stamped (not ledgered) in the config dir it runs on', () => {
    expect(decideMainAuth(base({ installMode: 'keyonly', oauthToken: '', envKey: ENV_KEY }))).toMatchObject({
      effective: 'keyonly', keySource: 'env', key: ENV_KEY, token: '', postUnset: [], stampTarget: '/home/test/.claude.json', ledgered: false,
    })
    expect(decideMainAuth(base({ installMode: 'keyonly', oauthToken: '', envKey: ENV_KEY, cfgKind: 'own-login', cfgDir: '/c' })).stampTarget).toBeNull()
  })
  it('shared with nothing: none', () => {
    expect(decideMainAuth(base({ installMode: 'none', oauthToken: '' }))).toMatchObject({ effective: 'none', key: '', token: '', postUnset: [] })
  })
  it('api: the vault key first, no token, the token unset after CFG_ENV, the switch\'s ledgered stamp', () => {
    expect(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, envKey: ENV_KEY }))).toMatchObject({
      configured: 'api', effective: 'api', keySource: 'vault', key: KEY, token: '', postUnset: ['CLAUDE_CODE_OAUTH_TOKEN'],
      stampTarget: '/home/test/.claude.json', ledgered: true, conflict: null,
    })
    expect(decideMainAuth(base({ authMode: 'api', envKey: ENV_KEY }))).toMatchObject({ keySource: 'env', key: ENV_KEY })
  })
  it('api on an isolated main stamps the isolated dir, not the shared file', () => {
    expect(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, cfgKind: 'isolated', cfgDir: '/iso' })).stampTarget).toBe('/iso/.claude.json')
  })
  it.each([
    ['custom provider', { customProvider: true }, 'custom-provider'],
    ['own login (explicit/rotated)', { cfgKind: 'own-login' as const, cfgDir: '/own' }, 'own-login'],
    ['token-mode rotated plan', { cfgKind: 'plan-token' as const, cfgDir: '/plan' }, 'plan-token'],
    ['no key anywhere', { vaultKey: '', envKey: '' }, 'no-key'],
  ])('api conflict (%s) falls to the side that does not bill, with a reason', (_n, o, conflict) => {
    const d = decideMainAuth(base({ authMode: 'api', vaultKey: KEY, ...o }))
    expect(d.effective).toBe('subscription')
    expect(d.key).toBe('')
    expect(d.ledgered).toBe(false)
    expect(d.conflict).toBe(conflict)
  })
  it('own_team is no main-agent mode: shared rule, with a reason', () => {
    expect(decideMainAuth(base({ authMode: 'own_team' }))).toMatchObject({ configured: 'shared', effective: 'subscription', conflict: 'own-team' })
  })
  it('the config-dir kind from the helper\'s mode line and from the dashboard decision agree', () => {
    expect(['explicit', 'rotated', 'token', 'isolated', ''].map(cfgKindFromHelperMode)).toEqual(['own-login', 'own-login', 'plan-token', 'isolated', 'shared'])
    expect(cfgKindFromDecision({ isolatedConfigDir: null, ownCredentials: false })).toBe('shared')
    expect(cfgKindFromDecision({ isolatedConfigDir: '/d', ownCredentials: true })).toBe('own-login')
    expect(cfgKindFromDecision({ isolatedConfigDir: '/d', ownCredentials: false, tokenSecretId: 'p1' })).toBe('plan-token')
    expect(cfgKindFromDecision({ isolatedConfigDir: '/d', ownCredentials: false })).toBe('isolated')
  })
})

const run = (script: string, env: Record<string, string> = {}) =>
  execFileSync('/bin/bash', ['-c', script], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', ...env } })

describe('applyMainAuth', () => {
  const setup = () => {
    const store = tmp('mauth-store-')
    const home = tmp('mauth-home-')
    return { store, home, paths: mainAuthPaths(store), dot: join(home, '.claude.json') }
  }
  const sh = (paths: ReturnType<typeof mainAuthPaths>, env: Record<string, string>) =>
    // the launch order: pane-auth, the config branch (here: a token export, as an isolated/token CFG_ENV does), post
    run(`. '${paths.paneAuth}' 2>/dev/null; export CLAUDE_CODE_OAUTH_TOKEN="\${CFG_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"; [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || unset CLAUDE_CODE_OAUTH_TOKEN; . '${paths.paneAuthPost}'; echo "key=\${ANTHROPIC_API_KEY-UNSET} token=\${CLAUDE_CODE_OAUTH_TOKEN-UNSET}"`, env).trim()

  it('api: the pane ends with exactly the key, even when CFG_ENV and the tmux global env add a token', () => {
    const { paths, home, dot } = setup()
    writeFileSync(dot, JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [], rejected: [KEY.slice(-20)] } }))
    const r = applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    expect(r).toEqual({ ok: true, failed: [] })
    expect(sh(paths, { CLAUDE_CODE_OAUTH_TOKEN: 'from-global-env', CFG_TOKEN: 'from-cfg-env' })).toBe(`key=${KEY} token=UNSET`)
    for (const p of [paths.paneAuth, paths.paneAuthPost, paths.ledger]) expect(statSync(p).mode & 0o777).toBe(0o600)
    const resp = JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses
    expect(resp.approved).toEqual([KEY.slice(-20)])
    expect(resp.rejected).toEqual([]) // the owner's old "No" does not outlive the switch
    expect(JSON.parse(readFileSync(dot, 'utf-8')).hasCompletedOnboarding).toBe(true)
    const ledger = JSON.parse(readFileSync(paths.ledger, 'utf-8'))
    expect(ledger).toEqual([{ target: dot, hash: createHash('sha256').update(KEY.slice(-20)).digest('hex') }])
    expect(readFileSync(paths.ledger, 'utf-8')).not.toContain(KEY.slice(-20))
    const launched = readFileSync(paths.launched, 'utf-8')
    expect(JSON.parse(launched)).toMatchObject({ configured: 'api', effective: 'api', keySource: 'vault', stampTarget: dot })
    expect(launched).not.toContain(KEY.slice(-8))
  })

  it('subscription: the pane ends with the token only, even when the tmux global env (key-only past) carries a key', () => {
    const { paths, home } = setup()
    applyMainAuth(decideMainAuth(base({ envKey: ENV_KEY, home })), paths)
    expect(readFileSync(paths.paneAuth, 'utf-8')).not.toContain(ENV_KEY)
    expect(sh(paths, { ANTHROPIC_API_KEY: 'from-global-env' })).toBe(`key=UNSET token=${TOKEN}`)
  })

  it('leaving api removes exactly the switch\'s approval, and keeps every other entry', () => {
    const { paths, home, dot } = setup()
    writeFileSync(dot, JSON.stringify({ customApiKeyResponses: { approved: ['someone-elses-suffix0'] } }))
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual(['someone-elses-suffix0', KEY.slice(-20)])
    applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual(['someone-elses-suffix0'])
    expect(JSON.parse(readFileSync(paths.ledger, 'utf-8'))).toEqual([])
  })

  it('a changed key: the old approval goes, the new one comes', () => {
    const { paths, home, dot } = setup()
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: ENV_KEY, home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual([ENV_KEY.slice(-20)])
    expect(JSON.parse(readFileSync(paths.ledger, 'utf-8'))).toHaveLength(1)
  })

  it('a key-only stamp is not the switch\'s: never ledgered, never removed by a later mode change', () => {
    const { paths, home, dot } = setup()
    applyMainAuth(decideMainAuth(base({ installMode: 'keyonly', oauthToken: '', envKey: ENV_KEY, home })), paths)
    expect(existsSync(paths.ledger)).toBe(false)
    applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual([ENV_KEY.slice(-20)])
  })

  it('a corrupt .claude.json is refused, kept intact, and the failure is named', () => {
    const { paths, home, dot } = setup()
    writeFileSync(dot, '{broken')
    const r = applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    expect(r.ok).toBe(false)
    expect(r.failed).toContain('stamp')
    expect(readFileSync(dot, 'utf-8')).toBe('{broken')
    expect(existsSync(paths.paneAuth)).toBe(true) // the other steps still ran
  })

  it('none: no pane-auth file at all, an empty post-file (a stale one can never unset what a later mode needs)', () => {
    const { paths, home } = setup()
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    applyMainAuth(decideMainAuth(base({ installMode: 'none', oauthToken: '', home })), paths)
    expect(existsSync(paths.paneAuth)).toBe(false)
    expect(readFileSync(paths.paneAuthPost, 'utf-8')).toBe('')
  })

  it('a value with a quote stays one shell word', () => {
    const { paths, home } = setup()
    const odd = "fake-key-with-'quote-and-$(echo pwned)"
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: odd, home })), paths)
    expect(run(`. '${paths.paneAuth}'; printf %s "$ANTHROPIC_API_KEY"`)).toBe(odd)
  })
})

describe('applyMainAuth: the ledger holds only what the switch itself added (EGM code review 1-3)', () => {
  const setup = () => {
    const store = tmp('mauth-store-')
    const home = tmp('mauth-home-')
    return { store, home, paths: mainAuthPaths(store), dot: join(home, '.claude.json') }
  }
  it('an approval of the same key that was there before (the owner\'s own Yes, a key-only stamp) is never claimed or removed', () => {
    const { paths, home, dot } = setup()
    writeFileSync(dot, JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)] } }))
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    expect(existsSync(paths.ledger)).toBe(false)
    applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual([KEY.slice(-20)])
  })
  it('the same holds when the earlier approval sits next to an old "No" (the rejected entry is cleared, the approval is still not ours)', () => {
    const { paths, home, dot } = setup()
    writeFileSync(dot, JSON.stringify({ customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [KEY.slice(-20)] } }))
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.rejected).toEqual([])
    expect(existsSync(paths.ledger)).toBe(false)
    applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual([KEY.slice(-20)])
  })
  it('a re-stamp that fails keeps the earlier ledger entry, so leaving api still removes that approval', () => {
    const { paths, home, dot } = setup()
    applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    const good = readFileSync(dot, 'utf-8')
    writeFileSync(dot, '{broken')
    const r = applyMainAuth(decideMainAuth(base({ authMode: 'api', vaultKey: KEY, home })), paths)
    expect(r.failed).toContain('stamp')
    expect(JSON.parse(readFileSync(paths.ledger, 'utf-8'))).toHaveLength(1)
    writeFileSync(dot, good)
    applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(JSON.parse(readFileSync(dot, 'utf-8')).customApiKeyResponses.approved).toEqual([])
  })
  it('a pane-auth or post-file that cannot be written leaves no stale one behind, and is named', () => {
    const { store, home } = setup()
    const paths = { ...mainAuthPaths(store), paneAuth: join(store, 'missing-dir', 'pa'), paneAuthPost: join(store, 'missing-dir', 'post') }
    const r = applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(r.failed).toEqual(expect.arrayContaining(['pane-auth', 'post']))
    expect(existsSync(paths.paneAuth)).toBe(false)
  })
  it('a crashed write\'s old tmp file (credential inside) is swept, a fresh one (a launch in flight) is kept', async () => {
    const { paths, home } = setup()
    const old = `${paths.paneAuth}.111.1.aaaa.tmp`
    const fresh = `${paths.paneAuth}.222.2.bbbb.tmp`
    writeFileSync(old, 'export X=1\n')
    writeFileSync(fresh, 'export X=2\n')
    const { utimesSync } = await import('node:fs')
    utimesSync(old, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    applyMainAuth(decideMainAuth(base({ home })), paths)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})

describe('readMainOauthToken: as channels.sh reads it', () => {
  it('.env first, else the token file without its trailing newlines, whitespace-only = none', () => {
    const d = tmp()
    const f = join(d, 'tok')
    writeFileSync(f, 'file-token\n\n')
    expect(readMainOauthToken(`CLAUDE_CODE_OAUTH_TOKEN=env-token\n`, f)).toBe('env-token')
    expect(readMainOauthToken('X=1\n', f)).toBe('file-token')
    writeFileSync(f, ' \n')
    expect(readMainOauthToken('', f)).toBe('')
    expect(readMainOauthToken('', join(d, 'missing'))).toBe('')
  })
})
