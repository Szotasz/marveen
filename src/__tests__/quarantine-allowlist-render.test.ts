import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderQuarantineReader, ownerAllowedDomains, quarantineReaderDomains, isPublicFetchHost } from '../web/agent-scaffold.js'

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

// EGRESSKEY816: a domain granted at the quarantine_domains level is honored by
// the egress-gate hook (its step 4 applies to the quarantine-reader agent type)
// but used to be invisible to the rendered reader definition, whose prompt-level
// list came from the `domains` key alone -- so the reader refused the host
// before a fetch was ever attempted. The render input must be the union the
// hook enforces.
describe('quarantineReaderDomains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-q-'))

  it('unions domains and quarantine_domains, domains first', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'),
      JSON.stringify({ domains: ['a.com'], quarantine_domains: ['q.com'] }))
    expect(quarantineReaderDomains(dir)).toEqual(['a.com', 'q.com'])
  })

  it('does not open quarantine_domains for the every-agent list', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'),
      JSON.stringify({ domains: ['a.com'], quarantine_domains: ['q.com'] }))
    expect(ownerAllowedDomains(dir)).toEqual(['a.com'])
  })

  it('dedupes a host present at both levels, case-insensitively', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'),
      JSON.stringify({ domains: ['both.com'], quarantine_domains: ['BOTH.com', 'q.com'] }))
    expect(quarantineReaderDomains(dir)).toEqual(['both.com', 'q.com'])
  })

  it('applies the same host vetting as the domains key', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'),
      JSON.stringify({ domains: [], quarantine_domains: ['q.com', 'localhost', 'evil.internal', 42, ' spaced.com '] }))
    expect(quarantineReaderDomains(dir)).toEqual(['q.com', 'spaced.com'])
  })

  it('a missing quarantine_domains key degrades to the domains list', () => {
    writeFileSync(join(dir, 'egress-allowlist.json'), JSON.stringify({ domains: ['a.com'] }))
    expect(quarantineReaderDomains(dir)).toEqual(['a.com'])
  })

  it('a quarantine_domains-level grant reaches the rendered reader definition', () => {
    // The regression this whole card exists for: the render must carry the
    // union, or the hook allows what the reader's own prompt still refuses.
    writeFileSync(join(dir, 'egress-allowlist.json'),
      JSON.stringify({ domains: [], quarantine_domains: ['elevenlabs.io'] }))
    const out = renderQuarantineReader(TEMPLATE, quarantineReaderDomains(dir))
    expect(out).toContain('- `elevenlabs.io`')
  })
})

// The egress gate and the reader are edited with different threat models: the
// gate answers "may the main agent call this host" (a LAN box is ordinary), the
// reader answers "may a fetch target be steered here". Inheriting the first into
// the second without a filter widens the inward-facing boundary. Reported on
// #797 with five values that all passed through before this.
describe('isPublicFetchHost', () => {
  it('rejects the five values that reproduced in review', () => {
    for (const bad of ['127.0.0.1', 'localhost', '169.254.169.254', '192.168.1.50', '*']) {
      expect(isPublicFetchHost(bad)).toBe(false)
    }
  })

  it('rejects IP literals generally, not just the private ones', () => {
    // A fetch target is a name; an address skips the name check entirely.
    for (const ip of ['8.8.8.8', '10.0.0.1', '172.16.4.9', '0.0.0.0', '1.2.3.4']) {
      expect(isPublicFetchHost(ip)).toBe(false)
    }
  })

  it('rejects internal suffixes and single-label names', () => {
    for (const bad of ['printer.local', 'db.internal', 'box.lan', 'wiki.intranet', 'nas', 'router.home']) {
      expect(isPublicFetchHost(bad)).toBe(false)
    }
  })

  it('rejects anything carrying a scheme, port, path, space or wildcard', () => {
    for (const bad of ['https://claude.com', 'claude.com:8080', 'claude.com/blog', 'claude com', '*.claude.com', '']) {
      expect(isPublicFetchHost(bad)).toBe(false)
    }
  })

  it('accepts ordinary public hostnames', () => {
    for (const ok of ['claude.com', 'docs.claude.com', 'hnrss.org', 'feeds.bbci.co.uk', 'export.arxiv.org']) {
      expect(isPublicFetchHost(ok)).toBe(true)
    }
  })

  it('is case and whitespace tolerant', () => {
    expect(isPublicFetchHost('  Claude.COM  ')).toBe(true)
  })

  it('drops the rejected entries from ownerAllowedDomains instead of failing the read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egress-filter-'))
    writeFileSync(join(dir, 'egress-allowlist.json'), JSON.stringify({
      domains: ['claude.com', '127.0.0.1', 'localhost', '169.254.169.254', '192.168.1.50', '*', 'docs.anthropic.com'],
    }))
    // The good ones survive; a hostile line does not take the whole file down.
    expect(ownerAllowedDomains(dir)).toEqual(['claude.com', 'docs.anthropic.com'])
  })
})

describe('renderQuarantineReader anchoring', () => {
  it('puts the block in the Domain restriction section even when a later section has bullets', () => {
    const tpl = [
      '## Domain restriction', '',
      'Only fetch URLs from these approved domains:',
      '- `hnrss.org`', '',
      '## Output format', '',
      '- `url` the requested URL', '',
    ].join('\n')
    const out = renderQuarantineReader(tpl, ['claude.com'])
    expect(out.indexOf('- `claude.com`')).toBeLessThan(out.indexOf('## Output format'))
  })
})
