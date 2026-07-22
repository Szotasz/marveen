import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook, no type declarations
import { decide, grantAllows, collectAccountIds, shortName, scrubForLog } from '../../scripts/hooks/mcp-permission-gate.mjs'

// The live grant Zsolt authorised: Pixel, Meta only, one account, expiring.
const VIP = '365735307576260'
const OTHER = '479300372597346'
const NOW = 1_784_720_000_000 // 2026-07-22 ~13:33 CEST
const grant = {
  agent: 'pixel',
  server: 'meta-ads',
  account_ids: [VIP],
  denied_account_ids: [OTHER],
  expires_at: 1_784_757_600, // 2026-07-23 00:00 CEST
}
const PIXEL_CWD = '/Users/macmini/marveen/agents/pixel'
const ctx = (over: Record<string, unknown> = {}) => ({
  grant, cwd: PIXEL_CWD, now: NOW, toolInput: { account_id: VIP, name: 'x' }, ...over,
})

const WRITE = 'mcp__Meta-Ads__update_campaign'

describe('ads grant: the happy path is narrow', () => {
  it('allows a Meta write for Pixel on the granted account', () => {
    expect(decide(WRITE, ctx())).toBe('allow-granted')
  })
  it('accepts the act_ prefixed form', () => {
    expect(decide(WRITE, ctx({ toolInput: { act: `act_${VIP}` } }))).toBe('allow-granted')
  })
  it('still allows ads READS with no grant at all (unchanged behaviour)', () => {
    expect(decide('mcp__Meta-Ads__get_campaign_insights', { grant: null })).toBe('allow')
  })
})

describe('ads grant: everything outside the grant still denies', () => {
  it('DENIES when there is no grant file (the default state)', () => {
    expect(decide(WRITE, ctx({ grant: null }))).toBe('deny')
  })
  it('DENIES after expiry -- the grant closes itself', () => {
    expect(decide(WRITE, ctx({ now: grant.expires_at * 1000 }))).toBe('deny')
    expect(decide(WRITE, ctx({ now: (grant.expires_at + 3600) * 1000 }))).toBe('deny')
  })
  it('DENIES another agent, even inside the window', () => {
    for (const a of ['copy', 'lumen', 'bit', 'nova']) {
      expect(decide(WRITE, ctx({ cwd: `/Users/macmini/marveen/agents/${a}` }))).toBe('deny')
    }
  })
  it('DENIES when cwd carries no agent identity', () => {
    expect(decide(WRITE, ctx({ cwd: '/tmp' }))).toBe('deny')
    expect(decide(WRITE, ctx({ cwd: undefined }))).toBe('deny')
  })
  it('DENIES Google Ads writes -- a Meta grant is not an ads grant', () => {
    expect(decide('mcp__google-ads__mutate_campaign', ctx())).toBe('deny')
    expect(decide('mcp__google-ads__update_budget', ctx({ toolInput: { account_id: VIP } }))).toBe('deny')
  })
  it('DENIES the excluded ad account', () => {
    expect(decide(WRITE, ctx({ toolInput: { account_id: OTHER } }))).toBe('deny')
  })
  it('DENIES a call that names no account at all (fail closed)', () => {
    expect(decide(WRITE, ctx({ toolInput: { name: 'no account here' } }))).toBe('deny')
    expect(decide(WRITE, ctx({ toolInput: {} }))).toBe('deny')
    expect(decide(WRITE, ctx({ toolInput: undefined }))).toBe('deny')
  })
  it('DENIES when both accounts appear', () => {
    expect(decide(WRITE, ctx({ toolInput: { account_id: VIP, fallback_account: OTHER } }))).toBe('deny')
  })
  it('DENIES when the excluded account hides in an unrecognised field', () => {
    expect(decide(WRITE, ctx({ toolInput: { account_id: VIP, notes: OTHER } }))).toBe('deny')
  })
  it('DENIES deletion even inside the grant', () => {
    for (const t of ['mcp__Meta-Ads__delete_campaign', 'mcp__Meta-Ads__remove_adset', 'mcp__Meta-Ads__destroy_ad']) {
      expect(decide(t, ctx())).toBe('deny')
    }
  })
  it('DENIES on a malformed grant rather than widening', () => {
    for (const g of [{}, { agent: 'pixel' }, { agent: 'pixel', server: 'meta-ads', expires_at: 'soon' },
      { agent: 'pixel', server: 'meta-ads', account_ids: [], expires_at: grant.expires_at }]) {
      expect(decide(WRITE, ctx({ grant: g }))).toBe('deny')
    }
  })
})

describe('ads grant: refusal reasons are specific enough to audit', () => {
  const why = (over = {}) => grantAllows(WRITE, shortName(WRITE), ctx(over)).why
  it('names the cause', () => {
    expect(why({ grant: null })).toMatch(/no grant/)
    expect(why({ now: (grant.expires_at + 1) * 1000 })).toMatch(/expired/)
    expect(why({ cwd: '/Users/macmini/marveen/agents/copy' })).toMatch(/not the granted agent/)
    expect(why({ toolInput: { account_id: OTHER } })).toMatch(/outside the grant/)
    expect(why({ toolInput: {} })).toMatch(/names no ad account/)
    expect(why({ toolInput: { account_id: VIP, x: OTHER } })).toMatch(/excluded account/)
  })
})

describe('collectAccountIds', () => {
  it('separates account-keyed values from incidental long numbers', () => {
    const { named, anyDigits } = collectAccountIds({
      account_id: VIP,
      campaign_id: '120210000000000001', // a campaign id, NOT an account
      nested: { ad_account_id: VIP },
    })
    expect([...named]).toEqual([VIP])
    expect(anyDigits.has('120210000000000001')).toBe(true)
  })
  it('does not treat a campaign id as an account (would block legitimate work)', () => {
    const { named } = collectAccountIds({ account_id: VIP, adset_id: '23851234567890123' })
    expect([...named]).toEqual([VIP])
  })
  it('walks arrays', () => {
    const { named } = collectAccountIds({ targets: [{ account_id: VIP }, { account_id: OTHER }] })
    expect(named.has(VIP) && named.has(OTHER)).toBe(true)
  })
})

// The audit log outlives the call it recorded. A refused call is precisely where a
// credential can turn up in the payload, so the log must not copy it faithfully.
describe('audit log scrubbing', () => {
  it('redacts credential-shaped keys at any depth', () => {
    const out = scrubForLog({
      account_id: VIP,
      access_token: 'EAABw...real',
      nested: { api_key: 'sk-live-123', client_secret: 'shh', page_password: 'p' },
      headers: { Authorization: 'Bearer abc' },
    })
    expect(out.access_token).toBe('[redacted]')
    expect(out.nested.api_key).toBe('[redacted]')
    expect(out.nested.client_secret).toBe('[redacted]')
    expect(out.nested.page_password).toBe('[redacted]')
    expect(out.headers.Authorization).toBe('[redacted]')
  })
  it('keeps the fields an audit actually needs', () => {
    const out = scrubForLog({ account_id: VIP, name: 'Summer campaign', daily_budget: 5000 })
    expect(out.account_id).toBe(VIP)
    expect(out.name).toBe('Summer campaign')
    expect(out.daily_budget).toBe(5000)
  })
  it('truncates a long value instead of writing it whole', () => {
    const out = scrubForLog({ body: 'x'.repeat(5000) })
    expect(out.body.length).toBeLessThan(400)
    expect(out.body).toMatch(/\[\+4700 chars\]$/)
  })
  it('survives arrays, nulls and non-objects', () => {
    expect(scrubForLog(null)).toBe(null)
    expect(scrubForLog([{ token: 'a' }, { name: 'b' }])[0].token).toBe('[redacted]')
    expect(scrubForLog(42)).toBe(42)
  })
})

describe('ads grant: nothing else about the gate changed', () => {
  it('non-ads writes still defer to the normal prompt', () => {
    expect(decide('mcp__someserver__create_thing', ctx())).toBe('defer')
  })
  it('channel replies still auto-allow', () => {
    expect(decide('mcp__plugin_telegram_telegram__reply', ctx())).toBe('allow')
  })
  it('reads still auto-allow', () => {
    expect(decide('mcp__whatever__list_items', ctx())).toBe('allow')
  })
  it('a one-argument call (no ctx) still denies ads writes', () => {
    expect(decide(WRITE)).toBe('deny')
  })
})
