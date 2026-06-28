import { describe, it, expect } from 'vitest'
import { collapseByMessageId } from '../web/token-usage.js'

// Minimal ParsedCall factory (the type is module-internal; the shape is what
// collapseByMessageId reads).
function call(over: Partial<Record<string, unknown>> = {}): any {
  return {
    agent: 'jarvis',
    sessionId: 's1',
    timestamp: 1000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contentPreview: '',
    toolName: null,
    messageId: null,
    ...over,
  }
}

describe('collapseByMessageId', () => {
  it('collapses the text + tool_use lines of one turn into a single row', () => {
    // Real-world shape: same message id, identical usage, 2-3s apart; the first
    // line has the text block (tool_name null), the second the tool_use block.
    const rows = [
      call({ messageId: 'msg_A', timestamp: 1000, outputTokens: 267, toolName: null, contentPreview: 'let me search' }),
      call({ messageId: 'msg_A', timestamp: 1003, outputTokens: 267, toolName: 'ToolSearch', contentPreview: '' }),
    ]
    const out = collapseByMessageId(rows)
    expect(out).toHaveLength(1)
    expect(out[0].outputTokens).toBe(267) // counted ONCE, not 534
    expect(out[0].toolName).toBe('ToolSearch') // tool name preserved
    expect(out[0].contentPreview).toBe('let me search') // first non-empty preview
    expect(out[0].timestamp).toBe(1000) // first occurrence kept
  })

  it('collapses three+ lines (parallel tool calls) into one', () => {
    const rows = [
      call({ messageId: 'msg_B', outputTokens: 461, toolName: null }),
      call({ messageId: 'msg_B', outputTokens: 461, toolName: null }),
      call({ messageId: 'msg_B', outputTokens: 461, toolName: 'Bash' }),
    ]
    const out = collapseByMessageId(rows)
    expect(out).toHaveLength(1)
    expect(out[0].outputTokens).toBe(461)
    expect(out[0].toolName).toBe('Bash')
  })

  it('keeps distinct turns separate and preserves order', () => {
    const rows = [
      call({ messageId: 'msg_A', outputTokens: 10, toolName: 'Read' }),
      call({ messageId: 'msg_B', outputTokens: 20 }),
      call({ messageId: 'msg_A', outputTokens: 10, toolName: 'Read' }),
    ]
    const out = collapseByMessageId(rows)
    expect(out.map((c) => c.messageId)).toEqual(['msg_A', 'msg_B'])
    expect(out[0].outputTokens).toBe(10)
    expect(out[1].outputTokens).toBe(20)
  })

  it('passes through rows without a message id (older transcripts)', () => {
    const rows = [
      call({ messageId: null, outputTokens: 5 }),
      call({ messageId: null, outputTokens: 7 }),
    ]
    const out = collapseByMessageId(rows)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.outputTokens)).toEqual([5, 7])
  })

  it('takes the max per usage field if a partial line differs', () => {
    const rows = [
      call({ messageId: 'msg_C', inputTokens: 100, outputTokens: 5, cacheReadTokens: 9 }),
      call({ messageId: 'msg_C', inputTokens: 100, outputTokens: 50, cacheReadTokens: 9, toolName: 'Edit' }),
    ]
    const out = collapseByMessageId(rows)
    expect(out).toHaveLength(1)
    expect(out[0].inputTokens).toBe(100)
    expect(out[0].outputTokens).toBe(50)
    expect(out[0].cacheReadTokens).toBe(9)
  })
})
