// DOCKERHTTPS1119: the UI slice of the optional two-step sign-in. The shipped web/app.js functions, evaluated from the
// file, against the contract's exact bodies; every branch keys on `code`, never on the English `error` text.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

function extractFn(name: string): string {
  const m = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`).exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

type Outcome = { kind: string; [k: string]: unknown }
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const totpOutcome = new Function(`${extractFn('totpOutcome')}; return totpOutcome`)() as (s: number, b: unknown) => Outcome
const tStub = (k: string, p: Record<string, unknown> = {}) => k + (Object.keys(p).length ? JSON.stringify(p) : '')
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const helpers = new Function('t', `${extractFn('totpOutcomeText')}; ${extractFn('totpBackupLeftText')}; ${extractFn('totpGroupSecret')};
  return { totpOutcomeText, totpBackupLeftText, totpGroupSecret }`)(tStub) as {
  totpOutcomeText: (o: Outcome) => string
  totpBackupLeftText: (n: unknown) => string
  totpGroupSecret: (s: string) => string
}

// The contract's bodies (API.md, "Error bodies (exact)").
const PENDING = 'p'.repeat(43)
const BODIES = {
  totp_required: { error: 'Two-step sign-in: enter the code from your authenticator app.', code: 'totp_required', pending: PENDING, expires_in_s: 300 },
  totp_invalid: { error: 'Invalid code', code: 'totp_invalid' },
  totp_pending_expired: { error: 'The sign-in step expired. Sign in again with your password.', code: 'totp_pending_expired' },
  totp_store_unavailable: { error: 'Two-step sign-in is unavailable: its store on the server cannot be read. Repair it on the machine (docs/dashboard-auth-recovery.md).', code: 'totp_store_unavailable' },
  totp_already_enabled: { error: 'Two-step sign-in is already on.', code: 'totp_already_enabled' },
  totp_not_enabled: { error: 'Two-step sign-in is off.', code: 'totp_not_enabled' },
  totp_setup_missing: { error: 'Start the setup first (or again: it expired).', code: 'totp_setup_missing' },
  totp_code_required: { error: 'A code is required.', code: 'totp_code_required' },
  owner: { error: 'Two-step sign-in can be changed only with the dashboard login (an owner session).', code: 'owner_session_required' },
}

describe('totpOutcome (web/app.js): the contract bodies, keyed on code', () => {
  it('T1: login: totp_required carries the pending token; a 401 without code is the password', () => {
    expect(totpOutcome(401, BODIES.totp_required)).toEqual({ kind: 'totp_required', pending: PENDING })
    expect(totpOutcome(401, { error: 'Invalid credentials' })).toEqual({ kind: 'bad_password' })
    expect(totpOutcome(401, { code: 'totp_required' })).toEqual({ kind: 'other' })
  })

  it('T2: login/totp: ok, ok with a backup code, invalid, expired, throttled, unavailable, network', () => {
    expect(totpOutcome(200, { ok: true, user: 'owner' })).toEqual({ kind: 'ok', backupUsed: false, left: null })
    expect(totpOutcome(200, { ok: true, user: 'owner', backup_code_used: true, backup_codes_left: 2 })).toEqual({ kind: 'ok', backupUsed: true, left: 2 })
    expect(totpOutcome(401, BODIES.totp_invalid).kind).toBe('invalid')
    expect(totpOutcome(401, BODIES.totp_pending_expired).kind).toBe('expired')
    expect(totpOutcome(429, { error: 'Too many attempts', retry_after_s: 30 })).toEqual({ kind: 'throttled', retry: 30 })
    expect(totpOutcome(503, BODIES.totp_store_unavailable).kind).toBe('unavailable')
    expect(totpOutcome(0, null).kind).toBe('network')
  })

  it('T3: settings: setup, enable and disable codes; the owner refusal with and without setup_required', () => {
    expect(totpOutcome(409, BODIES.totp_already_enabled).kind).toBe('already_on')
    expect(totpOutcome(409, BODIES.totp_not_enabled).kind).toBe('not_on')
    expect(totpOutcome(409, BODIES.totp_setup_missing).kind).toBe('setup_missing')
    expect(totpOutcome(400, BODIES.totp_invalid).kind).toBe('invalid')
    expect(totpOutcome(400, BODIES.totp_code_required).kind).toBe('code_required')
    expect(totpOutcome(403, BODIES.owner)).toEqual({ kind: 'owner', setupRequired: false })
    expect(totpOutcome(403, { ...BODIES.owner, setup_required: true })).toEqual({ kind: 'owner', setupRequired: true })
  })

  it('T4: the English error text alone decides nothing', () => {
    expect(totpOutcome(401, { error: 'Invalid code' }).kind).toBe('bad_password')
    expect(totpOutcome(409, { error: 'Two-step sign-in is already on.' }).kind).toBe('other')
    expect(totpOutcome(401, { error: 'x', code: 'toString' }).kind).toBe('other')
  })
})

describe('the texts', () => {
  it('T5: each outcome has its own key; throttled carries the wait', () => {
    expect(helpers.totpOutcomeText({ kind: 'invalid' })).toBe('auth.totp.err_invalid')
    expect(helpers.totpOutcomeText({ kind: 'expired' })).toBe('auth.totp.err_expired')
    expect(helpers.totpOutcomeText({ kind: 'unavailable' })).toBe('auth.totp.err_unavailable')
    expect(helpers.totpOutcomeText({ kind: 'throttled', retry: 30 })).toBe('auth.login.err_throttled (30s)')
    expect(helpers.totpOutcomeText({ kind: 'owner', setupRequired: true })).toBe('auth.totp.err_owner_setup')
    expect(helpers.totpOutcomeText({ kind: 'owner', setupRequired: false })).toBe('auth.totp.err_owner')
    expect(helpers.totpOutcomeText({ kind: 'other' })).toBe('auth.card.err_generic')
  })

  it('T6: the backup count, with the way to new codes at 0-2 only; the key in groups of four', () => {
    expect(helpers.totpBackupLeftText(2)).toBe('auth.totp.backup_left{"n":2} auth.totp.backup_low')
    expect(helpers.totpBackupLeftText(0)).toBe('auth.totp.backup_left{"n":0} auth.totp.backup_low')
    expect(helpers.totpBackupLeftText(3)).toBe('auth.totp.backup_left{"n":3}')
    expect(helpers.totpGroupSecret('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBe('ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567')
  })

  let hu: Record<string, string>
  let en: Record<string, string>
  beforeAll(async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
    hu = i18n.hu!
    en = i18n.en!
  })

  it('T7: every key the code uses exists in both languages; hu carries the accents', () => {
    const used = new Set<string>()
    for (const m of APP.matchAll(/'((?:auth\.totp|onboarding\.totp)\.[a-z_]+)'/g)) used.add(m[1]!)
    expect(used.size).toBeGreaterThan(30)
    for (const k of used) expect([k, typeof hu[k], typeof en[k]]).toEqual([k, 'string', 'string'])
    expect(hu['auth.totp.title']).toBe('Kétlépcsős belépés')
    expect(en['auth.totp.title']).toBe('Two-step sign-in')
    expect(hu['onboarding.totp.skip']).toBe('Kihagyom')
  })
})

describe('the wiring (source pins)', () => {
  it('T8: the overlay and the wizard sign-in branch on totp_required; the calls take the unwrapped fetch', () => {
    const overlay = extractFn('showLoginOverlay')
    expect(overlay).toContain("if (o.kind === 'totp_required') { passEl.value = ''; showCodeStep(o.pending); return }")
    expect(APP).toMatch(/window\.mvTotpCall = async \(method, path, body\) => \{[\s\S]{0,400}await originalFetch\(path, init\)/)
    expect(extractFn('onbSignIn')).toContain('if (r.totpRequired) { renderOnbTotpLogin(r.pending); return true }')
  })

  it('T9: the pending token, the key and the codes never reach storage, a URL or the console', () => {
    for (const fn of ['buildTotpCodeStep', 'mountTotpSetup', 'renderTotpSection', 'renderOnbTotpLogin']) {
      const src = extractFn(fn)
      expect([fn, /localStorage|sessionStorage|console\.|history\.|location\.(?:href|search|hash)\s*=/.test(src)]).toEqual([fn, false])
    }
  })

  it('T10: Settings shows the block only for an owner session; the wizard step is offered only after a create', () => {
    expect(extractFn('renderAuthCard')).toContain("if (status.owner_session === true && !status.setup_required) renderTotpSection(body)")
    expect(extractFn('wireOnboardingLogin')).toMatch(/if \(r\.ok\) \{\n(?:\s*\/\/.*\n)*\s*setOnbTotpOffer\(true\)/)
    expect(extractFn('renderOnboarding')).toContain('const totpOffer = !loginStep && onbTotpOfferPending()')
  })
})
