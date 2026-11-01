// VOICETOKENLEAK1101 (Dani 64894 (1)): the main agent's hand-back names the owner, whose name may hold a space or
// accents ("Kovács Anna"). The recipe quotes it, so the helper gets ONE assignee, not two words. Run for real.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), OWNER_NAME: 'Kovács Anna' }))

const { kanbanMoveInstructions } = await import('../web/routes/kanban.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { runRecipeLine } = await import('./helpers/kanban-recipe.js')

describe('the main agent hands a card back to an owner whose name has a space', () => {
  it('the assign line sends the whole name as one assignee', async () => {
    const out = kanbanMoveInstructions('abc123', MAIN_AGENT_ID)
    const line = out.split('\n').find((l) => l.includes('marveen-api.sh kanban-assign abc123 '))!
    expect(line).toBeDefined()
    const sent = await runRecipeLine(line)
    expect([sent.method, sent.url, sent.body]).toEqual(['PUT', '/api/kanban/abc123', { assignee: 'Kovács Anna', actor: MAIN_AGENT_ID }])
  })
})
