import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// RESPAWNZAJ822/PRODFAAG822 (2026-08-22): a context-guard-restarted session,
// resumed via inject-resume, branch-switched and committed on the running prod
// checkout (PR #1036 duplicate). The resume prompt is the ONLY context that
// session has, so the prod-tree constraint must be present in the prompt text
// itself -- on EVERY variant (with handoff, without, stale, unmeasurable).
// This test pins that invariant: a later rewording cannot silently drop it.

const SANDBOX = mkdtempSync(join(tmpdir(), 'resume-prompt-test-'))

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

const { resumePrompt } = await import('../web/context-guard-runner.js')

const CONSTRAINT = 'NE válts ágat, NE commitolj'

describe('resumePrompt carries the prod-tree constraint on every variant', () => {
  it('without a handoff', () => {
    expect(resumePrompt('samu', '/x/HANDOFF.md', false)).toContain(CONSTRAINT)
  })
  it('with a fresh handoff', () => {
    expect(resumePrompt('samu', '/x/HANDOFF.md', true)).toContain(CONSTRAINT)
  })
  it('with a stale handoff', () => {
    expect(resumePrompt('samu', '/x/HANDOFF.md', true, 42)).toContain(CONSTRAINT)
  })
  it('with unmeasurable handoff freshness', () => {
    expect(resumePrompt('samu', '/x/HANDOFF.md', true, 'unknown')).toContain(CONSTRAINT)
  })
  it('points at the worktree alternative', () => {
    expect(resumePrompt('samu', '/x/HANDOFF.md', false)).toContain('worktree')
  })
})

// ORSICTX912 (2026-09-12): msg 23670 was delivered seven seconds after the
// guard kill started, into the dying session. The queue said delivered, the
// fresh session never looked back, and completed_at is unused (0/37 measured)
// so the loss was invisible. The resume prompt is the fresh session's ONLY
// context, so the re-read instruction must be present on EVERY variant, and
// it must demand an OBSERVABLE trace (ack to the sender) -- an instruction
// whose success cannot be observed would run into the same blindness.
describe('resumePrompt carries the restart-window re-read on every variant', () => {
  const variants = [
    ['without a handoff', () => resumePrompt('samu', '/x/HANDOFF.md', false)],
    ['with a fresh handoff', () => resumePrompt('samu', '/x/HANDOFF.md', true)],
    ['with a stale handoff', () => resumePrompt('samu', '/x/HANDOFF.md', true, 42)],
    ['with unmeasurable freshness', () => resumePrompt('samu', '/x/HANDOFF.md', true, 'unknown')],
    ['main agent', () => resumePrompt('marveen', '/x/HANDOFF.md', true)],
  ] as const
  for (const [label, make] of variants) {
    it(label, () => {
      const p = make()
      expect(p).toContain('RESTART-ABLAK')
      // The queue re-read names the concrete endpoint, not a vague "check".
      expect(p).toContain('api/messages?agent=')
      // The observable trace: an ack to the SENDER, required even when the
      // item needs no work -- this is what makes the v1 measurable at all.
      expect(p).toContain('nyugtát a feladónak')
      expect(p).toContain('akkor is, ha nincs belőle teendő')
    })
  }
})

// Review msg 14197: the main agent's channel is the OWNER's Telegram, and
// session meta must never go there (standing owner preference; a 3am status
// notice went out exactly this way on 2026-08-05). The closing line is
// therefore agent-dependent, and this pins BOTH directions so a rewording
// cannot re-point the main agent at the owner's channel.
describe('resumePrompt closing line is agent-dependent', () => {
  it('main agent (mocked MAIN_AGENT_ID=marveen): no channel notice, transcript line instead', () => {
    const p = resumePrompt('marveen', '/x/HANDOFF.md', true)
    expect(p).not.toContain('jelezz a csatornádon')
    expect(p).toContain('transzkript')
    expect(p).toContain(CONSTRAINT)
  })
  it('sub-agent: channel notice stays (their channel is the inter-agent queue)', () => {
    expect(resumePrompt('samu', '/x/HANDOFF.md', true)).toContain('jelezz a csatornádon')
  })
})
