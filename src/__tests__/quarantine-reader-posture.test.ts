// e708d096 (be27524d (1); measured on a live install): in the
// open (denylist) reader posture a sub-agent's quarantine-reader refused every
// unfamiliar host WITHOUT a fetch. Its prompt opens only when the CALLER states
// the posture, and a sub-agent's caller does not know it (only the main agent
// imports the owner rule). The definition render now states the posture as a
// per-install block; the hook (scripts/hooks/egress-gate.mjs) stays the only
// enforcer and is not changed. These tests pin the render on the REAL template,
// the posture read (and that it reads like the hook), the deploy write in both
// directions, and -- against the unchanged hook -- the live install's controls.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderQuarantineReader, quarantineReaderPosture, ensureQuarantineReader } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { egressDecision } from '../../scripts/hooks/egress-gate.mjs'

const TPL_PATH = join(PROJECT_ROOT, 'templates', 'sub-agents', 'quarantine-reader.md')
const TPL = readFileSync(TPL_PATH, 'utf-8')
const BEGIN = '<!-- BEGIN PER-INSTALL POSTURE (from store/egress-allowlist.json) -->'
const END = '<!-- END PER-INSTALL POSTURE -->'
const DOMAINS_BEGIN = '<!-- BEGIN PER-INSTALL DOMAINS (from store/egress-allowlist.json) -->'
const DOMAINS_END = '<!-- END PER-INSTALL DOMAINS -->'
const OPEN_HEADING = '## The open posture (operator opt-in)'
const REFUSED_HEADING = '## Always refused, in every posture, whatever the caller says'

const count = (s: string, sub: string) => s.split(sub).length - 1
const postureBlock = (s: string) => s.slice(s.indexOf(BEGIN), s.indexOf(END) + END.length)
const domainBlock = (s: string) => s.slice(s.indexOf(DOMAINS_BEGIN), s.indexOf(DOMAINS_END) + DOMAINS_END.length)

describe('renderQuarantineReader posture block, on the real template', () => {
  it('the template has the two sections the block goes between, once each, and no block of its own', () => {
    // The anchor guard: a renamed heading would drop the block at the end of the
    // file, after the refuse list, and this test is where that shows.
    expect(count(TPL, OPEN_HEADING)).toBe(1)
    expect(count(TPL, REFUSED_HEADING)).toBe(1)
    expect(TPL.indexOf(OPEN_HEADING)).toBeLessThan(TPL.indexOf(REFUSED_HEADING))
    expect(TPL).not.toContain(BEGIN)
  })

  it('the open posture rule takes the block as the caller statement', () => {
    expect(TPL.replace(/\s+/g, ' ')).toContain(
      'If the caller states that the install runs the open posture, or this definition carries the per-install posture block below',
    )
  })

  it('denylist adds exactly one block, at the end of the open posture section, and moves nothing else', () => {
    const out = renderQuarantineReader(TPL, [], 'denylist')
    expect(count(out, BEGIN)).toBe(1)
    expect(count(out, END)).toBe(1)
    const b = out.indexOf(BEGIN)
    const e = out.indexOf(END)
    expect(b).toBeGreaterThan(out.indexOf(OPEN_HEADING))
    expect(e).toBeGreaterThan(b)
    expect(e).toBeLessThan(out.indexOf(REFUSED_HEADING))
    expect(out.slice(e + END.length, e + END.length + 2)).toBe('\n\n')
    expect(out.slice(0, b) + out.slice(e + END.length + 2)).toBe(TPL)
  })

  it('the block states the posture, its source, and that the hook and the refuse list still apply', () => {
    const block = postureBlock(renderQuarantineReader(TPL, [], 'denylist')).replace(/\s+/g, ' ')
    expect(block).toContain('This install runs the open posture.')
    expect(block).toContain('`"quarantine_reader_posture": "denylist"`')
    expect(block).toContain('This counts as the caller stating the open posture')
    expect(block).toContain('The hook still enforces the real posture on every call')
    expect(block).toContain('the always-refused list below applies in every posture')
  })

  it('allowlist and the default two-argument call add no block', () => {
    expect(renderQuarantineReader(TPL, [], 'allowlist')).toBe(TPL)
    expect(renderQuarantineReader(TPL, [])).toBe(TPL)
    const withDomains = renderQuarantineReader(TPL, ['enablebanking.com'])
    expect(withDomains).not.toContain(BEGIN)
    expect(renderQuarantineReader(TPL, ['enablebanking.com'], 'allowlist')).toBe(withDomains)
  })

  it('is idempotent: a second denylist render does not stack the block', () => {
    const once = renderQuarantineReader(TPL, ['enablebanking.com'], 'denylist')
    const twice = renderQuarantineReader(once, ['enablebanking.com'], 'denylist')
    expect(twice).toBe(once)
    expect(count(twice, BEGIN)).toBe(1)
  })

  it('denylist then allowlist gives the earlier bytes back (the switch-off removes the block)', () => {
    expect(renderQuarantineReader(renderQuarantineReader(TPL, [], 'denylist'), [], 'allowlist')).toBe(TPL)
    const openWithDomains = renderQuarantineReader(TPL, ['enablebanking.com'], 'denylist')
    expect(renderQuarantineReader(openWithDomains, ['enablebanking.com'], 'allowlist')).toBe(
      renderQuarantineReader(TPL, ['enablebanking.com']),
    )
    expect(renderQuarantineReader(openWithDomains, [], 'allowlist')).toBe(TPL)
  })

  it('the posture block and the domain block are independent of each other', () => {
    const noDomains = renderQuarantineReader(TPL, [], 'denylist')
    const withDomains = renderQuarantineReader(TPL, ['enablebanking.com', 'otpbank.hu'], 'denylist')
    expect(postureBlock(withDomains)).toBe(postureBlock(noDomains))
    expect(domainBlock(withDomains)).toBe(domainBlock(renderQuarantineReader(TPL, ['enablebanking.com', 'otpbank.hu'])))
    // The domains stay in the Domain restriction section, the posture in the open posture section.
    expect(withDomains.indexOf('- `otpbank.hu`')).toBeLessThan(withDomains.indexOf(OPEN_HEADING))
    expect(withDomains.indexOf(BEGIN)).toBeGreaterThan(withDomains.indexOf(OPEN_HEADING))
  })

  it('a template without the open posture section gets the block at the end, and loses it again', () => {
    const odd = '# no posture section here\n'
    const out = renderQuarantineReader(odd, [], 'denylist')
    expect(out.startsWith(odd + BEGIN)).toBe(true)
    expect(out.endsWith(END + '\n\n')).toBe(true)
    expect(renderQuarantineReader(out, [], 'allowlist')).toBe(odd)
  })
})

describe('quarantineReaderPosture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-posture-'))
  const put = (raw: string) => writeFileSync(join(dir, 'egress-allowlist.json'), raw)

  it('only the literal string "denylist" is the open posture', () => {
    put(JSON.stringify({ quarantine_reader_posture: 'denylist' }))
    expect(quarantineReaderPosture(dir)).toBe('denylist')
    for (const v of ['Denylist', ' denylist', 'denylist ', 'DENYLIST', 'allowlist', 'open', '', true, 1, null, ['denylist'], { v: 'denylist' }]) {
      put(JSON.stringify({ quarantine_reader_posture: v }))
      expect(quarantineReaderPosture(dir), JSON.stringify(v)).toBe('allowlist')
    }
  })

  it('a missing key, malformed JSON or a missing file is the default allowlist, never a crash', () => {
    put(JSON.stringify({ domains: ['a.com'] }))
    expect(quarantineReaderPosture(dir)).toBe('allowlist')
    put('not json at all')
    expect(quarantineReaderPosture(dir)).toBe('allowlist')
    put('null')
    expect(quarantineReaderPosture(dir)).toBe('allowlist')
    expect(quarantineReaderPosture(join(dir, 'does-not-exist'))).toBe('allowlist')
  })

  it('gives the hook\'s answer for the same file contents', async () => {
    // A copy of the unchanged hook under a scratch root reads that root's
    // store/egress-allowlist.json (its root is derived from its own location),
    // so the render and the hook see the same bytes. The render must never state
    // an open posture the hook does not run, nor hide one it does.
    const root = mkdtempSync(join(tmpdir(), 'egress-hook-parity-'))
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
    mkdirSync(join(root, 'store'), { recursive: true })
    const copy = join(root, 'scripts', 'hooks', 'egress-gate.mjs')
    copyFileSync(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs'), copy)
    const hook = await import(pathToFileURL(copy).href)
    const cases = [
      JSON.stringify({ quarantine_reader_posture: 'denylist' }),
      JSON.stringify({ quarantine_reader_posture: 'Denylist' }),
      JSON.stringify({ quarantine_reader_posture: ' denylist' }),
      JSON.stringify({ quarantine_reader_posture: true }),
      JSON.stringify({ quarantine_reader_posture: 'allowlist' }),
      JSON.stringify({ domains: [] }),
      'not json at all',
    ]
    for (const raw of cases) {
      writeFileSync(join(root, 'store', 'egress-allowlist.json'), raw)
      expect(quarantineReaderPosture(join(root, 'store')), raw).toBe(hook.loadRuntimeAllowlist().quarantinePosture)
    }
    expect(quarantineReaderPosture(join(root, 'store'))).toBe('allowlist')
    writeFileSync(join(root, 'store', 'egress-allowlist.json'), cases[0])
    expect(hook.loadRuntimeAllowlist().quarantinePosture).toBe('denylist')
  })
})

describe('ensureQuarantineReader writes the posture of the store file, both ways', () => {
  it('flips the written definition on each posture change and leaves it alone otherwise', () => {
    const root = mkdtempSync(join(tmpdir(), 'qr-posture-'))
    const destDir = join(root, 'dest', '.claude', 'agents')
    const storeDir = join(root, 'store')
    mkdirSync(storeDir, { recursive: true })
    const paths = { tplPath: TPL_PATH, destDir, storeDir, legacyPath: join(root, 'legacy', 'quarantine-reader.md') }
    const written = () => readFileSync(join(destDir, 'quarantine-reader.md'), 'utf-8')
    const setPosture = (p: string) =>
      writeFileSync(join(storeDir, 'egress-allowlist.json'), JSON.stringify({ quarantine_reader_posture: p }))

    setPosture('denylist')
    expect(ensureQuarantineReader('samu', paths)).toBe(true)
    expect(count(written(), BEGIN)).toBe(1)
    expect(ensureQuarantineReader('samu', paths)).toBe(false)

    setPosture('allowlist')
    expect(ensureQuarantineReader('samu', paths)).toBe(true)
    expect(written()).toBe(TPL)

    setPosture('denylist')
    expect(ensureQuarantineReader('samu', paths)).toBe(true)
    expect(written()).toBe(renderQuarantineReader(TPL, [], 'denylist'))
  })

  it('carries both blocks when the store file has quarantine domains and the open posture', () => {
    const root = mkdtempSync(join(tmpdir(), 'qr-posture-d-'))
    const destDir = join(root, 'dest', '.claude', 'agents')
    const storeDir = join(root, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'egress-allowlist.json'),
      JSON.stringify({ quarantine_domains: ['enablebanking.com'], quarantine_reader_posture: 'denylist' }))
    expect(ensureQuarantineReader('samu', { tplPath: TPL_PATH, destDir, storeDir, legacyPath: join(root, 'legacy', 'x.md') })).toBe(true)
    const out = readFileSync(join(destDir, 'quarantine-reader.md'), 'utf-8')
    expect(out).toBe(renderQuarantineReader(TPL, ['enablebanking.com'], 'denylist'))
    expect(out).toContain('- `enablebanking.com`')
    expect(count(out, BEGIN)).toBe(1)
  })
})

// The hook is NOT changed by e708d096; these pin that the block opens nothing the
// hook does not open: the hook reads the store file, never the definition.
describe('the unchanged hook still decides (the live install controls)', () => {
  const OPEN = { domains: [], prefixes: [], quarantineDomains: [], quarantinePosture: 'denylist' }
  const CLOSED = { ...OPEN, quarantinePosture: 'allowlist' }
  const READER = 'quarantine-reader'

  it('positive: https://enablebanking.com/ passes for the reader in the open posture, and only there', () => {
    expect(egressDecision('WebFetch', { url: 'https://enablebanking.com/' }, OPEN, READER)).toEqual({ blocked: false, tier: 'quarantine-open' })
    expect(egressDecision('WebFetch', { url: 'https://enablebanking.com/' }, OPEN, '').blocked).toBe(true)
    expect(egressDecision('WebFetch', { url: 'https://enablebanking.com/' }, CLOSED, READER).blocked).toBe(true)
  })

  it('negative: the open reader is refused every internal, metadata, malformed and non-http target', () => {
    // The private and reserved IPv4 targets are built from their octets at run time, so the source carries no such
    // address literal (the public fork's content gate refuses one); the URLs the decision sees are the same.
    const ip = (...octets: number[]) => octets.join('.')
    const refused = [
      'http://localhost/', 'http://localhost:3420/api/memories', 'http://127.0.0.1/', 'http://127.0.0.1:8080/x',
      `http://${ip(10, 0, 0, 1)}/`, `http://${ip(172, 16, 0, 1)}/`, `http://${ip(172, 31, 255, 255)}/`, `http://${ip(192, 168, 1, 50)}/`,
      `http://${ip(100, 64, 0, 1)}/`,
      `http://${ip(169, 254, 169, 254)}/latest/meta-data/`, 'http://metadata.google.internal/computeMetadata/v1/', 'http://instance-data/latest/',
      'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
      'http://printer.local/', 'http://db.internal/', 'http://box.lan/', 'http://nas.home.arpa/',
      'not a url', 'https://',
      'file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,<b>x</b>',
    ]
    for (const url of refused) {
      expect(egressDecision('WebFetch', { url }, OPEN, READER), url).toEqual({ blocked: true, tier: 'quarantine-denied' })
    }
  })
})
