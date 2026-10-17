// BGCHECKPOINT1008: the long-background-work rule that ships to every agent's CLAUDE.md.
//
// A key wall and an agent restart stop a running background sub-agent and a
// run_in_background command; the main conversation continues, the background
// work does not. The rule: save the partial result to a file about every ten
// minutes, resume from it, and note on the card where it is.
//
// Functional part mirrors message-close-section.test.ts (temp root, mocked config).
// The wiring part reads the two call sites with comment lines removed, so a
// commented-out call does not pass for a live one.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-bgcheckpoint-test-'))

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
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

const { ensureBackgroundCheckpointSection, buildBackgroundCheckpointBody, buildMessageCloseBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: background-checkpoint (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: background-checkpoint -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('background-checkpoint section: what it says (BGCHECKPOINT1008)', () => {
  const body = buildBackgroundCheckpointBody()

  it('names the two causes: the key wall and the restart stop background work', () => {
    expect(body).toMatch(/kulcsfal[\s\S]{0,80}újraindulás[\s\S]{0,160}háttér-alügynököt/)
  })

  it('the threshold and the cadence: longer than 15 minutes, about every 10 minutes, to a file', () => {
    expect(body).toMatch(/15 percnél tovább[\s\S]{0,60}kb\. 10 percenként[\s\S]{0,40}fájlba/)
  })

  it('the file lives under the working directory, not the scratchpad, and the brief names it', () => {
    expect(body).toMatch(/munkakönyvtárad alatt/)
    expect(body).toMatch(/scratchpad session-hez kötött \/tmp-mappa: új session[\s\S]{0,60}gép-újraindulás után nincs meg/)
    expect(body).toMatch(/briefjébe[\s\S]{0,40}fájl útjával/)
  })

  it('after a restart or a key wall: resume from the saved part, not from scratch', () => {
    expect(body).toMatch(/Újraindulás vagy kulcsfal után[\s\S]{0,60}mentett részt[\s\S]{0,60}ne elölről/)
  })

  it('one line on the card (or the HANDOFF.md): where the saved part is and the next step', () => {
    expect(body).toMatch(/lapra[\s\S]{0,40}egy sor: hol a mentett rész[\s\S]{0,40}következő lépés/)
  })

  it('one short section: a single heading, at most 12 lines, no em dash', () => {
    expect(body.split('\n').filter((l) => l.startsWith('## ')).length).toBe(1)
    expect(body.split('\n').length).toBeLessThanOrEqual(12)
    expect(body).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('background-checkpoint section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureBackgroundCheckpointSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensureBackgroundCheckpointSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureBackgroundCheckpointSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('leaves another generated section untouched', () => {
    const other = `<!-- BEGIN GENERATED: message-close (auto-generated, do not edit by hand) -->\n${buildMessageCloseBody()}\n<!-- END GENERATED: message-close -->`
    setup('agent-d', `# D\n\n${other}\n`)
    ensureBackgroundCheckpointSection('agent-d')
    const out = read('agent-d')
    expect(out).toContain(other)
    expect(out.indexOf(other)).toBeLessThan(out.indexOf(BEGIN))
  })

  it('no CLAUDE.md: nothing is created', () => {
    ensureBackgroundCheckpointSection('agent-missing')
    expect(() => read('agent-missing')).toThrow()
  })

  it('the main agent is written at the project root CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureBackgroundCheckpointSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toContain(BEGIN)
  })
})

describe('background-checkpoint section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureBackgroundCheckpointSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureBackgroundCheckpointSection\(name\)/m)
  })
})
