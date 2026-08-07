import { describe, it, expect } from 'vitest'
import {
  planLocalFirst,
  summariseLocalFirst,
  isRoutableTaskClass,
  LOCALLY_CAPABLE_CLASSES,
  ROUTABLE_TASK_CLASSES,
} from '../costops/local-first.js'

// Eco mode's third state: which scheduled work could run on the local router
// instead of being paid for in the cloud.
//
// The measurement that shaped this: nothing in the fleet suspends a schedule
// on a cap breach today, so there is no behaviour here to "replace". This
// plans, and says why for every task -- including the ones that stay.

const task = (over: Partial<Parameters<typeof planLocalFirst>[0][number]> = {}) => ({
  name: 'some-task',
  enabled: true,
  ...over,
})

const verdictFor = (t: Parameters<typeof planLocalFirst>[0][number]) => planLocalFirst([t])[0]

describe('which tasks can move to the local router', () => {
  it('moves a task that declares a locally served class', () => {
    expect(verdictFor(task({ taskClass: 'structured' }))).toMatchObject({ verdict: 'local' })
  })

  it('leaves an unlabelled task in the cloud rather than guessing from its prompt', () => {
    // Guessing would put a cost decision on a heuristic nobody measured.
    expect(verdictFor(task({}))).toMatchObject({ verdict: 'cloud', reason: expect.stringMatching(/no task class/) })
  })

  it('never plans agent-loop work locally, even though the router knows the name', () => {
    // The router carries that class only so it can refuse it loudly. Treating
    // it as a local capability here would undo that on the other side.
    expect(verdictFor(task({ taskClass: 'agent-loop' }))).toMatchObject({ verdict: 'cloud' })
    expect(LOCALLY_CAPABLE_CLASSES).not.toContain('agent-loop')
  })

  it('leaves the memory heartbeat alone, as a named exemption', () => {
    const decision = verdictFor(task({ name: 'memoria-heartbeat', taskClass: 'summary' }))
    expect(decision).toMatchObject({ verdict: 'exempt' })
    expect(decision.reason).toMatch(/host session/)
  })

  it('says a shell command uses no model at all, rather than calling it cloud work', () => {
    // "cloud" would misreport the cost story: these tasks never pay a model.
    expect(verdictFor(task({ type: 'command', taskClass: 'structured' }))).toMatchObject({ verdict: 'no-llm' })
  })

  it('does not plan a disabled task', () => {
    expect(verdictFor(task({ enabled: false, taskClass: 'structured' }))).toMatchObject({ verdict: 'cloud' })
  })
})

describe('the plan as a whole', () => {
  const decisions = planLocalFirst([
    task({ name: 'digest', taskClass: 'structured' }),
    task({ name: 'briefing', taskClass: 'hungarian' }),
    task({ name: 'unlabelled' }),
    task({ name: 'memoria-heartbeat', taskClass: 'summary' }),
    task({ name: 'backup', type: 'command' }),
  ])

  it('gives every task a verdict, including the ones that stay', () => {
    // A plan that lists only the movers cannot be checked against the fleet.
    expect(decisions).toHaveLength(5)
    expect(decisions.every((d) => d.reason.length > 0)).toBe(true)
  })

  it('summarises in counts rather than adjectives', () => {
    const text = summariseLocalFirst(decisions)
    expect(text).toMatch(/2 scheduled task\(s\) can run on the local router/)
    expect(text).toMatch(/1 still need the cloud/)
    expect(text).toMatch(/1 exempt/)
    expect(text).toMatch(/1 use no model/)
  })
})

describe('the class label a schedule may declare', () => {
  it('accepts exactly the router classes, so the two lists cannot drift', () => {
    for (const name of ROUTABLE_TASK_CLASSES) expect(isRoutableTaskClass(name)).toBe(true)
  })

  it('rejects anything else, including a plausible near-miss', () => {
    expect(isRoutableTaskClass('json')).toBe(false)
    expect(isRoutableTaskClass('Structured')).toBe(false)
    expect(isRoutableTaskClass(undefined)).toBe(false)
  })
})
