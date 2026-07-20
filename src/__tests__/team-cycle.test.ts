import { describe, it, expect } from 'vitest'
import { reportsToCreatesCycle } from '../web/agent-team.js'

// Build a reportsTo reader backed by a plain map. Anyone not listed reports to
// null (i.e. defaults to the main agent), matching readAgentTeam's default.
function reader(chain: Record<string, string | null>) {
  return (name: string) => ({ reportsTo: name in chain ? chain[name] : null })
}

const MAIN = 'main'

describe('reportsToCreatesCycle', () => {
  it('allows a null / main-agent parent (no cycle possible)', () => {
    const read = reader({})
    expect(reportsToCreatesCycle('a', null, read, MAIN)).toBe(false)
    expect(reportsToCreatesCycle('a', MAIN, read, MAIN)).toBe(false)
  })

  it('rejects reporting to itself', () => {
    expect(reportsToCreatesCycle('a', 'a', reader({}), MAIN)).toBe(true)
  })

  it('allows a straightforward manager assignment', () => {
    // b reports to main; making a report to b is fine.
    const read = reader({ b: MAIN })
    expect(reportsToCreatesCycle('a', 'b', read, MAIN)).toBe(false)
  })

  it('rejects a direct two-node cycle', () => {
    // b already reports to a; making a report to b closes the loop.
    const read = reader({ b: 'a' })
    expect(reportsToCreatesCycle('a', 'b', read, MAIN)).toBe(true)
  })

  it('rejects a transitive cycle (dragging a manager under a grandchild)', () => {
    // a -> b -> c chain (c reports to b, b reports to a). Making a report to c
    // would close a three-node loop.
    const read = reader({ c: 'b', b: 'a', a: MAIN })
    expect(reportsToCreatesCycle('a', 'c', read, MAIN)).toBe(true)
  })

  it('terminates on a pre-existing loop that does not involve the agent', () => {
    // x <-> y already loop (bad data). Assigning a under x must not spin and
    // must not falsely report a cycle for `a`.
    const read = reader({ x: 'y', y: 'x' })
    expect(reportsToCreatesCycle('a', 'x', read, MAIN)).toBe(false)
  })
})
