import { describe, it, expect } from 'vitest'
import { parseScheduledTaskMarker, userTurnText, collapseByMessageId } from '../web/token-usage.js'

/**
 * R0 (kanban #134): attribute token spend to the scheduled task that caused it.
 *
 * Nothing labelled the rows before this: task_title and project were 0%
 * populated across all 9309 of them, so "what did the morning briefing cost
 * last month" had no answer, and a model router could be neither trained nor
 * evaluated.
 *
 * The label comes off the provenance wrapper the schedule runner puts around
 * every injected prompt. Measured across all 95 transcripts on 2026-07-31:
 * 1149 scheduled prompts, 13 distinct tasks, and the structured tag and the
 * bracket prefix always appear together (1149/1149).
 */

// Shape of a real wrapped scheduled prompt: safety preamble, bracket prefix,
// then the structured tag. The markers are mid-string, never at the head.
function wrapped(kind: 'Heartbeat' | 'Utemezett feladat', name: string): string {
  return (
    'The wrapper marks provenance, not distrust. ' +
    `[${kind}: ${name}] ` +
    `<scheduled-task source="scheduled-task:${name}">\nDo the thing.\n</scheduled-task>`
  )
}

describe('reading the scheduled-task marker', () => {
  it('finds the task in a wrapped heartbeat prompt', () => {
    expect(parseScheduledTaskMarker(wrapped('Heartbeat', 'memoria-heartbeat'))).toBe('memoria-heartbeat')
  })

  it('finds the task in a wrapped scheduled-task prompt', () => {
    expect(parseScheduledTaskMarker(wrapped('Utemezett feladat', 'reggeli-teteles-lista'))).toBe('reggeli-teteles-lista')
  })

  it('does not require the marker at the start of the message', () => {
    // The safety preamble always precedes it. An anchored ^ match finds
    // nothing -- which is exactly how this was mismeasured once already.
    const text = wrapped('Heartbeat', 'kanban-audit')
    expect(text.startsWith('<scheduled-task')).toBe(false)
    expect(parseScheduledTaskMarker(text)).toBe('kanban-audit')
  })

  it('returns null for an ordinary interactive prompt', () => {
    expect(parseScheduledTaskMarker('szia, nezd meg a #132-t')).toBeNull()
    expect(parseScheduledTaskMarker('')).toBeNull()
  })

  it('handles every task name the fleet actually schedules', () => {
    for (const name of [
      'memoria-heartbeat', 'support-inbox-figyeles', 'kanban-flow-watchdog',
      'kanban-audit', 'reggeli-napindito', 'dream-engine', 'reggeli-teteles-lista',
      'idea-scout', 'heti-osszefoglalo', 'vercel-metrikak-atnezes',
      'post-rollback-diagnose', 'negativ-review-banyaszat-elso', 'hetfoi-legal-osszerakas',
    ]) {
      expect(parseScheduledTaskMarker(wrapped('Heartbeat', name)), name).toBe(name)
    }
  })

  it('is not fooled by a user quoting the human-readable prefix', () => {
    // The bracket form can appear in ordinary prose (someone pasting a log
    // line). The structured tag is the anchor precisely because it cannot.
    expect(parseScheduledTaskMarker('miert futott le a [Heartbeat: kanban-audit] ketszer?')).toBeNull()
  })
})

describe('telling a person apart from a tool result', () => {
  it('reads a plain string user turn', () => {
    expect(userTurnText('szia')).toBe('szia')
  })

  it('reads text blocks', () => {
    expect(userTurnText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('rejects a tool-result turn outright', () => {
    // 8270 of 10579 user lines across the fleet's transcripts are tool results.
    // Treating one as a person would clear the label on the first tool call of
    // a scheduled run -- so every task would look like it cost one API call.
    expect(userTurnText([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])).toBeNull()
  })

  it('rejects a mixed turn containing a tool result', () => {
    expect(userTurnText([{ type: 'text', text: 'hi' }, { type: 'tool_result', content: 'ok' }])).toBeNull()
  })

  it('ignores shapes it does not understand', () => {
    expect(userTurnText(null)).toBeNull()
    expect(userTurnText(undefined)).toBeNull()
    expect(userTurnText(42)).toBeNull()
    expect(userTurnText([{ type: 'image' }])).toBe('')
  })
})

describe('the label survives a collapse of one assistant turn', () => {
  const base = {
    agent: 'marveen', sessionId: 's', timestamp: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    thinkingTokens: 0, model: 'claude-opus-5', contentPreview: '', toolName: null,
  }

  it('keeps the task when the text line carries it and the tool line does not', () => {
    const out = collapseByMessageId([
      { ...base, taskTitle: 'kanban-audit', messageId: 'msg_1' },
      { ...base, taskTitle: null, messageId: 'msg_1', toolName: 'Bash' },
    ] as never)
    expect(out).toHaveLength(1)
    expect((out[0] as { taskTitle: string | null }).taskTitle).toBe('kanban-audit')
  })

  it('leaves interactive turns unlabelled', () => {
    const out = collapseByMessageId([
      { ...base, taskTitle: null, messageId: 'msg_2' },
    ] as never)
    expect((out[0] as { taskTitle: string | null }).taskTitle).toBeNull()
  })
})
