import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderQuarantineReader, ownerAllowedDomains } from '../web/agent-scaffold.js'

// The quarantine reader may only fetch from an allowlist, and that list used to
// exist TWICE: once in this template and once in store/egress-allowlist.json,
// maintained by hand. The two drifted, and the deploy silently reverted the
// hand-edit. These tests pin the fix: the owner's list is an INPUT to the
// render, so a re-render cannot erase the owner's decision.
const TEMPLATE = `---
name: quarantine-reader
---

## Domain restriction

Only fetch URLs from these approved domains. Reject all others:
- \`status.anthropic.com\`
- \`hnrss.org\`
- \`www.reddit.com\` (RSS feeds only)

For any other domain, return the error shape.
`

describe('renderQuarantineReader', () => {
  it('appends the owner domains inside the domain section, not at the end of the file', () => {
    const out = renderQuarantineReader(TEMPLATE, ['claude.com'])
    expect(out).toContain('- `claude.com`')
    // Still before the closing prose: the block must land in the list, because a
    // sub-agent reads the section, not the whole file as one blob.
    expect(out.indexOf('- `claude.com`')).toBeLessThan(out.indexOf('For any other domain'))
  })

  it('keeps every shipped domain', () => {
    const out = renderQuarantineReader(TEMPLATE, ['claude.com'])
    for (const d of ['status.anthropic.com', 'hnrss.org', 'www.reddit.com']) {
      expect(out).toContain(`- \`${d}\``)
    }
  })

  it('is idempotent: rendering twice does not stack the block', () => {
    const once = renderQuarantineReader(TEMPLATE, ['claude.com', 'openai.com'])
    const twice = renderQuarantineReader(once, ['claude.com', 'openai.com'])
    expect(twice).toBe(once)
    expect(twice.match(/BEGIN PER-INSTALL DOMAINS/g)?.length).toBe(1)
  })

  it('drops an owner domain the template already ships (no duplicate line)', () => {
    const out = renderQuarantineReader(TEMPLATE, ['hnrss.org'])
    expect(out.match(/- `hnrss\.org`/g)?.length).toBe(1)
    expect(out).not.toContain('BEGIN PER-INSTALL DOMAINS')
  })

  it('is case-insensitive about that duplicate check', () => {
    const out = renderQuarantineReader(TEMPLATE, ['HNRSS.ORG'])
    expect(out).not.toContain('BEGIN PER-INSTALL DOMAINS')
  })

  it('returns the template untouched when the owner allowed nothing', () => {
    expect(renderQuarantineReader(TEMPLATE, [])).toBe(TEMPLATE)
  })

  it('re-render REMOVES a domain the owner revoked', () => {
    // The point of the marker block: taking a domain out of the egress
    // allowlist has to take it out of the reader too, or a revoked permission
    // keeps working.
    const withDomain = renderQuarantineReader(TEMPLATE, ['claude.com'])
    const revoked = renderQuarantineReader(withDomain, [])
    expect(revoked).not.toContain('- `claude.com`')
    expect(revoked).toBe(TEMPLATE)
  })

  it('survives a template with no domain bullets at all', () => {
    const odd = '# no list here\n'
    expect(renderQuarantineReader(odd, ['claude.com'])).toBe(odd)
  })
})

describe('ownerAllowedDomains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-'))

  it('reads the domains array', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'), JSON.stringify({ domains: ['a.com', 'b.com'] }))
    expect(ownerAllowedDomains(dir)).toEqual(['a.com', 'b.com'])
  })

  it('trims and drops the blanks', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'), JSON.stringify({ domains: [' a.com ', '', '  ', 'b.com'] }))
    expect(ownerAllowedDomains(dir)).toEqual(['a.com', 'b.com'])
  })

  it('drops non-strings instead of throwing', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'), JSON.stringify({ domains: ['a.com', 42, null, { x: 1 }] }))
    expect(ownerAllowedDomains(dir)).toEqual(['a.com'])
  })

  it('a malformed or missing file means "no extra domains", never a crash', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'), 'not json at all')
    expect(ownerAllowedDomains(dir)).toEqual([])
    expect(ownerAllowedDomains(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('a file without a domains key is not an error either', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'), JSON.stringify({ note: 'empty for now' }))
    expect(ownerAllowedDomains(dir)).toEqual([])
  })
})
