// HOSTMOVE923 follow-up (review on #1502): the CLAUDE.md-side WRITE is pinned.
//
// The reviewer ran a mutant where ensureProjectRootInClaudeMd computes the
// rewrite but never writes the file back, and the full suite stayed green: the
// pure rewrite (rewriteForeignProjectRoot) and the source-level wiring were
// covered, the file round-trip was not. This test creates a temp agent
// directory whose CLAUDE.md names a foreign install root, calls the function,
// and reads the file back -- so a lost write, a wrong path, or a no-op return
// each fail here. Mock pattern mirrors autonomy-section.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-hostmove-write-'))
const NEW_ROOT = tmpRoot
const OLD_ROOT = '/Users/old-user/klaudia'

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-main',
  BOT_NAME: 'agent-main',
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
  listAgentNames: () => ['agent-a'],
  readAgentCapabilities: () => [],
}))

// Plain write so the round-trip is observable without the atomic-write temp
// file machinery; the function under test still goes through the same call.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureProjectRootInClaudeMd } = await import('../web/agent-scaffold.js')

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

const read = (agentName: string) => readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')

const FOREIGN = [
  '# agent-a',
  '',
  'Memória mentés:',
  `curl -s -H "Authorization: Bearer $(cat ${OLD_ROOT}/store/.dashboard-token)" http://localhost:3420/api/memories`,
  '',
  `Hook: python3 ${OLD_ROOT}/scripts/hooks/staleness-guard.py`,
  `Index: bash ${OLD_ROOT}/scripts/skill-index.sh`,
  '',
  'Nem install-kötött: /usr/local/bin/python3 és ~/Documents/x marad.',
  '',
].join('\n')

describe('ensureProjectRootInClaudeMd writes the re-anchored file back', () => {
  it('rewrites every foreign install-anchored path on disk and returns true', () => {
    setup('agent-a', FOREIGN)
    expect(ensureProjectRootInClaudeMd('agent-a')).toBe(true)
    const after = read('agent-a')
    expect(after).not.toContain(OLD_ROOT)
    expect(after).toContain(`$(cat ${NEW_ROOT}/store/.dashboard-token)`)
    expect(after).toContain(`python3 ${NEW_ROOT}/scripts/hooks/staleness-guard.py`)
    expect(after).toContain(`bash ${NEW_ROOT}/scripts/skill-index.sh`)
    // Everything else is byte-identical.
    expect(after).toContain('Nem install-kötött: /usr/local/bin/python3 és ~/Documents/x marad.')
    expect(after.split('\n')).toHaveLength(FOREIGN.split('\n').length)
  })

  it('is idempotent: a second call finds nothing foreign, returns false and leaves the file untouched', () => {
    setup('agent-b', FOREIGN)
    expect(ensureProjectRootInClaudeMd('agent-b')).toBe(true)
    const once = read('agent-b')
    expect(ensureProjectRootInClaudeMd('agent-b')).toBe(false)
    expect(read('agent-b')).toBe(once)
  })

  it('returns false and writes nothing when the CLAUDE.md already names the current root', () => {
    const current = FOREIGN.split(OLD_ROOT).join(NEW_ROOT)
    setup('agent-c', current)
    expect(ensureProjectRootInClaudeMd('agent-c')).toBe(false)
    expect(read('agent-c')).toBe(current)
  })

  it('returns false for an agent without a CLAUDE.md and creates none', () => {
    mkdirSync(join(tmpRoot, 'agents', 'agent-d'), { recursive: true })
    expect(ensureProjectRootInClaudeMd('agent-d')).toBe(false)
    expect(existsSync(join(tmpRoot, 'agents', 'agent-d', 'CLAUDE.md'))).toBe(false)
  })
})
