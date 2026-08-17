import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, createAgentMessage,
  markMessageDone, markMessageFailed, getAgentMessage, listAgentMessages,
  COMPLETION_REPORT_PREFIX,
} from '../db.js'
import { shouldNotifyDelegator } from '../web/routes/messages.js'
import { MAIN_AGENT_ID } from '../config.js'

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
    const msg = createAgentMessage('orin', 'dex', 'Research something')
    expect(markMessageDone(msg.id, 'Done: result')).toBe(true)
    const fetched = getAgentMessage(msg.id)
    expect(fetched).toBeDefined()
    expect(fetched!.from_agent).toBe('orin')
    expect(fetched!.to_agent).toBe('dex')
    expect(fetched!.result).toBe('Done: result')
    expect(fetched!.status).toBe('done')
  })

  it('completion sentinel prefix is detectable (ping-pong guard)', () => {
    const notif = createAgentMessage('dex', 'orin', '[Eredmény] msg_id:42 status:done\n\nreply')
    const fetched = getAgentMessage(notif.id)!
    expect(fetched.content.startsWith('[Eredmény]')).toBe(true)
  })

  it('notification message has correct from/to/content and is pending', () => {
    const msg = createAgentMessage('orin', 'rex', 'Do something')
    markMessageDone(msg.id, 'PR opened')
    const done = getAgentMessage(msg.id)!

    // Simulate what routes/messages.ts does after marking done
    expect(done.content.startsWith('[Eredmény]')).toBe(false) // not a notification
    const summary = (done.result ?? '').slice(0, 500) || '(nincs eredmény)'
    const notif = createAgentMessage(
      done.to_agent,
      done.from_agent,
      `[Eredmény] msg_id:${done.id} status:done\n\n${summary}`,
    )
    expect(notif.from_agent).toBe('rex')
    expect(notif.to_agent).toBe('orin')
    expect(notif.status).toBe('pending')
    expect(notif.content).toContain('[Eredmény]')
    expect(notif.content).toContain('PR opened')
  })

  it('failed message also triggers notification with status:failed', () => {
    const msg = createAgentMessage('orin', 'lex', 'Some task')
    markMessageFailed(msg.id, 'Network error')
    const failed = getAgentMessage(msg.id)!
    expect(failed.status).toBe('failed')

    const summary = (failed.result ?? '').slice(0, 500) || '(nincs eredmény)'
    const notif = createAgentMessage(
      failed.to_agent,
      failed.from_agent,
      `[Eredmény] msg_id:${failed.id} status:failed\n\n${summary}`,
    )
    expect(notif.content).toContain('status:failed')
    expect(notif.content).toContain('Network error')
  })

  it('self-message (from === to) does not create a notification', () => {
    // The route handler skips notification when from_agent === to_agent
    const before = listAgentMessages(200).length
    const msg = createAgentMessage('orin', 'orin', 'Send to self')
    markMessageDone(msg.id, 'ok')
    // Only the original message was created; route handler would NOT add a notification
    const after = listAgentMessages(200).length
    expect(after - before).toBe(1)
  })
})

// The tests above simulate the route's decision by re-implementing it. These call the
// exported predicate the route actually uses, so a change to the condition shows up here.
//
// Sender identities are deliberately MAIN_AGENT_ID and 'system' rather than invented
// names: `isKnownAgent` resolves real agent directories, and a CI checkout has none, so
// a made-up sender would be "unknown" there and the positive case would fail for the
// wrong reason.
describe('shouldNotifyDelegator', () => {
  it('notifies a real agent delegator', () => {
    expect(shouldNotifyDelegator(MAIN_AGENT_ID, 'dex', 'Research something')).toBe(true)
  })

  it('does not notify the `system` pseudo-sender', () => {
    // system posts [session-stuck]/[handoff-failure] but has no session to receive a
    // reply. Before this guard, the undeliverable reply produced another
    // [handoff-failure], which produced another reply when closed.
    expect(
      shouldNotifyDelegator('system', MAIN_AGENT_ID, "[session-stuck] Agent 'polip' ..."),
    ).toBe(false)
  })

  it('does not notify on a self-message', () => {
    expect(shouldNotifyDelegator(MAIN_AGENT_ID, MAIN_AGENT_ID, 'Send to self')).toBe(false)
  })

  it('does not notify when the content is already a completion report', () => {
    expect(
      shouldNotifyDelegator(MAIN_AGENT_ID, 'dex', `${COMPLETION_REPORT_PREFIX} msg_id:1 status:done`),
    ).toBe(false)
  })

  it('rejects an empty sender rather than treating it as an agent', () => {
    expect(shouldNotifyDelegator('', 'dex', 'orphan')).toBe(false)
  })
})
