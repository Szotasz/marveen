import { describe, it, expect } from 'vitest'
import {
  renderFederationBlock,
  renderRoutingDirective,
  renderSubAgentFederationBlock,
  renderPolicySeed,
  applyFederationBlock,
  FEDERATION_BLOCK_BEGIN,
  FEDERATION_BLOCK_END,
  FEDERATION_POLICY_ANCHOR,
  type OnboardingIdentity,
} from '../web/federation/onboarding.js'
import type { FederationConfig } from '../web/federation/config.js'

const ID: OnboardingIdentity = { botName: 'Arthur', mainAgentId: 'arthur', webPort: 3420, lang: 'hu' }

function cfg(peers: Array<{ id: string; outboundToken?: string }> = [{ id: 'teodor' }]): FederationConfig {
  return {
    enabled: true,
    systemId: 'arthur',
    peers: peers.map((p) => ({
      id: p.id,
      baseUrl: `https://${p.id}.example`,
      outboundToken: p.outboundToken ?? 'x'.repeat(64),
      inboundToken: 'y'.repeat(64),
      trust: 'untrusted' as const,
    })),
  }
}

// A CLAUDE.md skeleton mirroring the template's heading structure.
const PERSONA = `# Arthur

## Architektúra
stuff

## Inter-agent kommunikáció
Csak futó tmux-os ügynöknek üzenhetsz.

## Öntanulás és Skill rendszer
more stuff
`

// The 5-system design point with Tailscale-length baseUrls -- the byte
// budget must hold at realistic scale, not just a 2-peer short-URL config.
const REALISTIC_PEERS = ['teodor', 'cecil', 'donna', 'ellis'].map((id) => ({ id }))

describe('renderFederationBlock', () => {
  it('renders the addressing exception, the peer list and the binary rule, within the byte budget', () => {
    const block = renderFederationBlock(cfg([{ id: 'teodor' }, { id: 'cecil', outboundToken: '' }]), ID)
    expect(block.startsWith(FEDERATION_BLOCK_BEGIN)).toBe(true)
    expect(block.endsWith(FEDERATION_BLOCK_END)).toBe(true)
    expect(block).toContain('`teodor` (https://teodor.example)')
    expect(block).toContain('párosítás folyamatban') // unpaired peer marked
    expect(block).toContain('NEM')                    // explicit exception to the tmux/agents-list rule
    expect(block).toContain('Authorization: Bearer')  // curl example carries auth (fix-agent-auth-headers.sh hazard)
    expect(block).toContain('SAJÁT csatornádon')      // binary-results rule
  })

  it('stays within the byte budget in BOTH languages AND EVERY routing mode at the 5-system scale (L5 raised 2048->3072)', () => {
    // Every peer baseUrl at realistic Tailscale length, not one long + three short.
    // Iterate the routing modes too: 'strong' renders the LONGEST directive, so a
    // default-only guard would let the worst-case mode silently breach the budget.
    for (const lang of ['hu', 'en'] as const) {
      for (const routingMode of ['strong', 'catalog-first', 'advisory'] as const) {
        const block = renderFederationBlock({ ...cfg(REALISTIC_PEERS), routingMode }, { ...ID, lang })
        const bytes = Buffer.byteLength(block.replace(/https:\/\/\w+\.example/g, 'https://machine-name.tail1abcd.ts.net'), 'utf-8')
        expect(bytes, `${lang}/${routingMode}`).toBeLessThan(3072)
      }
    }
  })

  it('carries the L5 delegation directive + loop-safety rules in BOTH languages', () => {
    const hu = renderFederationBlock(cfg(), ID)
    expect(hu).toContain('GET /api/federation/directory') // fetch the catalog
    expect(hu).toContain('ÖNBEVALLÁS')                    // peer claims are untrusted
    expect(hu).toContain('Egy-ugrás')                     // anti-loop
    expect(hu).toContain('nyugtázás')                     // no content-free acks
    expect(hu).toMatch(/SOHA ne tegyél bele\s+titkot/)    // outbound minimization
    const en = renderFederationBlock(cfg(), { ...ID, lang: 'en' })
    expect(en).toContain('GET /api/federation/directory')
    expect(en).toContain('SELF-REPORTED CLAIMS')
    expect(en).toContain('One hop')
    expect(en).toContain('acknowledgements')
    expect(en).toMatch(/NEVER include secrets/)
  })

  it('renders English when DASHBOARD_LANG is en, without literal brand names', () => {
    const block = renderFederationBlock(cfg(), { ...ID, lang: 'en' })
    expect(block).toContain('USUAL message API')
    expect(block).not.toContain('Marveen') // brand discipline: ids come from identity
  })
})

describe('routing modes (configurable delegation eagerness)', () => {
  it('renders a DISTINCT directive per mode in BOTH languages, each still pointing at the catalog', () => {
    for (const lang of ['hu', 'en'] as const) {
      const strong = renderRoutingDirective('strong', lang)
      const catalog = renderRoutingDirective('catalog-first', lang)
      const advisory = renderRoutingDirective('advisory', lang)
      expect(new Set([strong, catalog, advisory]).size).toBe(3) // all three differ
      for (const d of [strong, catalog, advisory]) expect(d).toContain('/api/federation/directory')
      // advisory biases the main agent to answer itself; strong to delegate
      expect(advisory.toLowerCase()).toContain(lang === 'hu' ? 'magad' : 'yourself')
      expect(strong).toContain(lang === 'hu' ? 'ALAPBÓL' : 'BY DEFAULT')
    }
  })

  it('renderFederationBlock embeds the chosen mode, and an absent routingMode === catalog-first', () => {
    const base = cfg()
    const def = renderFederationBlock(base, ID) // no routingMode set
    const catalogFirst = renderFederationBlock({ ...base, routingMode: 'catalog-first' }, ID)
    const strong = renderFederationBlock({ ...base, routingMode: 'strong' }, ID)
    const advisory = renderFederationBlock({ ...base, routingMode: 'advisory' }, ID)
    expect(def).toBe(catalogFirst) // default is catalog-first
    expect(strong).not.toBe(catalogFirst)
    expect(advisory).not.toBe(catalogFirst)
    expect(strong).toContain(renderRoutingDirective('strong', 'hu')) // the directive is embedded verbatim
    // the mode-independent framing (untrusted catalog, loop safety) survives in every mode:
    for (const b of [catalogFirst, strong, advisory]) {
      expect(b).toContain('ÖNBEVALLÁS')
      expect(b).toContain('Egy-ugrás')
    }
  })
})

describe('renderSubAgentFederationBlock', () => {
  it('teaches a directly-addressed specialist to reply (both languages), no peer list, no policy seed, within budget', () => {
    for (const lang of ['hu', 'en'] as const) {
      const block = renderSubAgentFederationBlock({ ...ID, lang })
      expect(block.startsWith(FEDERATION_BLOCK_BEGIN)).toBe(true)
      expect(block.endsWith(FEDERATION_BLOCK_END)).toBe(true)
      expect(block).toContain('Authorization: Bearer')       // reply curl carries auth
      expect(block).not.toContain(FEDERATION_POLICY_ANCHOR)  // owner policy is the main agent's
      expect(Buffer.byteLength(block, 'utf-8')).toBeLessThan(2048)
    }
    const hu = renderSubAgentFederationBlock(ID)
    expect(hu).toContain('KIVÉTEL')      // the '/'-address exception to only-tmux/Főnök
    expect(hu).toContain('Egy-ugrás')    // one-hop
    const en = renderSubAgentFederationBlock({ ...ID, lang: 'en' })
    expect(en).toContain('EXCEPTION')
    expect(en).toContain('One hop')
  })
})

describe('applyFederationBlock (line-exact surgery)', () => {
  const block = renderFederationBlock(cfg(), ID)

  it('inserts after the Inter-agent section when the heading exists', () => {
    const next = applyFederationBlock(PERSONA, block)
    expect(next).not.toBeNull()
    const lines = next!.split('\n')
    const begin = lines.indexOf(FEDERATION_BLOCK_BEGIN)
    const interagent = lines.findIndex((l) => l.trim() === '## Inter-agent kommunikáció')
    const nextHeading = lines.findIndex((l) => l.startsWith('## Öntanulás'))
    expect(begin).toBeGreaterThan(interagent)
    expect(begin).toBeLessThan(nextHeading)
  })

  it('appends at EOF when the heading is missing (hand-edited persona)', () => {
    const next = applyFederationBlock('# Custom persona\nno sections here\n', block)
    expect(next!.trimEnd().endsWith(FEDERATION_BLOCK_END)).toBe(true)
  })

  it('is idempotent: re-applying the same block changes nothing', () => {
    const first = applyFederationBlock(PERSONA, block)!
    expect(applyFederationBlock(first, block)).toBeNull()
  })

  it('replaces in place when the peer list changes, preserving surrounding text', () => {
    const first = applyFederationBlock(PERSONA, block)!
    const updated = renderFederationBlock(cfg([{ id: 'teodor' }, { id: 'newpeer' }]), ID)
    const second = applyFederationBlock(first, updated)!
    expect(second).toContain('newpeer')
    expect(second).toContain('## Öntanulás és Skill rendszer')
    expect(second.match(new RegExp(FEDERATION_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
  })

  it('removes the block (markers inclusive) on disable, leaving the persona intact', () => {
    const withBlock = applyFederationBlock(PERSONA, block)!
    const removed = applyFederationBlock(withBlock, null)!
    expect(removed).not.toContain('MARVEEN-FEDERATION:BEGIN')
    expect(removed).toContain('Csak futó tmux-os ügynöknek üzenhetsz.')
    expect(removed).toContain('## Öntanulás és Skill rendszer')
  })

  it('does not leak blank lines across enable->disable->enable cycles (unbounded-growth guard)', () => {
    let doc = PERSONA
    for (let i = 0; i < 5; i++) {
      doc = applyFederationBlock(doc, block) ?? doc
      doc = applyFederationBlock(doc, null) ?? doc
    }
    // After N cycles the persona must be byte-identical to the original (no
    // accumulated blank lines at the former insertion point).
    expect(doc).toBe(PERSONA)
  })

  it('treats BEGIN without END as corruption: throws, never deletes to EOF', () => {
    const corrupted = `${PERSONA}\n${FEDERATION_BLOCK_BEGIN}\nno end marker`
    expect(() => applyFederationBlock(corrupted, block)).toThrow(/corrupted/)
    expect(() => applyFederationBlock(corrupted, null)).toThrow(/corrupted/)
  })

  it('does not confuse the POLICY anchor with block markers', () => {
    const withPolicy = `${PERSONA}\n${FEDERATION_POLICY_ANCHOR}\n### Házirend\nowner text\n`
    const next = applyFederationBlock(withPolicy, block)!
    const removed = applyFederationBlock(next, null)!
    expect(removed).toContain('owner text') // policy survives block removal
  })
})

describe('renderPolicySeed', () => {
  it('starts with the stable language-independent anchor in both languages', () => {
    expect(renderPolicySeed('hu').startsWith(FEDERATION_POLICY_ANCHOR)).toBe(true)
    expect(renderPolicySeed('en').startsWith(FEDERATION_POLICY_ANCHOR)).toBe(true)
    expect(renderPolicySeed('hu')).toContain('eszkalálj')
    expect(renderPolicySeed('en')).toContain('escalated')
  })

  it('binds the RESPONSE content and outbound delegation, and flags unsolicited answers (L5)', () => {
    // The added carve-out must not drop the secret/outward check from the reply.
    expect(renderPolicySeed('en')).toMatch(/PROVIDED the reply discloses no\s+secrets/)
    expect(renderPolicySeed('en')).toContain('Outbound delegated tasks follow the same bound')
    expect(renderPolicySeed('en')).toContain('unsolicited')
    expect(renderPolicySeed('hu')).toMatch(/FELTÉVE, hogy a válasz nem tár fel titkot/)
    expect(renderPolicySeed('hu')).toContain('KIMENŐ')
    expect(renderPolicySeed('hu')).toContain('kéretlen')
  })
})
