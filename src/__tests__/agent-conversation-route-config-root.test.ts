// The Conversation view (GET /api/agents/<name>/conversation) renders the
// newest transcript of an agent. Until #2716 it looked for that transcript in
// the wrong config root in two cases:
//
//   - main agent: configDir was hard-coded to undefined, i.e. the host default
//     ~/.claude, while a channels session with its own CLAUDE_CONFIG_DIR
//     (<root>/.channels-config or MAIN_AGENT_CONFIG_DIR) writes elsewhere;
//   - sub-agent: resolveAgentConfigDir() only knows what was CONFIGURED and
//     answers null for an auto-provisioned agents/<name>/.claude-config.
//
// In both cases the old directory under ~/.claude usually still exists and
// still parses, so the view did not come back empty: it showed an old session
// as if it were the live one. On the reporter's install that was a nine-day-old
// one-line "Please run /login . API Error: 401" next to a healthy agent.
//
// routes/agents.ts already reads through configDirFor() for the same reason
// (resolveTranscriptLocation, the transcript tail). This pins the same resolver
// on the Conversation route.
//
// A BEHAVIOUR TEST, like context-guard-main-transcript-root.test.ts: the two
// roots hold DIFFERENT sessions and the route is asserted on which one it
// returns. With the pre-fix line both cases flip to the stale session -- that
// is the negative control, built into the fixture.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = mkdtempSync(join(tmpdir(), 'conversation-root-'))
const PROJECT_ROOT = '/Users/x/marveen'
const SUB = 'ponder'
const SUB_WORKING_DIR = join(PROJECT_ROOT, 'agents', SUB)

const FIXTURE_HOME = join(FIXTURE, 'home')
const SHARED_CONFIG = join(FIXTURE_HOME, '.claude')
const ISOLATED_MAIN_CONFIG = join(FIXTURE, 'channels-config')
const ISOLATED_SUB_CONFIG = join(FIXTURE, 'agents', SUB, '.claude-config')

// The measured Claude Code rule (src/claude-project-dir.ts), not a
// re-derivation: the fixture dirs must be the ones the reader looks in.
const projectsDir = (configRoot: string, workingDir: string): string =>
  join(configRoot, 'projects', encodeClaudeProjectDir(workingDir))

// homedir() is where the OLD code landed (projectsDirFor falls back to
// <home>/.claude when no configDir is given). Pointing it at the fixture makes
// the negative control real: the pre-fix route reads the fixture's shared root,
// not the developer's own ~/.claude.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, default: { ...actual, homedir: () => FIXTURE_HOME }, homedir: () => FIXTURE_HOME }
})

vi.mock('../web/inbound-probe.js', () => ({
  mainConfigRoots: () => [SHARED_CONFIG, ISOLATED_MAIN_CONFIG],
}))

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The auto-provisioned shape: nothing CONFIGURED (resolveAgentConfigDir, which
// the pre-fix route asked, answers null), while the reader's resolver finds the
// isolated dir the launcher created.
vi.mock('../web/claude-plans.js', () => ({
  resolveAgentConfigDir: () => ({ configDir: null, planUnresolved: false, tokenSecretId: null }),
  resolveAgentConfigDirForRead: () => ISOLATED_SUB_CONFIG,
}))

function writeTranscript(dir: string, name: string, text: string, ageSeconds: number): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    message: { content: [{ type: 'text', text }] },
  }) + '\n')
  const when = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(file, when, when)
}

interface ConversationBody { sessionId?: string | null; entries: Array<{ text: string }> }

async function getConversation(name: string): Promise<ConversationBody> {
  const { tryHandleAgentConversation } = await import('../web/routes/agent-conversation.js')
  let body = ''
  const res = { writeHead: () => undefined, end: (chunk: string) => { body = chunk } }
  const url = new URL(`http://localhost/api/agents/${name}/conversation`)
  const handled = await tryHandleAgentConversation({ res, path: url.pathname, method: 'GET', url } as never)
  expect(handled).toBe(true)
  return JSON.parse(body) as ConversationBody
}

describe('conversation view: which config root the transcript is read from (#2716)', () => {
  beforeAll(() => {
    // Main agent, the post-migration shape of a real install: the shared root
    // frozen days ago, the isolated one live.
    writeTranscript(projectsDir(SHARED_CONFIG, PROJECT_ROOT), 'old-session.jsonl', 'Please run /login', 9 * 24 * 3600)
    writeTranscript(projectsDir(ISOLATED_MAIN_CONFIG, PROJECT_ROOT), 'live-session.jsonl', 'live main reply', 1)
    // Sub-agent: the shared copy is the NEWER file on purpose. A sub-agent's
    // root is resolved, not picked by recency, so the isolated dir must win
    // even then.
    writeTranscript(projectsDir(SHARED_CONFIG, SUB_WORKING_DIR), 'old-sub-session.jsonl', 'stale sub reply', 1)
    writeTranscript(projectsDir(ISOLATED_SUB_CONFIG, SUB_WORKING_DIR), 'live-sub-session.jsonl', 'live sub reply', 60)
  })

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  it('shows the main agent\'s live session from its isolated root, not the stale shared one', async () => {
    const body = await getConversation('marveen')
    expect(body.sessionId).toBe('live-session')
    expect(body.entries.map(e => e.text)).toEqual(['live main reply'])
    // Stated rather than implied: this is what the pre-fix route returned.
    expect(body.sessionId).not.toBe('old-session')
  })

  it('shows a sub-agent\'s live session from its auto-provisioned root', async () => {
    const body = await getConversation(SUB)
    expect(body.sessionId).toBe('live-sub-session')
    expect(body.entries.map(e => e.text)).toEqual(['live sub reply'])
    expect(body.sessionId).not.toBe('old-sub-session')
  })
})
