// Locks in the 2026-06-27 recovery change: sub-agent channel-plugin recovery no
// longer injects /mcp keystrokes. The old recovery drove a fixed
// /mcp+Up+Enter+Enter navigation (soft reconnect in the monitor, plus a
// post-respawn "colleague auto-unlock" in agent-process) to re-enable a wedged
// plugin. That was both pointless (channel sub-agents always launch fresh, so
// there is no --continue context to preserve) and unstable (the MCP server list
// order differs per agent, so the hard-coded "one Up == the channel plugin"
// lands on the wrong server and parks the pane in the /mcp modal -- the
// Reni-reported deaf-bot / stuck-in-/mcp incident). Recovery is now a verified
// fresh relaunch retried each tick. The monitor tick + the launch path are not
// exported as units, so -- matching the source-assertion convention in this dir
// -- we assert against the source text. The MAIN-session soft /mcp reconnect is
// intentionally NOT touched by this change and must remain.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')
const PROCESS_PATH = join(__dirname, '..', 'web', 'agent-process.ts')

describe('channel recovery: no /mcp keystroke dance for sub-agents', () => {
  const monitor = readFileSync(MONITOR_PATH, 'utf-8')
  const process = readFileSync(PROCESS_PATH, 'utf-8')

  it('the sub-agent down path no longer drives a soft /mcp reconnect', () => {
    // The per-down-spell soft-reconnect state is gone entirely.
    expect(monitor).not.toContain('agentSoftReconnectTried')
    // The sub-agent soft reconnect call (keyed by the per-target agent name)
    // is gone. The destructive-restart path below it stays the recovery.
    expect(monitor).not.toContain('attemptChannelMcpReconnect(t.agentName!)')
  })

  it('still goes straight to the verified fresh relaunch (stop+start) when down', () => {
    expect(monitor).toContain("'Agent channel plugin down -- auto-restarting'")
    expect(monitor).toContain('stopAgentProcess(t.agentName!)')
    expect(monitor).toContain('startAgentProcess(t.agentName!)')
  })

  it('leaves the MAIN-session soft /mcp reconnect untouched', () => {
    // The main agent keeps its own soft-first cascade; only the sub-agent path
    // changed. Guard against an over-broad removal.
    expect(monitor).toContain('attemptChannelMcpReconnect(MAIN_AGENT_ID)')
  })

  it('agent-process no longer schedules the /mcp unlock keystrokes on sub-agent launch', () => {
    // Neither the import nor the call may remain in the launch path.
    expect(process).not.toContain('schedulePluginUnlockAfterRespawn')
  })
})
