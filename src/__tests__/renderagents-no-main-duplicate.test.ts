import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

// Structural guard: renderAgents() must skip the main agent entry from the
// /api/agents list, because the main agent is already rendered as the dedicated
// Marveen card. Without the guard a second card appears once the agents/<id>/
// config directory is created (regression introduced after #40).
describe('renderAgents: main agent must not appear as a second card', () => {
  it('the agents for-loop contains a mainAgentId() skip guard', () => {
    const startMarker = 'for (const agent of agents) {'
    const endMarker = 'renderFederatedAgentCards('
    const start = appSource.indexOf(startMarker)
    expect(start).toBeGreaterThan(-1)

    const end = appSource.indexOf(endMarker, start)
    expect(end).toBeGreaterThan(start)

    const block = appSource.slice(start, end)

    // The guard must be present inside the loop
    expect(block).toContain('mainAgentId()')
    expect(block).toContain('continue')

    // The guard must precede the card creation
    const guardPos = block.indexOf('mainAgentId()')
    const cardPos = block.indexOf('document.createElement')
    expect(guardPos).toBeLessThan(cardPos)
  })
})
