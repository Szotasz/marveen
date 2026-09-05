import { describe, it, expect } from 'vitest'
import { checkAgentPutFields, checkConfigPutFields, AGENT_PUT_WRITABLE_FIELDS } from '../web/agent-put-fields.js'
import { DEFAULT_CONTEXT_GUARD } from '../context-guard.js'
import { DEFAULT_AUTO_RESTART, LEGACY_AUTO_RESTART_FIELDS } from '../auto-restart.js'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

// PUT /api/agents/:name answered 200 {ok:true} to fields it did not understand
// and quietly dropped them. A securityProfile was set that way four times on
// 2026-07-27, acknowledged each time, never applied -- the agent stayed in a
// mode where it stopped for approval on every tool call and was unusable for
// hours. The failure mode of this rule is silence, so it gets its own tests.
describe('checkAgentPutFields', () => {
  it('accepts the payloads the dashboard actually sends', () => {
    // taken from the real call sites in web/app.js -- if one of these ever
    // starts failing, the UI breaks, so they are pinned here deliberately
    expect(checkAgentPutFields('laci', { claudeMd: '...', soulMd: '...' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { model: 'claude-opus-5' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { claudePlan: '' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { authMode: 'shared' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { memoryIsolation: true }).ok).toBe(true)
    expect(checkAgentPutFields('laci', {}).ok).toBe(true)
  })

  it('refuses securityProfile and says where it belongs', () => {
    const r = checkAgentPutFields('vera', { securityProfile: 'researcher-permissive' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['securityProfile'])
    // the message has to carry the alternative: a bare refusal sends people
    // looking for a way around the check instead of at the right endpoint
    expect(r.message).toContain('/api/agents/vera/security')
    expect(r.message).toContain('profile')
  })

  it('refuses a field nobody has heard of, rather than ignoring it', () => {
    const r = checkAgentPutFields('laci', { claudeMd: 'ok', tipoField: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['tipoField'])
  })

  it('names every offending field, not just the first', () => {
    const r = checkAgentPutFields('laci', { securityProfile: 'x', nonsense: true, model: 'ok' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['securityProfile', 'nonsense'])
    expect(r.rejected).not.toContain('model')
  })

  it('rejects a body that is not an object at all', () => {
    expect(checkAgentPutFields('laci', null).ok).toBe(false)
    expect(checkAgentPutFields('laci', 'securityProfile=x').ok).toBe(false)
    expect(checkAgentPutFields('laci', 42).ok).toBe(false)
  })

  it('does not quietly gain a writable field', () => {
    // A field added to this list widens what the endpoint can change, so the
    // list is pinned: growing it should require editing this test too.
    expect([...AGENT_PUT_WRITABLE_FIELDS]).toEqual([
      'claudeMd', 'soulMd', 'mcpJson', 'model',
      'authMode', 'apiKey', 'claudePlan', 'memoryIsolation',
    ])
    expect(AGENT_PUT_WRITABLE_FIELDS).not.toContain('securityProfile')
  })
})

// The config endpoints (auto-restart, context-guard) have the same hole: an
// unknown field is normalized away and the call still answers 200 {ok:true},
// so a client cannot tell a typo from a saved setting. A field can look
// configured for as long as nobody reads the stored value back, which is what
// makes this failure expensive -- it is discovered by the behaviour that never
// arrives, not by the call that set it.
//
//   PUT /api/agents/<name>/context-guard
//     {..., "idleFlushEnabled": true, "totalNonsenseField": 42}
//   -> 200 {"ok":true,"contextGuard":{ ...only the known fields... }}
describe('checkConfigPutFields', () => {
  const guardFields = Object.keys(DEFAULT_CONTEXT_GUARD)

  it('accepts a full round-tripped config (GET then PUT back)', () => {
    // The shape a client gets from GET must be a legal PUT body, or the
    // simplest possible use of the endpoint breaks.
    expect(checkConfigPutFields({ ...DEFAULT_CONTEXT_GUARD }, guardFields).ok).toBe(true)
    expect(checkConfigPutFields({ ...DEFAULT_AUTO_RESTART }, Object.keys(DEFAULT_AUTO_RESTART)).ok).toBe(true)
  })

  it('accepts a partial config -- only unknown KEYS are refused, not missing ones', () => {
    // Value coercion stays the endpoint's job; this check must not turn a
    // partial payload into an error.
    expect(checkConfigPutFields({ enabled: true }, guardFields).ok).toBe(true)
    expect(checkConfigPutFields({}, guardFields).ok).toBe(true)
  })

  it('now ACCEPTS a payload whose fields used to be silently swallowed', () => {
    // These three fields did not exist before the idle-flush tier, so a PUT
    // carrying them was accepted and dropped. Pinned here rather than only in
    // the guard tests because this is the endpoint that reported success: the
    // pair of assertions is the whole point, that the call used to succeed
    // without doing anything and now succeeds because the fields exist.
    const r = checkConfigPutFields(
      { ...DEFAULT_CONTEXT_GUARD, idleFlushEnabled: true, idleFlushTokens: 400_000, idleMinutes: 20 },
      guardFields,
    )
    expect(r.ok).toBe(true)
  })

  it('still refuses a near-miss of a real idle-flush field', () => {
    // The failure this check exists for survives the fields becoming real: a
    // plural, a transposition, an American spelling all still vanish silently
    // without it.
    const r = checkConfigPutFields({ idleFlushToken: 400_000, idleMinute: 20 }, guardFields)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['idleFlushToken', 'idleMinute'])
  })

  it('names every unknown field and keeps the known ones out of the list', () => {
    const r = checkConfigPutFields({ enabled: true, actPtc: 0.9, nonsense: 1 }, guardFields)
    expect(r.ok).toBe(false)
    if (r.ok) return
    // actPtc is a transposition of actPct -- the typo this check exists for
    expect(r.rejected).toEqual(['actPtc', 'nonsense'])
    expect(r.rejected).not.toContain('enabled')
  })

  it('tells the caller which fields the endpoint does know', () => {
    const r = checkConfigPutFields({ actPtc: 0.9 }, guardFields)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('actPct')
  })

  it('accepts the exact payloads the dashboard sends', () => {
    // Pinned from the real call sites in web/app.js. These are the only live
    // callers of these two endpoints, so a check that rejects one of them
    // breaks the settings pane.
    expect(checkConfigPutFields(
      { enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null },
      Object.keys(DEFAULT_AUTO_RESTART),
    ).ok).toBe(true)
    // The idle-flush save merges its three fields over a freshly-read config,
    // so the body is a full context-guard config.
    expect(checkConfigPutFields(
      { ...DEFAULT_CONTEXT_GUARD, idleFlushEnabled: true, idleFlushTokens: 400_000, idleMinutes: 20 },
      guardFields,
    ).ok).toBe(true)
  })

  // The auto-restart endpoint's known set is the config keys PLUS the legacy
  // ones. `handoff` used to be a stored field that the UI sent
  // on every save; removing it from the config would make the endpoint reject
  // the payload of any dashboard page still open in a browser with the old
  // app.js -- a save failing with a 400 for a field WE sent. It is accepted
  // here and dropped by normalizeAutoRestartConfig: tolerated, never stored.
  it('still accepts an auto-restart payload from a stale dashboard page', () => {
    const endpointFields = [...Object.keys(DEFAULT_AUTO_RESTART), ...LEGACY_AUTO_RESTART_FIELDS]
    expect(checkConfigPutFields(
      { enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: false },
      endpointFields,
    ).ok).toBe(true)
    // Tolerating the legacy key must not turn the check into a pushover: a real
    // typo is still rejected.
    expect(checkConfigPutFields({ enabled: true, handof: false }, endpointFields).ok).toBe(false)
  })

  it('rejects a body that is not an object at all', () => {
    expect(checkConfigPutFields(null, guardFields).ok).toBe(false)
    expect(checkConfigPutFields('enabled=true', guardFields).ok).toBe(false)
    expect(checkConfigPutFields(42, guardFields).ok).toBe(false)
  })

  it('derives the known set from the default config, so it cannot drift', () => {
    // The route passes Object.keys(DEFAULT_CONTEXT_GUARD). If a field is added
    // to ContextGuardConfig without a default, normalize() would still read it
    // while this check refused it -- pinned so that mismatch fails here.
    expect(guardFields).toEqual([
      'enabled', 'saturationRestart', 'actPct', 'hardPct',
      'limitTokens', 'cooldownMinutes', 'handoffTimeoutMinutes',
      'idleFlushEnabled', 'idleFlushTokens', 'idleMinutes',
    ])
  })
})


// The field-list checks above prove what the ENDPOINT'S KNOWN SET does. They say
// nothing about which set the route actually passes -- measured: dropping
// LEGACY_AUTO_RESTART_FIELDS from the call site left every one of them green.
// So drive the route itself: a stale dashboard page's payload must still save.
async function putAutoRestart(name: string, body: unknown): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}/auto-restart`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

// The route writes the real store file, so save and restore it: a developer
// running the suite in a checkout that has one must not find their own
// auto-restart config rewritten by a test.
const STORE_FILE = join(STORE_DIR, 'auto-restart.json')
let storeBefore: string | null = null

beforeAll(() => {
  mkdirSync(STORE_DIR, { recursive: true })
  storeBefore = existsSync(STORE_FILE) ? readFileSync(STORE_FILE, 'utf-8') : null
})

afterAll(() => {
  if (storeBefore !== null) writeFileSync(STORE_FILE, storeBefore)
  else rmSync(STORE_FILE, { force: true })
})

describe('PUT /api/agents/:name/auto-restart -- the legacy handoff key', () => {
  it('saves a payload carrying the removed field instead of 400-ing on it', async () => {
    const r = await putAutoRestart(MAIN_AGENT_ID, {
      enabled: false, mode: 'continue', dailyTime: null, intervalHours: null, handoff: false,
    })
    expect(r.status).toBe(200)
    expect(r.body?.ok).toBe(true)
    // Accepted, and dropped: the stored config must not carry it back.
    expect('handoff' in (r.body?.autoRestart ?? {})).toBe(false)
  })

  it('still rejects a genuinely unknown field', async () => {
    const r = await putAutoRestart(MAIN_AGENT_ID, { enabled: false, handof: false })
    expect(r.status).toBe(400)
    expect(r.body?.rejected).toEqual(['handof'])
  })
})
