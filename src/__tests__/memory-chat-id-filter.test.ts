// MEMCHATID1123: the no-agent memory views read the whole store, whatever chat id a row carries.
//
// The writers put different chat ids into memories.chat_id: the API (saveAgentMemory) and the daily-log mirror write
// ALLOWED_CHAT_ID, the nightly digest (saveMemory) writes the resolved OWNER chat, which on a Slack or Teams install,
// or after ALLOWED_CHAT_ID was changed, is another value. The no-agent list and search filtered on ALLOWED_CHAT_ID and
// the digest's input on the owner chat, so each was blind to the other's rows, and every row written before a change
// of ALLOWED_CHAT_ID disappeared from the "all agents" view. The store here is mixed the way such an install is.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, saveMemory, getMemoriesForChat, searchMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(pathAndQuery: string) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() {},
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } } },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

const OTHER_CHAT = 'C0SLACKOWNER' // a chat id that is not ALLOWED_CHAT_ID, as the digest writes it on a Slack install

beforeEach(() => {
  initDatabase(':memory:')
  // An API save (chat_id = ALLOWED_CHAT_ID) ...
  saveAgentMemory('agent-a', 'quokkaledger written through the API', 'warm')
  // ... and a digest row under the owner chat (chat_id = another value).
  saveMemory(OTHER_CHAT, '[Napi naplo] quokkaledger digest of the day', 'episodic', undefined, 'agent-a')
})

const contents = (rows: Array<{ content: string }>): string[] => rows.map((r) => r.content).sort()

describe('the no-agent readers see every row, whatever its chat id (MEMCHATID1123)', () => {
  it('getMemoriesForChat (the no-agent list and the digest input) returns both rows', () => {
    expect(contents(getMemoriesForChat(50))).toEqual(['[Napi naplo] quokkaledger digest of the day', 'quokkaledger written through the API'])
  })

  it('searchMemories (the no-agent search) finds both rows', () => {
    expect(contents(searchMemories('quokkaledger', 50))).toEqual(['[Napi naplo] quokkaledger digest of the day', 'quokkaledger written through the API'])
  })

  it('the dashboard list without an agent shows both rows', async () => {
    const { ctx, out } = fakeCtx('/api/memories?limit=50')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(contents(out.body)).toEqual(['[Napi naplo] quokkaledger digest of the day', 'quokkaledger written through the API'])
  })

  it('the dashboard search without an agent finds both rows (the FTS branch, not the substring fallback)', async () => {
    const { ctx, out } = fakeCtx('/api/memories?q=quokkaledger&limit=50&strict=1')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(contents(out.body)).toEqual(['[Napi naplo] quokkaledger digest of the day', 'quokkaledger written through the API'])
  })

  it('the agent-scoped list is unchanged: it filters on the agent, never on the chat id', async () => {
    saveAgentMemory('agent-b', 'quokkaledger of another agent', 'warm')
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&limit=50')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(contents(out.body)).toEqual(['[Napi naplo] quokkaledger digest of the day', 'quokkaledger written through the API'])
  })
})
