import { describe, it, expect } from 'vitest'
import {
  planRoute,
  estimatePromptTokens,
  TASK_CLASSES,
  type HostHealth,
} from '../llm-router/routing.js'

// The routing table from docs/eco-mode-local-router-plan.md section 4, as code.
//
// The plan's measurements are the reason each rule exists, and they are the
// reason the rules belong HERE rather than in a prompt convention: a caller
// that forgets `think: false` gets an empty answer from gemma, and a caller
// that sends a 12k prompt to StrikeX waits two minutes for prompt evaluation
// alone. The router must be impossible to misuse from outside.

const allHealthy: HostHealth = { air903max: true, strikex: true }
const airDown: HostHealth = { air903max: false, strikex: true }
const bothDown: HostHealth = { air903max: false, strikex: false }
const nothingBusy = new Set<string>()

const route = (taskClass: string, over: Partial<Parameters<typeof planRoute>[0]> = {}) =>
  planRoute({
    taskClass,
    promptTokens: 500,
    health: allHealthy,
    busyHosts: nothingBusy,
    ...over,
  })

/**
 * The same call, narrowed to a real target.
 *
 * A refusal here is a test failure with a useful message rather than an
 * undefined property three lines later -- and it means every assertion below
 * also asserts that the request was not refused.
 */
const routed = (taskClass: string, over: Partial<Parameters<typeof planRoute>[0]> = {}) => {
  const plan = route(taskClass, over)
  if (plan.refused) throw new Error(`expected a target for "${taskClass}", got refusal: ${plan.refused} (${plan.detail})`)
  return plan
}

describe('each class lands on the machine the measurements chose', () => {
  it('sends structured extraction to air903max/qwen3-coder', () => {
    expect(route('structured')).toMatchObject({ host: 'air903max', model: 'qwen3-coder:latest' })
  })

  it('sends Hungarian user-facing text to gemma', () => {
    expect(route('hungarian')).toMatchObject({ host: 'air903max', model: 'gemma4:31b-magyar' })
  })

  it('sends code work to laguna', () => {
    expect(route('code')).toMatchObject({ host: 'air903max', model: 'laguna-xs.2:fixed' })
  })

  it('treats an unknown class as the general one rather than refusing', () => {
    // The plan: the caller either names a class or gets the default. An
    // unknown label is a caller mistake we can absorb safely -- the general
    // route is the conservative one.
    expect(route('something-we-never-defined')).toMatchObject({ host: 'air903max', model: 'qwen3-coder:latest' })
  })
})

describe('the rules the caller must not be able to break', () => {
  it('always talks to laguna over chat, thinking on', () => {
    // Measured: /api/generate degenerates, and structured work needs think.
    const plan = routed('code')
    expect(plan.endpoint).toBe('/api/chat')
    expect(plan.options).toMatchObject({ think: true })
  })

  it('always turns gemma thinking off', () => {
    // Measured: gemma4 in its default thinking mode returns an EMPTY answer
    // under ollama. A caller cannot be trusted to remember that.
    expect(routed('hungarian').options).toMatchObject({ think: false })
  })

  it('ignores a caller trying to turn gemma thinking back on', () => {
    const plan = routed('hungarian', { callerOptions: { think: true, temperature: 0.2 } })
    expect(plan.options).toMatchObject({ think: false })
    // Harmless caller options still come through: this is a guard, not a cage.
    expect(plan.options).toMatchObject({ temperature: 0.2 })
  })
})

describe('when the primary machine is not there', () => {
  it('falls back to StrikeX for the classes that measured no capability drop', () => {
    expect(route('structured', { health: airDown })).toMatchObject({
      host: 'strikex',
      model: 'qwen3:14b',
    })
  })

  it('falls back to the small coder model for code', () => {
    expect(route('code', { health: airDown })).toMatchObject({ host: 'strikex', model: 'qwen2.5-coder:14b' })
  })

  it('refuses rather than inventing a target when both are down', () => {
    expect(route('structured', { health: bothDown })).toMatchObject({ refused: 'no-healthy-host' })
  })
})

describe('the prompt-size rule that protects StrikeX', () => {
  it('keeps long-context work on air903max only', () => {
    expect(route('long-context')).toMatchObject({ host: 'air903max' })
  })

  it('refuses long-context work when air903max is down instead of sending it to StrikeX', () => {
    // Measured: StrikeX evaluates a long prompt for one to two minutes. The
    // plan calls this the cloud case, and the honest local answer is no.
    expect(route('long-context', { health: airDown, promptTokens: 12_000 })).toMatchObject({
      refused: 'no-local-capacity',
    })
  })

  it('will not send an oversized prompt to StrikeX even for a class that normally falls back', () => {
    expect(route('structured', { health: airDown, promptTokens: 9_000 })).toMatchObject({
      refused: 'prompt-too-long-for-fallback',
    })
  })

  it('still allows a short prompt on the fallback', () => {
    expect(route('structured', { health: airDown, promptTokens: 4_000 })).toMatchObject({ host: 'strikex' })
  })
})

describe('what the router will not pretend to do', () => {
  it('refuses agent-loop and tool-use work outright', () => {
    // Not measured, explicitly a non-goal in the plan. Routing it locally
    // would be a guess presented as a capability.
    expect(route('agent-loop')).toMatchObject({ refused: 'cloud-only' })
  })
})

describe('busy machines, with no queue in this phase', () => {
  it('uses the fallback when the primary is busy', () => {
    expect(route('structured', { busyHosts: new Set(['air903max']) })).toMatchObject({ host: 'strikex' })
  })

  it('refuses when every eligible machine is busy, rather than queueing', () => {
    // One request per machine is the VRAM reality. Waiting would hide the
    // contention; refusing lets the caller decide (cloud, retry, or later).
    expect(route('structured', { busyHosts: new Set(['air903max', 'strikex']) })).toMatchObject({
      refused: 'all-busy',
    })
  })

  it('refuses long-context work when its only machine is busy', () => {
    expect(route('long-context', { busyHosts: new Set(['air903max']) })).toMatchObject({ refused: 'all-busy' })
  })
})

describe('the prompt-size estimate', () => {
  it('is conservative: it would rather overestimate than let a long prompt through', () => {
    const text = 'a'.repeat(4000)
    expect(estimatePromptTokens([{ role: 'user', content: text }])).toBeGreaterThanOrEqual(1000)
  })

  it('counts every message, not just the last one', () => {
    const one = estimatePromptTokens([{ role: 'user', content: 'x'.repeat(400) }])
    const three = estimatePromptTokens([
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'x'.repeat(400) },
    ])
    expect(three).toBeGreaterThan(one * 2)
  })
})

describe('the table itself', () => {
  it('names every class the plan defines', () => {
    expect(Object.keys(TASK_CLASSES).sort()).toEqual(
      ['agent-loop', 'code', 'general', 'hungarian', 'long-context', 'structured', 'summary'].sort(),
    )
  })
})
