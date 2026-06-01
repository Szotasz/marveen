// Regression tests for the 2026-06-01 channel-recovery stage-3 fix.
//
// Background: every Telegram channel disconnect on 2026-06-01 13:09 / 13:51 /
// 15:03 escalated stage1 -> stage4 (hard restart, context lost), because the
// stage-3 path (`resumeMarveenSession`) called `tmux respawn-pane -k` but
// never reaped the orphan bun poller grandchild. The freshly-respawned
// --continue session raced the still-alive poller for the same bot token,
// the plugin never reached an inbound-ready state, the recovery timed out
// after 90s and fell through to the kontextus-losing stage 4.
//
// We can't drive a real tmux/launchd interaction from a unit test, so the
// asserts here are static (read the source) and lock in the structural
// invariants that the 2026-06-01 fix introduced:
//   1. reapChannelOrphans is imported and called BEFORE respawn-pane -k.
//   2. dismissResumeSummaryModalIfPresent is called AFTER respawn-pane -k.
//   3. RESUME_GRACE_MS is at least 150 seconds (was 90; the 60s
//      channel-monitor poll plus plugin re-handshake needs the headroom).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')

describe('channel-monitor: stage-3 resumeMarveenSession recovery hardening', () => {
  const src = readFileSync(MONITOR_PATH, 'utf-8')

  // Slice out the resumeMarveenSession body so unrelated mentions
  // elsewhere in the file (e.g. comments, sendAlert text) cannot
  // satisfy these checks by accident.
  const fnStart = src.indexOf('function resumeMarveenSession')
  expect(fnStart, 'resumeMarveenSession not found').toBeGreaterThan(0)
  const fnEnd = src.indexOf('\n}\n', fnStart)
  expect(fnEnd, 'resumeMarveenSession closing brace not found').toBeGreaterThan(fnStart)
  const fnBody = src.slice(fnStart, fnEnd)

  it('reapChannelOrphans is imported in channel-monitor', () => {
    // Cheap guard: a future refactor that drops the symbol from the
    // import list would leave the function as a TS reference error,
    // but this assertion surfaces it explicitly with a clearer message.
    expect(src).toMatch(/import\s*{\s*reapChannelOrphans\s*}\s*from\s*'\.\/channel-poller-reap\.js'/)
  })

  it('dismissResumeSummaryModalIfPresent is imported from agent-process', () => {
    expect(src).toMatch(/dismissResumeSummaryModalIfPresent[\s\S]*?from\s*'\.\/agent-process\.js'/)
  })

  it('reapChannelOrphans is called inside resumeMarveenSession BEFORE the tmux respawn', () => {
    const reapIdx = fnBody.indexOf('reapChannelOrphans(')
    const respawnIdx = fnBody.indexOf("'respawn-pane'")
    expect(reapIdx, 'reapChannelOrphans call missing from resumeMarveenSession').toBeGreaterThan(0)
    expect(respawnIdx, 'respawn-pane call missing from resumeMarveenSession').toBeGreaterThan(0)
    // Order matters: the reap must happen first to clear the orphan
    // before the fresh poller is spawned by the respawn.
    expect(reapIdx).toBeLessThan(respawnIdx)
  })

  it('dismissResumeSummaryModalIfPresent is called inside resumeMarveenSession AFTER the tmux respawn', () => {
    const dismissIdx = fnBody.indexOf('dismissResumeSummaryModalIfPresent(')
    const respawnIdx = fnBody.indexOf("'respawn-pane'")
    expect(dismissIdx, 'modal dismiss call missing from resumeMarveenSession').toBeGreaterThan(0)
    expect(respawnIdx, 'respawn-pane call missing from resumeMarveenSession').toBeGreaterThan(0)
    // Order matters: dismiss can only run on the fresh TUI that the
    // respawn just produced. Calling it before respawn would target
    // the dying parent's pane state.
    expect(respawnIdx).toBeLessThan(dismissIdx)
  })

  it('RESUME_GRACE_MS is at least 240 seconds (post-2026-06-01-16:31 budget)', () => {
    // 90s -> 150s -> 240s. The 150s window was empirically insufficient on
    // a >200k-token --continue session (2026-06-01 16:31 incident); the
    // resume respawned cleanly but the plugin re-handshake did not finish
    // inside the window and stage 4 fired. Pin >=240000 to catch a future
    // refactor that drops the budget back below the observed worst case.
    const m = src.match(/const\s+RESUME_GRACE_MS\s*=\s*([\d_]+)/)
    expect(m, 'RESUME_GRACE_MS constant not found').not.toBeNull()
    const value = parseInt((m![1] as string).replace(/_/g, ''), 10)
    expect(value).toBeGreaterThanOrEqual(240_000)
  })
})

describe('channel-monitor: post-respawn cold-start guard (2026-06-01 480s outage)', () => {
  // Background: a keepalive fresh-respawn at 17:59:20 was followed by a
  // down-detect at 18:03 because the post-respawn grace was only 120s -- it
  // expired while the new large-context session was still booting, so the
  // recovery cascade (soft->save->resume->hard) stacked THREE restarts onto a
  // session that was merely cold-starting. downedFor was 480s. The fix widens
  // the grace and gates the cascade on lastMainRespawnAt() (which folds in the
  // keepalive-respawn timestamp, not just the hard-restart one).
  const src = readFileSync(MONITOR_PATH, 'utf-8')

  const fnStart = src.indexOf('function handleMarveenDown')
  expect(fnStart, 'handleMarveenDown not found').toBeGreaterThan(0)
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)

  it('post-respawn grace is at least 300 seconds (covers a large-context cold start)', () => {
    const m = src.match(/const\s+MARVEEN_POST_RESPAWN_GRACE_MS\s*=\s*([\d_]+)/)
    expect(m, 'MARVEEN_POST_RESPAWN_GRACE_MS constant not found').not.toBeNull()
    const value = parseInt((m![1] as string).replace(/_/g, ''), 10)
    expect(value).toBeGreaterThanOrEqual(300_000)
  })

  it('handleMarveenDown gates on lastMainRespawnAt() so a keepalive respawn also suppresses escalation', () => {
    // The earlier code gated only on marveenLastHardRestart, which a keepalive
    // fresh-respawn updated but a future refactor might not. lastMainRespawnAt()
    // is the single source of truth for "we respawned recently, give it time".
    expect(fnBody).toMatch(/lastMainRespawnAt\(\)/)
    expect(fnBody).toMatch(/MARVEEN_POST_RESPAWN_GRACE_MS/)
  })

  it('the cold-start guard returns BEFORE the cascade creates a down state', () => {
    // The grace check must short-circuit before the `if (!marveenDownState)`
    // branch, otherwise a still-booting session would begin stage 1 and stack.
    const guardIdx = fnBody.indexOf('MARVEEN_POST_RESPAWN_GRACE_MS')
    const downStateIdx = fnBody.indexOf('if (!marveenDownState)')
    expect(guardIdx, 'grace guard missing from handleMarveenDown').toBeGreaterThan(0)
    expect(downStateIdx, 'down-state init missing from handleMarveenDown').toBeGreaterThan(0)
    expect(guardIdx).toBeLessThan(downStateIdx)
  })
})
