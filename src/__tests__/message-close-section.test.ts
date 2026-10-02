// ACKONCLOSE927: the message-close rule that ships to every agent's CLAUDE.md.
//
// Closing a message sends an '[Eredmény]' ack to the original sender by
// default. For an incoming report that ack only lengthens the sender's queue
// (measured on an external install, 2026-09-27: three closes took it from 1 to
// 4). `notify: false` already skips it, but no recipe told an agent about it.
//
// Functional part mirrors autonomy-section.test.ts (temp root, mocked config).
// The wiring part reads the two call sites with comment lines removed, so a
// commented-out call does not pass for a live one.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-msgclose-test-'))

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

const { ensureMessageCloseSection, buildMessageCloseBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: message-close (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: message-close -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('message-close section: what it says (ACKONCLOSE927)', () => {
  const body = buildMessageCloseBody()

  it('tells the reader to close an INCOMING report with notify:false', () => {
    expect(body).toMatch(/BEJÖVŐ RIPORT[\s\S]{0,120}"notify":false/)
  })

  it('keeps the default for a DELEGATED task, where the ack is the result', () => {
    expect(body).toMatch(/DELEGÁLT FELADAT[\s\S]{0,120}szokásos módon/)
  })

  it('the example sends a real JSON boolean false, not the string', () => {
    expect(body).toContain(`'{"status":"done","notify":false}'`)
    expect(body).not.toContain('"notify":"false"')
    expect(body).toMatch(/string 400-at kap/)
  })

  it('the example is a PUT on the message id, with the bearer token', () => {
    expect(body).toMatch(/curl -s -X PUT \S+\/api\/messages\/<id>/)
    expect(body).toMatch(/Authorization: Bearer \$\(cat /)
  })
})

describe('message-close section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureMessageCloseSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensureMessageCloseSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureMessageCloseSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('the main agent is written at PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureMessageCloseSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toContain(BEGIN)
  })
})

describe('message-close section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureMessageCloseSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureMessageCloseSection\(name\)/m)
  })
})
