// Functional test for ensureAutonomySection() -- mirrors fleet-roster-section.test.ts.
// Verifies that the function actually writes the autonomy-wiring block to the
// agent's CLAUDE.md (not just that the source text exists somewhere in the
// scaffold), proving the wiring reaches the agent file on every respawn.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-autonomy-test-'))

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

const { ensureAutonomySection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: autonomy-wiring -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string) {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

// The main agent's CLAUDE.md lives at PROJECT_ROOT/CLAUDE.md (not inside agents/).
// ensureAutonomySection(MAIN_AGENT_ID) must use that path, verified here.
const MAIN_CLAUDE_MD = join(tmpRoot, 'CLAUDE.md')

describe('ensureAutonomySection -- main agent (PROJECT_ROOT/CLAUDE.md)', () => {
  it('writes the autonomy block to PROJECT_ROOT/CLAUDE.md for MAIN_AGENT_ID', () => {
    writeFileSync(MAIN_CLAUDE_MD, '# Main Agent\n\nPersona content.\n', 'utf-8')
    ensureAutonomySection('agent-a') // agent-a is the mocked MAIN_AGENT_ID
    const result = readFileSync(MAIN_CLAUDE_MD, 'utf-8')
    expect(result).toContain(MARKER_BEGIN)
    expect(result).toContain(MARKER_END)
    expect(result).toContain('## Autonómia és jóváhagyás')
    expect(result).toContain('/api/approvals')
    // Persona content must be preserved
    expect(result).toContain('# Main Agent')
    expect(result).toContain('Persona content.')
  })

  it('does NOT write to agents/agent-a/CLAUDE.md for MAIN_AGENT_ID', () => {
    // Ensure sub-agent dir also has a CLAUDE.md to prove it is NOT the target
    const subDir = join(tmpRoot, 'agents', 'agent-a')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'CLAUDE.md'), '# Sub\n', 'utf-8')
    writeFileSync(MAIN_CLAUDE_MD, '# Main Agent\n', 'utf-8')

    ensureAutonomySection('agent-a')

    // Main CLAUDE.md gets the block
    const main = readFileSync(MAIN_CLAUDE_MD, 'utf-8')
    expect(main).toContain(MARKER_BEGIN)
    // Sub-agent file must be untouched
    const sub = readFileSync(join(subDir, 'CLAUDE.md'), 'utf-8')
    expect(sub).not.toContain(MARKER_BEGIN)
  })
})

describe('ensureAutonomySection', () => {
  it('(a) appends the autonomy block when CLAUDE.md has no existing marker', () => {
    setup('new-agent', '# New Agent\n\nExisting content.\n')
    ensureAutonomySection('new-agent')
    const result = read('new-agent')
    expect(result).toContain(MARKER_BEGIN)
    expect(result).toContain(MARKER_END)
    // Existing content must be preserved
    expect(result).toContain('# New Agent')
    expect(result).toContain('Existing content.')
    // Must contain the autonomy section heading
    expect(result).toContain('## Autonómia és jóváhagyás')
    // Must contain the /api/approvals endpoint for level 2
    expect(result).toContain('/api/approvals')
  })

  it('(a) level 2 curl in the written block uses the agent name, not a placeholder', () => {
    setup('agent-b', '# Agent B\n')
    ensureAutonomySection('agent-b')
    const result = read('agent-b')
    // The approval POST must contain the actual agent name
    const postIdx = result.indexOf('/api/approvals')
    const snippet = result.slice(postIdx - 50, postIdx + 300)
    expect(snippet).toContain('agent-b')
    expect(snippet).not.toContain('AGENT_NAME')
  })

  it('(a) level 1 block in the written file does NOT call /api/approvals', () => {
    setup('level1-agent', '# Agent\n')
    ensureAutonomySection('level1-agent')
    const result = read('level1-agent')
    const level1Idx = result.indexOf('Level 1')
    const level2Idx = result.indexOf('Level 2')
    const level1Block = result.slice(level1Idx, level2Idx)
    expect(level1Block).not.toContain('/api/approvals')
    // Level 1 must have inter-agent message and MEGÁLL
    expect(level1Block).toContain('/api/messages')
    expect(level1Block).toContain('ÁLLJ MEG')
  })

  it('(b) replaces ONLY the marker block when markers already exist', () => {
    const before = 'Content above.\n'
    const after = '\nContent below.'
    setup('update-agent', before + MARKER_BEGIN + '\nOLD CONTENT\n' + MARKER_END + after)
    ensureAutonomySection('update-agent')
    const result = read('update-agent')
    expect(result).toContain('Content above.')
    expect(result).toContain('Content below.')
    expect(result).not.toContain('OLD CONTENT')
    expect(result).toContain('## Autonómia és jóváhagyás')
    // Markers must appear exactly once
    expect(result.split(MARKER_BEGIN).length - 1).toBe(1)
    expect(result.split(MARKER_END).length - 1).toBe(1)
  })

  it('(c) does not write to disk when computed content is identical (idempotent)', () => {
    setup('stable-agent', '# Stable\n')
    ensureAutonomySection('stable-agent')
    const path = join(tmpRoot, 'agents', 'stable-agent', 'CLAUDE.md')
    const mtimeBefore = statSync(path).mtimeMs
    ensureAutonomySection('stable-agent')
    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
  })

  it('(d) skips gracefully when CLAUDE.md does not exist', () => {
    expect(() => ensureAutonomySection('ghost-agent-xyz')).not.toThrow()
  })
})
