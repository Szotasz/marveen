import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getPendingMessages } from '../db.js'

// Override MAIN_AGENT_ID before the route module loads so the notification
// targets the configured value, not a hardcoded agent id.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-a' }
})

import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

function fakePost(path: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

function fakePatch(id: string, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}`
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'PATCH', url } as RouteContext, out }
}

describe('approvals notification target', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('sends the inter-agent notification to MAIN_AGENT_ID, not a hardcoded agent id', async () => {
    const { ctx, out } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send weekly digest',
    })

    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)

    // The notification must go to the mocked MAIN_AGENT_ID value.
    const pending = getPendingMessages('agent-a')
    expect(pending.length).toBe(1)
    expect(pending[0].to_agent).toBe('agent-a')
    expect(pending[0].from_agent).toBe('system')
    expect(pending[0].content).toContain('[APPROVAL_REQUEST]')

    // Regression guard: no message may land on a different target.
    const wrongTarget = getPendingMessages('agent-b')
    expect(wrongTarget.length).toBe(0)
  })
})

describe('approvals self-approval guard', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('returns 403 when resolved_by matches the requesting agent_id', async () => {
    // Create an approval for agent-b
    const { ctx: postCtx, out: postOut } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send report',
    })
    await tryHandleApprovals(postCtx)
    expect(postOut.status).toBe(201)
    const id = postOut.body.id

    // agent-b attempts to approve its own request
    const { ctx: patchCtx, out: patchOut } = fakePatch(id, {
      status: 'approved',
      resolved_by: 'agent-b',
    })
    const handled = await tryHandleApprovals(patchCtx)
    expect(handled).toBe(true)
    expect(patchOut.status).toBe(403)
    expect(patchOut.body.error).toMatch(/cannot approve its own request/)
  })

  it('allows approval when resolved_by differs from the requesting agent_id', async () => {
    const { ctx: postCtx, out: postOut } = fakePost('/api/approvals', {
      agent_id: 'agent-b',
      category: 'email_send',
      action_description: 'Send report',
    })
    await tryHandleApprovals(postCtx)
    const id = postOut.body.id

    // A different caller (e.g. the owner via telegram_text) approves
    const { ctx: patchCtx, out: patchOut } = fakePatch(id, {
      status: 'approved',
      resolved_by: 'telegram_text',
    })
    const handled = await tryHandleApprovals(patchCtx)
    expect(handled).toBe(true)
    expect(patchOut.status).toBe(200)
    expect(patchOut.body.status).toBe('approved')
  })
})
