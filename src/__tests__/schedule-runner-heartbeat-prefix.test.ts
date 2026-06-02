import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for Marveen's PR #257 review-block: the
// schedule-runner's heartbeat prefix had a Marveen-specific
// Telegram-keepalive directive hardcoded. Funnelling the new
// channel-less `heartbeat` agent through the same prefix would have:
//   1. Contradicted the agent's own CLAUDE.md contract ("NEVER call
//      Telegram tools, always inter-agent to Marveen").
//   2. If the channel-plugin disable ever leaked through user-scope
//      settings (the fleet's recurring failure mode), instructed the
//      agent to call chat_id ALLOWED_CHAT_ID directly -- reproducing
//      the self-poll problem this whole PR is meant to solve.
//
// Fix: branch the heartbeat-prefix by agentName. Channel-less
// `heartbeat` agent gets a minimal tag; Marveen still gets the
// historical Telegram-keepalive scaffolding.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner heartbeat prefix branches by agentName', () => {
  it('keeps the [Heartbeat: ${task.name}] tag (resubmit-marker matches)', () => {
    // The marker downstream is `[Heartbeat: ${task.name}]`. Both
    // branches of the new conditional MUST emit it -- otherwise the
    // resubmit-retry code at the bottom of the function stops working.
    expect(SRC).toMatch(/\[Heartbeat: \$\{task\.name\}\]/)
  })

  it('routes agentName === heartbeat to the minimal prefix (no Telegram directive)', () => {
    // The outer heartbeat-vs-utemezett-feladat block ends where the
    // `[Utemezett feladat:` prefix appears. Slice from "task.type ===
    // 'heartbeat'" up to that marker -- everything between is the
    // heartbeat branch, including BOTH inner sub-branches.
    const heartbeatBlockStart = SRC.indexOf("if (task.type === 'heartbeat')")
    expect(heartbeatBlockStart).toBeGreaterThan(0)
    const outerElseMarker = SRC.indexOf('[Utemezett feladat:', heartbeatBlockStart)
    expect(outerElseMarker).toBeGreaterThan(heartbeatBlockStart)
    const heartbeatBlock = SRC.slice(heartbeatBlockStart, outerElseMarker)
    expect(heartbeatBlock).toMatch(/agentName === 'heartbeat'/)

    // Identify the channel-less sub-branch: from the inner-if to the
    // inner-else. Both are inside heartbeatBlock now.
    const innerIfIdx = heartbeatBlock.indexOf("agentName === 'heartbeat'")
    const innerElseIdx = heartbeatBlock.indexOf('} else {', innerIfIdx)
    expect(innerElseIdx).toBeGreaterThan(innerIfIdx)
    const channelLessBranch = heartbeatBlock.slice(innerIfIdx, innerElseIdx)

    // Channel-less branch MUST NOT have Telegram instruction strings.
    expect(channelLessBranch).not.toMatch(/NE Telegram-tool-t/)
    expect(channelLessBranch).not.toMatch(/CSAK AKKOR irj Telegramon/)
    expect(channelLessBranch).not.toMatch(/ALLOWED_CHAT_ID/)
    expect(channelLessBranch).not.toMatch(/Telegram-bun MCP-stdio-pipe/)
  })

  it('Marveen branch still carries the historical keep-alive scaffolding', () => {
    // Don't break the Marveen-targeted heartbeat (e.g. the existing
    // memoria-heartbeat task) when fixing the channel-less one.
    expect(SRC).toMatch(/KOTELEZO ELSO TEENDO MIELOTT BARMIT IRSZ/)
    expect(SRC).toMatch(/Telegram-bun MCP-stdio-pipe keep-alive/)
  })

  it('comments the rationale for the branch (why, not just what)', () => {
    // PR #257 review-block specifically called out the
    // contract-contradiction risk. Future readers should find that
    // reasoning at the branch, not buried in git log.
    expect(SRC).toMatch(/contract|contradiction|channel-plugin disable/i)
  })
})
