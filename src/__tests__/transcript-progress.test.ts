// ROUTERSTUCK1012: what the router counts as progress in an agent's transcript,
// and that it reads only the tail of the newest session (plus that session's
// sub-agents). The entry shapes are the ones measured in a live sub-agent
// transcript on 2026-10-12 (type / isMeta / isCompactSummary / timestamp).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastProgressAtFromTail, readTranscriptProgressAt, TRANSCRIPT_TAIL_BYTES } from '../web/transcript-progress.js'

const T = (iso: string) => Date.parse(iso)
const line = (o: Record<string, unknown>) => JSON.stringify(o)

const assistant = (ts: string) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } })
const toolResult = (ts: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })
const prompt = (ts: string, text: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const compactSummary = (ts: string) => line({
  type: 'user', timestamp: ts, isCompactSummary: true, isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' },
})
const meta = (ts: string) => line({ type: 'user', timestamp: ts, isMeta: true, message: { role: 'user', content: 'caveat' } })
const queued = (ts: string) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: '[Uzenet @samu-tol]: ...' })
const attachment = (ts: string) => line({ type: 'attachment', timestamp: ts, attachment: { type: 'x' } })
const boundary = (ts: string) => line({ type: 'system', subtype: 'compact_boundary', timestamp: ts, content: 'Conversation compacted' })
const turnDuration = (ts: string) => line({ type: 'system', subtype: 'turn_duration', timestamp: ts, durationMs: 1 })

describe('lastProgressAtFromTail: what counts as progress', () => {
  it('assistant output, a tool result and a taken prompt count; the newest wins', () => {
    const text = [assistant('2026-10-12T08:00:00Z'), toolResult('2026-10-12T08:01:00Z'), assistant('2026-10-12T08:02:00Z')].join('\n')
    expect(lastProgressAtFromTail(text, false)).toBe(T('2026-10-12T08:02:00Z'))
  })

  it('a "<"-prefixed prompt (task-notification, channel line) the session took counts', () => {
    const text = [assistant('2026-10-12T08:00:00Z'), prompt('2026-10-12T08:05:00Z', '<task-notification>done</task-notification>')].join('\n')
    expect(lastProgressAtFromTail(text, false)).toBe(T('2026-10-12T08:05:00Z'))
  })

  it('the compaction summary is NOT progress on its own: the entry before it decides', () => {
    const text = [assistant('2026-10-12T08:00:00Z'), boundary('2026-10-12T08:30:00Z'), compactSummary('2026-10-12T08:30:01Z')].join('\n')
    expect(lastProgressAtFromTail(text, false)).toBe(T('2026-10-12T08:00:00Z'))
  })

  it('mail queued for a busy session, attachments, meta lines and system lines are not progress', () => {
    const text = [
      assistant('2026-10-12T08:00:00Z'),
      queued('2026-10-12T08:20:00Z'), attachment('2026-10-12T08:21:00Z'), meta('2026-10-12T08:22:00Z'), turnDuration('2026-10-12T08:23:00Z'),
    ].join('\n')
    expect(lastProgressAtFromTail(text, false)).toBe(T('2026-10-12T08:00:00Z'))
  })

  it('a JSON line that is not an object (null, a number, a string, an array) is skipped, not fatal', () => {
    const text = ['null', '5', '"x"', '[]', assistant('2026-10-12T08:00:00Z'), 'null'].join('\n')
    expect(lastProgressAtFromTail(text, false)).toBe(T('2026-10-12T08:00:00Z'))
  })

  it('nothing that counts: null', () => {
    expect(lastProgressAtFromTail([queued('2026-10-12T08:20:00Z'), compactSummary('2026-10-12T08:30:00Z')].join('\n'), false)).toBeNull()
    expect(lastProgressAtFromTail('', false)).toBeNull()
  })

  it('a cut first line is dropped, garbage and entries without a usable timestamp are skipped', () => {
    const cut = assistant('2026-10-12T09:00:00Z').slice(20) // the tail began mid-entry
    const text = [cut, 'not json', line({ type: 'assistant' }), line({ type: 'assistant', timestamp: 'never' }), assistant('2026-10-12T08:10:00Z')].join('\n')
    expect(lastProgressAtFromTail(text, true)).toBe(T('2026-10-12T08:10:00Z'))
    // The same text read from the start of the file keeps its first line (here unparseable anyway).
    expect(lastProgressAtFromTail(assistant('2026-10-12T09:00:00Z'), false)).toBe(T('2026-10-12T09:00:00Z'))
  })
})

describe('readTranscriptProgressAt: the newest session, its sub-agents, the tail only', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tprog-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (rel: string, lines: string[], mtimeIso: string) => {
    const f = join(dir, rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, lines.join('\n') + '\n')
    const t = new Date(mtimeIso)
    utimesSync(f, t, t)
  }

  it('a missing or empty project dir is null (the router then keeps today\'s rule)', async () => {
    expect(await readTranscriptProgressAt(join(dir, 'nope'))).toBeNull()
    expect(await readTranscriptProgressAt(dir)).toBeNull()
  })

  it('reads the newest session file by mtime, not an older session', async () => {
    write('old.jsonl', [assistant('2026-10-12T07:00:00Z')], '2026-10-12T07:00:00Z')
    write('new.jsonl', [assistant('2026-10-12T08:00:00Z')], '2026-10-12T08:00:00Z')
    expect(await readTranscriptProgressAt(dir)).toBe(T('2026-10-12T08:00:00Z'))
  })

  it('a main thread waiting on a Task: the session\'s own sub-agent file carries the progress', async () => {
    write('sess.jsonl', [assistant('2026-10-12T08:00:00Z')], '2026-10-12T08:00:00Z')
    write('sess/subagents/agent-a.jsonl', [assistant('2026-10-12T08:40:00Z')], '2026-10-12T08:40:00Z')
    // Another (older) session's sub-agent is not this session's work.
    write('other.jsonl', [assistant('2026-10-12T06:00:00Z')], '2026-10-12T06:00:00Z')
    write('other/subagents/agent-b.jsonl', [assistant('2026-10-12T08:50:00Z')], '2026-10-12T06:00:00Z')
    expect(await readTranscriptProgressAt(dir)).toBe(T('2026-10-12T08:40:00Z'))
  })

  it('only the tail is read: an entry before the last TRANSCRIPT_TAIL_BYTES is not seen', async () => {
    const pad = line({ type: 'system', subtype: 'informational', content: 'x'.repeat(1000) })
    const filler = Array.from({ length: Math.ceil((TRANSCRIPT_TAIL_BYTES * 2) / pad.length) }, () => pad)
    // The only progress entry sits at the very start, far outside the tail.
    write('sess.jsonl', [assistant('2026-10-12T08:00:00Z'), ...filler], '2026-10-12T08:59:00Z')
    expect(await readTranscriptProgressAt(dir)).toBeNull()
    // Positive control: the same entry inside the tail is found.
    write('sess.jsonl', [...filler, assistant('2026-10-12T08:00:00Z')], '2026-10-12T08:59:00Z')
    expect(await readTranscriptProgressAt(dir)).toBe(T('2026-10-12T08:00:00Z'))
  })
})
