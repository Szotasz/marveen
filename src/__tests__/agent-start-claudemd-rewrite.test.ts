// rewriteAgentClaudeMdOnStart run against an agent directory (MIOAGENTINSTALL1114, PR-I0).
//
// agent-start-claudemd-writers.test.ts pins WHICH writers run and in which order, by reading the source.
// This file runs the lifted function on a temp agents directory and looks at the CLAUDE.md it leaves:
// the hand-written body is kept, every generated block is appended once, the blocks stand in call
// order, and a second run changes nothing. That is what a caller outside startAgentProcess (the agent
// package installer) relies on. Temp root and mocked config as in pane-at-escape-section.test.ts.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-startrewrite-test-'))
// readEnvFile (src/env.ts) takes its folder from this at import time.
process.env.CLAUDECLAW_ENV_DIR = tmpRoot

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
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
  }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['agent-a', 'agent-b', 'agent-c'],
    readAgentCapabilities: () => [],
  }
})

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { rewriteAgentClaudeMdOnStart } = await import('../web/agent-process.js')
type Profile = Parameters<typeof rewriteAgentClaudeMdOnStart>[1]

const PROFILE: Profile = {
  id: 'test', label: 'Test', description: 'test profile', permissionMode: 'permissive',
  filesystem: { allow: [], deny: [] },
}
const BODY = '# Agent B\n\nA hand-written line the start must not touch.\n'
const file = (agent: string) => join(tmpRoot, 'agents', agent, 'CLAUDE.md')
function setup(agent: string): void {
  mkdirSync(join(tmpRoot, 'agents', agent), { recursive: true })
  writeFileSync(file(agent), BODY, 'utf-8')
}
const read = (agent: string) => readFileSync(file(agent), 'utf-8')
const blocks = (text: string) => [...text.matchAll(/^<!-- BEGIN GENERATED: ([a-z0-9-]+) /gm)].map((m) => m[1])

// Literal on purpose: the blocks a permissive agent with no opt-in gets, in the order the calls append them.
// The writers that leave no block here: the token sync and the root replacer (they rewrite in place), the
// skill-section refresher (only an existing section), THIN CHIEF (opt-in) and the strict recipes (strict only).
const BLOCKS = [
  'fleet-roster',
  'autonomy-wiring',
  'skills-path-trap',
  'system-directive-auth',
  'agent-id-header',
  'memory-search-label',
  'fleet-auth',
  'evidence-rule',
  'mcp-list-channel',
  'message-close',
  'api-helper',
  'background-checkpoint',
  'pane-at-escape',
]

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('rewriteAgentClaudeMdOnStart on an agent directory', () => {
  setup('agent-b')
  rewriteAgentClaudeMdOnStart('agent-b', PROFILE)
  const first = read('agent-b')

  it('keeps the hand-written body where it was, at the head of the file', () => {
    expect(first.startsWith(BODY)).toBe(true)
  })

  it('appends every generated block once, in call order', () => {
    expect(blocks(first)).toEqual(BLOCKS)
  })

  it('a second run changes nothing', () => {
    rewriteAgentClaudeMdOnStart('agent-b', PROFILE)
    expect(read('agent-b')).toBe(first)
  })

  it('a profile that opts in gets the THIN CHIEF section too, and nothing else moves', () => {
    setup('agent-c')
    rewriteAgentClaudeMdOnStart('agent-c', { ...PROFILE, thinChiefHandoff: true })
    const withOptIn = read('agent-c')
    expect(withOptIn.startsWith(BODY)).toBe(true)
    // In its place in the call order: after the agent-id header block, before the memory-search one.
    const at = BLOCKS.indexOf('memory-search-label')
    expect(blocks(withOptIn)).toEqual([...BLOCKS.slice(0, at), 'thin-chief-handoff', ...BLOCKS.slice(at)])
    expect(blocks(first)).not.toContain('thin-chief-handoff')
  })
})
