// CLAUDEPLANWATCHDOG912: resolveMainConfigDecision() used to know only about
// the generic, credential-less flotta-isolated dir (ensureMainAgentIsolatedConfigDir).
// The JS in-process respawn paths (channel-monitor.ts's resumeMarveenSession /
// respawnMainSessionFresh) build their launch command from THIS decision, not
// from scripts/main-agent-isolated-config.mjs -- so a main agent that had just
// been rotated onto a claude-plans entry (POST /api/claude-plans/rotate) got
// silently reverted to the shared flotta identity on the very next watchdog or
// keep-alive respawn, because neither an explicit MAIN_AGENT_CONFIG_DIR nor a
// rotated claude-plans entry was ever consulted here -- only the shell
// respawners (scripts/main-agent-isolated-config.mjs, locked by
// main-config-dir-parity.test.ts) already had the full explicit > rotated >
// isolated precedence. Observed live on 2026-09-12 (solarforce-ai host): a
// successful rotate to a registered plan was undone by the next background
// respawn, landing the main session on an unauthenticated isolated dir.
//
// This file locks the SAME precedence into resolveMainConfigDecision(), so the
// two decision-makers (the mjs script and this module) cannot drift again.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let ROOT = ''

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'boss',
  get PROJECT_ROOT() { return ROOT },
}))
vi.mock('../db.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createAgentMessage: () => 1,
}))

let fakeExplicit: string | null = null
let fakeRotated: string | null = null
let fakeIsolated: string | null = null
let isolatedCalls = 0

vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMainAgentConfigDir: () => fakeExplicit,
  resolveMainAgentRotatedConfigDir: () => fakeRotated,
  ensureMainAgentIsolatedConfigDir: () => { isolatedCalls++; return fakeIsolated },
  readMainSharedConfigState: (dir: string | null) => ({
    isolatedConfigDir: dir,
    fleetToken: true,
    isolatedDirExists: true,
  }),
}))

const { resolveMainConfigDecision } = await import('../web/main-config-decision.js')

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mcguard-rotation-'))
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  fakeExplicit = null
  fakeRotated = null
  fakeIsolated = '/srv/m/.channels-config'
  isolatedCalls = 0
})
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('resolveMainConfigDecision precedence (CLAUDEPLANWATCHDOG912)', () => {
  it('uses the rotated plan dir over the plain isolated dir, and flags it as own-credential', () => {
    fakeRotated = '/home/solarforce/.claude-second'
    const d = resolveMainConfigDecision()
    expect(d.isolatedConfigDir).toBe('/home/solarforce/.claude-second')
    expect(d.ownCredentials).toBe(true)
    expect(d.trigger).toBeNull()
    // The generic isolated-dir provisioner must not even be consulted once a
    // rotated dir already answers the question -- it PROVISIONS on disk, and
    // a rotated/explicit dir needs none of that.
    expect(isolatedCalls).toBe(0)
  })

  it('an explicit MAIN_AGENT_CONFIG_DIR wins over a rotated plan', () => {
    fakeExplicit = '/home/solarforce/.claude-bot'
    fakeRotated = '/home/solarforce/.claude-second'
    const d = resolveMainConfigDecision()
    expect(d.isolatedConfigDir).toBe('/home/solarforce/.claude-bot')
    expect(d.ownCredentials).toBe(true)
  })

  it('falls back to the plain isolated dir when nothing is rotated, and flags it as NOT own-credential', () => {
    fakeRotated = null
    const d = resolveMainConfigDecision()
    expect(d.isolatedConfigDir).toBe('/srv/m/.channels-config')
    expect(d.ownCredentials).toBe(false)
    expect(isolatedCalls).toBe(1)
  })
})
