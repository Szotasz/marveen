import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getDb } from '../db.js'
import { MAIN_AGENT_ID, HEARTBEAT_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { isHeartbeatTemplateLeak } from '../web/heartbeat-header-stamp.js'
import type { RouteContext } from '../web/routes/types.js'

// HBTEMPLATELEAK1002 (measured 2026-10-02): at 12:00 and 13:00 the heartbeat
// agent first sent its task's sample header ("## Heartbeat YYYY-MM-DD HH:MM",
// at 12:00 with the instruction text and a curl recipe), then the real report.
// The cause was the agent's own parsing (it took the first marker, the sample
// line); this guard makes sure such a leak never reaches a box, whatever writes it.

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}

const rows = (needle: string) =>
  (getDb().prepare('SELECT count(*) AS n FROM agent_messages WHERE content LIKE ?').get(`%${needle}%`) as { n: number }).n

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('isHeartbeatTemplateLeak', () => {
  it('the placeholder header is a leak, leading whitespace included', () => {
    expect(isHeartbeatTemplateLeak('## Heartbeat YYYY-MM-DD HH:MM (Europe/Budapest)\nmerve: YYYY-MM-DD HH:MM')).toBe(true)
    expect(isHeartbeatTemplateLeak('\n  ## Heartbeat YYYY-MM-DD HH:MM')).toBe(true)
  })
  it('a real report and a message that only mentions the placeholder are not', () => {
    expect(isHeartbeatTemplateLeak('## Heartbeat 2026-10-02 13:00 (Europe/Budapest)\n### Kanban')).toBe(false)
    expect(isHeartbeatTemplateLeak('[Samu] the heartbeat sent "## Heartbeat YYYY-MM-DD HH:MM" first')).toBe(false)
  })
})

describe('POST /api/messages refuses a leaked heartbeat template (runtime)', () => {
  // The guard runs before the sender checks: the heartbeat id is refused here
  // even where it is not a registered sender, and an ACCEPTED sender (the main
  // agent, see the positive control below) is refused the same way.
  it('an accepted sender: 422 and NOTHING is written', async () => {
    const leak = '## Heartbeat YYYY-MM-DD HH:MM (Europe/Budapest)\nmerve: YYYY-MM-DD HH:MM\nleak-marker-main-91d2'
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: leak })
    expect(r.statusCode).toBe(422)
    expect(rows('leak-marker-main-91d2')).toBe(0)
  })

  it('the heartbeat sender: 422 and NOTHING is written', async () => {
    const leak = '## Heartbeat YYYY-MM-DD HH:MM (Europe/Budapest)\nmerve: YYYY-MM-DD HH:MM\n\n## Tedd most:\nleak-marker-7c1f'
    const r = await post({ from: HEARTBEAT_AGENT_ID, to: MAIN_AGENT_ID, content: leak })
    expect(r.statusCode).toBe(422)
    expect(String(r.json.error)).toMatch(/heartbeat_template_placeholder/)
    expect(rows('leak-marker-7c1f')).toBe(0)
  })

  // POSITIVE CONTROL for the "nothing is written" assertion above: the same
  // route, same sender, with a real date DOES write the row, so a zero count
  // there means the guard refused it, not that the route never writes.
  it('the real report with a date is accepted and written', async () => {
    const real = '## Heartbeat 2026-10-02 13:00 (Europe/Budapest)\nmerve: 2026-10-02 13:00\n\n### Kanban\nreal-marker-3b9e'
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: real })
    expect(r.statusCode).toBe(200)
    expect(rows('real-marker-3b9e')).toBe(1)
  })

  it('a message that discusses the placeholder (not starting with it) is not refused', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'the first message read "## Heartbeat YYYY-MM-DD HH:MM" discuss-marker-5a0c' })
    expect(r.statusCode).toBe(200)
    expect(rows('discuss-marker-5a0c')).toBe(1)
  })
})
