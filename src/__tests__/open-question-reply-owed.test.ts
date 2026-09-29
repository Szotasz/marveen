import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getDb, hasOpenInboundQuestion, openInboundQuestionMessageId } from '../db.js'
import { replyOwed } from '../reply-owed.js'

// REPLYOWED924: the restart gates read "is there an open question?" from the
// conversation ledger. An unaddressed GROUP message owes no reply, so it must
// not count -- otherwise it pins an open question forever.
let t = 1_000
function row(dir: 'in' | 'out', chat: string, text: string, mid: string | null = null, replyTo: string | null = null) {
  getDb().prepare(
    `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at, reply_to_message_id)
     VALUES ('marveen', ?, ?, ?, ?, '', ?, ?)`,
  ).run(chat, dir, mid, text, t++, replyTo)
}

// Hermetic alias config: the checkout's agents/ dir must not leak in.
let agentsDir = ''
const savedEnv = { dir: process.env.CHANNEL_SCOPE_AGENTS_DIR, names: process.env.TG_MENTION_NAMES }
beforeEach(() => {
  initDatabase(':memory:'); t = 1_000
  agentsDir = mkdtempSync(join(tmpdir(), 'replyowed-'))
  process.env.CHANNEL_SCOPE_AGENTS_DIR = agentsDir
  delete process.env.TG_MENTION_NAMES
})
afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true })
  if (savedEnv.dir === undefined) delete process.env.CHANNEL_SCOPE_AGENTS_DIR
  else process.env.CHANNEL_SCOPE_AGENTS_DIR = savedEnv.dir
  if (savedEnv.names === undefined) delete process.env.TG_MENTION_NAMES
  else process.env.TG_MENTION_NAMES = savedEnv.names
})

describe('replyOwed (twin of channel_scope.py)', () => {
  it('DM always, group only when named', () => {
    expect(replyOwed('111111111', 'szia', 'marveen')).toBe(true)
    expect(replyOwed('-100222222222', 'Anna, mehet a meeting', 'marveen')).toBe(false)
    expect(replyOwed('-100222222222', 'Marveen, nézd meg légyszi', 'marveen')).toBe(true)
    expect(replyOwed('-100222222222', '@marveenbot kész?', 'marveen')).toBe(true)
  })

  // Same cases as scripts/__tests__/channel-scope.test.py -- the twins must agree.
  it('accent-folded and inflection-tolerant, like the Python core', () => {
    const G = '-100222222222'
    expect(replyOwed(G, 'Zara, nézd meg', 'zara')).toBe(true)
    expect(replyOwed(G, 'Zárát kérem, nézd meg', 'zara')).toBe(true)
    expect(replyOwed(G, 'Írisz, segíts', 'iris')).toBe(true)
    expect(replyOwed(G, 'beszéltem Írisszel', 'iris')).toBe(true)
    expect(replyOwed(G, '@iris_helper_bot kész?', 'iris')).toBe(true)
    expect(replyOwed(G, 'irisztinakonyvtar', 'iris')).toBe(false)
    expect(replyOwed(G, 'bazara', 'zara')).toBe(false)
    expect(replyOwed(G, 'ok, mehet', 'zara', { repliesToAgent: true })).toBe(true)
    expect(replyOwed(G, 'ok, mehet', 'zara', { repliesToAgent: () => { throw new Error('x') } })).toBe(true)
    expect(replyOwed('111111111', 'x', 'zara', { repliesToAgent: () => { throw new Error('x') } })).toBe(true)
  })

  it('configured name forms: agent-config.json displayName/mentionNames and TG_MENTION_NAMES', () => {
    const G = '-100222222222'
    mkdirSync(join(agentsDir, 'kappa'))
    writeFileSync(join(agentsDir, 'kappa', 'agent-config.json'),
      JSON.stringify({ displayName: 'Front Desk', mentionNames: ['Kristóf'] }))
    expect(replyOwed(G, 'Kristofnak szólj', 'kappa')).toBe(true)
    expect(replyOwed(G, 'front  desk, help', 'kappa')).toBe(true)
    expect(replyOwed(G, 'Kristóf, szia', 'zara')).toBe(false)
    process.env.TG_MENTION_NAMES = 'Zarabot, Z-Bot'
    expect(replyOwed(G, 'z-bot?', 'zara')).toBe(true)
  })
})

describe('open question ignores unaddressed group messages', () => {
  it('a lone group message is not an open question', () => {
    row('in', '-100222222222', 'okés', '10')
    expect(hasOpenInboundQuestion('marveen')).toBe(false)
    expect(openInboundQuestionMessageId('marveen')).toBeNull()
  })
  it('an unanswered DM stays open even when a group message came after it', () => {
    row('in', '111111111', 'Mikor jön a szállítás?', '11')
    row('in', '-100222222222', 'Anna, mehet a meeting', '12')
    expect(hasOpenInboundQuestion('marveen')).toBe(true)
    expect(openInboundQuestionMessageId('marveen')).toBe('11')
  })
  it('an answered DM is closed; a later group chatter does not reopen it', () => {
    row('in', '111111111', 'Mikor jön a szállítás?', '13')
    row('out', '111111111', 'Holnap.')
    row('in', '-100222222222', 'okés', '14')
    expect(hasOpenInboundQuestion('marveen')).toBe(false)
  })
  it('a group reply to one of the agent\'s own messages is an open question', () => {
    row('out', '-100222222222', 'Kész a lista.', '500')
    row('in', '-100222222222', 'és a másik mikor lesz?', '16', '500')
    expect(openInboundQuestionMessageId('marveen')).toBe('16')
  })
  it('a group reply to someone else\'s message is not', () => {
    row('out', '-100222222222', 'Kész a lista.', '500')
    row('in', '-100222222222', 'és a másik mikor lesz?', '17', '499')
    expect(hasOpenInboundQuestion('marveen')).toBe(false)
  })
  it('a group message that names the agent is still an open question', () => {
    row('in', '-100222222222', 'Marveen, küldd át a számlát', '15')
    expect(hasOpenInboundQuestion('marveen')).toBe(true)
  })
})
