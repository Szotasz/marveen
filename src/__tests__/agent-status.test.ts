// Contract tests for the per-agent status derivation.
//
// The rule this file exists to protect: MISSING tool telemetry and ZERO tool
// calls are different answers. Measured 2026-08-29, all 603 rows in
// tool_call_log carried agent_id='jarvis' and six of seven agents had none at
// all, so the degraded path is the DEFAULT state of the fleet, not an edge
// case. A view that renders those six as "0 tool calls, stalled" would report
// healthy agents as dead -- worse than showing nothing.

import { describe, it, expect } from 'vitest'
import {
  deriveAgentStatus,
  AGENT_STATUS_THRESHOLDS,
  type AgentStatusSignals,
} from '../web/agent-status.js'

const NOW = 1_800_000_000

function signals(over: Partial<AgentStatusSignals> = {}): AgentStatusSignals {
  return {
    agent: 'devy',
    isMain: false,
    running: true,
    paneState: 'working',
    permissionMode: 'bypass permissions',
    toolDataAvailable: true,
    toolCallsSinceStart: 12,
    lastToolCallAt: NOW - 40,
    lastInboundAt: NOW - 1900,
    lastOutboundAt: NOW - 600,
    lastInboundSubject: 'Nezd meg a footer ikonokat',
    currentCard: { id: 'c1', title: 'Molyo: Footer menu ikonok', enteredStatusAt: NOW - 1920 },
    nowSec: NOW,
    ...over,
  }
}

describe('deriveAgentStatus: the six fields', () => {
  it('reports what, since when, last signal age, and tool count', () => {
    const r = deriveAgentStatus(signals())
    expect(r.state).toBe('working')
    expect(r.work).toEqual({ kind: 'card', text: 'Molyo: Footer menu ikonok', cardId: 'c1' })
    expect(r.sinceSec).toBe(1920)
    expect(r.lastSignalAgeSec).toBe(40)
    expect(r.lastSignalSource).toBe('tool')
    expect(r.toolCalls).toBe(12)
    expect(r.degraded).toBe(false)
  })

  it('falls back to the last handed-over task when no card is claimed', () => {
    const r = deriveAgentStatus(signals({ currentCard: null }))
    expect(r.work).toEqual({ kind: 'message', text: 'Nezd meg a footer ikonokat', cardId: null })
    expect(r.sinceSec).toBe(1900)
  })

  it('does not present a stale handed-over task as current work', () => {
    // Measured on the live board: three agents' newest inbound was the same
    // 447-hour-old broadcast, rendered as work started 447 hours ago.
    const stale = AGENT_STATUS_THRESHOLDS.MESSAGE_WORK_CLAIM_MAX_AGE_SEC + 60
    const r = deriveAgentStatus(signals({ currentCard: null, lastInboundAt: NOW - stale }))
    expect(r.work.kind).toBe('none')
    expect(r.sinceSec).toBeNull()
  })

  it('an in_progress card never expires -- it is the agent\'s own claim', () => {
    const ancient = NOW - 500 * 3600
    const r = deriveAgentStatus(signals({
      lastInboundAt: ancient,
      currentCard: { id: 'c9', title: 'Long haul', enteredStatusAt: ancient },
    }))
    expect(r.work).toEqual({ kind: 'card', text: 'Long haul', cardId: 'c9' })
    expect(r.sinceSec).toBe(500 * 3600)
  })

  it('says nothing rather than guessing when there is neither card nor task', () => {
    const r = deriveAgentStatus(signals({ currentCard: null, lastInboundSubject: null, lastInboundAt: null }))
    expect(r.work.kind).toBe('none')
    expect(r.sinceSec).toBeNull()
  })

  it('never reports a completion percentage', () => {
    // Pinned deliberately: nothing in the system knows a task's size, so any
    // percentage would be invented. If a future change adds one, this fails.
    expect(Object.keys(deriveAgentStatus(signals()))).not.toContain('percent')
    expect(JSON.stringify(deriveAgentStatus(signals()))).not.toMatch(/percent|progress/i)
  })
})

describe('deriveAgentStatus: missing tool data is not zero tool calls', () => {
  it('reports toolCalls as null, never 0, when the agent has no telemetry', () => {
    const r = deriveAgentStatus(signals({ toolDataAvailable: false, toolCallsSinceStart: 0, lastToolCallAt: null }))
    expect(r.toolCalls).toBeNull()
    expect(r.toolCalls).not.toBe(0)
    expect(r.degraded).toBe(true)
  })

  it('distinguishes it from a real zero: telemetry covering the current work', () => {
    const r = deriveAgentStatus(signals({ toolDataAvailable: true, toolCallsSinceStart: 0, lastToolCallAt: NOW - 10 }))
    expect(r.toolCalls).toBe(0)
    expect(r.degraded).toBe(false)
  })

  it('treats telemetry that predates the current work as no data, not as zero', () => {
    // Measured on the live fleet: an agent whose hook had been removed kept
    // five stale rows and rendered as "0 tool calls" while actively working.
    const r = deriveAgentStatus(signals({
      toolDataAvailable: true,
      toolCallsSinceStart: 0,
      lastToolCallAt: NOW - 3000,
      currentCard: { id: 'c2', title: 'Fresh work', enteredStatusAt: NOW - 400 },
    }))
    expect(r.toolCalls).toBeNull()
    expect(r.degraded).toBe(true)
  })

  it('stale telemetry cannot produce a STALLED verdict either', () => {
    const r = deriveAgentStatus(signals({
      toolDataAvailable: true,
      lastToolCallAt: NOW - 99_999,
      lastOutboundAt: NOW - AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC - 60,
      currentCard: { id: 'c3', title: 'Fresh work', enteredStatusAt: NOW - 400 },
    }))
    expect(r.state).toBe('working')
  })

  it('still reports a message-based last signal while degraded', () => {
    // The row stays useful: what the agent was handed, and when it last spoke.
    const r = deriveAgentStatus(signals({ toolDataAvailable: false, lastToolCallAt: null, lastOutboundAt: NOW - 300 }))
    expect(r.lastSignalAgeSec).toBe(300)
    expect(r.lastSignalSource).toBe('message')
    expect(r.work.kind).toBe('card')
  })
})

describe('deriveAgentStatus: STALLED never fires without tool telemetry', () => {
  const longSilence = AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC + 60

  it('fires for a working agent that has been silent past the threshold', () => {
    const r = deriveAgentStatus(signals({
      lastToolCallAt: NOW - longSilence,
      lastOutboundAt: NOW - longSilence,
    }))
    expect(r.state).toBe('stalled')
  })

  it('does NOT fire on the same silence when telemetry is missing', () => {
    // The exact false-death case: six of seven agents look like this today.
    const r = deriveAgentStatus(signals({
      toolDataAvailable: false,
      lastToolCallAt: null,
      lastOutboundAt: NOW - longSilence,
    }))
    expect(r.state).toBe('working')
    expect(r.state).not.toBe('stalled')
  })

  it('does not fire exactly one second below the threshold', () => {
    const r = deriveAgentStatus(signals({
      lastToolCallAt: NOW - (AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC - 1),
      lastOutboundAt: NOW - (AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC - 1),
    }))
    expect(r.state).toBe('working')
  })

  it('does not fire for an idle agent -- idle is a resting state, not a stall', () => {
    const r = deriveAgentStatus(signals({
      paneState: 'idle',
      lastToolCallAt: NOW - longSilence,
      lastOutboundAt: NOW - longSilence,
    }))
    expect(r.state).toBe('idle')
  })
})

describe('deriveAgentStatus: run state wins over everything', () => {
  it('a stopped agent is stopped regardless of stale signals', () => {
    expect(deriveAgentStatus(signals({ running: false })).state).toBe('stopped')
  })

  it('an unreachable agent is reported as such, not guessed at', () => {
    expect(deriveAgentStatus(signals({ paneState: 'unreachable' })).state).toBe('unreachable')
  })

  it('an unreadable pane is unknown, not idle', () => {
    expect(deriveAgentStatus(signals({ paneState: 'unknown' })).state).toBe('unknown')
  })
})

describe('deriveAgentStatus: inbound messages are not a sign of life', () => {
  it('someone else messaging the agent does not refresh its last signal', () => {
    // An inbound message says the ROUTER is alive, not the agent. Counting it
    // would make a dead agent look freshly active every time it is pinged.
    const r = deriveAgentStatus(signals({
      lastToolCallAt: null,
      toolDataAvailable: false,
      lastOutboundAt: null,
      lastInboundAt: NOW - 5,
    }))
    expect(r.lastSignalAgeSec).toBeNull()
    expect(r.lastSignalSource).toBeNull()
  })
})

describe('deriveAgentStatus: permission mode is passed through, not interpreted', () => {
  it('surfaces the raw string and derives no state from it', () => {
    const r = deriveAgentStatus(signals({ permissionMode: 'bypass permissions' }))
    expect(r.permissionMode).toBe('bypass permissions')
    expect(r.state).toBe('working')
  })

  it('an unrecognised mode changes nothing about the state', () => {
    // No matcher exists against mode strings, so a new one cannot break the view.
    const r = deriveAgentStatus(signals({ permissionMode: 'some future mode' }))
    expect(r.state).toBe('working')
    expect(r.permissionMode).toBe('some future mode')
  })
})

describe('thresholds live in exactly one place', () => {
  it('exposes the named constants the derivation uses', () => {
    expect(AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC).toBeGreaterThan(0)
    expect(AGENT_STATUS_THRESHOLDS.TOOL_DATA_WINDOW_SEC).toBeGreaterThan(0)
  })

  it('the derivation honours a changed threshold rather than a hardcoded copy', () => {
    // If someone inlines the number, this catches it: the boundary case is
    // computed FROM the constant, so a divergent literal fails here.
    const justOver = AGENT_STATUS_THRESHOLDS.STALLED_AFTER_SEC
    const r = deriveAgentStatus(signals({
      lastToolCallAt: NOW - justOver,
      lastOutboundAt: NOW - justOver,
    }))
    expect(r.state).toBe('stalled')
  })
})
