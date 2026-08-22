// Functional test for ensureSkillsPathTrapSection() -- mirrors
// autonomy-section.test.ts. SKILLUTCSAPDA822: the `.claude-config/skills`
// path IS the shared global dir (symlink), reads as "my own config", and five
// third-party skills landed fleet-wide through it on 2026-08-22. This proves
// the warning block actually reaches the agent file on respawn, idempotently.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-skilltrap-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
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

const { ensureSkillsPathTrapSection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: skills-path-trap (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: skills-path-trap -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureSkillsPathTrapSection', () => {
  it('appends the warning block to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureSkillsPathTrapSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('.claude-config/skills')
    expect(out).toContain('NEM a saját mappád')
    expect(out).toContain('.claude/skills/')
    // Existing content untouched.
    expect(out).toContain('Some persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-b', '# Agent B\n')
    ensureSkillsPathTrapSection('agent-b')
    const first = read('agent-b')
    ensureSkillsPathTrapSection('agent-b')
    expect(read('agent-b')).toBe(first)
    // Exactly one block, not stacked.
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-b', `# Agent B\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureSkillsPathTrapSection('agent-b')
    const out = read('agent-b')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('.claude-config/skills')
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureSkillsPathTrapSection('agent-nonexistent')).not.toThrow()
  })

  it('the main agent path targets PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const trap = src.indexOf('ensureSkillsPathTrapSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(trap).toBeGreaterThan(roster)
  })

  it('the generated template names the trap inline too', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('CSAPDA: a .claude-config/skills NEM a tiéd')
  })
})
