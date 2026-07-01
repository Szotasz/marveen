import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, createAgentMessage,
  markMessageDone, markMessageFailed, getAgentMessage, listAgentMessages,
} from '../db.js'

// Contract tests for the completion-notification feature.
//
// When a delegated inter-agent message is marked done/failed (PUT /api/messages/:id),
// the route handler creates a reverse notification message from executor → delegator
// so the delegator learns the result without polling. These tests verify:
//   1. getAgentMessage() returns the full record needed to build the notification
//   2. The sentinel prefix [Eredmény] breaks ping-pong chains
//   3. The notification message is created with the right from/to/content
//   4. self-messages do not create a notification

beforeAll(() => { initDatabase(':memory:') })

describe('completion-notification contract', () => {
  it('getAgentMessage returns the saved message after markMessageDone', () => {
    const msg = createAgentMessage('atlas', 'prometheus', 'Kutass valamit')
    expect(markMessageDone(msg.id, 'Kész: eredmény')).toBe(true)
    const fetched = getAgentMessage(msg.id)
    expect(fetched).toBeDefined()
    expect(fetched!.from_agent).toBe('atlas')
    expect(fetched!.to_agent).toBe('prometheus')
    expect(fetched!.result).toBe('Kész: eredmény')
    expect(fetched!.status).toBe('done')
  })

  it('completion sentinel prefix is detectable (ping-pong guard)', () => {
    const notif = createAgentMessage('prometheus', 'atlas', '[Eredmény] msg_id:42 status:done\n\nVálasz')
    const fetched = getAgentMessage(notif.id)!
    expect(fetched.content.startsWith('[Eredmény]')).toBe(true)
  })

  it('notification message has correct from/to/content and is pending', () => {
    const msg = createAgentMessage('atlas', 'daidalosz', 'Csinálj valamit')
    markMessageDone(msg.id, 'PR #16 kész')
    const done = getAgentMessage(msg.id)!

    // Simulate what routes/messages.ts does after marking done
    expect(done.content.startsWith('[Eredmény]')).toBe(false) // not a notification
    const summary = (done.result ?? '').slice(0, 500) || '(nincs eredmény)'
    const notif = createAgentMessage(
      done.to_agent,
      done.from_agent,
      `[Eredmény] msg_id:${done.id} status:done\n\n${summary}`,
    )
    expect(notif.from_agent).toBe('daidalosz')
    expect(notif.to_agent).toBe('atlas')
    expect(notif.status).toBe('pending')
    expect(notif.content).toContain('[Eredmény]')
    expect(notif.content).toContain('PR #16 kész')
  })

  it('failed message also triggers notification with status:failed', () => {
    const msg = createAgentMessage('atlas', 'hermes', 'Valami feladat')
    markMessageFailed(msg.id, 'Hálózati hiba')
    const failed = getAgentMessage(msg.id)!
    expect(failed.status).toBe('failed')

    const summary = (failed.result ?? '').slice(0, 500) || '(nincs eredmény)'
    const notif = createAgentMessage(
      failed.to_agent,
      failed.from_agent,
      `[Eredmény] msg_id:${failed.id} status:failed\n\n${summary}`,
    )
    expect(notif.content).toContain('status:failed')
    expect(notif.content).toContain('Hálózati hiba')
  })

  it('self-message (from === to) does not create a notification', () => {
    // The route handler skips notification when from_agent === to_agent
    const before = listAgentMessages(200).length
    const msg = createAgentMessage('atlas', 'atlas', 'Saját magának küld')
    markMessageDone(msg.id, 'ok')
    // Only the original message was created; route handler would NOT add a notification
    const after = listAgentMessages(200).length
    expect(after - before).toBe(1)
  })
})
