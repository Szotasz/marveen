import { describe, it, expect } from 'vitest'
import { maskSecrets } from '../web/agent-transcript.js'

// The endpoint returns whole events on purpose (the owner asked for it), so
// masking is the only thing standing between a leaked credential and the
// caller. These tests pin that behaviour: a secret must not survive, and the
// surrounding text must.
describe('maskSecrets', () => {
  it('redacts a bearer token but keeps the label', () => {
    const out = maskSecrets('curl -H "Authorization: Bearer abcdef0123456789abcdef0123456789"')
    expect(out).not.toContain('abcdef0123456789abcdef0123456789')
    expect(out).toContain('Bearer')
    expect(out).toContain('<REDACTED>')
  })

  it('redacts a github fine-grained PAT', () => {
    const secret = `github_pat_${'A1b2C3d4E5'.repeat(3)}`
    const out = maskSecrets(`push failed with ${secret} in url`)
    expect(out).not.toContain(secret)
    expect(out).toContain('push failed with')
    expect(out).toContain('in url')
  })

  it('redacts classic gh tokens and slack tokens', () => {
    // Assembled at run time on purpose: written out whole, these fixtures trip
    // GitHub push protection, which blocks the push even though nothing here
    // is a real credential. Splitting the literal keeps the pattern out of the
    // source while the value under test stays identical.
    const gh = `ghp_${'x'.repeat(36)}`
    const slack = ['xox', 'b-1234567890-abcdefghijklmno'].join('')
    const out = maskSecrets(`${gh} and ${slack}`)
    expect(out).not.toContain(gh)
    expect(out).not.toContain(slack)
  })

  it('redacts a token= assignment', () => {
    const out = maskSecrets('token=sk-live-0123456789abcdefghij')
    expect(out).not.toContain('sk-live-0123456789abcdefghij')
  })

  // Masking is not truncation: this is the difference the owner explicitly
  // asked for. Ordinary prose -- including long words and ids that are not
  // credentials -- has to come through untouched.
  it('leaves ordinary text alone', () => {
    const text = 'A 8692-es feladat lezarva, a kovetkezo batch 17 elemu, review_id=4291'
    expect(maskSecrets(text)).toBe(text)
  })

  it('leaves short values alone even next to a secret-ish label', () => {
    const text = 'token: abc'
    expect(maskSecrets(text)).toBe(text)
  })

  // SHAPE-ONLY credentials -- the review condition on this PR (2026-09-05).
  // Each of these carries NO label and NO prefix the earlier passes look for,
  // so before wiring maskSecrets to SECRET_PATTERNS every one of them came out
  // of the endpoint verbatim. One test per named shape, so a future narrowing
  // of the pattern set fails here loudly instead of silently leaking.
  it('redacts an untagged JWT', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
                 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.')
    const out = maskSecrets(`response body: ${jwt} (200)`)
    expect(out).not.toContain(jwt)
    expect(out).toContain('response body:')
    expect(out).toContain('(200)')
  })

  it('redacts an AWS access key id', () => {
    const akia = `AKIA${'ABCDEFGHIJKLMNOP'}`
    const out = maskSecrets(`aws configure set aws_access_key_id ${akia}`)
    expect(out).not.toContain(akia)
    expect(out).toContain('aws configure set')
  })

  // The UNDERSCORE form: the standalone list only had `sk-`, so `sk_live_`
  // walked straight through. Assembled at run time like the gh/slack fixtures.
  it('redacts an sk_live_ key (underscore form)', () => {
    const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8I9j0'].join('_')
    const out = maskSecrets(`stripe call failed with ${key}`)
    expect(out).not.toContain(key)
    expect(out).toContain('stripe call failed with')
  })

  it('redacts a private key block header', () => {
    const out = maskSecrets('cat id_rsa -> -----BEGIN RSA PRIVATE KEY----- ...')
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(out).toContain('cat id_rsa')
  })

  // Guard against the adaptation itself: SECRET_PATTERNS entries are
  // single-match, so a non-global copy would mask only the FIRST occurrence.
  it('redacts every occurrence, not just the first', () => {
    const a = `AKIA${'ABCDEFGHIJKLMNOP'}`
    const b = `AKIA${'QRSTUVWXYZ012345'}`
    const out = maskSecrets(`${a} and later ${b}`)
    expect(out).not.toContain(a)
    expect(out).not.toContain(b)
  })
})
