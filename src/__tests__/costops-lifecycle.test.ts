import { describe, it, expect } from 'vitest'
import { deriveSourceLifecycle, deriveProvenance, type LifecycleInput } from '../costops/lifecycle.js'

function baseInput(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    explicitlyUnsupported: false,
    explicitlyDeprecated: false,
    credentialRequired: false,
    credentialPresent: false,
    lastRunStatus: null,
    hasEverHadActivity: true,
    ...overrides,
  }
}

describe('deriveSourceLifecycle (CostOps Phase 0, GAP-03)', () => {
  it('the headline case: OpenAI-shaped source (credential works, zero usage) is inactive, NOT credential_error/blocked', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      credentialRequired: true, credentialPresent: true, lastRunStatus: 'ok', hasEverHadActivity: false,
    }))
    expect(lifecycle).toBe('inactive')
  })

  it('missing required credential -> not_configured (not blocked, not an error state)', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({ credentialRequired: true, credentialPresent: false }))
    expect(lifecycle).toBe('not_configured')
  })

  it('credential present but a collector run genuinely failed -> blocked', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      credentialRequired: true, credentialPresent: true, lastRunStatus: 'error', hasEverHadActivity: false,
    }))
    expect(lifecycle).toBe('blocked')
  })

  it('credential present, collector working, has real activity -> active', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      credentialRequired: true, credentialPresent: true, lastRunStatus: 'ok', hasEverHadActivity: true,
    }))
    expect(lifecycle).toBe('active')
  })

  it('a manual/invoice source (no credential needed) with activity -> active', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      credentialRequired: false, credentialPresent: false, lastRunStatus: null, hasEverHadActivity: true,
    }))
    expect(lifecycle).toBe('active')
  })

  it('a manual source with no activity yet -> inactive (never not_configured -- no credential is required at all)', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      credentialRequired: false, credentialPresent: false, lastRunStatus: null, hasEverHadActivity: false,
    }))
    expect(lifecycle).toBe('inactive')
  })

  it('explicit unsupported override wins over every other signal', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      explicitlyUnsupported: true, credentialRequired: true, credentialPresent: true, lastRunStatus: 'ok', hasEverHadActivity: true,
    }))
    expect(lifecycle).toBe('unsupported')
  })

  it('explicit deprecated override wins over an otherwise-active source', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({
      explicitlyDeprecated: true, credentialRequired: true, credentialPresent: true, lastRunStatus: 'ok', hasEverHadActivity: true,
    }))
    expect(lifecycle).toBe('deprecated')
  })

  it('unsupported outranks deprecated when both are somehow set', () => {
    const lifecycle = deriveSourceLifecycle(baseInput({ explicitlyUnsupported: true, explicitlyDeprecated: true }))
    expect(lifecycle).toBe('unsupported')
  })

  it('every non-ok run status (partial/rate_limited/failed) maps to blocked, not just error', () => {
    for (const status of ['error', 'failed', 'partial', 'rate_limited'] as const) {
      const lifecycle = deriveSourceLifecycle(baseInput({
        credentialRequired: true, credentialPresent: true, lastRunStatus: status, hasEverHadActivity: false,
      }))
      expect(lifecycle).toBe('blocked')
    }
  })

  it('produces exactly one of the 6 documented lifecycle states, never anything else', () => {
    const allowed = new Set(['active', 'inactive', 'not_configured', 'unsupported', 'blocked', 'deprecated'])
    const scenarios: LifecycleInput[] = [
      baseInput(),
      baseInput({ credentialRequired: true, credentialPresent: false }),
      baseInput({ credentialRequired: true, credentialPresent: true, lastRunStatus: 'error' }),
      baseInput({ credentialRequired: true, credentialPresent: true, lastRunStatus: 'ok', hasEverHadActivity: false }),
      baseInput({ explicitlyUnsupported: true }),
      baseInput({ explicitlyDeprecated: true }),
    ]
    for (const s of scenarios) expect(allowed.has(deriveSourceLifecycle(s))).toBe(true)
  })
})

describe('deriveProvenance (CostOps Phase 0, GAP-03 -- separate from lifecycle)', () => {
  it('maps actual_source=provider_api to provider_api_actual', () => {
    expect(deriveProvenance('provider_api', 'provider_api')).toBe('provider_api_actual')
  })

  it('maps actual_source=email_invoice to invoice_actual', () => {
    expect(deriveProvenance('actual_invoice', 'email_invoice')).toBe('invoice_actual')
  })

  it('maps actual_source=manual_entry + confidence=manual to manual_actual', () => {
    expect(deriveProvenance('manual', 'manual_entry')).toBe('manual_actual')
  })

  it('maps actual_source=manual_entry + an estimate confidence to calculated_estimate, not manual_actual', () => {
    expect(deriveProvenance('estimate', 'manual_entry')).toBe('calculated_estimate')
    expect(deriveProvenance('local_usage', 'manual_entry')).toBe('calculated_estimate')
    expect(deriveProvenance('provider_plan_estimate', 'manual_entry')).toBe('calculated_estimate')
  })

  it('maps actual_source=pending_permission to unknown -- genuinely not observable, never guessed', () => {
    expect(deriveProvenance('pending_permission', 'pending_permission')).toBe('unknown')
  })

  it('falls back to unknown for no_data / missing actual_source with no estimate confidence either', () => {
    expect(deriveProvenance(null, 'no_data')).toBe('unknown')
    expect(deriveProvenance(undefined, undefined)).toBe('unknown')
  })

  it('never returns imported_actual today -- no current collector produces it (reserved for future use)', () => {
    const allActualSources = ['provider_api', 'email_invoice', 'manual_entry', 'pending_permission', 'no_data', null, undefined]
    const allConfidences = ['manual', 'estimate', 'local_usage', 'provider_plan_estimate', 'actual_invoice', 'billing_export', null, undefined]
    for (const a of allActualSources) for (const c of allConfidences) {
      expect(deriveProvenance(c, a)).not.toBe('imported_actual')
    }
  })
})
