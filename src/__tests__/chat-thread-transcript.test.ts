import { describe, it, expect } from 'vitest'
import { parseThreadTimeline, deriveThreadTitle } from '../web/chat/thread-transcript.js'

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

function userLine(content: unknown, ts = '2026-06-12T10:00:00Z'): string {
  return line({ type: 'user', timestamp: ts, message: { role: 'user', content } })
}

function assistantLine(blocks: unknown[], ts = '2026-06-12T10:00:05Z'): string {
  return line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks } })
}

describe('parseThreadTimeline', () => {
  it('renders plain user prompts and assistant text as a chat timeline', () => {
    const jsonl = [
      userLine('Szia, mi a heti terv?'),
      assistantLine([{ type: 'text', text: 'Szia! Itt a heti terv: ...' }]),
    ].join('\n')
    const entries = parseThreadTimeline(jsonl)
    expect(entries).toEqual([
      { ts: '2026-06-12T10:00:00Z', kind: 'user', text: 'Szia, mi a heti terv?' },
      { ts: '2026-06-12T10:00:05Z', kind: 'assistant', text: 'Szia! Itt a heti terv: ...' },
    ])
  })

  it('skips tool_result user lines (array content is not a human message)', () => {
    const jsonl = [
      userLine('kérdés'),
      userLine([{ type: 'tool_result', tool_use_id: 'x', content: 'file contents...' }]),
    ].join('\n')
    expect(parseThreadTimeline(jsonl)).toHaveLength(1)
  })

  it('strips system-reminder and slash-command blocks; drops lines with nothing left', () => {
    const jsonl = [
      userLine('<system-reminder>belső utasítás</system-reminder>valódi üzenet'),
      userLine('<system-reminder>csak harness-zaj</system-reminder>'),
      userLine('<command-name>/compact</command-name><command-message>compact</command-message>'),
    ].join('\n')
    const entries = parseThreadTimeline(jsonl)
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'user', text: 'valódi üzenet' }),
    ])
  })

  it('renders tool_use blocks as collapsed action labels', () => {
    const jsonl = assistantLine([
      { type: 'tool_use', name: 'Bash', input: { description: 'List files' } },
      { type: 'tool_use', name: 'mcp__iss__iss_query_tickets', input: {} },
      { type: 'text', text: 'Kész.' },
    ])
    const entries = parseThreadTimeline(jsonl)
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'action', text: 'Bash: List files' }),
      expect.objectContaining({ kind: 'action', text: 'iss_query_tickets' }),
      expect.objectContaining({ kind: 'assistant', text: 'Kész.' }),
    ])
  })

  it('tolerates malformed lines and applies the limit keeping the newest entries', () => {
    const lines = ['not-json', '{"type":"user"}']
    for (let i = 0; i < 10; i++) lines.push(userLine(`üzenet ${i}`))
    const entries = parseThreadTimeline(lines.join('\n'), 3)
    expect(entries.map(e => e.text)).toEqual(['üzenet 7', 'üzenet 8', 'üzenet 9'])
  })
})

describe('deriveThreadTitle', () => {
  it('uses the whole message when short', () => {
    expect(deriveThreadTitle('Heti riport összeállítása')).toBe('Heti riport összeállítása')
  })

  it('collapses whitespace and cuts long messages at a word boundary with ellipsis', () => {
    const title = deriveThreadTitle('Kérlek nézd át a   teljes\n szerződés-állományt és készíts részletes összefoglalót a lejáratokról ügyfelenként')
    expect(title.length).toBeLessThanOrEqual(61)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toContain('\n')
  })
})
