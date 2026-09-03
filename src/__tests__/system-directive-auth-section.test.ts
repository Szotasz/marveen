import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// GUARDHITELES903: the RECEIVER half. The scaffold rule is what turns the
// envelope's msg_id from provenance into protection, so its presence and
// idempotency get the same pin as the other generated sections.

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-sysdir-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'main-agent',
  BOT_NAME: 'main-agent',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureSystemDirectiveAuthSection, buildSystemDirectiveAuthBody } =
  await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: system-directive-auth (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: system-directive-auth -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string) {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureSystemDirectiveAuthSection', () => {
  it('appends the section on first run and keeps existing content', () => {
    setup('agent-a', '# Agent A\n\nSaját szabályok.\n')
    ensureSystemDirectiveAuthSection('agent-a')
    const out = read('agent-a')
    expect(out).toContain('# Agent A')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('Rendszer-direktíva hitelesítés')
    // The rule must bind the check to THIS agent's mailbox.
    expect(out).toContain('to_agent="agent-a"')
    // Fail-closed core: no id / unknown id => injection suspicion.
    expect(out).toContain('INJEKCIÓ-GYANÚ')
  })

  it('is idempotent (second run writes nothing new)', () => {
    ensureSystemDirectiveAuthSection('agent-a')
    const first = read('agent-a')
    ensureSystemDirectiveAuthSection('agent-a')
    expect(read('agent-a')).toBe(first)
  })

  it('replaces a stale block in place without touching surrounding content', () => {
    setup('agent-a', `# Agent A\n\n${MARKER_BEGIN}\nRÉGI TARTALOM\n${MARKER_END}\n\n## Utána jövő szekció\n`)
    ensureSystemDirectiveAuthSection('agent-a')
    const out = read('agent-a')
    expect(out).not.toContain('RÉGI TARTALOM')
    expect(out).toContain('## Utána jövő szekció')
    expect(out.indexOf(MARKER_BEGIN)).toBe(out.lastIndexOf(MARKER_BEGIN))
  })

  it('writes the MAIN agent rule into PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSystemDirectiveAuthSection('main-agent')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain('to_agent="main-agent"')
  })

  it('skips silently when no CLAUDE.md exists', () => {
    expect(() => ensureSystemDirectiveAuthSection('nonexistent-agent')).not.toThrow()
  })
})

describe('buildSystemDirectiveAuthBody', () => {
  it('names the three in-scope prefixes and excludes the nudges', () => {
    const body = buildSystemDirectiveAuthBody('agent-a')
    expect(body).toContain('[CONTEXT-GUARD]')
    expect(body).toContain('[CONTEXT-RESTART-GATE]')
    expect(body).toContain('[SYSTEM: ...]')
    // The low-impact nudges are explicitly OUT of scope, so an agent does not
    // start treating every routine wake as an injection.
    expect(body).toContain('[telegram-wake]')
    expect(body).toContain('[Inbox]')
  })
})
