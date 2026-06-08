import { describe, it, expect } from 'vitest'
import { sessionStartCardFields } from '../web/agent-session-card.js'

describe('sessionStartCardFields', () => {
  it('builds an in_progress, low-priority card on the agent-sessions board', () => {
    const f = sessionStartCardFields('cody', 'Cody', null)
    expect(f.status).toBe('in_progress')
    expect(f.priority).toBe('low')
    expect(f.project).toBe('agent-sessions')
    expect(f.assignee).toBe('cody')
    expect(f.title).toContain('Cody')
  })

  it('marks a local session as "local" in the description', () => {
    const f = sessionStartCardFields('cody', 'Cody', null)
    expect(f.description).toContain('local')
    expect(f.description).not.toContain('remote')
  })

  it('marks a remote session with its host in the description', () => {
    const f = sessionStartCardFields('cassie', 'Cassie', 'devbox')
    expect(f.description).toContain('remote: devbox')
  })
})
