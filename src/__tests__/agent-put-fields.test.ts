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

// The config endpoints (auto-restart, context-guard) had the same hole, and it
// bit on 2026-08-11: a whole fleet was PUT an idle-flush config that no version
// of the code has ever read, and all nine calls answered 200 {ok:true}. The
// mechanism was believed shipped for three weeks on the strength of those
// replies. Reproduced live before this test was written:
//
//   PUT /api/agents/marveencoder/context-guard
//     {..., "idleFlushEnabled": true, "totalNonsenseField": 42}
//   -> 200 {"ok":true,"contextGuard":{ ...only the seven known fields... }}
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

  it('refuses the exact payload that was silently swallowed on 2026-08-11', () => {
    const r = checkConfigPutFields(
      { ...DEFAULT_CONTEXT_GUARD, idleFlushEnabled: true, idleFlushTokens: 500_000, idleMinutes: 30 },
      guardFields,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['idleFlushEnabled', 'idleFlushTokens', 'idleMinutes'])
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
    ])
  })
})
