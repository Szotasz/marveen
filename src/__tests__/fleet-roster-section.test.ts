import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Create a temp dir that acts as the project root for the test.
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-roster-test-'))

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
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: (name: string) => {
    if (name === 'agent-a') return ['architecture', 'infrastructure']
    if (name === 'agent-b') return ['management']
    return []
  },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureFleetRosterSection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: fleet-roster -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string) {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureFleetRosterSection', () => {
  it('(a) appends marker block when CLAUDE.md has no existing marker', () => {
    setup('new-agent', '# New Agent\n\nExisting content.\n')
    ensureFleetRosterSection('new-agent')
    const result = read('new-agent')
    expect(result).toContain(MARKER_BEGIN)
    expect(result).toContain(MARKER_END)
    expect(result).toContain('# New Agent')
    expect(result).toContain('Existing content.')
    // main-agent must appear (MAIN_AGENT_ID, not in listAgentNames mock)
    expect(result).toContain('main-agent')
    // self must not appear
    expect(result).not.toMatch(/\*\*new-agent\*\*/)
  })

  it('(b) replaces only the marker block, surrounding content unchanged', () => {
    const before = 'Content above.\n'
    const after = '\nContent below.'
    setup('update-agent', before + MARKER_BEGIN + '\nOLD ROSTER\n' + MARKER_END + after)
    ensureFleetRosterSection('update-agent')
    const result = read('update-agent')
    expect(result).toContain('Content above.')
    expect(result).toContain('Content below.')
    expect(result).not.toContain('OLD ROSTER')
    expect(result).toContain('agent-a')
    expect(result).toContain('agent-b')
  })

  it('(c) does not write to disk when computed content is identical', () => {
    setup('stable-agent', '# Stable\n')
    ensureFleetRosterSection('stable-agent')
    const path = join(tmpRoot, 'agents', 'stable-agent', 'CLAUDE.md')
    const mtimeBefore = statSync(path).mtimeMs
    ensureFleetRosterSection('stable-agent')
    expect(statSync(path).mtimeMs).toBe(mtimeBefore)
  })

  it('(d) skips gracefully when CLAUDE.md does not exist', () => {
    expect(() => ensureFleetRosterSection('ghost-agent-xyz')).not.toThrow()
  })

  it('(e) only sanitized capability tags reach the output', () => {
    setup('caps-agent', '# Caps\n')
    ensureFleetRosterSection('caps-agent')
    const result = read('caps-agent')
    expect(result).toContain('architecture')
    expect(result).toContain('infrastructure')
    expect(result).not.toContain('IGNORE ALL PREVIOUS')
  })
})
