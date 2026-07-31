import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notifyOwnerOfAgentComment } from '../web/routes/kanban.js'
import { OWNER_NAME } from '../config.js'
import { initDatabase, getDb } from '../db.js'

// An empty bot token is what an install without Telegram looks like -- the
// only way to exercise the channel guard, since the tests everywhere else
// inject their own sender and never reach it. The chat id stays set so the
// conversation-log row has something to assert on.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  TELEGRAM_BOT_TOKEN: '',
  ALLOWED_CHAT_ID: '4242',
}))

beforeEach(() => {
  // The nudge writes itself to conversation_log; give it a real schema.
  initDatabase(':memory:')
})

/**
 * A card assigned to the owner is one THEY are expected to act on. An agent
 * answering there is usually a question or a handback, and until now it landed
 * silently: the comment appeared on a board nobody was watching, and the thread
 * stalled waiting for a reply the owner never knew was expected.
 *
 * Measured over the seven days to 2026-07-31: 68 such comments across 24 cards,
 * about 10 a day. Volume worth knowing before deciding whether this needs a
 * cooldown -- see the PR.
 */

const OWNER = OWNER_NAME
const card = (over: Partial<{ id: string; title: string; assignee: string | null }> = {}) => ({
  id: 'abc12345', title: 'Kartya-komment csatorna', assignee: OWNER, ...over,
})

describe('who gets nudged', () => {
  it('nudges when an agent comments on an owner card', async () => {
    const send = vi.fn(async () => {})
    expect(notifyOwnerOfAgentComment(card(), 'prisma', 'Kesz, review-ra var.', send)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the owner comments on their own card', async () => {
    // Notifying someone about their own message is pure noise.
    const send = vi.fn(async () => {})
    expect(notifyOwnerOfAgentComment(card(), OWNER, 'sajat jegyzet', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('matches the owner case-insensitively on both sides', async () => {
    // The board holds both "marveen" and "Marveen"; assignee casing drifts.
    const send = vi.fn(async () => {})
    expect(notifyOwnerOfAgentComment(card({ assignee: OWNER.toUpperCase() }), 'prisma', 'x', send)).toBe(true)
    expect(notifyOwnerOfAgentComment(card(), OWNER.toLowerCase(), 'x', send)).toBe(false)
  })

  it('stays quiet on a card the owner does not hold', async () => {
    const send = vi.fn(async () => {})
    expect(notifyOwnerOfAgentComment(card({ assignee: 'prisma' }), 'marveen', 'x', send)).toBe(false)
    expect(notifyOwnerOfAgentComment(card({ assignee: null }), 'marveen', 'x', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('what the nudge says', () => {
  it('names the commenter and the card, so it is actionable without opening it', async () => {
    let text = ''
    notifyOwnerOfAgentComment(card(), 'edina1', 'Leadtam a szoveget.', async (t) => { text = t })
    expect(text).toContain('edina1')
    expect(text).toContain('Kartya-komment csatorna')
    expect(text).toContain('Leadtam a szoveget.')
  })

  it('truncates a long comment instead of pasting an essay into Telegram', async () => {
    let text = ''
    notifyOwnerOfAgentComment(card(), 'prisma', 'x'.repeat(500), async (t) => { text = t })
    expect(text.length).toBeLessThan(300)
    expect(text).toContain('...')
  })

  it('flattens newlines so the nudge stays one readable block', async () => {
    let text = ''
    notifyOwnerOfAgentComment(card(), 'prisma', 'elso\n\n  masodik', async (t) => { text = t })
    expect(text).toContain('elso masodik')
  })

  it('does not claim truncation on a comment that fits once flattened', async () => {
    // A short comment padded with blank lines is long raw and short flattened.
    // Measuring the raw length put "..." on comments shown whole.
    let text = ''
    const padded = `roviden kesz.${'\n'.repeat(300)}`
    notifyOwnerOfAgentComment(card(), 'prisma', padded, async (t) => { text = t })
    expect(text).toContain('roviden kesz.')
    expect(text).not.toContain('...')
  })
})

describe('the agent knows the owner was pinged', () => {
  it('logs a delivered nudge to the conversation log', async () => {
    // The nudge leaves through the bot, outside the agent's session. Without
    // this row the agent has no record that the owner was pinged at all.
    notifyOwnerOfAgentComment(card(), 'prisma', 'Kesz, review-ra var.', async () => {})
    await new Promise((r) => setTimeout(r, 0))

    const row = getDb().prepare(
      "SELECT chat_id, direction, text, ts FROM conversation_log WHERE direction = 'out'",
    ).get() as { chat_id: string; direction: string; text: string; ts: string } | undefined
    expect(row).toBeDefined()
    expect(row!.chat_id).toBe('4242')
    expect(row!.text).toContain('Kesz, review-ra var.')
    // ISO-8601, not an epoch stringified into a TEXT column.
    expect(row!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('logs nothing when delivery failed', async () => {
    // A row for a message that never went out is the same confident-and-wrong
    // record this trace exists to remove.
    notifyOwnerOfAgentComment(card(), 'prisma', 'x', async () => { throw new Error('telegram down') })
    await new Promise((r) => setTimeout(r, 0))

    const count = getDb().prepare('SELECT count(*) AS n FROM conversation_log').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('it never breaks commenting', () => {
  it('swallows a delivery failure', async () => {
    expect(() =>
      notifyOwnerOfAgentComment(card(), 'prisma', 'x', async () => { throw new Error('telegram down') }),
    ).not.toThrow()
    // let the rejected promise settle so the handler runs
    await new Promise((r) => setTimeout(r, 0))
  })

  it('returns false rather than sending when the channel is unconfigured', () => {
    // No injected sender: this has to fall through to the default transport
    // and stop at the token/chat guard. Passing a sender would skip the guard
    // entirely, and an off-owner card would return false for the wrong reason
    // -- the assertion would pass while testing nothing.
    expect(notifyOwnerOfAgentComment(card(), 'prisma', 'x')).toBe(false)
  })
})
