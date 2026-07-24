import { describe, expect, it, vi } from 'vitest'
import {
  buildCodexExecArgs,
  codexReplyPayload,
  codexTaskKey,
  dispatchCodexBatch,
  parseCodexSessionId,
  selectCodexBatch,
  type CodexSessionStore,
} from '../web/codex-exec-dispatcher.js'
import type { CodexInboxEnvelope } from '../web/codex-agent-inbox.js'

function envelope(
  id: string,
  from: string | null,
  ts: number,
  taskId: string | null = null,
): CodexInboxEnvelope {
  return { id, from, ts, taskId, content: `prompt-${id}`, sourceMessageId: Number(id) || null }
}

describe('codex-exec dispatcher', () => {
  it('sorts FIFO and enforces the hard per-tick cap', () => {
    const input = Array.from({ length: 8 }, (_, i) => envelope(String(i), 'mason', 100 - i))
    expect(selectCodexBatch(input, 3).map(item => item.id)).toEqual(['7', '6', '5'])
  })

  it('resumes per connected task, posts replies, and processes only the cap', async () => {
    const items = [
      envelope('1', 'mason', 1, 'task-a'),
      envelope('2', 'mason', 2, 'task-a'),
      envelope('3', 'system', 3, 'task-system'),
      envelope('4', 'sage', 4, 'task-b'),
      envelope('5', 'sage', 5, 'task-c'),
      envelope('6', 'sage', 6, 'beyond-cap'),
    ]
    const sessions: CodexSessionStore = { sessions: {} }
    const prior: Array<string | null> = []
    const replies: unknown[] = []
    const completed: string[] = []
    let seq = 0
    const result = await dispatchCodexBatch('sol', items, sessions, {
      run: vi.fn(async (_item, sessionId) => {
        prior.push(sessionId)
        return { reply: `answer-${++seq}`, sessionId: sessionId ?? `session-${seq}` }
      }),
      reply: vi.fn(async payload => { replies.push(payload) }),
      complete: vi.fn(async item => { completed.push(item.id) }),
    }, 5)

    expect(result).toEqual({ processed: 5, failed: 0 })
    expect(prior).toEqual([null, 'session-1', null, null, null])
    expect(completed).toEqual(['1', '2', '3', '4', '5'])
    expect(replies).toEqual([
      { from: 'sol', to: 'mason', content: 'answer-1', task_id: 'task-a' },
      { from: 'sol', to: 'mason', content: 'answer-2', task_id: 'task-a' },
      { from: 'sol', to: 'sage', content: 'answer-4', task_id: 'task-b' },
      { from: 'sol', to: 'sage', content: 'answer-5', task_id: 'task-c' },
    ])
  })

  it('isolates failures and leaves failed envelopes incomplete for retry', async () => {
    const completed: string[] = []
    const result = await dispatchCodexBatch('sol', [
      envelope('1', 'mason', 1),
      envelope('2', 'mason', 2),
    ], { sessions: {} }, {
      run: async item => {
        if (item.id === '1') throw new Error('boom')
        return { reply: 'ok', sessionId: 's2' }
      },
      reply: async () => {},
      complete: item => { completed.push(item.id) },
    })
    expect(result).toEqual({ processed: 1, failed: 1 })
    expect(completed).toEqual(['2'])
  })

  it('uses task ids for continuity and safe peer/event fallbacks', () => {
    expect(codexTaskKey(envelope('1', 'mason', 1, 'card-42'))).toBe('task:card-42')
    expect(codexTaskKey(envelope('1', 'mason', 1))).toBe('peer:mason')
    expect(codexTaskKey(envelope('evt', null, 1))).toBe('event:evt')
    expect(codexReplyPayload('sol', envelope('1', 'system', 1), 'x')).toBeNull()
  })

  it('passes effort and read-only sandbox to new and resumed Codex calls', () => {
    const fresh = buildCodexExecArgs({
      model: 'gpt-5.6-sol',
      effort: 'high',
      outputPath: '/tmp/out',
    })
    expect(fresh).toEqual([
      'exec', '--sandbox', 'read-only',
      '-m', 'gpt-5.6-sol',
      '-c', 'model_reasoning_effort=high',
      '--skip-git-repo-check',
      '--output-last-message', '/tmp/out',
      '--json',
      '-',
    ])

    const resume = buildCodexExecArgs({
      model: 'gpt-5.6-sol',
      effort: 'high',
      outputPath: '/tmp/out',
      sessionId: 'session-123',
    })
    expect(resume).toEqual([
      'exec', 'resume',
      '-c', 'sandbox_mode="read-only"',
      '-m', 'gpt-5.6-sol',
      '-c', 'model_reasoning_effort=high',
      '--skip-git-repo-check',
      '--output-last-message', '/tmp/out',
      '--json',
      'session-123',
      '-',
    ])
  })

  it('extracts the persisted session id from Codex JSONL', () => {
    expect(parseCodexSessionId('{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.completed"}')).toBe('abc')
    expect(parseCodexSessionId('not json\n')).toBeNull()
  })
})
