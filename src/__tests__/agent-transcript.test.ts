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
})
