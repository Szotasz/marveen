// Tests for the tool call audit metadata enrichment.
//
// The PostToolUse hook (tool-log-capture.py) sends three audit fields that
// Claude Code natively provides in the hook payload:
//
//   agent_id   -- derived from session cwd (ledger_lib.agent_id_from_cwd)
//   trace_id   -- the CC-native tool_use_id (stable, unique per call, present
//                 in both Pre and PostToolUse payloads -- empirically verified
//                 2026-07-20). Stored in trace_id rather than a separate column
//                 because it IS the tracing key.
//   duration_ms -- CC's own wall-clock measurement (more accurate than hook-
//                 side timestamps because it excludes hook overhead).
//
// No PreToolUse hook is needed: CC provides correlation key + latency in one
// place (PostToolUse payload), so a separate pre-tracking table would add
// complexity without adding information.
//
// These tests verify:
//   (a) all three audit fields are stored and retrievable
//   (b) rows logged WITHOUT the fields (old/minimal hook callers) stay readable
//   (c) two calls with different tool_use_ids produce distinct trace_ids
//   (d) duration_ms is stored as an integer
//   (e) fix-revert guard: removing the new parameters → assertions fail

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, logToolCall, getRecentToolCalls } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('tool call audit metadata: agent_id, trace_id, duration_ms storage', () => {
  it('stores agent_id, trace_id, and duration_ms and returns them via getRecentToolCalls', () => {
    logToolCall('sess-1', 'Bash', 'ls -la', true, 'agent-a', 'toolu_abc123', 42)

    const rows = getRecentToolCalls(3600)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe('agent-a')
    expect(rows[0].trace_id).toBe('toolu_abc123')
    expect(rows[0].duration_ms).toBe(42)
  })

  it('stores core fields alongside the audit fields', () => {
    logToolCall('sess-2', 'Read', '/etc/hosts', false, 'agent-b', 'toolu_xyz999', 7)

    const rows = getRecentToolCalls(3600)
    expect(rows[0].session_id).toBe('sess-2')
    expect(rows[0].tool_name).toBe('Read')
    expect(rows[0].input_summary).toBe('/etc/hosts')
    expect(rows[0].success).toBe(0)
    expect(rows[0].agent_id).toBe('agent-b')
    expect(rows[0].trace_id).toBe('toolu_xyz999')
    expect(rows[0].duration_ms).toBe(7)
  })

  it('accepts null for all three audit fields (backward compat -- old hook callers)', () => {
    logToolCall('sess-old', 'WebFetch', 'https://example.invalid', true)

    const rows = getRecentToolCalls(3600)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].trace_id).toBeNull()
    expect(rows[0].duration_ms).toBeNull()
  })

  it('two calls with different tool_use_ids produce distinct trace_ids', () => {
    // trace_id = CC tool_use_id, which is unique per call.
    logToolCall('sess-3', 'Bash', 'pwd',  true, 'agent-a', 'toolu_call1', 10)
    logToolCall('sess-3', 'Bash', 'date', true, 'agent-a', 'toolu_call2', 20)

    const rows = getRecentToolCalls(3600)
    expect(rows).toHaveLength(2)
    expect(rows[0].trace_id).toBe('toolu_call1')
    expect(rows[1].trace_id).toBe('toolu_call2')
    expect(rows[0].trace_id).not.toBe(rows[1].trace_id)
  })

  it('duration_ms is stored as an integer (not rounded or cast to string)', () => {
    logToolCall('sess-4', 'Edit', 'x.ts', true, 'agent-a', 'toolu_dur', 1337)

    const rows = getRecentToolCalls(3600)
    expect(typeof rows[0].duration_ms).toBe('number')
    expect(rows[0].duration_ms).toBe(1337)
  })

  it('rows from multiple agents are independently labeled with correct trace_ids', () => {
    logToolCall('sess-5', 'Read',  'a.ts', true, 'agent-a', 'toolu_a1', 5)
    logToolCall('sess-6', 'Write', 'b.ts', true, 'agent-b', 'toolu_b1', 8)

    const rows = getRecentToolCalls(3600)
    const byAgent = Object.fromEntries(rows.map(r => [r.agent_id, r]))
    expect(byAgent['agent-a'].trace_id).toBe('toolu_a1')
    expect(byAgent['agent-b'].trace_id).toBe('toolu_b1')
  })
})

// --- Fix-revert guard ---
//
// If logToolCall were reverted to the 4-arg signature (without agentId,
// traceId, durationMs), the tests below would turn RED because the columns
// would stay null even when explicit values are passed. That is correct
// behaviour -- these tests MUST be red on revert.

describe('fix-revert guard: all three audit fields are load-bearing', () => {
  it('agent_id is non-null when explicitly provided', () => {
    logToolCall('sess-g1', 'Bash', 'echo hi', true, 'agent-sentinel', 'toolu_sentinel', 1)
    const rows = getRecentToolCalls(3600)
    expect(rows[0].agent_id).not.toBeNull()
    expect(rows[0].agent_id).toBe('agent-sentinel')
  })

  it('trace_id is non-null when explicitly provided', () => {
    logToolCall('sess-g2', 'Edit', 'x.ts', true, 'agent-sentinel', 'toolu_sentinel2', 2)
    const rows = getRecentToolCalls(3600)
    expect(rows[0].trace_id).not.toBeNull()
    expect(rows[0].trace_id).toBe('toolu_sentinel2')
  })

  it('duration_ms is non-null when explicitly provided', () => {
    logToolCall('sess-g3', 'Read', 'y.ts', true, 'agent-sentinel', 'toolu_sentinel3', 999)
    const rows = getRecentToolCalls(3600)
    expect(rows[0].duration_ms).not.toBeNull()
    expect(rows[0].duration_ms).toBe(999)
  })
})
