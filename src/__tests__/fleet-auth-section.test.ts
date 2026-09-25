// Functional test for ensureFleetAuthSection() -- mirrors
// skills-path-trap-section.test.ts. AUTHSECT919: the fleet auth rule lived only
// as hand-written prose in the agent CLAUDE.md files. Measured 2026-09-19 on the
// owner host: 22 agents carried it, zero generating surfaces did -- so the next
// agent created would have missed it silently. This proves the block reaches
// the agent file on respawn, idempotently, and does NOT duplicate the rule for
// the agents that already got it by hand.
//
// The assertions below check that the three auth-path TERMS survive in the
// generated body; they deliberately do not pin the surrounding prose, because
// the prose is exactly what had to change in review. The first draft framed
// `claudeConfigDir` and a per-agent `.credentials.json` as blanket
// prohibitions; both are supported behaviour (see the scope-correction note on
// buildFleetAuthBody), so the body now describes the real auth design and keeps
// only the two rules that are genuinely non-negotiable.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fleetauth-test-'))

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

const { ensureFleetAuthSection, buildFleetAuthBody } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: fleet-auth (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: fleet-auth -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureFleetAuthSection', () => {
  it('appends the auth rule to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureFleetAuthSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(out).toContain('claudeConfigDir')
    expect(out).toContain('.credentials.json')
    expect(out).toContain('Some persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-c', '# Agent C\n')
    ensureFleetAuthSection('agent-c')
    const first = read('agent-c')
    ensureFleetAuthSection('agent-c')
    expect(read('agent-c')).toBe(first)
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-d', `# Agent D\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureFleetAuthSection('agent-d')
    const out = read('agent-d')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  // The reason this rule exists: on the install where the gap was measured the
  // rule was already in all 22 agent files by hand. Appending a marker block
  // there would have given every agent two near-identical copies of the same
  // MEGSZEGHETETLEN rule -- pure context cost, and the kind of duplicate that
  // later drifts apart.
  it('does NOT duplicate the rule where a hand-written copy already exists', () => {
    setup('agent-e', '# Agent E\n\n## Flotta-szintű AUTH-szabály (MEGSZEGHETETLEN — 2026-07-01)\n\nKézzel írt változat.\n')
    ensureFleetAuthSection('agent-e')
    const out = read('agent-e')
    expect(out).not.toContain(MARKER_BEGIN)
    expect(out).toContain('Kézzel írt változat.')
  })

  // ...but once our block IS in the file, the skip must not fire on our own
  // heading, otherwise a wording fix could never reach a back-filled agent.
  it('still refreshes its own block even though the block names the rule', () => {
    setup('agent-f', '# Agent F\n')
    ensureFleetAuthSection('agent-f')
    const first = read('agent-f')
    writeFileSync(join(tmpRoot, 'agents', 'agent-f', 'CLAUDE.md'),
      first.replace('CLAUDE_CODE_OAUTH_TOKEN', 'ELAVULT_SZOVEG'), 'utf-8')
    ensureFleetAuthSection('agent-f')
    const out = read('agent-f')
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(out).not.toContain('ELAVULT_SZOVEG')
    expect(out.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureFleetAuthSection('agent-nonexistent')).not.toThrow()
  })

  it('the main agent path targets PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureFleetAuthSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
  })
})

describe('body hygiene', () => {
  // The block ships to every install, so it must not carry one deployment's
  // operator name or agent names (same reason as template-identity-hygiene).
  it('is host-agnostic: no operator or per-install agent names', () => {
    const body = buildFleetAuthBody()
    expect(body).not.toMatch(/\/(Users|home)\/[A-Za-z0-9._-]+/)
    expect(body).not.toMatch(/Juhász|Viktor|Szabolcs|marveenja/i)
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const auth = src.indexOf('ensureFleetAuthSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(auth).toBeGreaterThan(roster)
  })

  it('the dashboard applies it to the main agent at start', () => {
    const src = readFileSync(join(__dirname, '../../src/web.ts'), 'utf-8')
    expect(src).toContain('ensureFleetAuthSection(MAIN_AGENT_ID)')
  })
})
