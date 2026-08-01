import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase,
  createAgentMessage,
  deleteAgentMessages,
  getAgentConversation,
} from '../db.js'

// Reported by a user, 2026-08-01. They deleted the "quantumae" agent, but it
// stayed visible in the dashboard Messages view. DELETE /api/agents/:name
// removed the agent dir and cleaned team references, but never purged the
// agent_messages rows the agent had sent or received. Those orphaned rows kept
// the deleted agent alive as a phantom conversation partner.
//
// Fix: the handler calls deleteAgentMessages(name). The behavior of the purge
// is tested directly against an in-memory DB (idiom of agent-conversation.test.ts,
// never touching store/claudeclaw.db); the handler wiring is asserted at the
// source level (idiom of agent-create-no-destructive-rollback.test.ts, because
// the route drives tmux and the live agents dir and cannot be run in a harness).

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('deleteAgentMessages purges a removed agent from inter-agent messages', () => {
  it('removes every row the agent sent or received, and nothing else', () => {
    createAgentMessage('system', 'tdel-ghost', 'welcome')        // received
    createAgentMessage('tdel-ghost', 'marveen', 'i did a thing') // sent
    createAgentMessage('someone', 'tdel-other', 'unrelated')     // noise, must survive

    const removed = deleteAgentMessages('tdel-ghost')

    expect(removed).toBe(2)
    expect(getAgentConversation('tdel-ghost', 50).length).toBe(0)
    // A different agent's traffic must be untouched.
    expect(getAgentConversation('tdel-other', 50).length).toBe(1)
  })

  it('is a no-op (0 removed) for an agent with no messages', () => {
    expect(deleteAgentMessages('tdel-nobody')).toBe(0)
  })
})

describe('the DELETE /api/agents/:name handler wires in the message purge', () => {
  const SRC = join(import.meta.dirname, '..')

  function deleteHandlerBody(): string {
    const code = readFileSync(join(SRC, 'web/routes/agents.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const start = code.indexOf("agentMatch && method === 'DELETE'")
    expect(start, 'DELETE agent handler not found').toBeGreaterThan(-1)
    const end = code.indexOf('return true', code.indexOf('cleanupTeamReferences(name)', start))
    expect(end, 'DELETE handler end not found').toBeGreaterThan(start)
    return code.slice(start, end)
  }

  it('the delete handler calls deleteAgentMessages', () => {
    // Without this the purge exists but never runs on delete, and the ghost returns.
    expect(deleteHandlerBody()).toMatch(/deleteAgentMessages\(/)
  })
})
