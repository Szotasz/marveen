import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 2026-08-04, P1: the hourly heartbeat went silent for two hours. The schedule
// runner did the right thing -- it refuses to inject into a 100%-context pane
// and defers to the retry queue -- but that deferral only terminates if
// SOMEBODY rescues the wedged session, and the only rescuer is the
// context-guard's saturation net. The net swept listAgentNames(), which drops
// any directory carrying HIDDEN_AGENT_SENTINEL, and agents/heartbeat carries
// exactly that. The worker was invisible to its own life support, so the retry
// waited forever and two hourly ticks plus a support-inbox tick died quietly.
//
// The sentinel is a VISIBILITY decision ("do not clutter the dashboard"). This
// suite pins that it never again doubles as a LIFECYCLE decision.
const SANDBOX = mkdtempSync(join(tmpdir(), 'guardsweep-'))
const AGENTS = join(SANDBOX, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-process.js', () => ({
  // The not-ready-path modal clear: false = no modal, so every caller keeps
  // its existing skip/busy behaviour and these fixtures are unaffected.
  clearFeedbackModalAndRecheck: () => false,
  agentRunState: () => 'stopped',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: vi.fn(),
  capturePane: () => null,
  sendPromptToSession: vi.fn(),
  isSessionReadyForPrompt: async () => false,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))

const { guardSweepAgentNames } = await import('../web/context-guard-runner.js')
const { listAgentNames, listAllAgentNames, HIDDEN_AGENT_SENTINEL } = await import('../web/agent-config.js')

function agent(name: string, hidden = false): void {
  mkdirSync(join(AGENTS, name), { recursive: true })
  if (hidden) writeFileSync(join(AGENTS, name, HIDDEN_AGENT_SENTINEL), '')
}

beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true })
  mkdirSync(AGENTS, { recursive: true })
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('hidden technical workers and the saturation net', () => {
  it('the guard sweep visits a dashboard-hidden worker', () => {
    agent('samu')
    agent('heartbeat', true)

    // The exact shape of the outage: heartbeat exists on disk, is hidden, and
    // must still be swept.
    expect(guardSweepAgentNames()).toContain('heartbeat')
    expect(guardSweepAgentNames()).toContain('samu')
    expect(guardSweepAgentNames()[0]).toBe('marveen') // main stays first
  })

  it('the sweep set is a SET -- the main agent is never swept twice', () => {
    // On a real install agents/<MAIN_AGENT_ID> exists as a directory, so the
    // main agent arrives from BOTH sources: the explicit head of the list and
    // the directory listing. Without the sandbox dir below this test cannot see
    // the duplicate at all, which is why it is created here explicitly.
    agent('marveen')
    agent('samu')
    agent('heartbeat', true)

    const swept = guardSweepAgentNames()
    expect(swept[0]).toBe('marveen')
    expect(swept).toEqual([...new Set(swept)])
    expect(swept.filter((n) => n === 'marveen')).toHaveLength(1)
    // and the widening still holds in the same breath
    expect(swept).toContain('heartbeat')
  })

  it('the dashboard listing still hides that same worker', () => {
    agent('samu')
    agent('heartbeat', true)

    // Requirement from the report: fix the life support WITHOUT un-hiding the
    // technical worker in the UI. Both halves are asserted together so a future
    // "just use listAllAgentNames everywhere" cannot pass this file.
    expect(listAgentNames()).toEqual(['samu'])
    expect(listAllAgentNames().sort()).toEqual(['heartbeat', 'samu'])
  })

  it('a hidden worker with no store entry is still armed by default', async () => {
    // The wedge was NOT caused by a missing store/context-guard.json entry:
    // an agent absent from the store falls back to DEFAULT_CONTEXT_GUARD, whose
    // saturationRestart is already true. Pinned so nobody "fixes" the outage by
    // seeding config rows and calls it closed while the sweep stays narrow.
    const { readContextGuardConfig } = await import('../web/context-guard-store.js')
    const cfg = readContextGuardConfig('heartbeat')
    expect(cfg.saturationRestart).toBe(true)
    expect(cfg.enabled).toBe(false) // proactive tiers stay off; only the net runs
  })

  it('the rescue restart is FRESH, never --continue', () => {
    // Measured live on 2026-08-04: a default (--continue) restart of the wedged
    // heartbeat left the pane still showing "100% context used" -- continue
    // reloads the very context that wedged it. Only the fresh restart cleared
    // it. performRestart is private inside a module full of IO, so pin the
    // guarantee at the source, brace-matched to its own body.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'context-guard-runner.ts'),
      'utf8',
    )
    const m = /function performRestart\s*\([^)]*\)[^{]*\{/.exec(src)
    expect(m, 'performRestart not found').not.toBeNull()
    let depth = 0
    let end = src.length
    for (let i = src.indexOf('{', m!.index); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = src.slice(m!.index, end + 1)
    expect(body).toContain('restartAgentProcess(name, { fresh: true })')
    expect(body).not.toMatch(/restartAgentProcess\(name,\s*\{\s*fresh:\s*false/)
    expect(body).not.toMatch(/restartAgentProcess\(name\)/)
  })
})
