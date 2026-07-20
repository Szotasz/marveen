// Tests for the tool call audit metadata enrichment.
//
// The PostToolUse hook (tool-log-capture.py) now sends agent_id (derived from
// the session cwd) and trace_id (uuid4 per call) alongside the existing fields.
// logToolCall persists them to the tool_call_log table; getRecentToolCalls
// returns them in every row.
//
// These tests verify:
//   (a) agent_id and trace_id are stored and retrievable
//   (b) rows logged WITHOUT agent_id/trace_id (old hook) stay readable (null)
//   (c) each call gets its own trace_id -- two rows never share one
//   (d) fix-revert guard: removing the columns drops the fields from results

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, logToolCall, getRecentToolCalls } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('tool call audit metadata: agent_id + trace_id storage', () => {
  it('stores agent_id and trace_id and returns them via getRecentToolCalls', () => {
    logToolCall('sess-1', 'Bash', 'ls -la', true, 'agent-a', 'trace-abc-123')

    const rows = getRecentToolCalls(3600)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe('agent-a')
    expect(rows[0].trace_id).toBe('trace-abc-123')
  })

  it('stores session_id, tool_name, input_summary and success alongside the new fields', () => {
    logToolCall('sess-2', 'Read', '/etc/hosts', false, 'agent-b', 'trace-xyz-999')

    const rows = getRecentToolCalls(3600)
    expect(rows[0].session_id).toBe('sess-2')
    expect(rows[0].tool_name).toBe('Read')
    expect(rows[0].input_summary).toBe('/etc/hosts')
    expect(rows[0].success).toBe(0)
    expect(rows[0].agent_id).toBe('agent-b')
    expect(rows[0].trace_id).toBe('trace-xyz-999')
  })

  it('accepts null agent_id and null trace_id for backward compatibility (old hook callers)', () => {
    // Callers that do not yet send audit fields must not break.
    logToolCall('sess-old', 'WebFetch', 'https://example.invalid', true)

    const rows = getRecentToolCalls(3600)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].trace_id).toBeNull()
  })

  it('two separate calls each get their own distinct trace_id', () => {
    logToolCall('sess-3', 'Bash', 'pwd', true, 'agent-a', 'trace-first')
    logToolCall('sess-3', 'Bash', 'date', true, 'agent-a', 'trace-second')

    const rows = getRecentToolCalls(3600)
    expect(rows).toHaveLength(2)
    expect(rows[0].trace_id).not.toBe(rows[1].trace_id)
  })

  it('rows from multiple agents are independently labeled', () => {
    logToolCall('sess-4', 'Read', 'a.ts', true, 'agent-a', 'trace-1')
    logToolCall('sess-5', 'Write', 'b.ts', true, 'agent-b', 'trace-2')

    const rows = getRecentToolCalls(3600)
    const byAgent = Object.fromEntries(rows.map(r => [r.agent_id, r]))
    expect(byAgent['agent-a'].session_id).toBe('sess-4')
    expect(byAgent['agent-b'].session_id).toBe('sess-5')
  })
})

// --- Fix-revert guard ---
//
// If logToolCall were reverted to the 4-arg signature (without agentId/traceId),
// the assertions below would fail because the columns would stay null even
// when explicit values are passed. That is the correct behaviour -- these
// tests must turn RED on revert.

describe('fix-revert guard: audit fields are load-bearing', () => {
  it('agent_id is non-null when explicitly provided (proves column is written)', () => {
    logToolCall('sess-guard', 'Bash', 'echo hi', true, 'agent-sentinel', 'trace-sentinel')
    const rows = getRecentToolCalls(3600)
    expect(rows[0].agent_id).not.toBeNull()
    expect(rows[0].agent_id).toBe('agent-sentinel')
  })

  it('trace_id is non-null when explicitly provided (proves column is written)', () => {
    logToolCall('sess-guard2', 'Edit', 'x.ts', true, 'agent-sentinel', 'trace-sentinel-2')
    const rows = getRecentToolCalls(3600)
    expect(rows[0].trace_id).not.toBeNull()
    expect(rows[0].trace_id).toBe('trace-sentinel-2')
  })
})
