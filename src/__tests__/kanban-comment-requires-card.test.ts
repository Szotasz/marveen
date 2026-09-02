import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// A comment posted to a card id that does not exist used to be STORED, with
// HTTP 200. The row hangs off an id no board view resolves, so the comment is
// invisible -- while the caller's only success signal says it landed. It
// happened twice in production from two unrelated mistakes (a truncated id
// column; a loop body that kept its literal placeholder), which is why the
// guard belongs in the endpoint and not in the instructions: the written
// warning had been in CLAUDE.md the whole time and did not carry.
const getKanbanCard = vi.fn()
const addKanbanComment = vi.fn(() => ({ id: 1, card_id: 'CARD0001' }))

vi.mock('../db.js', () => ({
  listKanbanCards: vi.fn(() => []),
  createKanbanCard: vi.fn(),
  updateKanbanCard: vi.fn(),
  deleteKanbanCard: vi.fn(),
  moveKanbanCard: vi.fn(),
  archiveKanbanCard: vi.fn(),
  unarchiveKanbanCard: vi.fn(),
  getKanbanComments: vi.fn(() => []),
  addKanbanComment,
  getKanbanCardEvents: vi.fn(() => []),
  listKanbanProjects: vi.fn(() => []),
  getKanbanCard,
  getChildCards: vi.fn(() => []),
  getDb: vi.fn(),
  createAgentMessage: vi.fn(),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn(() => undefined),
  listLabels: vi.fn(() => []),
  getLabel: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn(),
  getLabelsForAllCards: vi.fn(() => ({})),
  getLabelsForCard: vi.fn(() => []),
  listArchivedKanbanCards: vi.fn(() => []),
  revertIdeaFromKanban: vi.fn(),
  getHeartbeatKanbanSummary: vi.fn(() => ({})),
}))

const { tryHandleKanban } = await import('../web/routes/kanban.js')

function postComment(cardId: string, payload: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as any
  const captured: { status?: number; body?: string } = {}
  const res: any = {
    writeHead: (status: number) => { captured.status = status; return res },
    end: (chunk?: unknown) => { if (chunk !== undefined) captured.body = String(chunk) },
    setHeader: () => {},
  }
  const path = `/api/kanban/${cardId}/comments`
  return tryHandleKanban({
    req, res, path, method: 'POST',
    url: new URL(`http://localhost${path}`),
  } as any).then(handled => ({ handled, ...captured }))
}

describe('POST /api/kanban/:id/comments -- the card must exist', () => {
  beforeEach(() => {
    getKanbanCard.mockReset()
    addKanbanComment.mockClear()
  })

  it('404s instead of storing an invisible comment when the card does not exist', async () => {
    getKanbanCard.mockReturnValue(undefined)

    const out = await postComment('CARDID', { author: 'sanyiba', content: 'a body that must not be stored' })

    expect(out.handled).toBe(true)
    expect(out.status).toBe(404)
    // The write must not have happened -- the whole failure mode was a 200 next
    // to a stored row nobody can read.
    expect(addKanbanComment).not.toHaveBeenCalled()
  })

  it('names the id it could not find, so the caller can see WHICH id was wrong', async () => {
    getKanbanCard.mockReturnValue(undefined)

    const out = await postComment('CARDID', { author: 'sanyiba', content: 'x' })

    // Both real occurrences were mistakes ABOUT THE ID (a truncated one, a
    // placeholder). An error that does not echo the id leaves the caller
    // guessing which of a loop's iterations went wrong.
    expect(out.body).toContain('CARDID')
    expect(out.body).toContain('NEM jött létre')
  })

  // POSITIVE CONTROL. Without this, a mock (or a future refactor) that makes
  // EVERY request 404 would keep the two tests above green while the endpoint
  // is broken for its normal use. The guard has to reject the bad id and let
  // the good one through -- one of those alone is not the requirement.
  it('POZITÍV KONTROLL: an existing card still gets its comment', async () => {
    getKanbanCard.mockReturnValue({ id: 'CARD0001', title: 'valódi kártya' })

    const out = await postComment('CARD0001', { author: 'sanyiba', content: 'ez elmegy' })

    expect(out.handled).toBe(true)
    expect(out.status).toBe(200)
    expect(addKanbanComment).toHaveBeenCalledTimes(1)
    expect(addKanbanComment).toHaveBeenCalledWith('CARD0001', 'sanyiba', 'ez elmegy')
  })

  // The 400 for a missing author/content predates this guard and must survive
  // it: the card lookup was inserted ABOVE that check, so a bad payload on a
  // real card has to still say 400, not 200 and not 404.
  it('keeps the existing 400 for a payload without author or content', async () => {
    getKanbanCard.mockReturnValue({ id: 'CARD0001', title: 'valódi kártya' })

    const out = await postComment('CARD0001', { author: 'sanyiba' })

    expect(out.status).toBe(400)
    expect(addKanbanComment).not.toHaveBeenCalled()
  })
})
