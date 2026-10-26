// ROSTERALIAS1026: one agent's hook-seeding failure must not leave the agents
// after it in the list unseeded. forEachAgentIsolated runs each agent on its
// own, reports failures, and keeps going; src/web.ts must use it instead of a
// plain for-loop swallowed by the one shared try/catch.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { forEachAgentIsolated } from '../web/agent-seed-loop.js'

describe('forEachAgentIsolated', () => {
  it('one agent throwing does not stop the loop', () => {
    const boom = new Error('boom')
    const seed = vi.fn((name: string) => {
      if (name === 'b') throw boom
    })
    const onError = vi.fn()
    const failed = forEachAgentIsolated(['a', 'b', 'c'], seed, onError)
    expect(seed.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('b')
    expect(onError.mock.calls[0][1]).toBe(boom)
    expect(failed).toEqual(['b'])
  })

  it('returns [] and never calls onError when nothing throws', () => {
    const seed = vi.fn()
    const onError = vi.fn()
    expect(forEachAgentIsolated(['a', 'b', 'c'], seed, onError)).toEqual([])
    expect(seed.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c'])
    expect(onError).not.toHaveBeenCalled()
  })

  it('a throwing onError does not stop the loop either', () => {
    const seed = vi.fn((name: string) => {
      if (name === 'b') throw new Error('boom')
    })
    const onError = vi.fn(() => {
      throw new Error('reporting failed')
    })
    const failed = forEachAgentIsolated(['a', 'b', 'c'], seed, onError)
    expect(seed.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c'])
    expect(failed).toEqual(['b'])
  })

  it('src/web.ts seeds through forEachAgentIsolated, not one shared loop', () => {
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    expect(src).toContain('forEachAgentIsolated([MAIN_AGENT_ID, ...listAllAgentNames()]')
    expect(src).not.toContain('for (const agentName of [MAIN_AGENT_ID, ...listAllAgentNames()])')
  })
})
