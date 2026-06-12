import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Security regression test (2026-06-08).
//
// The schedule-runner used to inject a coercive "keep-alive" preamble into
// heartbeat prompts for every agent whose name was not literally `heartbeat`
// (so the jarvis-driven heartbeats -- kanban-audit, memoria-heartbeat -- all
// got it). The preamble sat OUTSIDE the wrapUntrusted() envelope and demanded
// a mandatory no-op tool call while forbidding use of Telegram: the runner
// poisoning its own trusted channel, a prompt injection we shipped ourselves.
//
// It is removed. The runner must never again prepend an operational directive
// to a heartbeat prompt; the agent's CLAUDE.md + the task SKILL.md drive
// behaviour. These tests lock that in.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner heartbeat prefix is injection-free', () => {
  it('keeps the [Heartbeat: ${task.name}] tag (resubmit-marker matches)', () => {
    // The downstream resubmit-retry code matches `[Heartbeat: ${task.name}]`,
    // so the tag itself must stay.
    expect(SRC).toMatch(/\[Heartbeat: \$\{task\.name\}\]/)
  })

  it('contains NO keep-alive / Telegram-keepalive injection strings anywhere', () => {
    expect(SRC).not.toMatch(/KOTELEZO ELSO TEENDO MIELOTT BARMIT IRSZ/)
    expect(SRC).not.toMatch(/Telegram-bun MCP-stdio-pipe keep-alive/)
    expect(SRC).not.toMatch(/NE Telegram-tool-t/)
    expect(SRC).not.toMatch(/marveen-keepalive\.log/)
    expect(SRC).not.toMatch(/kotelezo no-op tool-call/)
  })

  it('does not branch the heartbeat prefix by agentName (one clean prefix)', () => {
    const heartbeatBlockStart = SRC.indexOf("if (task.type === 'heartbeat')")
    expect(heartbeatBlockStart).toBeGreaterThan(0)
    const outerElseMarker = SRC.indexOf('[Utemezett feladat:', heartbeatBlockStart)
    expect(outerElseMarker).toBeGreaterThan(heartbeatBlockStart)
    const heartbeatBlock = SRC.slice(heartbeatBlockStart, outerElseMarker)
    // No inner agentName branch deciding whether to inject a directive.
    expect(heartbeatBlock).not.toMatch(/agentName === 'heartbeat'/)
  })

  it('documents the security rationale at the branch (why, not just what)', () => {
    expect(SRC).toMatch(/SECURITY|inject|poison|wrapUntrusted/i)
  })
})
