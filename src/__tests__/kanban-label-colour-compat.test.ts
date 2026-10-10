import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// the label palette is normalized (a palette name such as `red` is stored and
// served as #ff0000; a value that is not a colour is dropped), and a label
// PUT that sends a legacy label its own current colour back must not silently
// recolour it.
// Route level, with the palette a legacy mixed KANBAN_LABEL_COLORS=red,#3b82f6
// normalizes to.
const getLabel = vi.fn()
const createLabel = vi.fn((l: unknown) => l)
const updateLabel = vi.fn(() => true)

vi.mock('../db.js', () => ({
  listKanbanCards: vi.fn(() => []),
  createKanbanCard: vi.fn(),
  updateKanbanCard: vi.fn(),
  deleteKanbanCard: vi.fn(),
  moveKanbanCard: vi.fn(),
  archiveKanbanCard: vi.fn(),
  unarchiveKanbanCard: vi.fn(),
  getKanbanComments: vi.fn(() => []),
  addKanbanComment: vi.fn(),
  getKanbanCardEvents: vi.fn(() => []),
  listKanbanProjects: vi.fn(() => []),
  getKanbanCard: vi.fn(),
  getChildCards: vi.fn(() => []),
  getDb: vi.fn(),
  createAgentMessage: vi.fn(),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn(() => undefined),
  listLabels: vi.fn(() => []),
  getLabel,
  createLabel,
  updateLabel,
  deleteLabel: vi.fn(),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn(),
  getLabelsForAllCards: vi.fn(() => ({})),
  getLabelsForCard: vi.fn(() => []),
  listArchivedKanbanCards: vi.fn(() => []),
  revertIdeaFromKanban: vi.fn(),
  getHeartbeatKanbanSummary: vi.fn(() => ({})),
}))

const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

vi.mock('../config.js', async (importOriginal) => {
  const { parseLabelPalette } = await import('../css-color.js')
  const palette = parseLabelPalette('red,#3b82f6')
  return { ...(await importOriginal<typeof import('../config.js')>()), KANBAN_LABEL_COLORS: palette.colors, KANBAN_LABEL_COLORS_REJECTED: palette.rejected }
})

const { tryHandleKanban } = await import('../web/routes/kanban.js')

function call(method: string, path: string, payload: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as any
  const captured: { status?: number; body?: string } = {}
  const res: any = {
    writeHead: (status: number) => { captured.status = status; return res },
    end: (chunk?: unknown) => { if (chunk !== undefined) captured.body = String(chunk) },
    setHeader: () => {},
  }
  return tryHandleKanban({ req, res, path, method, url: new URL(`http://localhost${path}`) } as any).then(handled => ({ handled, ...captured }))
}

describe('label colours with a legacy palette (KANBAN_LABEL_COLORS=red,#3b82f6)', () => {
  beforeEach(() => { getLabel.mockReset(); createLabel.mockClear(); updateLabel.mockClear(); warn.mockClear() })

  it('POST with a palette name stores its normalized colour, as hex', async () => {
    await call('POST', '/api/kanban/labels', { name: 'n', color: 'red' })
    expect(createLabel).toHaveBeenCalledWith(expect.objectContaining({ color: '#ff0000' }))
  })

  it('POST with a colour outside the palette gets the first palette entry', async () => {
    await call('POST', '/api/kanban/labels', { name: 'n', color: 'green' })
    expect(createLabel).toHaveBeenCalledWith(expect.objectContaining({ color: '#ff0000' }))
  })

  it('PUT resubmitting a legacy label its own current colour keeps it', async () => {
    getLabel.mockReturnValue({ id: 'L1', name: 'old', color: 'blue', created_at: 1 })
    await call('PUT', '/api/kanban/labels/L1', { name: 'renamed', color: 'blue' })
    expect(updateLabel).toHaveBeenCalledWith('L1', { name: 'renamed', color: 'blue' })
  })

  it('PUT with a different colour is still checked against the palette', async () => {
    getLabel.mockReturnValue({ id: 'L1', name: 'old', color: 'blue', created_at: 1 })
    await call('PUT', '/api/kanban/labels/L1', { color: '#3B82F6' })
    expect(updateLabel).toHaveBeenCalledWith('L1', { color: '#3b82f6' })
  })

  it('INVARIANT: PUT with the own stored value of the label keeps it even when it is not a colour we parse', async () => {
    getLabel.mockReturnValue({ id: 'L1', name: 'old', color: 'url(https://example.invalid/x)', created_at: 1 })
    await call('PUT', '/api/kanban/labels/L1', { color: 'url(https://example.invalid/x)' })
    expect(updateLabel).toHaveBeenCalledWith('L1', { color: 'url(https://example.invalid/x)' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('PUT with the same colour in another spelling keeps the stored spelling', async () => {
    getLabel.mockReturnValue({ id: 'L1', name: 'old', color: 'hsl(.5turn 100% 50%)', created_at: 1 })
    await call('PUT', '/api/kanban/labels/L1', { color: '#00FFFF' })
    expect(updateLabel).toHaveBeenCalledWith('L1', { color: 'hsl(.5turn 100% 50%)' })
  })

  it('a PUT to an unknown label id is not logged (it gets the 404)', async () => {
    getLabel.mockReturnValue(undefined)
    updateLabel.mockReturnValueOnce(false)
    const r = await call('PUT', '/api/kanban/labels/NOPE', { color: 'green' })
    expect(r.status).toBe(404)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a replaced colour is logged (PUT and POST)', async () => {
    getLabel.mockReturnValue({ id: 'L1', name: 'old', color: 'blue', created_at: 1 })
    await call('PUT', '/api/kanban/labels/L1', { color: 'green' })
    expect(updateLabel).toHaveBeenCalledWith('L1', { color: '#ff0000' })
    await call('POST', '/api/kanban/labels', { name: 'n', color: 'url(https://example.invalid/x)' })
    expect(warn).toHaveBeenCalledTimes(2)
  })

})
