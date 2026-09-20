// The transcript route has TWO gates. The CALLER gate (who is reading) is
// pinned in agent-transcript-caller-gate.test.ts. This suite covers the other
// one: the TARGET gate, which decides WHOSE log may be read.
//
// WHY THIS FILE EXISTS (review: Szotasz, 2026-09-16). The target gate was
// unpinned, and the reviewer proved it by hand: he deleted
// store/transcript-allowlist.json and the suite stayed 19/19 green, then set
// the file to an everyone-shaped value and it stayed green again. Both of
// those are the gate failing open, and nothing turned red. The reason is that
// every existing test is refused by the CALLER gate first, so execution never
// reaches the target gate at all -- the two assertions that do get past it
// (`not.toEqual(FORBIDDEN_KIND)`) say nothing about what the target gate then
// decided.
//
// So the tests below drive the REAL route with a caller that is already past
// the first gate, and assert on the target gate's own refusal. Only the read
// of the allowlist file is substituted, because the value under test IS that
// file's content and a test must not depend on what happens to sit in store/
// on the machine running it.
//
// THE POSITIVE CONTROL IS NOT OPTIONAL. A suite that only asserts "403" would
// be green on a gate that refuses everything unconditionally -- which is the
// same shape of green that let this through in the first place. The last test
// shows the same route answering 200 when the name IS listed, so the refusals
// above it are measurements of the gate rather than of a wall.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// What the allowlist file returns for this test. `null` means the read throws,
// which is what both a MISSING and an UNREADABLE file look like from here:
// readFileOr() swallows every error and hands back its fallback.
const allowlistFajl: { tartalom: string | null } = { tartalom: null }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((celpont: unknown, ...tobbi: unknown[]) => {
    if (typeof celpont === 'string' && celpont.endsWith('transcript-allowlist.json')) {
      if (allowlistFajl.tartalom === null) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return allowlistFajl.tartalom
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(celpont, ...tobbi)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { join } = await import('node:path')
type RouteContext = import('../web/routes/types.js').RouteContext

function fakeCtx(path: string, auth: RouteContext['auth']): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req: {} as RouteContext['req'], res, path: url.pathname, method: 'GET', url, auth } as RouteContext, out }
}

const TRANSCRIPT = `/api/agents/${MAIN_AGENT_ID}/transcript`
const WEB_DIR = join(PROJECT_ROOT, 'web')
// A caller the FIRST gate lets through, so what we measure below is the second
// one. The owner checking his own fleet from a logged-in dashboard session.
const EMBER: RouteContext['auth'] = { kind: 'session', user: 'viktor' }
const TARGET_403 = { error: 'Transcript access is not enabled for this agent' }

beforeEach(() => { allowlistFajl.tartalom = null })

describe('transcript route: target gate (whose log may be read)', () => {
  it('refuses when the allowlist file is absent entirely -- fail closed', async () => {
    // The reviewer's first experiment. No file means no decision has been made
    // about who may read whose material, and the safe reading of "no decision"
    // is nobody -- never everybody.
    allowlistFajl.tartalom = null
    const { ctx, out } = fakeCtx(TRANSCRIPT, EMBER)
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual(TARGET_403)
  })

  it('refuses every unreadable or everyone-shaped allowlist, with no wildcard escape', async () => {
    // The reviewer's second experiment, widened. An allowlist is a list of
    // NAMES and nothing else: there is no value in it that means "anyone", so
    // a file that tries to say it must land on the same refusal as no file.
    // Table-driven on purpose -- the failure mode here is a single shape that
    // slips through, and one example would not have found it.
    const alakok: Array<[string, string]> = [
      ['star wildcard', '["*"]'],
      ['hungarian everyone', '["mindenki"]'],
      ['english everyone', '["all"]'],
      ['boolean true', 'true'],
      ['object instead of array', '{"marveen-is": true}'],
      ['string instead of array', '"mindenki"'],
      ['empty list', '[]'],
      ['truncated json', '["marveen-is"'],
      ['not json at all', 'mindenki'],
      ['empty file', ''],
    ]
    for (const [cimke, tartalom] of alakok) {
      allowlistFajl.tartalom = tartalom
      const { ctx, out } = fakeCtx(TRANSCRIPT, EMBER)
      expect(await tryHandleAgents(ctx, WEB_DIR), cimke).toBe(true)
      expect(out.status, cimke).toBe(403)
      expect(out.body, cimke).toEqual(TARGET_403)
    }
  })

  it('answers when the name IS listed -- the control that makes the refusals above mean something', async () => {
    // Without this, every assertion in this file would also pass against a
    // gate that refuses unconditionally, and the suite would carry the same
    // false comfort it was written to remove. `bytes=1` keeps the read to a
    // single byte: what is being measured is the gate, not the log.
    allowlistFajl.tartalom = JSON.stringify([MAIN_AGENT_ID])
    const { ctx, out } = fakeCtx(`${TRANSCRIPT}?bytes=1`, EMBER)
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).not.toBe(403)
    expect(out.body).not.toEqual(TARGET_403)
    expect(out.body).toHaveProperty('agent', MAIN_AGENT_ID)
  })

  it('keeps the caller gate ahead of the target gate even when the allowlist would allow', async () => {
    // Ordering matters and is easy to lose in a later refactor: if the target
    // gate ran first, a holder of the SHARED fleet token would get a 200 on
    // any listed agent. The listed name here is exactly the one the shared
    // token must still not reach.
    allowlistFajl.tartalom = JSON.stringify([MAIN_AGENT_ID])
    const { ctx, out } = fakeCtx(TRANSCRIPT, { kind: 'token' })
    expect(await tryHandleAgents(ctx, WEB_DIR)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: 'Forbidden for this credential type' })
  })
})
