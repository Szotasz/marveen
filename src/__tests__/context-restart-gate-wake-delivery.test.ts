// WHAT THIS FILE PINS: the CALL SITE of the wake nudge, not the text builder.
//
// gateWakePrompt(name) has its own unit tests, but they call it directly. A
// mutant that replaces the argument at the call site in deliverPendingWake
// (e.g. gateWakePrompt(MAIN_AGENT_ID), or a fixed agent name) kept the whole
// suite green, and then every agent got the same, wrong branch for reporting a
// failed restart. Here the nudge goes through the production entry point
// (checkAgent -> deliverPendingWake) and the text that is actually SENT is
// checked per agent.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAIN = 'wakemain'
const SUB = 'wakesub'
const NOW = 1_800_000_000_000
const sent: { name: string; text: string }[] = []

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: MAIN,
  PROJECT_ROOT: mkdtempSync(join(tmpdir(), 'gate-wake-')),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (n: string) => `agent-${n}`,
  capturePane: () => { throw new Error('no tmux in tests') },
}))
vi.mock('../web/context-guard-runner.js', () => ({ getHardGuardPhase: () => null }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [MAIN, SUB] }))
vi.mock('../web/system-directive.js', () => ({
  sendSystemDirective: vi.fn(async (name: string, _session: string, text: string) => {
    sent.push({ name, text })
    return 'sent'
  }),
}))
vi.mock('../web/context-restart-gate-store.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  return {
    ...real,
    readGateConfig: (name: string) => ({ ...(real.readGateConfig as (n: string) => object)(name), enabled: true }),
    // A wake owed for a /clear one minute ago: past WAKE_DELAY_MS, well inside WAKE_MAX_AGE_MS.
    readGateRunState: () => ({ firstBlockedAt: null, lastClearAt: NOW - 60_000, pendingWakeAt: NOW - 60_000 }),
    writeGateRunState: vi.fn(),
  }
})

const { checkAgent } = await import('../web/context-restart-gate-runner.js')

async function wakeTextFor(name: string): Promise<string> {
  sent.length = 0
  // Only the wake delivery matters here; whatever the rest of the sweep does
  // without tmux or transcripts is irrelevant to this pin.
  try { await checkAgent(name, NOW) } catch { /* the measuring part after the wake */ }
  const mine = sent.filter(s => s.name === name)
  expect(mine).toHaveLength(1)
  return mine[0].text
}

describe('deliverPendingWake sends the wake text of the agent it wakes', () => {
  beforeEach(() => { sent.length = 0 })

  it('a sub-agent is told to report a faulty handoff to the main agent over the queue', async () => {
    const text = await wakeTextFor(SUB)
    expect(text).toContain(`inter-agent uzenetben a fo ugynoknek (${MAIN})`)
    expect(text).not.toContain('azt a transzkriptben rogzitsd')
  })

  it('the main agent is told to record a faulty handoff in its transcript, not to message anyone', async () => {
    const text = await wakeTextFor(MAIN)
    expect(text).toContain('azt a transzkriptben rogzitsd')
    expect(text).not.toContain('inter-agent uzenetben a fo ugynoknek')
  })

  it('neither text names a specific channel provider', async () => {
    for (const name of [MAIN, SUB]) expect(await wakeTextFor(name)).not.toMatch(/Telegram/)
  })
})
