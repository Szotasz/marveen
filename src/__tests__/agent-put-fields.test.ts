import { describe, it, expect } from 'vitest'
import { checkAgentPutFields, checkConfigPutFields, AGENT_PUT_WRITABLE_FIELDS } from '../web/agent-put-fields.js'
import { DEFAULT_CONTEXT_GUARD } from '../context-guard.js'
import { DEFAULT_AUTO_RESTART } from '../auto-restart.js'

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
    // breaks the settings pane -- and the auto-restart payload carries
    // `handoff`, a field the UI sends on every save and nothing else does.
    expect(checkConfigPutFields(
      { enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: false },
      Object.keys(DEFAULT_AUTO_RESTART),
    ).ok).toBe(true)
    // The idle-flush save merges its three fields over a freshly-read config,
    // so the body is a full context-guard config.
    expect(checkConfigPutFields(
      { ...DEFAULT_CONTEXT_GUARD, idleFlushEnabled: true, idleFlushTokens: 400_000, idleMinutes: 20 },
      guardFields,
    ).ok).toBe(true)
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
