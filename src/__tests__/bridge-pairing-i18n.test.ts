// BRIDGEHU813. The pairing UI was already Hungarian everywhere except its
// error line: the dashboard printed the server's English sentence verbatim
// (web/app.js did `msg.textContent = data.error`). The fix gives every pairing
// failure a stable `code`, and the UI translates on the code.
//
// What this file guards, and why each part is here:
//  1. COVERAGE -- every code the server can actually emit has a hu AND en key.
//     Without this a new server error would silently reach the user in English
//     again, which is exactly the bug. Measured functionally where possible:
//     the validators are RUN and their thrown codes collected, not grepped.
//  2. BEHAVIOUR -- the real bridgeEnrollErrorText from app.js, evaluated with a
//     stub t(): known code translates, unknown code falls back to the server's
//     sentence, and nothing renders a bare key.
//  3. MUTATION CONTROLS -- each assertion is shown to fail when the property it
//     claims is broken. A green coverage test that cannot go red proves nothing.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import {
  RemoteEnrollError,
  validatePublicKeyLine,
  checkEnrollHost,
  ACCEPTED_KEY_TYPE,
  COMMENT_PREFIX,
} from '../remote-enroll-core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const KEY_PREFIX = 'auth.bridge.err.'

let hu: Record<string, string>
let en: Record<string, string>

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

/** A syntactically valid line, used as the base for targeted mutations. */
const GOOD_KEY = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from(ACCEPTED_KEY_TYPE, 'utf8'),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString('base64')
const GOOD_LINE = `${ACCEPTED_KEY_TYPE} ${GOOD_KEY} ${COMMENT_PREFIX}1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed`

/** Run every validator branch and collect the code it threw. Functional, not
 * a grep: if a code is renamed in the source, this map changes with it. */
function codesThrownByValidators(): Map<string, string> {
  const seen = new Map<string, string>()
  const record = (label: string, run: () => unknown) => {
    try {
      run()
      throw new Error(`expected "${label}" to throw`)
    } catch (err) {
      if (!(err instanceof RemoteEnrollError)) throw err
      seen.set(err.code, label)
    }
  }
  const badBlob = (b: Buffer) =>
    `${ACCEPTED_KEY_TYPE} ${b.toString('base64')} ${COMMENT_PREFIX}1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed`
  const field = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }

  record('line_required', () => validatePublicKeyLine(undefined as unknown as string))
  record('line_empty', () => validatePublicKeyLine('   '))
  record('line_multiline', () => validatePublicKeyLine(`${GOOD_LINE}\nsecond`))
  record('line_fields', () => validatePublicKeyLine(`${ACCEPTED_KEY_TYPE} ${GOOD_KEY}`))
  record('key_type', () => validatePublicKeyLine(GOOD_LINE.replace(ACCEPTED_KEY_TYPE, 'ssh-rsa')))
  // Not badBlob(): base64-encoding a Buffer always yields valid base64. The
  // invalid body has to be substituted as a raw string.
  record('key_not_base64', () =>
    validatePublicKeyLine(`${ACCEPTED_KEY_TYPE} !!!! ${COMMENT_PREFIX}1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed`))
  record('blob_too_short', () => validatePublicKeyLine(badBlob(Buffer.from([1, 2]))))
  record('blob_type_field', () => validatePublicKeyLine(badBlob(Buffer.concat([field(99), Buffer.alloc(4)]))))
  record('blob_type_mismatch', () =>
    validatePublicKeyLine(badBlob(Buffer.concat([field(11), Buffer.from('ssh-ed25518', 'utf8'), field(32), Buffer.alloc(32)]))))
  record('blob_truncated', () =>
    validatePublicKeyLine(badBlob(Buffer.concat([field(11), Buffer.from(ACCEPTED_KEY_TYPE, 'utf8')]))))
  record('key_length', () =>
    validatePublicKeyLine(badBlob(Buffer.concat([field(11), Buffer.from(ACCEPTED_KEY_TYPE, 'utf8'), field(31), Buffer.alloc(31)]))))
  record('blob_trailing', () =>
    validatePublicKeyLine(badBlob(Buffer.concat([field(11), Buffer.from(ACCEPTED_KEY_TYPE, 'utf8'), field(32), Buffer.alloc(33)]))))
  record('comment_prefix', () => validatePublicKeyLine(`${ACCEPTED_KEY_TYPE} ${GOOD_KEY} other:abc`))
  record('comment_uuid', () => validatePublicKeyLine(`${ACCEPTED_KEY_TYPE} ${GOOD_KEY} ${COMMENT_PREFIX}not-a-uuid`))
  return seen
}

/** The host checker returns codes instead of throwing. */
function codesFromHostCheck(): string[] {
  const cases = ['', 'a'.repeat(254), 'user@example.com', 'https://example.com/x', 'not a host!']
  return cases.map((c) => {
    const r = checkEnrollHost(c, isIP)
    if (r.ok) throw new Error(`expected "${c.slice(0, 20)}" to be rejected`)
    return r.code
  })
}

/** Route-level codes: these live in the response body, not in an exception, so
 * they are read from the handler source. Anchored on `code:` so a renamed code
 * moves this list with it. */
function routeCodes(): string[] {
  const src = readFileSync(join(ROOT, 'src/web/routes/security.ts'), 'utf-8')
  const found = [...src.matchAll(/\bcode: '([a-z0-9_]+)'/g)].map((m) => m[1])
  return [...new Set(found)]
}

describe('BRIDGEHU813 -- every pairing failure has a Hungarian message', () => {
  it('the validators throw a code for every branch, and each has a hu and en key', () => {
    const thrown = codesThrownByValidators()
    // The count is asserted so that deleting a branch (and its control) shows
    // up as a failure rather than as a quietly smaller set.
    expect(thrown.size).toBe(14)
    const missingHu = [...thrown.keys()].filter((c) => !(KEY_PREFIX + c in hu))
    const missingEn = [...thrown.keys()].filter((c) => !(KEY_PREFIX + c in en))
    expect(missingHu, 'codes with no Hungarian message').toEqual([])
    expect(missingEn, 'codes with no English message').toEqual([])
  })

  it('every host-check rejection carries a code that has both messages', () => {
    const codes = codesFromHostCheck()
    expect(codes).toEqual(['host_empty', 'host_too_long', 'host_email', 'host_url', 'host_invalid'])
    for (const c of codes) {
      expect(hu, `hu is missing ${c}`).toHaveProperty(KEY_PREFIX + c)
      expect(en, `en is missing ${c}`).toHaveProperty(KEY_PREFIX + c)
    }
  })

  it('the route codes and the host-key failure have both messages too', () => {
    const codes = [...routeCodes(), 'host_key_missing']
    expect(codes).toContain('enroll_failed')
    expect(codes).toContain('invalid_name')
    expect(codes.length).toBeGreaterThanOrEqual(7)
    for (const c of codes) {
      if (c === 'checked') continue
      expect(hu, `hu is missing ${c}`).toHaveProperty(KEY_PREFIX + c)
      expect(en, `en is missing ${c}`).toHaveProperty(KEY_PREFIX + c)
    }
  })

  it('the route serialises code and params beside the message', () => {
    // The browser test builds its stubbed response in this exact shape. If the
    // route ever stops sending `code`, that stub would keep the browser test
    // green while the real dashboard fell back to English, so the shape is
    // pinned here rather than trusted.
    const src = readFileSync(join(ROOT, 'src/web/routes/security.ts'), 'utf-8')
    expect(src).toContain('{ error: err.message, code: err.code, params: err.params }')
    // The host branch forwards the checker's own code rather than inventing one.
    expect(src).toMatch(/code: checked\.code/)
    expect(src).toMatch(/params: checked\.params/)
  })

  it('the host-key failure this card came from is Hungarian and names the fix', () => {
    // The reporter's own case: the English text said the right thing, in the
    // wrong language. The Hungarian must still name the actual step (turn on
    // remote login), not just report that something failed.
    const msg = hu[`${KEY_PREFIX}host_key_missing`]
    expect(msg).toContain('Távoli bejelentkezés')
    expect(msg).not.toBe(en[`${KEY_PREFIX}host_key_missing`])
  })

  it('MUTATION CONTROL: the coverage assertion fails when a message is missing', () => {
    const withHole = { ...hu }
    delete withHole[`${KEY_PREFIX}host_key_missing`]
    const missing = [...codesThrownByValidators().keys(), 'host_key_missing'].filter(
      (c) => !(KEY_PREFIX + c in withHole),
    )
    expect(missing).toEqual(['host_key_missing'])
  })

  it('MUTATION CONTROL: hu and en actually differ (a copy-paste of en would pass a weaker test)', () => {
    const codes = [...codesThrownByValidators().keys()]
    const identical = codes.filter((c) => hu[KEY_PREFIX + c] === en[KEY_PREFIX + c])
    expect(identical, 'these Hungarian messages are byte-identical to the English').toEqual([])
  })
})

describe('BRIDGEHU813 -- the dashboard translates on the code, not on the sentence', () => {
  // Evaluate the real function out of app.js rather than restating it here: a
  // restated copy would keep passing after the shipped one broke.
  function loadErrorText(dict: Record<string, string>) {
    const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
    const start = app.indexOf('function bridgeEnrollErrorText(data) {')
    expect(start, 'bridgeEnrollErrorText not found in web/app.js').toBeGreaterThan(-1)
    const end = app.indexOf('\n}', start) + 2
    const src = app.slice(start, end)
    const t = (key: string, params: Record<string, string> = {}) =>
      (dict[key] ?? key).replace(/\{(\w+)\}/g, (_: string, k: string) => (params[k] != null ? params[k] : `{${k}}`))
    return new Function('t', `${src}; return bridgeEnrollErrorText`)(t) as (d: unknown) => string
  }

  it('a known code renders the Hungarian message, not the server sentence', () => {
    const f = loadErrorText(hu)
    const out = f({ error: "could not obtain this machine's ssh-ed25519 host key", code: 'host_key_missing' })
    expect(out).toBe(hu[`${KEY_PREFIX}host_key_missing`])
    expect(out).not.toContain('could not obtain')
  })

  it('placeholders are filled from params', () => {
    const f = loadErrorText(hu)
    const out = f({ error: 'x', code: 'host_email', params: { seen: 'szabi@example.com' } })
    expect(out).toContain('szabi@example.com')
    expect(out).not.toContain('{seen}')
  })

  it('an unknown code falls back to the server sentence, never to a raw key', () => {
    const f = loadErrorText(hu)
    const out = f({ error: 'something new the server added', code: 'not_translated_yet' })
    expect(out).toBe('something new the server added')
    expect(out).not.toContain(KEY_PREFIX)
  })

  it('no code at all still shows the server sentence', () => {
    const f = loadErrorText(hu)
    expect(f({ error: 'plain server error' })).toBe('plain server error')
  })

  it('an empty body falls back to the generic message', () => {
    const f = loadErrorText({ ...hu, 'auth.card.err_generic': 'Ismeretlen hiba.' })
    expect(f({})).toBe('Ismeretlen hiba.')
  })

  it('MUTATION CONTROL: with an empty dictionary the known code degrades to English, not to a key', () => {
    const f = loadErrorText({})
    const out = f({ error: 'server sentence', code: 'host_key_missing' })
    expect(out).toBe('server sentence')
  })
})
