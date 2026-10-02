import { describe, it, expect } from 'vitest'
import { buildAgentPrompt, EMAIL_UNREADABLE_INSTRUCTION } from '../heartbeat.js'

// Email is the only heartbeat source the code does not fetch: the agent reads
// it through an MCP tool. When that tool is missing or failing, nothing in the
// round says so, and an absent Email section reads exactly like "no new mail".
// The calendar already refuses that collapse (heartbeat-calendar-fail-open);
// these tests pin that the prompt asks the agent for the same distinction.

function data() {
  return {
    timestamp: new Date(2026, 8, 2, 10, 0),
    calendar: { ok: true as const, events: [] },
    kanban: { urgent: 0, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] },
    system: { dbSizeMB: 50, dbWarning: false },
    tasks: { count: 0, nextRun: null },
  }
}

describe('buildAgentPrompt: an unreadable mailbox must not read as an empty one', () => {
  it('the prompt carries the instruction', () => {
    expect(buildAgentPrompt(data())).toContain(EMAIL_UNREADABLE_INSTRUCTION)
  })

  it('the instruction names the marker and forbids the "no mail" sentence', () => {
    expect(EMAIL_UNREADABLE_INSTRUCTION).toContain('EMAIL NEM OLVASHATO')
    expect(EMAIL_UNREADABLE_INSTRUCTION).toMatch(/SOHA ne ird, hogy nincs uj level/)
  })

  it('it sits right after the email fetch line, before the format instruction', () => {
    const p = buildAgentPrompt(data())
    const fetchAt = p.indexOf('search_emails')
    const ruleAt = p.indexOf(EMAIL_UNREADABLE_INSTRUCTION)
    const formatAt = p.indexOf('HEARTBEAT.md formatumot')
    expect(fetchAt).toBeGreaterThan(-1)
    expect(ruleAt).toBeGreaterThan(fetchAt)
    expect(formatAt).toBeGreaterThan(ruleAt)
  })
})
