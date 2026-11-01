// Functional test for ensureShellGrepSection() -- mirrors fleet-auth-section.test.ts.
// SHELLGREP1101: the Bash tool's bare `grep` is Claude Code's embedded ugrep, which
// skips gitignored files, .git and binary input on a recursive search, so a secret or
// completeness sweep can report a false "nothing found". This proves the rule reaches
// the agent file on respawn and the main agent at dashboard start, idempotently, and
// does NOT duplicate it for agents whose file already prescribes /usr/bin/grep by hand.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-shellgrep-test-'))

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

const { ensureShellGrepSection, buildShellGrepBody } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: shell-grep (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: shell-grep -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureShellGrepSection', () => {
  it('appends the rule to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureShellGrepSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('/usr/bin/grep')
    expect(out).toContain('.gitignore')
    expect(out).toContain('command grep')
    expect(out).toContain('Some persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-c', '# Agent C\n')
    ensureShellGrepSection('agent-c')
    const first = read('agent-c')
    ensureShellGrepSection('agent-c')
    expect(read('agent-c')).toBe(first)
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-d', `# Agent D\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureShellGrepSection('agent-d')
    const out = read('agent-d')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('/usr/bin/grep')
  })

  it('does NOT duplicate the rule where a hand-written copy already prescribes /usr/bin/grep', () => {
    setup('agent-e', '# Agent E\n\n## Keresés\n\nTitok-kereséshez `/usr/bin/grep -r`, kézzel írt változat.\n')
    ensureShellGrepSection('agent-e')
    const out = read('agent-e')
    expect(out).not.toContain(MARKER_BEGIN)
    expect(out).toContain('kézzel írt változat.')
  })

  // ...but once our block IS in the file, the skip must not fire on the block's own
  // /usr/bin/grep, otherwise a wording fix could never reach a back-filled agent.
  it('still refreshes its own block even though the block itself names /usr/bin/grep', () => {
    setup('agent-f', '# Agent F\n')
    ensureShellGrepSection('agent-f')
    const first = read('agent-f')
    writeFileSync(join(tmpRoot, 'agents', 'agent-f', 'CLAUDE.md'),
      first.replace('a cső minden fokozatában', 'ELAVULT_SZOVEG'), 'utf-8')
    ensureShellGrepSection('agent-f')
    const out = read('agent-f')
    expect(out).toContain('a cső minden fokozatában')
    expect(out).not.toContain('ELAVULT_SZOVEG')
    expect(out.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureShellGrepSection('agent-nonexistent')).not.toThrow()
  })

  it('the main agent path targets PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureShellGrepSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
  })
})

describe('body hygiene', () => {
  // The block ships to every install: no operator or per-install agent names, no host paths.
  it('is host-agnostic', () => {
    const body = buildShellGrepBody()
    expect(body).not.toMatch(/\/(Users|home)\/[A-Za-z0-9._-]+/)
    expect(body).not.toMatch(/Juhász|Viktor|Szabolcs|marveenja/i)
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn, after the fleet auth block', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const auth = src.indexOf('ensureFleetAuthSection(name)')
    const grep = src.indexOf('ensureShellGrepSection(name)')
    expect(auth).toBeGreaterThan(0)
    expect(grep).toBeGreaterThan(auth)
  })

  it('the dashboard applies it to the main agent at start', () => {
    const src = readFileSync(join(__dirname, '../../src/web.ts'), 'utf-8')
    expect(src).toContain('ensureShellGrepSection(MAIN_AGENT_ID)')
  })
})
