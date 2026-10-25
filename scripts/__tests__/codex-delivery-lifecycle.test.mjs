import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCodexChannelState, migrateLegacyPending } from '../lib/codex-channel-state.mjs'

test('old channel queue entries and failure evidence survive normalization', () => {
  const previous = {
    threads: { 'synthetic-chat-legacy': 'thread-1' },
    pending: [{ key: 'synthetic-chat-legacy:358', params: { meta: { chat_id: 'synthetic-chat-legacy' }, content: 'old message' } }],
    lastFailure: { error: 'previous error' },
  }
  const restored = normalizeCodexChannelState(previous)
  assert.deepEqual(restored.pending, previous.pending)
  assert.deepEqual(restored.threads, previous.threads)
  assert.deepEqual(restored.lastFailure, previous.lastFailure)
})

test('a legacy state without queue fields can still start', () => {
  assert.deepEqual(normalizeCodexChannelState({ threads: {} }).pending, [])
  assert.deepEqual(normalizeCodexChannelState(null), { threads: {}, pending: [] })
})


test('failed destination commit keeps the original queue', () => {
  const item={key:'synthetic-message',params:{meta:{chat_id:'synthetic-chat'},content:'synthetic'}}
  const state={pending:[item]};let saved=false
  assert.throws(()=>migrateLegacyPending(state,{prepareChannel(){throw Error('synthetic commit failure')}},()=>{saved=true}))
  assert.equal(saved,false);assert.equal(state.pending[0],item)
})
test('crash after commit before JSON save is repeatable, without losing evidence', () => {
  const item={key:'synthetic-message',params:{meta:{chat_id:'synthetic-chat'},content:'synthetic'}}
  const state={pending:[item]},records=new Map()
  const recovery={prepareChannel(item,safe){if(!records.has(item.key))records.set(item.key,{safe})}}
  assert.throws(()=>migrateLegacyPending(state,recovery,()=>{throw Error('synthetic crash')}))
  assert.equal(state.pending.length,1);assert.equal(records.size,1)
  migrateLegacyPending(state,recovery,()=>{})
  assert.equal(state.pending.length,0);assert.equal(records.size,1);assert.equal(records.get(item.key).safe,false)
})
test('only explicit versioned unstarted evidence can preserve queued status', () => {
  const seen=[]
  const state={pending:[{queueVersion:2,status:'queued',attemptCount:0,startedAt:null},{status:'queued'},{queueVersion:2,status:'running',attemptCount:1}]}
  migrateLegacyPending(state,{prepareChannel(item,safe){seen.push(safe)}},()=>{})
  assert.deepEqual(seen,[true,false,false])
})
