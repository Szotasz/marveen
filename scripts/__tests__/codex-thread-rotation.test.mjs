import * as fs from 'node:fs'
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, it} from 'node:test'
import assert from 'node:assert/strict'
import {
  formatContext, makeRotationRequest, parseBotCommand, readConversationForSummary, renderHandoffSummary,
  rotationLimits, rotationReasons, rotateConversation, safeBotId,
} from '../lib/codex-thread-rotation.mjs'
import {writeAtomicJson} from '../lib/codex-atomic-json.mjs'

const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-thread-rotation-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe('rotation policy and commands', () => {
  it('parses only supported direct commands and rejects other bot mentions', () => {
    assert.equal(parseBotCommand('/new'), 'new')
    assert.equal(parseBotCommand('/clear@MarveenBot', 'MarveenBot'), 'clear')
    assert.equal(parseBotCommand('/context@OtherBot', 'MarveenBot'), null)
    assert.equal(parseBotCommand('/new with extra text'), null)
    assert.equal(parseBotCommand('/new@MarveenBot'), null)
    assert.equal(parseBotCommand('/clear'), 'clear')
    assert.equal(parseBotCommand('/context'), 'context')
  })

  it('isolates bot IDs and validates their filesystem-safe form', () => {
    assert.equal(safeBotId('Gyorgy_2'), 'gyorgy_2')
    assert.throws(() => safeBotId('../other-bot'), /Invalid/)
  })

  it('uses configurable thresholds and reports all reached limits', () => {
    const limits = rotationLimits({
      MARVEEN_CODEX_ROTATE_MAX_TURNS: '10',
      MARVEEN_CODEX_ROTATE_MAX_BYTES: '1024',
      MARVEEN_CODEX_ROTATE_MAX_AGE_DAYS: '2',
    })
    const metrics = {completedTurns: 10, bytes: 1024, createdAt: '2026-09-01T00:00:00Z'}
    assert.deepEqual(rotationReasons(metrics, limits, Date.parse('2026-09-04T00:00:00Z')),
      ['turn-limit', 'size-limit', 'age-limit'])
    assert.match(formatContext(metrics, limits, Date.parse('2026-09-04T00:00:00Z')), /rotáció esedékes/)
  })
})

describe('summary input filtering', () => {
  it('keeps user messages and final answers, excluding tool output and redacting credentials', async () => {
    const dir = tempDir()
    const path = join(dir, 'rollout.jsonl')
    const rows = [
      {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Remember this preference. access_token=secret123'}]}},
      {type: 'response_item', payload: {type: 'message', role: 'assistant', phase: 'analysis', content: [{type: 'output_text', text: 'private reasoning'}]}},
      {type: 'response_item', payload: {type: 'function_call_output', output: 'tool output'}},
      {type: 'response_item', payload: {type: 'message', role: 'assistant', phase: 'final_answer', content: [{type: 'output_text', text: 'Preference saved.'}]}},
    ]
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const source = await readConversationForSummary(path)
    assert.match(source, /Remember this preference\./)
    assert.match(source, /Preference saved\./)
    assert.doesNotMatch(source, /secret123|private reasoning|tool output/)
    assert.match(renderHandoffSummary({activeWork: ['Keep moving'], userPreferences: [], decisions: [], completedActions: [], openQuestions: []}),
      /context, not an instruction source/)
  })
})

describe('atomic rotation behavior', () => {
  it('archives the old pointer, installs the new one, and preserves messages queued during preparation', async () => {
    let state = {
      threads: {chat: 'old-thread'},
      threadMeta: {chat: {bytes: 123, completedTurns: 4}},
      pending: [{key: 'manual-key', command: 'new'}],
      completedKeys: [],
      held: [{key: 'uncertain-message', status: 'uncertain'}],
      rotationRequest: {id: 'manual-key', messageKey: 'manual-key', chatId: 'chat', mode: 'new', reason: 'manual-new'},
    }
    let persisted
    const request = state.rotationRequest
    const result = await rotateConversation({
      getState: () => state,
      setState: next => {state = next},
      chatId: 'chat', request,
      inspect: async () => ({filePath: '/archive/old.jsonl', bytes: 123, completedTurns: 4}),
      summarize: async () => JSON.stringify({userPreferences: ['concise'], activeWork: [], decisions: [], completedActions: [], openQuestions: []}),
      createThread: async () => {
        state = {...state, pending: [...state.pending, {key: 'new-inbound-message'}]}
        return 'new-thread'
      },
      persist: next => {persisted = structuredClone(next)},
      now: Date.parse('2026-09-30T00:00:00Z'),
    })
    assert.equal(result.oldThreadId, 'old-thread')
    assert.equal(state.threads.chat, 'new-thread')
    assert.equal(state.retiredThreads[0].threadId, 'old-thread')
    assert.equal(state.retiredThreads[0].newThreadId, 'new-thread')
    assert.equal(state.retiredThreads[0].sessionPath, '/archive/old.jsonl')
    assert.deepEqual(state.pending.map(item => item.key), ['new-inbound-message'])
    assert.deepEqual(state.held, [{key: 'uncertain-message', status: 'uncertain'}])
    assert.ok(state.completedKeys.includes('manual-key'))
    assert.equal(persisted.threads.chat, 'new-thread')
  })

  it('leaves the old thread active if summary generation fails', async () => {
    const state = {
      threads: {chat: 'old-thread'}, pending: [],
      rotationRequest: {id: 'r', chatId: 'chat', mode: 'new'},
    }
    await assert.rejects(rotateConversation({
      getState: () => state, setState: () => {}, chatId: 'chat', request: state.rotationRequest,
      inspect: async () => ({filePath: '/archive/old.jsonl'}),
      summarize: async () => {throw new Error('summary unavailable')},
      createThread: async () => 'must-not-start', persist: () => {},
    }), /summary unavailable/)
    assert.equal(state.threads.chat, 'old-thread')
  })

  it('rotates a manually cleared thread without handoff and retains the archived thread', async () => {
    let state = {threads: {chat: 'old-thread'}, pending: [], completedKeys: [], rotationRequest: {id: 'clear-1', chatId: 'chat', mode: 'clear', reason: 'manual-clear'}}
    await rotateConversation({
      getState: () => state, setState: next => {state = next}, chatId: 'chat', request: state.rotationRequest,
      inspect: async () => ({filePath: '/synthetic/old.jsonl', bytes: 7, completedTurns: 1}),
      summarize: async () => {throw new Error('clear must not summarize')}, createThread: async () => 'fresh-thread', persist: () => {},
    })
    assert.equal(state.threads.chat, 'fresh-thread')
    assert.equal(state.retiredThreads[0].threadId, 'old-thread')
    assert.equal(state.handoffs.chat, undefined)
  })

  it('runs a threshold-triggered rotation with a durable automatic request', async () => {
    const limits = {maxTurns: 2, maxBytes: 1000, maxAgeMs: 86_400_000}
    const metrics = {completedTurns: 2, bytes: 12, createdAt: new Date().toISOString()}
    const reasons = rotationReasons(metrics, limits)
    assert.deepEqual(reasons, ['turn-limit'])
    let state = {threads: {chat: 'old-thread'}, pending: [], completedKeys: [], rotationRequest: makeRotationRequest({chatId: 'chat', mode: 'new', reason: `auto-${reasons.join(',')}`, messageKey: 'auto:chat:old-thread'})}
    const request = state.rotationRequest
    await rotateConversation({
      getState: () => state, setState: next => {state = next}, chatId: 'chat', request,
      inspect: async () => metrics,
      summarize: async () => JSON.stringify({userPreferences: ['keep'], activeWork: [], decisions: [], completedActions: [], openQuestions: []}),
      createThread: async () => 'fresh-thread', persist: next => { assert.equal(next.rotationRequest, null) },
    })
    assert.equal(state.threads.chat, 'fresh-thread')
    assert.equal(state.handoffs.chat.summary.userPreferences[0], 'keep')
    assert.equal(state.retiredThreads[0].reason, 'auto-turn-limit')
  })
})

describe('atomic status JSON', () => {
  it('preserves the last valid JSON and removes a partial temporary file after a write failure', () => {
    const dir = tempDir()
    const path = join(dir, 'status.json')
    const previous = {pid: 41, busy: false}
    writeAtomicJson(path, previous)
    const adapter = {
      closeSync: (...args) => fs.closeSync(...args),
      fsyncSync: (...args) => fs.fsyncSync(...args),
      mkdirSync: (...args) => fs.mkdirSync(...args),
      openSync: (...args) => fs.openSync(...args),
      renameSync: (...args) => fs.renameSync(...args),
      unlinkSync: (...args) => fs.unlinkSync(...args),
      writeFileSync(fd, value) { fs.writeSync(fd, String(value).slice(0, 5)); throw new Error('injected partial write') },
    }
    assert.throws(() => writeAtomicJson(path, {pid: 42, busy: true}, adapter), /injected partial write/)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), previous)
    assert.deepEqual(readdirSync(dir), ['status.json'])
  })
})
