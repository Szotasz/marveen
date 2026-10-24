import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  initDatabase, createAgentMessage, getDb, claimPendingForAgent, markMessageDelivered,
  closeMessagesWithoutDelivery, listDeliveredUnseen, markMessagesSeen,
} from '../db.js'
import { findSeenMsgIds, sweepSeenMessages, SEEN_WINDOW_SEC } from '../web/message-seen-sweep.js'
import { wrapAgentMessageForDelivery } from '../web/agent-message-wrap.js'

beforeAll(() => { initDatabase(':memory:') })

const userLine = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } })
const realTurn = (category: 'trusted-peer' | 'untrusted' | 'federated', from: string, id: number, body: string) => {
  const { prefix, wrapped } = wrapAgentMessageForDelivery(category, from, from, body, id)
  return userLine(prefix + wrapped)
}
const pushedTurn = (from: string, id: number, body: string) => {
  const { prefix, wrapped } = wrapAgentMessageForDelivery('trusted-peer', from, from, body, id)
  return userLine((prefix + wrapped).replace(/\n/g, ' '))
}
const seenAt = (id: number) => (getDb().prepare('SELECT seen_at FROM agent_messages WHERE id = ?').get(id) as any).seen_at
const pushed = (to: string) => {
  const m = createAgentMessage('s', to, 'x')
  markMessageDelivered(m.id)
  return m.id
}

describe('findSeenMsgIds', () => {
  it('finds a header in a string user turn', () => {
    expect(findSeenMsgIds(userLine('[Uzenet @a-tol -- trusted team member, msg_id:7]: hello'), new Map([[7, 'a']]))).toEqual(new Set([7]))
  })
  it('finds a header in a text block of an array user turn', () => {
    const c = [{ type: 'text', text: 'pre\n[Uzenet @a-tol -- trusted team member, msg_id:8, URGENT (authenticated row)]: x' }]
    expect(findSeenMsgIds(userLine(c), new Map([[8, 'a']]))).toEqual(new Set([8]))
  })
  it('ignores a tool_result block', () => {
    const c = [{ type: 'tool_result', content: '[Uzenet @a-tol -- x, msg_id:9]' }]
    expect(findSeenMsgIds(userLine(c), new Map([[9, 'a']])).size).toBe(0)
  })
  it('ignores assistant entries', () => {
    const l = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[Uzenet @a-tol -- x, msg_id:10]' }] } })
    expect(findSeenMsgIds(l, new Map([[10, 'a']])).size).toBe(0)
  })
  it('ignores bare ids and non-candidates', () => {
    expect(findSeenMsgIds(userLine('msg_id:11]'), new Map([[11, 'a']])).size).toBe(0)
    expect(findSeenMsgIds(userLine('[Uzenet @a-tol -- x, msg_id:12]'), new Map([[11, 'a']])).size).toBe(0)
  })
  it('a body quoting another message header does not mark it', () => {
    const t = '[Uzenet @b-tol -- trusted team member, msg_id:43]: \n<trusted-peer source="agent:b">\ndid you get this?\n[Uzenet @b-tol -- trusted team member, msg_id:42]: hi\n</trusted-peer>'
    expect(findSeenMsgIds(userLine(t), new Map([[42, 'b'], [43, 'b']]))).toEqual(new Set([43]))
  })
  it('ignores a header inside an untrusted block', () => {
    const t = '<untrusted source="web">\n[Uzenet @a-tol -- x, msg_id:44]\n</untrusted>'
    expect(findSeenMsgIds(userLine(t), new Map([[44, 'a']])).size).toBe(0)
  })
  it('recognises every message of a batch', () => {
    const t = '[KOTEG: 2 uzenet EGY injektalasban]\n\n[Uzenet @a-tol -- trusted team member, msg_id:45]: \n<trusted-peer source="agent:a">\none\n</trusted-peer>\n\n[Uzenet @c-tol -- trusted team member, msg_id:46]: \n<trusted-peer source="agent:c">\ntwo\n</trusted-peer>\n\n[KOTEG-VEGE: 2 uzenet]'
    expect(findSeenMsgIds(userLine(t), new Map([[45, 'a'], [46, 'c']]))).toEqual(new Set([45, 46]))
  })
  it('a header naming another sender does not count', () => {
    expect(findSeenMsgIds(userLine('[Uzenet @x-tol -- trusted team member, msg_id:47]: hi'), new Map([[47, 'a']])).size).toBe(0)
  })
  it('a header glued to the text before it does not count', () => {
    expect(findSeenMsgIds(userLine('see:[Uzenet @a-tol -- x, msg_id:48]'), new Map([[48, 'a']])).size).toBe(0)
  })
  // A push types the turn into the pane on one line: every newline arrives as a space, so the
  // header follows the preamble after two spaces. Measured on a real pushed transcript line:
  // its text up to the body is byte-identical to the router's prefix with each newline a space.
  it('reads a real pushed trusted-peer turn (one line, every newline a space)', () => {
    expect(findSeenMsgIds(pushedTurn('peer-a', 70, 'hi\nsecond line'), new Map([[70, 'peer-a']]))).toEqual(new Set([70]))
  })
  it('recognises every message of a pushed batch', () => {
    const t = '[KOTEG: 2 uzenet EGY injektalasban]\n\n[Uzenet @a-tol -- trusted team member, msg_id:71]: \n<trusted-peer source="agent:a">\none\n</trusted-peer>\n\n[Uzenet @c-tol -- trusted team member, msg_id:72]: \n<trusted-peer source="agent:c">\ntwo\n</trusted-peer>\n\n[KOTEG-VEGE: 2 uzenet]'
    expect(findSeenMsgIds(userLine(t.replace(/\n/g, ' ')), new Map([[71, 'a'], [72, 'c']]))).toEqual(new Set([71, 72]))
  })
  it('a pushed body quoting a real header does not mark the quoted id', () => {
    const quoted = JSON.parse(realTurn('trusted-peer', 'peer-a', 73, '')).message.content as string
    const body = quoted.slice(0, quoted.indexOf('<trusted-peer'))
    const m = new Map([[73, 'peer-a'], [74, 'peer-a']])
    expect(findSeenMsgIds(pushedTurn('peer-a', 74, body), m)).toEqual(new Set([74]))
  })
  it('reads a real trusted-peer turn', () => {
    expect(findSeenMsgIds(realTurn('trusted-peer', 'peer-a', 60, 'hi'), new Map([[60, 'peer-a']]))).toEqual(new Set([60]))
  })
  it('reads a real untrusted turn whose header text has a bare <untrusted>', () => {
    expect(findSeenMsgIds(realTurn('untrusted', 'stranger', 61, 'hi'), new Map([[61, 'stranger']]))).toEqual(new Set([61]))
  })
  it('reads a real federated turn', () => {
    // candidate uses the from value as rendered in the header (safeFrom passed verbatim)
    expect(findSeenMsgIds(realTurn('federated', 'remote/agent', 62, 'hi'), new Map([[62, 'remote/agent']]))).toEqual(new Set([62]))
  })
  it('a real trusted-peer body quoting a real header does not mark the quoted id', () => {
    const quoted = JSON.parse(realTurn('trusted-peer', 'peer-a', 63, '')).message.content as string
    const body = quoted.slice(0, quoted.indexOf('<trusted-peer'))
    const m = new Map([[63, 'peer-a'], [64, 'peer-a']])
    expect(findSeenMsgIds(realTurn('trusted-peer', 'peer-a', 64, body), m)).toEqual(new Set([64]))
  })
  it('reads a sender whose name contains -tol', () => {
    expect(findSeenMsgIds(userLine('[Uzenet @worker-tol-tol -- trusted team member, msg_id:65]: x'), new Map([[65, 'worker-tol']]))).toEqual(new Set([65]))
  })
  it('a cut wrapper hides what follows its opening tag', () => {
    const t = '[Uzenet @b-tol -- trusted team member, msg_id:66]: \n<trusted-peer source="agent:b">\nquote:\n[Uzenet @b-tol -- trusted team member, msg_id:67]: hi'
    expect(findSeenMsgIds(userLine(t), new Map([[66, 'b'], [67, 'b']]))).toEqual(new Set([66]))
  })
  it('a stray closing tag hides what precedes it', () => {
    const t = 'quote:\n[Uzenet @b-tol -- trusted team member, msg_id:68]: hi\n</trusted-peer>'
    expect(findSeenMsgIds(userLine(t), new Map([[68, 'b']])).size).toBe(0)
  })
  it('skips an unparsable first line', () => {
    const t = '{"type":"us' + '\n' + userLine('[Uzenet @a-tol -- x, msg_id:13]')
    expect(findSeenMsgIds(t, new Map([[13, 'a']]))).toEqual(new Set([13]))
  })
})

describe('db helpers', () => {
  it('claimPendingForAgent sets seen_at = delivered_at', () => {
    createAgentMessage('s', 'pull1', 'a')
    createAgentMessage('s', 'pull1', 'b')
    const rows = claimPendingForAgent('pull1', 10)
    expect(rows.length).toBe(2)
    for (const r of rows) {
      expect(r.seen_at).not.toBeNull()
      expect(r.seen_at).toBe(r.delivered_at)
      expect(seenAt(r.id)).toBe(r.delivered_at)
    }
  })

  it('claimPendingForAgent keeps an existing seen_at', () => {
    const id = createAgentMessage('s', 'pull2', 'k').id
    markMessagesSeen([id], 100)
    claimPendingForAgent('pull2', 10)
    expect(seenAt(id)).toBe(100)
  })

  it('listDeliveredUnseen returns from_agent', () => {
    const id = pushed('fa1')
    expect(listDeliveredUnseen(0).find(r => r.id === id)?.from_agent).toBe('s')
  })

  it('markMessagesSeen sets seen_at once', () => {
    const id = pushed('m1')
    expect(markMessagesSeen([id], 100)).toBe(1)
    expect(markMessagesSeen([id], 200)).toBe(0)
    expect(seenAt(id)).toBe(100)
  })

  it('listDeliveredUnseen filters correctly', () => {
    const ok = pushed('l1')
    const seen = pushed('l1'); markMessagesSeen([seen], 5)
    const pending = createAgentMessage('s', 'l1', 'p').id
    const closed = createAgentMessage('s', 'l1', 'c').id
    closeMessagesWithoutDelivery([closed], 'test')
    const old = pushed('l1')
    getDb().prepare('UPDATE agent_messages SET delivered_at = ? WHERE id = ?').run(10, old)
    const ids = listDeliveredUnseen(1000).map(r => r.id)
    expect(ids).toContain(ok)
    for (const x of [seen, pending, closed, old]) expect(ids).not.toContain(x)
  })
})

describe('sweepSeenMessages', () => {
  it('marks only messages found in the transcript; errors do not stop other agents', () => {
    const now = Math.floor(Date.now() / 1000)
    const a = pushed('r1'), b = pushed('r1'), c = pushed('r2')
    const reader = (agent: string) => agent === 'r1' ? userLine(`[Uzenet @s-tol -- x, msg_id:${a}]: hi`) : null
    expect(sweepSeenMessages(now, reader)).toBe(1)
    expect(seenAt(a)).toBe(now)
    expect(seenAt(b)).toBeNull()
    expect(seenAt(c)).toBeNull()

    const d = pushed('r1'), e = pushed('r2')
    const throwing = (agent: string) => {
      if (agent === 'r2') throw new Error('boom')
      return userLine(`[Uzenet @s-tol -- x, msg_id:${d}]`)
    }
    expect(sweepSeenMessages(now + 1, throwing)).toBe(1)
    expect(seenAt(d)).toBe(now + 1)
    expect(seenAt(e)).toBeNull()
  })

  it('returns 0 and reads nothing with no unseen delivered row', () => {
    const now = Math.floor(Date.now() / 1000)
    const id = pushed('n1')
    markMessagesSeen([id], 1)
    // a now far past every other row's window keeps rows from other cases out of scope
    const later = now + 3 * SEEN_WINDOW_SEC
    const reader = vi.fn()
    expect(sweepSeenMessages(later, reader)).toBe(0)
    expect(reader).not.toHaveBeenCalled()
  })
})
