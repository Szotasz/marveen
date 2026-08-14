/**
 * PUT and DELETE /api/memories/:id used to take no confirmation and 200
 * unconditionally, so a caller that meant to probe a different verb (or hit
 * the wrong id) could silently overwrite or permanently remove a live row
 * with no trace of what changed.
 *
 * Fix: both verbs require a `confirm: true` field in the JSON body -- without
 * it they 400 and do not mutate. DELETE's success response echoes the removed
 * row; PUT's success response echoes the row's previous content.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function mkRes() {
  const state = { statusCode: 0, body: '' }
  return {
    state,
    writeHead(code: number) { state.statusCode = code; return this },
    setHeader() {},
    end(data?: unknown) { if (data !== undefined) state.body += String(data) },
  }
}

async function call(method: string, id: number, body?: unknown): Promise<{ statusCode: number; json: any }> {
  const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  const ctx: RouteContext = {
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: `/api/memories/${id}`,
    method,
    url: new URL(`http://127.0.0.1:3420/api/memories/${id}`),
    fedPeer: null,
  }
  const handled = await tryHandleMemories(ctx)
  expect(handled).toBe(true)
  return { statusCode: res.state.statusCode || 200, json: res.state.body ? JSON.parse(res.state.body) : null }
}

const MARKER = 'confirm-gate-poz-kontroll-torzs-XJ4q'

describe('PUT/DELETE /api/memories/:id require confirmation', () => {
  let id: number

  beforeEach(() => {
    initDatabase(':memory:')
    id = saveAgentMemory('agent-a', MARKER, 'warm', 'confirm-gate-teszt').id
  })

  it('DELETE without confirm: true is refused, and the row survives', async () => {
    const before = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string } | undefined
    expect(before?.content).toBe(MARKER)

    const { statusCode, json } = await call('DELETE', id) // no body at all
    expect(statusCode).toBe(400)
    expect(json.error).toMatch(/confirm/i)

    const after = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string } | undefined
    expect(after?.content).toBe(MARKER)
  })

  it('DELETE with confirm: true removes the row and echoes what was deleted', async () => {
    const { statusCode, json } = await call('DELETE', id, { confirm: true })
    expect(statusCode).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.deleted?.content).toBe(MARKER)

    const after = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id)
    expect(after).toBeUndefined()
  })

  it('PUT without confirm: true is refused, and the row is unchanged', async () => {
    const { statusCode, json } = await call('PUT', id, { content: 'overwritten-by-mistake' })
    expect(statusCode).toBe(400)
    expect(json.error).toMatch(/confirm/i)

    const after = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string } | undefined
    expect(after?.content).toBe(MARKER)
  })

  it('PUT with confirm: true overwrites and echoes the PREVIOUS content', async () => {
    const { statusCode, json } = await call('PUT', id, { content: 'new-content', confirm: true })
    expect(statusCode).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.previous_content).toBe(MARKER)

    const after = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string } | undefined
    expect(after?.content).toBe('new-content')
  })
})
