// TEAMSAPPROVECARD1118 (Samu D1): the dashboard's own channel-token check for the approval-card click. The same
// vectors as the Teams plugin's copy (claude-channel-teams tests/channel-token.test.ts), plus Dani's R1 (a failed key
// fetch is not retried on every request). Signed with a key made here; the OpenID metadata and the JWKS come from an
// injected fetch, so nothing leaves the process. Every rule has a case that breaks only that rule.
import { describe, expect, test, vi } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import {
  createChannelTokenVerifier,
  CHANNEL_OPENID_METADATA_URL,
  CHANNEL_TOKEN_ISSUER,
  CLOCK_SKEW_S,
  REFETCH_MIN_MS,
} from '../bot-channel-token.js'

const APP = '00000000-aaaa-bbbb-cccc-000000000001'
const SURL = 'https://smba.trafficmanager.net/emea/'
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys'
const NOW = 1_795_000_000_000

function rsa() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) as { n: string; e: string } }
}
const K1 = rsa()
const K2 = rsa()

function b64(o: unknown): string { return Buffer.from(JSON.stringify(o)).toString('base64url') }
function token(over: Record<string, unknown> = {}, head: Record<string, unknown> = {}, key: KeyObject = K1.privateKey): string {
  const t = Math.floor(NOW / 1000)
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...head })
  const p = b64({ iss: CHANNEL_TOKEN_ISSUER, aud: APP, exp: t + 3600, nbf: t - 10, serviceurl: SURL, ...over })
  const s = cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')
  return `${h}.${p}.${s}`
}
const activity = (over: Record<string, unknown> = {}) => ({ type: 'message', channelId: 'msteams', serviceUrl: SURL, ...over })

function keysFetch(keys: unknown[] = [{ kty: 'RSA', kid: 'k1', ...K1.jwk, endorsements: ['msteams', 'webchat'] }], jwksUri = JWKS_URL) {
  const urls: string[] = []
  const f = vi.fn(async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    if (url === CHANNEL_OPENID_METADATA_URL) return new Response(JSON.stringify({ jwks_uri: jwksUri }), { status: 200 })
    if (url === jwksUri) return new Response(JSON.stringify({ keys }), { status: 200 })
    return new Response('no', { status: 404 })
  })
  return { f: f as unknown as typeof fetch, urls }
}
function verifier(keys?: unknown[], jwksUri?: string, now: () => number = () => NOW) {
  const k = keysFetch(keys, jwksUri)
  return { verify: createChannelTokenVerifier(APP, { fetch: k.f, now }), urls: k.urls }
}

describe('channel-token-only verifier', () => {
  test('a channel token signed by an msteams-endorsed key passes', async () => {
    const { verify } = verifier()
    const r = await verify(`Bearer ${token()}`, activity())
    expect(r.ok).toBe(true)
  })

  test('an emulator-shaped token for the bot itself (the bot password path) is refused before any key fetch', async () => {
    const { verify, urls } = verifier()
    const t = Math.floor(NOW / 1000)
    const emu = token({ iss: 'https://sts.windows.net/11111111-2222-3333-4444-555555555555/', aud: APP, appid: APP, ver: '1.0', exp: t + 3600 })
    expect(await verify(`Bearer ${emu}`, activity())).toEqual({ ok: false, reason: 'not a Bot Framework channel token (issuer)' })
    const v2 = token({ iss: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0', aud: APP, azp: APP, ver: '2.0' })
    expect((await verify(`Bearer ${v2}`, activity())).ok).toBe(false)
    expect(urls).toEqual([])
  })

  test('header shape: no bearer, malformed, other algorithms, no kid', async () => {
    const { verify } = verifier()
    expect(await verify(undefined, activity())).toEqual({ ok: false, reason: 'no bearer token' })
    expect(await verify(token(), activity())).toEqual({ ok: false, reason: 'no bearer token' })
    expect(await verify('Bearer a.b', activity())).toEqual({ ok: false, reason: 'malformed token' })
    expect(await verify('Bearer a.b.c+', activity())).toEqual({ ok: false, reason: 'malformed token' })
    for (const alg of ['none', 'HS256', 'RS384', 'PS256']) {
      expect(await verify(`Bearer ${token({}, { alg })}`, activity())).toEqual({ ok: false, reason: 'algorithm is not RS256' })
    }
    expect(await verify(`Bearer ${token({}, { kid: undefined })}`, activity())).toEqual({ ok: false, reason: 'no key id' })
  })

  test('audience: another app, an array, missing', async () => {
    const { verify } = verifier()
    for (const aud of ['another-app', [APP], undefined]) {
      expect(await verify(`Bearer ${token({ aud })}`, activity())).toEqual({ ok: false, reason: 'audience is not this bot' })
    }
  })

  // The skew is pinned as a number, 300 s (the SDK's 5 minutes), not read back from the constant it tests.
  test('time: expired beyond the 300 s skew is refused, inside it passes; nbf beyond the skew is refused', async () => {
    expect(CLOCK_SKEW_S).toBe(300)
    const { verify } = verifier()
    const t = Math.floor(NOW / 1000)
    expect(await verify(`Bearer ${token({ exp: t - 301 })}`, activity())).toEqual({ ok: false, reason: 'token expired' })
    expect((await verify(`Bearer ${token({ exp: t - 295 })}`, activity())).ok).toBe(true)
    expect(await verify(`Bearer ${token({ exp: undefined })}`, activity())).toEqual({ ok: false, reason: 'token expired' })
    expect(await verify(`Bearer ${token({ nbf: t + 305 })}`, activity())).toEqual({ ok: false, reason: 'token not yet valid' })
    expect((await verify(`Bearer ${token({ nbf: t + 295 })}`, activity())).ok).toBe(true)
  })

  test('serviceUrl: the claim must equal the activity serviceUrl, and the activity must carry one', async () => {
    const { verify } = verifier()
    const reason = 'serviceUrl claim does not match the activity'
    expect(await verify(`Bearer ${token({ serviceurl: 'https://evil.example/' })}`, activity())).toEqual({ ok: false, reason })
    expect(await verify(`Bearer ${token()}`, activity({ serviceUrl: undefined }))).toEqual({ ok: false, reason })
    expect(await verify(`Bearer ${token({ serviceurl: undefined })}`, activity())).toEqual({ ok: false, reason })
  })

  test('channel: only msteams activities', async () => {
    const { verify } = verifier()
    expect(await verify(`Bearer ${token()}`, activity({ channelId: 'emulator' }))).toEqual({ ok: false, reason: 'activity is not from the msteams channel' })
  })

  test('keys: unknown kid, a key not endorsed for msteams, a key with no endorsements', async () => {
    expect(await verifier().verify(`Bearer ${token({}, { kid: 'k9' })}`, activity())).toEqual({ ok: false, reason: 'unknown signing key' })
    const notTeams = verifier([{ kty: 'RSA', kid: 'k1', ...K1.jwk, endorsements: ['webchat'] }])
    expect(await notTeams.verify(`Bearer ${token()}`, activity())).toEqual({ ok: false, reason: 'signing key is not endorsed for msteams' })
    const none = verifier([{ kty: 'RSA', kid: 'k1', ...K1.jwk }])
    expect(await none.verify(`Bearer ${token()}`, activity())).toEqual({ ok: false, reason: 'signing key is not endorsed for msteams' })
  })

  test('signature: another key under the same kid, a payload changed after signing', async () => {
    const { verify } = verifier()
    expect(await verify(`Bearer ${token({}, {}, K2.privateKey)}`, activity())).toEqual({ ok: false, reason: 'bad signature' })
    const [h, , s] = token().split('.')
    const forged = `${h}.${b64({ iss: CHANNEL_TOKEN_ISSUER, aud: APP, exp: Math.floor(NOW / 1000) + 3600, serviceurl: SURL, extra: 1 })}.${s}`
    expect(await verify(`Bearer ${forged}`, activity())).toEqual({ ok: false, reason: 'bad signature' })
  })

  test('metadata: unavailable, or a jwks_uri off the metadata host, gives no keys', async () => {
    const down = createChannelTokenVerifier(APP, { fetch: (async () => new Response('x', { status: 503 })) as unknown as typeof fetch, now: () => NOW })
    expect(await down(`Bearer ${token()}`, activity())).toEqual({ ok: false, reason: 'signing keys unavailable' })
    const off = verifier(undefined, 'https://evil.example/keys')
    expect(await off.verify(`Bearer ${token()}`, activity())).toEqual({ ok: false, reason: 'signing keys unavailable' })
  })

  test('cache: keys are fetched once; an unknown kid refetches only after REFETCH_MIN_MS', async () => {
    let now = NOW
    const { verify, urls } = verifier(undefined, undefined, () => now)
    expect((await verify(`Bearer ${token()}`, activity())).ok).toBe(true)
    expect((await verify(`Bearer ${token()}`, activity())).ok).toBe(true)
    expect(urls.length).toBe(2)
    await verify(`Bearer ${token({}, { kid: 'k9' })}`, activity())
    expect(urls.length).toBe(2)
    now += REFETCH_MIN_MS + 1
    await verify(`Bearer ${token({ exp: Math.floor(now / 1000) + 3600 }, { kid: 'k9' })}`, activity())
    expect(urls.length).toBe(4)
  })
})

describe('a failed key fetch is not retried on every request (Dani R1)', () => {
  test('after a failure, no new fetch inside REFETCH_MIN_MS; after it, one', async () => {
    let now = NOW
    let calls = 0
    const down = (async () => { calls++; return new Response('x', { status: 503 }) }) as unknown as typeof fetch
    const verify = createChannelTokenVerifier(APP, { fetch: down, now: () => now })
    expect(await verify(`Bearer ${token()}`, activity())).toEqual({ ok: false, reason: 'signing keys unavailable' })
    expect(calls).toBe(1)
    for (let i = 0; i < 5; i++) expect(await verify(`Bearer ${token()}`, activity())).toEqual({ ok: false, reason: 'signing keys unavailable' })
    expect(calls).toBe(1)
    now += REFETCH_MIN_MS + 1
    await verify(`Bearer ${token({ exp: Math.floor(now / 1000) + 3600 })}`, activity())
    expect(calls).toBe(2)
  })
  test('an unknown kid after a failed refresh keeps the cached keys and starts no fetch inside the window', async () => {
    let now = NOW
    let fail = false
    const k = keysFetch()
    const flaky = (async (u: unknown, i?: unknown) => (fail ? new Response('x', { status: 503 }) : (k.f as unknown as (a: unknown, b?: unknown) => Promise<Response>)(u, i))) as unknown as typeof fetch
    const verify = createChannelTokenVerifier(APP, { fetch: flaky, now: () => now })
    expect((await verify(`Bearer ${token()}`, activity())).ok).toBe(true)
    fail = true
    now += REFETCH_MIN_MS + 1
    const later = { exp: Math.floor(now / 1000) + 3600 }
    expect(await verify(`Bearer ${token(later, { kid: 'k9' })}`, activity())).toEqual({ ok: false, reason: 'signing keys unavailable' })
    expect(await verify(`Bearer ${token(later, { kid: 'k9' })}`, activity())).toEqual({ ok: false, reason: 'unknown signing key' })
    expect((await verify(`Bearer ${token(later)}`, activity())).ok).toBe(true)
  })
})
