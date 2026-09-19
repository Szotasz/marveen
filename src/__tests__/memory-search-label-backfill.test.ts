// MEMKERESVAK917 -- the BACK-FILL half of #1380.
//
// #1380 taught the two GENERATING surfaces to hand the agent the relaxation
// label. Both only run when an agent is CREATED, and no respawn-time updater
// touches the memory section, so on the day it merged the fix reached zero of
// the agents already on disk: nine agent CLAUDE.md files on the owner host
// still carried the search recipe with no way to see the header.
//
// What is pinned here is the BEHAVIOUR that closes that gap, not the wording:
//   - a file with a pre-#1380 recipe gets the block,
//   - a file generated AFTER #1380 does NOT get a second copy,
//   - once the block is in a file it is refreshed in place,
//   - the block is written per-agent, not with a shared /tmp path.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-memlabel-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureMemorySearchLabelSection, buildMemorySearchLabelBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: memory-search-label (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: memory-search-label -->'

// The shape nine agents actually carry on the owner host: the recipe, with a
// bare `curl -s` and no mention of the header.
const PRE_1380 = `# Agent

## Memoria

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=agent-b&q=KULCSSZO&category=warm"
`

// What generateClaudeMd() writes since #1380: the label is already inline.
const POST_1380 = `# Agent

## Memoria

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -D /tmp/mem-fejlec-agent-c.txt -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=agent-c&q=KULCSSZO&category=warm"
grep -i '^x-memory-search' /tmp/mem-fejlec-agent-c.txt

relaxed=true  -> mentett közelítés, NEM bizonyíték.
relaxed=false -> a kérdés úgy illeszkedett, ahogy kérted.
`

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureMemorySearchLabelSection', () => {
  it('back-fills an agent whose recipe predates #1380', () => {
    setup('agent-b', PRE_1380)
    ensureMemorySearchLabelSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(BEGIN)
    expect(out).toContain(END)
    // The persona above the block is untouched.
    expect(out.startsWith(PRE_1380.trimEnd())).toBe(true)
  })

  it('does NOT add a second copy where #1380 already put the label inline', () => {
    setup('agent-c', POST_1380)
    ensureMemorySearchLabelSection('agent-c')
    expect(read('agent-c')).toBe(POST_1380)
  })

  it('is idempotent: a second run changes nothing', () => {
    setup('agent-d', PRE_1380)
    ensureMemorySearchLabelSection('agent-d')
    const once = read('agent-d')
    ensureMemorySearchLabelSection('agent-d')
    expect(read('agent-d')).toBe(once)
    expect(once.split(BEGIN).length - 1).toBe(1)
  })

  it('refreshes an existing block in place instead of appending another', () => {
    setup('agent-e', PRE_1380 + `\n${BEGIN}\nstale text\n${END}\n`)
    ensureMemorySearchLabelSection('agent-e')
    const out = read('agent-e')
    expect(out).not.toContain('stale text')
    expect(out.split(BEGIN).length - 1).toBe(1)
  })

  it('writes the main agent to PROJECT_ROOT/CLAUDE.md, not agents/<name>', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), PRE_1380, 'utf-8')
    ensureMemorySearchLabelSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toContain(BEGIN)
    expect(existsSync(join(tmpRoot, 'agents', 'agent-a', 'CLAUDE.md'))).toBe(false)
  })

  it('does nothing when the agent has no CLAUDE.md', () => {
    expect(() => ensureMemorySearchLabelSection('agent-missing')).not.toThrow()
    expect(existsSync(join(tmpRoot, 'agents', 'agent-missing', 'CLAUDE.md'))).toBe(false)
  })
})

describe('buildMemorySearchLabelBody', () => {
  // Deterministic per-agent path. The scaffold copy is an LLM prompt carrying
  // the literal AGENT_NAME for the model to substitute; if that substitution is
  // ever missed, every agent dumps headers into ONE shared file and reads the
  // neighbour's label. This body must not have that failure mode.
  // Asserted as a SET, not as presence: the body names the dump file twice (the
  // curl that writes it and the grep that reads it), so `toContain(per-agent
  // path)` stays green while the OTHER occurrence points at a shared file --
  // which is the whole failure mode. EVERY occurrence has to carry the name.
  it('names the dump file after the agent, not a shared path', () => {
    for (const name of ['agent-b', 'agent-c']) {
      const paths = buildMemorySearchLabelBody(name).match(/\/tmp\/mem-fejlec[^\s`"']*/g) ?? []
      expect(paths.length).toBeGreaterThan(1)
      expect([...new Set(paths)]).toEqual([`/tmp/mem-fejlec-${name}.txt`])
    }
    expect(buildMemorySearchLabelBody('agent-b')).not.toContain('AGENT_NAME')
  })

  it('hands the caller a way to SEE the label and the words to read it with', () => {
    const b = buildMemorySearchLabelBody('agent-b')
    expect(b).toMatch(/curl[\s\S]{0,200}?-D /)
    expect(b.toLowerCase()).toContain('x-memory-search')
    expect(b).toContain('relaxed=true')
    expect(b).toContain('relaxed=false')
  })

  // The two corrections the #1380 review produced. Both are claims the endpoint
  // was measured on, and both are easy to lose in a rewording.
  it('says strict=1 is what an absence claim needs', () => {
    expect(buildMemorySearchLabelBody('agent-b')).toContain('strict=1')
  })

  // There used to be an assertion here that the block warns the tier filter
  // truncates after the limit. #1384 pushed that filter down into the search
  // SQL, so the warning became false before this PR ever merged and the text it
  // pinned is gone from the body. Measured on merged develop against a copy of
  // the owner store: q=billingo&category=warm now answers 39 rows at limit=50
  // and 39 at limit=200, converged, where before it was 9 and 39. The property
  // lives in memory-search-tier-goes-into-the-query.test.ts now.

  // `relaxed=false; hits=0` is a real answer: the pre-review wording called
  // relaxed=false "a real hit" outright, which is false on an empty body.
  it('does not equate relaxed=false with having a hit', () => {
    expect(buildMemorySearchLabelBody('agent-b')).toContain('hits=0')
  })

  // A raw accented byte in q returns HTTP 400 with an empty body and NO
  // X-Memory-Search header, so the grep prints nothing and it looks exactly
  // like an empty hit though the search never ran. Measured 2026-09-19. The
  // body must warn to percent-encode (or use -G --data-urlencode) so no agent
  // reads a 400 as "no memory".
  it('warns that a raw accented q is a silent 400, not an empty result', () => {
    const b = buildMemorySearchLabelBody('agent-b')
    expect(b).toContain('400')
    expect(b).toContain('--data-urlencode')
  })
})
