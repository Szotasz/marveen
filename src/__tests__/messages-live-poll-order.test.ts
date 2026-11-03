// #2405 review: the open thread's live poll compares the newest page it polls
// with the newest page it drew. created_at is whole seconds and the API pages by
// (created_at DESC, id DESC); when the client sorted by created_at alone, two
// messages in the same second at the page boundary put different ids into the
// two pages, the signatures never matched and every poll redrew the thread.
// The functions run OUT OF the shipped web/app.js, against a fake API that
// orders the way db.ts does.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

type Msg = { id: number; created_at: number; status: string; result: string | null; completed_at: number | null }

function harness(server: Msg[]) {
  const start = APP.indexOf('function chatListSig(')
  const end = APP.indexOf('function renderChatBubbles(')
  // A moved or renamed function must fail the test, not quietly produce a stub.
  if (start < 0 || end < start) throw new Error('chat live-poll functions not found in web/app.js')
  const limits: number[] = []
  const container = {
    innerHTML: '', scrollHeight: 1000, scrollTop: 1000, clientHeight: 0, offsetParent: {},
    insertAdjacentHTML() {},
  }
  const document = { hidden: false, getElementById: (id: string) => (id === 'chatBubbles' ? container : null) }
  const fetch = async (url: string) => {
    const limit = Number(new URL(url, 'http://x').searchParams.get('limit'))
    limits.push(limit)
    const page = [...server].sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, limit)
    return { ok: true, json: async () => page }
  }
  const state = { agent: 'kodolo', minLoadedId: null, hasMore: true, loading: false, liveSig: null as string | null, liveTimer: null, loadedCount: 0 }
  const fns = new Function(
    'document', 'fetch', 'chatThreadState', 'CHAT_PAGE_SIZE', 't', 'chatWithReplies', 'buildBubbleHtml', 'escapeHtml',
    `${APP.slice(start, end)}; return { pollChatThread, fetchChatPage, chatListSig, chatSortAsc }`,
  )(document, fetch, state, 10, (k: string) => k, (m: Msg[]) => m, () => '', (s: string) => s)
  return { ...fns, state, limits }
}

const msg = (id: number, created_at: number): Msg => ({ id, created_at, status: 'done', result: 'ok', completed_at: created_at })

describe('chat live poll: same-second messages at the page boundary', () => {
  it('after a 22-message redraw the next poll matches liveSig and does not redraw', async () => {
    // ids 1..30, one second apart, except the 10th and 11th newest (21 and 20) share a second.
    const server = Array.from({ length: 30 }, (_, i) => msg(i + 1, 1_000 + i + 1))
    server[19].created_at = server[20].created_at
    const h = harness(server)
    await h.fetchChatPage('kodolo', null, 22, 'replace')
    expect(h.state.loadedCount).toBe(22)
    const newest = [...server].sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, 10)
    expect(h.state.liveSig).toBe(h.chatListSig(h.chatSortAsc(newest)))
    h.limits.length = 0
    await h.pollChatThread()
    await h.pollChatThread()
    expect(h.limits).toEqual([10, 10])
  })

  it('a tie is broken by id, oldest first', () => {
    const h = harness([])
    expect(h.chatSortAsc([msg(5, 7), msg(3, 7), msg(4, 6)]).map((m: Msg) => m.id)).toEqual([4, 3, 5])
  })
})

describe('chat live poll: a paginated thread keeps its oldest row when a message arrives', () => {
  it('22 loaded, one new message: the redraw asks for 23', async () => {
    const server = Array.from({ length: 30 }, (_, i) => msg(i + 1, 1_000 + i + 1))
    const h = harness(server)
    await h.fetchChatPage('kodolo', null, 22, 'replace')
    server.push(msg(31, 2_000))
    h.limits.length = 0
    await h.pollChatThread()
    expect(h.limits).toEqual([10, 23])
    expect(h.state.loadedCount).toBe(23)
  })

  it('a status change only (no new id) redraws the same count', async () => {
    const server = Array.from({ length: 30 }, (_, i) => msg(i + 1, 1_000 + i + 1))
    server[29].status = 'pending'
    const h = harness(server)
    await h.fetchChatPage('kodolo', null, 22, 'replace')
    server[29].status = 'done'
    h.limits.length = 0
    await h.pollChatThread()
    expect(h.limits).toEqual([10, 22])
  })
})
