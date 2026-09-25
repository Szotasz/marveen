import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb, hasOpenInboundQuestion, openInboundQuestionMessageId } from '../db.js'
import { replyOwed } from '../reply-owed.js'

// REPLYOWED924: the restart gates read "is there an open question?" from the
// conversation ledger. An unaddressed GROUP message owes no reply, so it must
// not count -- otherwise it pins an open question forever.
let t = 1_000
function row(dir: 'in' | 'out', chat: string, text: string, mid: string | null = null) {
  getDb().prepare(
    `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
     VALUES ('marveen', ?, ?, ?, ?, '', ?)`,
  ).run(chat, dir, mid, text, t++)
}

beforeEach(() => { initDatabase(':memory:'); t = 1_000 })

describe('replyOwed (twin of channel_scope.py)', () => {
  it('DM always, group only when named', () => {
    expect(replyOwed('111111111', 'szia', 'marveen')).toBe(true)
    expect(replyOwed('-100222222222', 'Anna, mehet a meeting', 'marveen')).toBe(false)
    expect(replyOwed('-100222222222', 'Marveen, nézd meg légyszi', 'marveen')).toBe(true)
    expect(replyOwed('-100222222222', '@marveenbot kész?', 'marveen')).toBe(true)
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
  it('a group message that names the agent is still an open question', () => {
    row('in', '-100222222222', 'Marveen, küldd át a számlát', '15')
    expect(hasOpenInboundQuestion('marveen')).toBe(true)
  })
})
