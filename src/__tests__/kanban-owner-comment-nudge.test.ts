import { describe, it, expect, vi } from 'vitest'
import { notifyOwnerOfAgentComment } from '../web/routes/kanban.js'
import { OWNER_NAME } from '../config.js'

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
    // Covered by the token/chat guard: an install without Telegram configured
    // must not throw on every comment.
    const send = vi.fn(async () => {})
    const result = notifyOwnerOfAgentComment(card({ assignee: 'nobody' }), 'prisma', 'x', send)
    expect(result).toBe(false)
  })
})
