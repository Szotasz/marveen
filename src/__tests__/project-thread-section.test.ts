// The project-thread section every agent's CLAUDE.md carries (src/web/agent-scaffold.ts):
// how an agent posts a question or report to a project's shared thread instead of asking
// the main agent to relay it. Setup mirrors message-close-section.test.ts (temp root,
// mocked config); the wiring part reads the two call sites with comment lines removed.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-projthread-test-'))

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
  APP_TZ: 'UTC',
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

const { ensureProjectThreadSection, buildProjectThreadBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: project-thread (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: project-thread -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('project-thread section: what it says', () => {
  it('a non-strict agent gets the helper and a curl with a QUOTED heredoc, never -d "..."', () => {
    const body = buildProjectThreadBody('agent-b')
    expect(body).toContain('marveen-api.sh project-thread-post agent-b')
    expect(body).toContain("--data-binary @- <<'JSON'")
    expect(body).toContain('/api/project-threads/')
    expect(body).toContain('"needs_owner":true')
    expect(body).not.toMatch(/-d "\{/)
    expect(body).toMatch(/CSAK akkor számít, ha a válaszban visszajött egy `"id"`/)
  })

  it('a strict agent gets the helper only: no substitution, no token header, no curl', () => {
    const body = buildProjectThreadBody('agent-b', true)
    expect(body).toContain('project-thread-post agent-b')
    expect(body).not.toContain('$(')
    expect(body).not.toContain('Authorization: Bearer')
    expect(body.split('\n').filter((l) => l.trimStart().startsWith('curl '))).toEqual([])
  })

  it('only the main agent is told about the FYI copies', () => {
    expect(buildProjectThreadBody('agent-a')).toContain('Projekt-szál FYI')
    expect(buildProjectThreadBody('agent-b')).not.toContain('Projekt-szál FYI')
  })
})

describe('project-thread section: idempotent insert and update', () => {
  it('appends once, a second run changes nothing, a stale block is replaced in place', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureProjectThreadSection('agent-b')
    const once = read('agent-b')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensureProjectThreadSection('agent-b')
    expect(read('agent-b')).toBe(once)

    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureProjectThreadSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })
})

describe('project-thread section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent, agent-process.ts for every agent start', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureProjectThreadSection\(MAIN_AGENT_ID\)/m)
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureProjectThreadSection\(name\)/m)
  })
})
