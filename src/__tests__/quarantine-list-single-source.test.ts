import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The quarantine domain list lives in exactly one place.
//
// It used to live in two: the gate (enforcement) and the sub-agent's own
// definition (a promise the prompt makes to itself), plus a copy of that
// definition in every agent directory. They agreed on the day they were
// written, which is the only day a duplicated list is guaranteed to agree --
// and the prompt copy could never enforce anything anyway.
//
// The gate is the source. This test is what stops the enumeration from
// creeping back into the prompt the next time someone adds a domain and
// "helpfully" documents it in both places.

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

const GATE = 'scripts/hooks/egress-gate.mjs'
const TEMPLATE = 'templates/sub-agents/quarantine-reader.md'

// A sample of the list, not the whole thing: this test must not become a second
// copy of the very list it is guarding.
const SAMPLE_DOMAINS = ['status.anthropic.com', 'hnrss.org', 'feeds.bbci.co.uk', 'export.arxiv.org']

describe('where the quarantine domain list lives', () => {
  it('is in the gate, which is the thing that decides', () => {
    const gate = repoFile(GATE)
    for (const domain of SAMPLE_DOMAINS) expect(gate).toContain(domain)
  })

  it('is NOT in the sub-agent definition any more', () => {
    // The failure this prevents: someone adds a domain to the gate, documents
    // it in the prompt too, and six months later the two disagree with nobody
    // noticing -- because only one of them is ever executed.
    const template = repoFile(TEMPLATE)
    for (const domain of SAMPLE_DOMAINS) {
      expect(template, `${TEMPLATE} should not enumerate ${domain}`).not.toContain(domain)
    }
  })

  it('and the definition says who does hold it, rather than going silent', () => {
    // Removing the list without saying why would read as an oversight, and the
    // next editor would put it back.
    const template = repoFile(TEMPLATE)
    expect(template).toMatch(/egress gate/i)
    expect(template).toMatch(/do not carry the domain list/i)
  })

  it('still tells the sub-agent what to do when a fetch is refused', () => {
    // The refusal is an ordinary result for this agent; without this line it
    // would be free to treat a block as a problem to route around.
    const template = repoFile(TEMPLATE)
    expect(template).toMatch(/refusal is a\s+RESULT/i)
    expect(template).toMatch(/never try another route/i)
  })
})
