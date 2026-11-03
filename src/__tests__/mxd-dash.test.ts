// GROMZOOWNERQR1030: the dash.sock client, the owner QR flow and the app's URI format.
// Every socket here is a FAKE (helpers/fake-mxd-dash.ts): the real dash.sock issues
// live, rate-limited owner secrets.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mxdDashCall, MxdDashError, requestOwnerQr, buildOwnerQrUri,
  MXD_DASH_SOCK_DARWIN, MXD_DASH_SOCK_LINUX, type MxdDashCall,
} from '../web/mxd-dash.js'
import { startFakeMxdDash, INVITE_OK, LOGIN_OK, type FakeMxdDash } from './helpers/fake-mxd-dash.js'

let fake: FakeMxdDash
beforeEach(async () => { fake = await startFakeMxdDash() })
afterEach(async () => { await fake.close() })

const callFake: () => MxdDashCall = () => (req) => mxdDashCall(req, { socketPath: fake.path, timeoutMs: 1000 })

async function failureOf(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return e instanceof MxdDashError ? e.code : `not-an-MxdDashError:${String(e)}` }
  return 'resolved'
}

describe('mxdDashCall (transport)', () => {
  it('writes one JSON line and reads one reply line', async () => {
    fake.script.set('status', { ok: true, running: true, linked: true })
    expect(await mxdDashCall({ verb: 'status' }, { socketPath: fake.path })).toEqual({ ok: true, running: true, linked: true })
    expect(fake.seen).toEqual(['status'])
  })

  it('a partial line with no newline never resolves as a reply', async () => {
    fake.script.set('status', { raw: '{"ok":true,' })
    // The fake writes half a line and nothing more: no reply is made up from it.
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path, timeoutMs: 200 }))).toBe('timeout')
  })

  it('times out when mxd never answers', async () => {
    fake.script.set('status', 'hang')
    const t0 = Date.now()
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path, timeoutMs: 150 }))).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('refuses an oversized reply', async () => {
    fake.script.set('status', { raw: '{"ok":true,"pad":"' + 'x'.repeat(70 * 1024) + '"}\n' })
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path }))).toBe('oversized')
  })

  it('the cap is configurable and exact', async () => {
    const line = JSON.stringify({ ok: true, pad: 'y'.repeat(100) })
    fake.script.set('status', { raw: line + '\n' })
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path, maxReply: line.length - 1 }))).toBe('oversized')
    expect(await mxdDashCall({ verb: 'status' }, { socketPath: fake.path, maxReply: line.length })).toMatchObject({ ok: true })
  })

  it('refuses malformed JSON and a non-object reply', async () => {
    fake.script.set('status', { raw: 'not json\n' })
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path }))).toBe('malformed')
    fake.script.set('status', { raw: '[1,2]\n' })
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path }))).toBe('malformed')
  })

  it('an error never carries reply bytes', async () => {
    fake.script.set('owner_invite', { raw: '{"ok":true,"owner_secret":"moi_LEAKME' })
    let msg = ''
    try { await mxdDashCall({ verb: 'owner_invite' }, { socketPath: fake.path, timeoutMs: 150 }) } catch (e) { msg = String((e as Error).message) + JSON.stringify(e) }
    expect(msg).not.toContain('LEAKME')
  })

  it('a connection closed before a full line is "closed"', async () => {
    fake.script.set('status', { raw: '' })
    // the fake writes nothing; close it from the server side
    const p = mxdDashCall({ verb: 'status' }, { socketPath: fake.path, timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 50))
    await fake.close()
    expect(await failureOf(p)).toBe('closed')
    fake = await startFakeMxdDash() // afterEach closes it again
  })

  it('no socket is "not_running"', async () => {
    expect(await failureOf(mxdDashCall({ verb: 'status' }, { socketPath: fake.path + '.missing' }))).toBe('not_running')
  })

  it('mxd\'s uid refusal comes back as an ordinary error reply', async () => {
    // serve_conn writes {"ok":false,"error":"forbidden"} to another uid and closes.
    fake.script.set('status', { ok: false, error: 'forbidden' })
    expect(await mxdDashCall({ verb: 'status' }, { socketPath: fake.path })).toEqual({ ok: false, error: 'forbidden' })
  })

  it('under vitest the installed socket paths are refused before any connect', async () => {
    for (const p of [MXD_DASH_SOCK_DARWIN, MXD_DASH_SOCK_LINUX]) {
      expect(await failureOf(mxdDashCall({ verb: 'owner_invite' }, { socketPath: p }))).toBe('test_guard')
    }
  })
})

describe('requestOwnerQr (the owner flow)', () => {
  it('a free owner seat: the join code from owner_invite, no login code asked', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    fake.script.set('owner_login_code', LOGIN_OK)
    const r = await requestOwnerQr(callFake())
    expect(r).toEqual({ ok: true, qr: { kind: 'join', uri: 'marveen://join?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=moi_INVITESECRET_x9Q', expires_in: 600 } })
    expect(fake.seen).toEqual(['owner_invite'])
  })

  for (const code of ['owner_invite_already_issued', 'owner_invite_used']) {
    it(`owner already registered (${code}): falls back to the login code`, async () => {
      fake.script.set('owner_invite', { ok: false, error: code })
      fake.script.set('owner_login_code', LOGIN_OK)
      const r = await requestOwnerQr(callFake())
      expect(r).toEqual({ ok: true, qr: { kind: 'login', uri: 'marveen://login?v=1&hs=https%3A%2F%2Fchat.gromzo.com&s=mol_LOGINSECRET_k2Z', expires_in: 120 } })
      expect(fake.seen).toEqual(['owner_invite', 'owner_login_code'])
    })
  }

  it('an invite still live and no owner yet: invite_outstanding', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', { ok: false, error: 'no_owner' })
    expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'invite_outstanding' })
  })

  // Every error code mxd can put on owner_invite (link.rs owner_invite/owner_qr_proof,
  // controller.rs owner_invite + OWNER_INVITE_REFUSALS, main.rs serve_conn): passed on, no fallback.
  for (const code of ['not_linked', 'consent_required', 'unauthorized', 'upstream', 'rate_limited', 'foreign_homeserver',
    'refused', 'revoked', 'team_unknown', 'team_lapsed', 'forbidden', 'unavailable']) {
    it(`owner_invite error ${code}: passed on, no login code asked`, async () => {
      fake.script.set('owner_invite', { ok: false, error: code })
      fake.script.set('owner_login_code', LOGIN_OK)
      expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code })
      expect(fake.seen).toEqual(['owner_invite'])
    })
  }

  // owner_login_code's own refusals (controller.rs OWNER_LOGIN_REFUSALS + the gates).
  for (const code of ['identity_reset_in_progress', 'rate_limited', 'revoked', 'team_unknown', 'team_lapsed', 'unauthorized', 'upstream']) {
    it(`login code error ${code} after the fallback: passed on`, async () => {
      fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
      fake.script.set('owner_login_code', { ok: false, error: code })
      expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code })
    })
  }

  it('GROMZORESETWAIT1031: the reset lock passes its wait (1..86400 whole seconds) and its stall', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', { ok: false, error: 'identity_reset_in_progress', retry_after: 420 })
    expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'identity_reset_in_progress', retryAfter: 420 })
    for (const bad of [0, -5, 86_401, 1.5, '420', null]) {
      fake.script.set('owner_login_code', { ok: false, error: 'identity_reset_in_progress', retry_after: bad })
      expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'identity_reset_in_progress' })
    }
    fake.script.set('owner_login_code', { ok: false, error: 'identity_reset_stalled' })
    expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'identity_reset_stalled' })
    // Another code never carries a wait.
    fake.script.set('owner_login_code', { ok: false, error: 'rate_limited', retry_after: 60 })
    expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'rate_limited' })
  })

  it('a non-code error string becomes "refused" (nothing verbatim from upstream)', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'Something <b>bad</b> happened' })
    expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'refused' })
  })

  it('a reply that does not fit is bad_reply, and no URI is built from it', async () => {
    const bad = [
      { ...INVITE_OK, homeserver: 'http://chat.gromzo.com' },
      { ...INVITE_OK, homeserver: 'https://chat.gromzo.com/path' },
      { ...INVITE_OK, homeserver: 'https://u@chat.gromzo.com' },
      { ...INVITE_OK, owner_secret: 'a b' },
      { ...INVITE_OK, owner_secret: '' },
      { ...INVITE_OK, owner_secret: 'mol_looks_like_login' },
      { ...INVITE_OK, expires_in: 0 },
      { ...INVITE_OK, expires_in: '600' },
      { ok: true, homeserver: 'https://chat.gromzo.com', login_secret: 'mol_x', expires_in: 600 },
    ]
    for (const b of bad) {
      fake.script.set('owner_invite', b)
      expect(await requestOwnerQr(callFake()), JSON.stringify(b)).toEqual({ ok: false, code: 'bad_reply' })
    }
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', { ...LOGIN_OK, login_secret: 'moi_not_a_login' })
    expect(await requestOwnerQr(callFake())).toEqual({ ok: false, code: 'bad_reply' })
  })

  it('a trailing slash on the homeserver is dropped (the app compares origins)', async () => {
    fake.script.set('owner_invite', { ...INVITE_OK, homeserver: 'https://chat.gromzo.com/' })
    const r = await requestOwnerQr(callFake())
    expect(r.ok && r.qr.uri).toBe('marveen://join?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=moi_INVITESECRET_x9Q')
  })
})

// The app's parser, transcribed (gromzo-ios-owner main 875f979,
// RegistrationKit/Sources/RegistrationKit/JoinLink.swift:69-116): scheme marveen, host
// join|login, v=1, hs a bare https origin on the allow list, the secret under t (join)
// or s (login), and a login secret starts with mol_ while an invite secret never does.
function appParse(text: string): { kind: 'invite' | 'login', homeserver: string, token: string } {
  const u = new URL(text)
  if (u.protocol !== 'marveen:') throw new Error('notAJoinLink')
  const host = u.host.toLowerCase()
  const q = u.searchParams
  const kinds = q.getAll('k')
  let kind: 'invite' | 'login'
  if (host === 'join') {
    if (kinds.length > 1) throw new Error('notAJoinLink')
    if (kinds.length === 1 && kinds[0] !== 'owner') throw new Error('unsupportedVersion')
    kind = 'invite'
  } else if (host === 'login') kind = 'login'
  else throw new Error('notAJoinLink')
  if (q.get('v') !== '1') throw new Error('unsupportedVersion')
  const hs = q.get('hs'); if (!hs) throw new Error('missingField(hs)')
  const field = kind === 'login' ? 's' : 't'
  const token = q.get(field); if (!token) throw new Error(`missingField(${field})`)
  const isLogin = token.startsWith('mol_') && token.length > 4
  if (isLogin !== (kind === 'login') || (kind !== 'login' && token.startsWith('mol_'))) throw new Error('wrongSecret')
  const h = new URL(hs)
  if (h.protocol !== 'https:') throw new Error('insecureHomeserver')
  if (h.username || h.password || !['', '/'].includes(h.pathname) || h.search || h.hash) throw new Error('unknownHomeserver')
  if (!['https://chat.gromzo.com'].includes(h.origin)) throw new Error('unknownHomeserver')
  return { kind, homeserver: h.origin, token }
}

describe('buildOwnerQrUri: exactly what the app accepts', () => {
  it('the join URI (JoinLink.swift:3) parses as the owner invite with the secret intact', () => {
    const uri = buildOwnerQrUri('join', 'https://chat.gromzo.com', 'moi_A+b/c=d')
    expect(uri).toBe('marveen://join?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=moi_A%2Bb%2Fc%3Dd')
    expect(appParse(uri)).toEqual({ kind: 'invite', homeserver: 'https://chat.gromzo.com', token: 'moi_A+b/c=d' })
  })

  it('the login URI (JoinLink.swift:4) parses as the login code', () => {
    const uri = buildOwnerQrUri('login', 'https://chat.gromzo.com', 'mol_xyz')
    expect(uri).toBe('marveen://login?v=1&hs=https%3A%2F%2Fchat.gromzo.com&s=mol_xyz')
    expect(appParse(uri)).toEqual({ kind: 'login', homeserver: 'https://chat.gromzo.com', token: 'mol_xyz' })
  })

  it('the transcribed parser is not a rubber stamp: the app\'s own refusals fire', () => {
    expect(() => appParse('marveen://login?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=mol_abc')).toThrow('missingField(s)')
    expect(() => appParse('marveen://join?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=mol_abc')).toThrow('wrongSecret')
    expect(() => appParse('marveen://join?v=2&hs=https%3A%2F%2Fchat.gromzo.com&t=x')).toThrow('unsupportedVersion')
    expect(() => appParse('marveen://join?v=1&hs=https%3A%2F%2Fevil.example&t=x')).toThrow('unknownHomeserver')
  })
})
