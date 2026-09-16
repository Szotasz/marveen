// The transcript route has TWO gates, and they answer different questions.
// This suite covers the CALLER side, which the first shape of #1095 did not
// have at all (review: Szotasz, 2026-09-03).
//
// Why it matters, stated as the review did: the allowlist decides WHOSE log is
// readable, and says nothing about WHO is reading. `/api/*` auth is a single
// SHARED Bearer token that every sub-agent in the fleet reads out of
// store/.dashboard-token by its own standing instructions. So with only the
// allowlist, "enabling" one agent would have exposed that agent's session log
// -- customer correspondence and the principal's personal data, fleet rule 8
// -- to every holder of the fleet token. The PR's own security claim was
// therefore only half true until this gate existed.
//
// The response is not truncated (whole events by design) and supports `since`
// paging, so a caller who gets in can walk the entire log. That is what makes
// the caller gate the load-bearing one rather than a formality.
import { describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { join } from 'node:path'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, auth?: RouteContext['auth']): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as RouteContext['req'], res, path: url.pathname, method: 'GET', url, auth } as RouteContext
  return { ctx, out }
}

const TRANSCRIPT = `/api/agents/${MAIN_AGENT_ID}/transcript`
const WEB_DIR = join(PROJECT_ROOT, 'web')
const CRED_403 = 'Forbidden for this credential type'

describe('transcript route: caller gate (named principals only)', () => {
  it('refuses the SHARED dashboard token -- the fleet credential is not a person', async () => {
    // This is the case the review was about: every sub-agent holds this token.
    const { ctx, out } = fakeCtx(TRANSCRIPT, { kind: 'token' })
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: CRED_403 })
  })

  it('refuses a federation peer', async () => {
    // Belt and braces: the federation token is already scoped to two wire
    // endpoints, so it cannot reach here -- but a transcript must never be
    // reachable by a peer even if that scoping is ever widened.
    const { ctx, out } = fakeCtx(TRANSCRIPT, { kind: 'federation', peer: 'marveen-wevent' })
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: CRED_403 })
  })

  it('refuses a request with no resolved principal (fail-closed)', async () => {
    const { ctx, out } = fakeCtx(TRANSCRIPT, undefined)
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: CRED_403 })
  })

  it('refuses an unknown/future credential kind by default, not by omission', async () => {
    // Default-deny: a kind added to AuthResult later must not fall through to
    // "allowed" just because nobody updated this route.
    const { ctx, out } = fakeCtx(TRANSCRIPT, { kind: 'kiosk' } as unknown as RouteContext['auth'])
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: CRED_403 })
  })

  it('lets a logged-in human PAST the caller gate (the target gate then decides)', async () => {
    // With no store/transcript-allowlist.json the target gate refuses -- which
    // is the point: a DIFFERENT 403, proving the caller gate was cleared and
    // the allowlist is what stopped it.
    const { ctx, out } = fakeCtx(TRANSCRIPT, { kind: 'session', user: 'viktor' })
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.body).not.toEqual({ error: CRED_403 })
  })

  it('lets an enrolled device past the caller gate (the owner checking from his phone)', async () => {
    const { ctx, out } = fakeCtx(TRANSCRIPT, { kind: 'device', device: 'viktor-phone', deviceId: 1 })
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.body).not.toEqual({ error: CRED_403 })
  })

  it('runs the caller gate BEFORE the not-found check, so a token holder cannot enumerate agents', async () => {
    // If the 404 came first, the difference between 404 and 403 would tell a
    // shared-token holder which agents exist. Both must look identical to him.
    const missing = fakeCtx('/api/agents/nincs-ilyen-agens/transcript', { kind: 'token' })
    expect(await tryHandleAgents(missing.ctx, WEB_DIR)).toBe(true)
    expect(missing.out.status).toBe(403)
    expect(missing.out.body).toEqual({ error: CRED_403 })

    const present = fakeCtx(TRANSCRIPT, { kind: 'token' })
    await tryHandleAgents(present.ctx, WEB_DIR)
    // Byte-identical answer for an existing and a non-existing agent.
    expect(missing.out.status).toBe(present.out.status)
    expect(missing.out.body).toEqual(present.out.body)
  })
})
