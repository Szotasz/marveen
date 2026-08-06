import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN_AGENT_ID } from '../config.js'
import { withoutMainAgent, isMainChannelsAgent } from '../web/main-agent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentsSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')

describe('withoutMainAgent', () => {
  it('removes the main agent id from a list that contains it', () => {
    const result = withoutMainAgent([MAIN_AGENT_ID, 'agent-a', 'agent-b'])
    expect(result).not.toContain(MAIN_AGENT_ID)
    expect(result).toEqual(['agent-a', 'agent-b'])
  })

  it('leaves a list that does not contain the main agent unchanged', () => {
    const result = withoutMainAgent(['agent-a', 'agent-b'])
    expect(result).toEqual(['agent-a', 'agent-b'])
  })

  it('returns an empty list when given only the main agent', () => {
    expect(withoutMainAgent([MAIN_AGENT_ID])).toEqual([])
  })

  it('is consistent with isMainChannelsAgent', () => {
    const names = [MAIN_AGENT_ID, 'agent-a']
    const filtered = withoutMainAgent(names)
    for (const n of filtered) {
      expect(isMainChannelsAgent(n)).toBe(false)
    }
  })
})

// Structural guard: the activity endpoint must use withoutMainAgent so that the
// main agent is never pushed as a second isMain:false worker entry. The guard
// covers both the for-loop source and the model-suggest names variable.
describe('/api/agents/activity: main agent must not appear as a worker entry', () => {
  it('the activity worker loop uses withoutMainAgent (not a raw listAgentNames)', () => {
    // Isolate the activity handler block
    const startMarker = "if (path === '/api/agents/activity' && method === 'GET')"
    const endMarker = "if (path === '/api/agents/model-suggest'"
    const start = agentsSource.indexOf(startMarker)
    const end = agentsSource.indexOf(endMarker, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = agentsSource.slice(start, end)

    expect(block).toContain('withoutMainAgent(listAgentNames())')
    // The raw loop without the filter must not be present
    expect(block).not.toContain('for (const name of listAgentNames())')
  })
})

// Structural guard: model-suggest must not prepend MAIN_AGENT_ID onto a raw
// listAgentNames() result, which would include the main agent twice.
describe('/api/agents/model-suggest: main agent must not appear twice', () => {
  it('filters the main agent out of names before prepending MAIN_AGENT_ID', () => {
    const startMarker = "if (path === '/api/agents/model-suggest'"
    const endMarker = "if (path === '/api/agents' && method === 'POST')"
    const start = agentsSource.indexOf(startMarker)
    const end = agentsSource.indexOf(endMarker, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = agentsSource.slice(start, end)

    expect(block).toContain('withoutMainAgent(listAgentNames())')
    // Must not spread a raw listAgentNames() result
    expect(block).not.toMatch(/const names = listAgentNames\(\)\s*\n/)
  })
})
