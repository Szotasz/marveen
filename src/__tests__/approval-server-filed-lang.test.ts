// APPROVALTAGEN1108 (Samu 73350): a server-filed request (memory delete, second reviewer) is worded in the language its
// owner post goes out in, read ONCE in fileServerApproval: the description and the post can never differ, even when the
// install key changes between the two. Real memory-delete route, in-memory DB; only the outbound owner text is captured.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const ownerTexts: string[] = []
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'lean-chief', CHANNEL_PROVIDER: 'slack', TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: vi.fn(async (text: string) => { ownerTexts.push(text); return { sent: true } }),
}))
vi.mock('../web/autonomy-level.js', async (orig) => {
  const actual = await orig<typeof import('../web/autonomy-level.js')>()
  return { ...actual, readAutonomyLevel: () => ({ level: 1, source: 'config' }) }
})

const { initDatabase, saveAgentMemory, getApproval } = await import('../db.js')
const { tryHandleMemories } = await import('../web/routes/memories.js')
const { reactionDeps } = await import('../web/routes/approvals.js')

async function del(id: number) {
  const url = new URL(`http://localhost:3420/api/memories/${id}`)
  let body = ''
  const res = { writeHead: () => {}, end: (b?: string) => { body = b || '' } }
  const ctx: RouteContext = { req: Readable.from([]) as any, res: res as any, path: url.pathname, method: 'DELETE', url, auth: { kind: 'token', agent: 'leanscout' } }
  await tryHandleMemories(ctx)
  return JSON.parse(body)
}
const flush = () => new Promise((r) => setTimeout(r, 0))

const realLang = reactionDeps.lang
let reads = 0
beforeEach(() => { initDatabase(':memory:'); ownerTexts.length = 0; reads = 0 })
afterEach(() => { reactionDeps.lang = realLang })

describe('a server-filed request: description and owner post in one language', () => {
  for (const [first, second] of [['en', 'hu'], ['hu', 'en']] as const) {
    it(`the key reads ${first} and then ${second}: the description AND the post are ${first}, the key is read once`, async () => {
      reactionDeps.lang = () => (reads++ === 0 ? first : second)
      const { id } = saveAgentMemory('leanscout', 'Stale note about the old deploy runbook', 'hot')
      const r = await del(id)
      await flush()
      expect(r.error).toBe('approval_required')
      const description = getApproval(r.approval_id)!.action_description
      expect(ownerTexts).toHaveLength(1)
      if (first === 'en') {
        expect(description.startsWith(`Permanent deletion of memory #${id} `)).toBe(true)
        expect(ownerTexts[0].startsWith('[APPROVAL NEEDED] leanscout | data_delete\n' + description + '\nExpires: ')).toBe(true)
      } else {
        expect(description.startsWith(`Emlék végleges törlése: #${id} `)).toBe(true)
        expect(ownerTexts[0].startsWith('[JÓVÁHAGYÁS KELL] leanscout | data_delete\n' + description + '\nLejárat: ')).toBe(true)
      }
      expect(reads).toBe(1)
    })
  }
})
