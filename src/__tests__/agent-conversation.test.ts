import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  getAgentConversation,
  getAgentConversationThreads,
} from '../db.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  // In-memory DB so the test is idempotent and never touches store/claudeclaw.db.
  initDatabase(':memory:')
})

// Dashboard messages bug (2026-06-03): the old GET /api/messages?agent=X path
// fetched the GLOBAL last-N then JS-filtered, so a rarely-active agent's thread
// looked empty. These cover the SQL-filtered replacement + threads aggregation.
describe('getAgentConversation', () => {
  it('returns ONLY this agent\'s messages, newest-first', () => {
    const a = 'tconv-alpha'
    createAgentMessage(a, 'marveen', 'a1')
    createAgentMessage('marveen', a, 'a2')
    createAgentMessage('someone-else', 'third', 'noise') // must not leak in
    const conv = getAgentConversation(a, 50)
    expect(conv.length).toBe(2)
    expect(conv.every(m => m.from_agent === a || m.to_agent === a)).toBe(true)
    // newest-first: a2 (later id) before a1
    expect(conv[0].content).toBe('a2')
    expect(conv[1].content).toBe('a1')
  })

  it('respects the limit', () => {
    const a = 'tconv-limit'
    for (let i = 0; i < 5; i++) createAgentMessage(a, 'marveen', `m${i}`)
    expect(getAgentConversation(a, 3).length).toBe(3)
  })

  it('caps the limit at 200 and floors it at 1', () => {
    const a = 'tconv-cap'
    createAgentMessage(a, 'marveen', 'x')
    expect(getAgentConversation(a, 99999).length).toBeLessThanOrEqual(200)
    expect(getAgentConversation(a, 0).length).toBe(1) // floored to >=1, one row exists
  })

  it('paginates older with beforeId (scroll-up)', () => {
    const a = 'tconv-page'
    const ids: number[] = []
    for (let i = 0; i < 6; i++) ids.push(createAgentMessage(a, 'marveen', `p${i}`).id)
    // newest-first page of 3 -> the 3 highest ids
    const page1 = getAgentConversation(a, 3)
    expect(page1.map(m => m.id)).toEqual([ids[5], ids[4], ids[3]])
    // next older page: before the oldest id we have (ids[3])
    const page2 = getAgentConversation(a, 3, ids[3])
    expect(page2.map(m => m.id)).toEqual([ids[2], ids[1], ids[0]])
    // no overlap between pages
    expect(page2.every(m => m.id < ids[3])).toBe(true)
  })
})

describe('getAgentConversationThreads', () => {
  it('lists a peer with its count + most-recent message', () => {
    const a = 'tthread-peer'
    createAgentMessage(a, 'marveen', 't1')
    createAgentMessage('marveen', a, 't2')
    const last = createAgentMessage(a, 'marveen', 't3-last')
    const threads = getAgentConversationThreads()
    const row = threads.find(t => t.agent === a)
    expect(row).toBeDefined()
    expect(row!.count).toBe(3)
    expect(row!.lastMessage?.id).toBe(last.id)
    expect(row!.lastMessage?.content).toBe('t3-last')
  })

  it('excludes CHAT_SYSTEM_AGENTS as thread rows but still counts their messages for the peer', () => {
    const a = 'tthread-withsys'
    createAgentMessage('heartbeat', a, 'hb-to-peer')
    createAgentMessage(a, 'channel-coordinator', 'peer-to-coord')
    const threads = getAgentConversationThreads()
    const agents = threads.map(t => t.agent)
    // system agents never appear as their own thread row
    expect(agents).not.toContain('heartbeat')
    expect(agents).not.toContain('channel-coordinator')
    expect(agents).not.toContain('telegram-coordinator')
    expect(agents).not.toContain('system')
    // but the peer's count includes the messages exchanged with system agents
    const row = threads.find(t => t.agent === a)
    expect(row?.count).toBe(2)
  })

  it('is sorted newest-first by last message', () => {
    const older = 'tthread-older'
    const newer = 'tthread-newer'
    createAgentMessage(older, 'marveen', 'old')
    createAgentMessage(newer, 'marveen', 'new')
    const threads = getAgentConversationThreads()
    const iOlder = threads.findIndex(t => t.agent === older)
    const iNewer = threads.findIndex(t => t.agent === newer)
    expect(iNewer).toBeGreaterThanOrEqual(0)
    expect(iOlder).toBeGreaterThan(iNewer) // newer peer appears before older
  })
})
