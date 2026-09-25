// Functional test for ensureSkillsPathTrapSection() -- mirrors
// autonomy-section.test.ts. SKILLUTCSAPDA822: the isolated config root's
// `skills` entry IS the shared global dir (symlink), reads as "my own config",
// and five third-party skills landed fleet-wide through it on 2026-08-22. This
// proves the warning block actually reaches the agent file on respawn,
// idempotently.
//
// SKILLGYOKERNEV925: these assertions deliberately pin the MEASUREMENT
// (`echo "$CLAUDE_CONFIG_DIR"`) and BOTH root names, not one path string. A body
// that names a single root teaches a false generalisation in both directions,
// and the old assertions (`toContain('.claude-config/skills')`) would have
// passed on exactly the text that caused one: the root is named
// `.claude-config` for sub-agents and `.channels-config` for the main agent,
// measured 2026-09-25, and in both the `skills` entry is the same symlink.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-skilltrap-test-'))

vi.mock('../config.js', () => ({
  // agent-scaffold imports settings-store (MCPOROKLES923), which derives a path from
  // STORE_DIR at import time. A never-created dir: nothing here reads the store.
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  // Empty = the resolver falls through to the public URL, then to
  // localhost -- i.e. exactly the behaviour these tests asserted
  // before AGENT_API_ORIGIN existed.
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
    // The measurement, not a remembered path name.
    expect(out).toContain('echo "$CLAUDE_CONFIG_DIR"')
    // BOTH root names appear, so neither reads as "the" trap path.
    expect(out).toContain('.claude-config')
    expect(out).toContain('.channels-config')
    expect(out).toContain('SYMLINK a')
    // A sub-agent DOES have a private dir, and the body says where.
    expect(out).toContain('agents/<a-te-neved>/.claude/skills')
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
    expect(out).toContain('echo "$CLAUDE_CONFIG_DIR"')
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

  // SKILLGYOKERLATSZIK923: one text for everybody was wrong for the main agent in
  // the direction that matters -- it promised a private dir that does not exist
  // for a reader whose cwd IS the project root.
  it('tells the main agent it has NO private dir, and the sub-agent where its own is', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const main = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    setup('agent-b', '# Agent B\n')
    ensureSkillsPathTrapSection('agent-b')
    const sub = read('agent-b')

    expect(main).toContain('EZ NEKED NEM PRIVÁT')
    expect(main).toContain('NINCS olyan hely, ahova a fő ágens')
    expect(main).not.toContain('EZ az egyetlen, ami tényleg')

    expect(sub).toContain('EZ az egyetlen, ami tényleg')
    expect(sub).not.toContain('EZ NEKED NEM PRIVÁT')

    // Same trap, two readings: the bodies must actually differ.
    expect(main).not.toBe(sub)
    // ...but the measurement is in both.
    expect(main).toContain('echo "$CLAUDE_CONFIG_DIR"')
    expect(sub).toContain('echo "$CLAUDE_CONFIG_DIR"')
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
