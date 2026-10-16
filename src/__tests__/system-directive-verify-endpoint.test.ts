import { describe, it, expect, beforeAll, vi } from 'vitest'

// GUARDHITELES903 review finding (#1158): the receiver scaffold instructs
// `GET /api/messages/<N>` -- so the PR must prove, at the WORKING level and
// not just the wording level, that the tool the recipient is told to use
// exists and answers. This test runs the full loop: the real sender primitive
// writes the real anchor row (real in-memory DB), the envelope's msg_id is
// extracted the way a recipient would, and the REAL route handler serves the
// verification request. Plus the negative-control pair: a fabricated id must
// 404 from the handler (JSON error), not merely fall through unrouted.
//
// (The reviewer's live 404 was measured on the prod host running v1.36.0 --
// 21 commits behind -- where the route, added by #1080, did not exist yet.
// This test pins the route's existence to THIS branch so a future removal
// breaks the receiver rule loudly.)

vi.mock('../web/agent-process.js', () => ({
  sendPromptToSession: vi.fn(async () => 'sent' as const),
}))

import { initDatabase } from '../db.js'
import { sendPromptToSession } from '../web/agent-process.js'
import { tryHandleMessages } from '../web/routes/messages.js'

const { sendSystemDirective } = await import('../web/system-directive.js')

beforeAll(() => { initDatabase(':memory:') })

async function getMessageRoute(idPath: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
  let status = 200
  let body = ''
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { body = b ?? '' },
  } as any
  const handled = await tryHandleMessages({
    req: {} as any, res, path: `/api/messages/${idPath}`, method: 'GET',
    url: new URL(`http://localhost/api/messages/${idPath}`),
  } as any)
  return { status: handled ? status : -1, json: body ? JSON.parse(body) : null }
}

describe('the verification endpoint the receiver rule points at', () => {
  it('serves the anchor row of a freshly sent directive with the fields the rule checks', async () => {
    const directive = '[CONTEXT-GUARD] Teszt-direktiva: irj HANDOFF.md-t es allj meg.'
    await sendSystemDirective('boni', 'agent-boni', directive)

    // Recover the msg_id the way a recipient does: from the injected envelope.
    const injected = vi.mocked(sendPromptToSession).mock.calls[0][1]
    const m = injected.match(/msg_id:(\d+)/)
    expect(m).not.toBeNull()

    const { status, json } = await getMessageRoute(m![1])
    expect(status).toBe(200)
    // The four acceptance conditions of the scaffold rule, verbatim:
    expect(json!.from_agent).toBe('system')
    expect(json!.to_agent).toBe('boni')
    expect(json!.status).not.toBe('failed')
    expect(json!.content).toBe(directive)
  })

  it('404s (handler JSON, not an unrouted miss) on a fabricated msg_id -- the negative control', async () => {
    const { status, json } = await getMessageRoute('999999')
    expect(status).toBe(404)
    expect(json).toEqual({ error: 'Message not found' })
  })
})
