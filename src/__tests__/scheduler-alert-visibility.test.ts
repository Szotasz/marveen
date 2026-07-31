import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { recordSchedulerAlert } from '../web/schedule-runner.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'

/**
 * Scheduler alerts leave through the bot directly, bypassing the main agent's
 * session. On 2026-07-29 that produced an exchange where the operator asked
 * about an alert and the agent truthfully denied sending it -- it had no record
 * the message existed. The agent was not wrong; it was uninformed, which is
 * worse, because a confident denial reads as fact.
 *
 * Two traces close it: a conversation_log row so the alert is in the agent's
 * own history, and an inter-agent message so the agent is told rather than
 * left to notice.
 */

const CHAT = '1061406155'
const TEXT = '[marveen scheduler] A(z) "kanban-audit" feladat 40 perce fut -- lehetseges beakadas.'
const NOW = 1_785_000_000

function freshDb() {
  initDatabase(':memory:')
  getDb().exec('DELETE FROM conversation_log; DELETE FROM agent_messages;')
}

const convRows = () => getDb().prepare('SELECT * FROM conversation_log').all() as Array<Record<string, unknown>>
const msgRows = () => getDb().prepare('SELECT * FROM agent_messages').all() as Array<Record<string, unknown>>

describe('recording an alert that went out', () => {
  beforeEach(freshDb)

  it('writes it to the conversation log as outbound', () => {
    recordSchedulerAlert(CHAT, TEXT, NOW)
    const rows = convRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent_id: MAIN_AGENT_ID, chat_id: CHAT, direction: 'out', text: TEXT, created_at: NOW,
    })
  })

  it('writes ts in the same ISO-8601 shape as every other row', () => {
    // ledger_lib.py writes an ISO string here and epoch seconds in created_at.
    // Putting the epoch in ts stores "1785000000.0" under TEXT affinity: a
    // silent format drift that only breaks whoever parses ts as a date.
    recordSchedulerAlert(CHAT, TEXT, NOW)
    expect(convRows()[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('leaves message_id null, because the send does not return one', () => {
    // sendTelegramMessage resolves void. Inventing an id would be worse than
    // admitting we do not have it, and NULLs stay distinct under the table's
    // UNIQUE(agent_id, chat_id, direction, message_id).
    recordSchedulerAlert(CHAT, TEXT, NOW)
    expect(convRows()[0].message_id).toBeNull()
  })

  it('does not collide when the same alert repeats', () => {
    recordSchedulerAlert(CHAT, TEXT, NOW)
    recordSchedulerAlert(CHAT, TEXT, NOW + 60)
    expect(convRows()).toHaveLength(2)
  })

  it('queues a copy for the main agent', () => {
    recordSchedulerAlert(CHAT, TEXT, NOW)
    const msgs = msgRows()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].to_agent).toBe(MAIN_AGENT_ID)
    expect(String(msgs[0].content)).toContain(TEXT)
  })

  it('says in the copy that it already went out', () => {
    // Without this the agent could read the copy as a request to send it,
    // and the operator would get the same alert twice.
    recordSchedulerAlert(CHAT, TEXT, NOW)
    expect(String(msgRows()[0].content)).toContain('mar kiment')
  })
})

describe('recording never breaks alerting', () => {
  beforeEach(freshDb)

  it('still queues the agent copy when the log write fails', () => {
    const db = getDb()
    const spy = vi.spyOn(db, 'prepare')
    spy.mockImplementationOnce(() => { throw new Error('table is locked') })
    expect(() => recordSchedulerAlert(CHAT, TEXT, NOW)).not.toThrow()
    spy.mockRestore()
    expect(msgRows()).toHaveLength(1)
  })

  it('does not throw out to the alerting path', () => {
    getDb().exec('DROP TABLE conversation_log')
    expect(() => recordSchedulerAlert(CHAT, TEXT, NOW)).not.toThrow()
  })
})

describe('it is wired into both places that send an alert', () => {
  // The point of the card is that these two sends were invisible. A helper
  // that exists but is called from neither would leave the bug exactly where
  // it was, and no logic test would notice.
  const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'schedule-runner.ts'), 'utf-8')

  it('is called after every sendTelegramMessage in the runner', () => {
    const sends = src.match(/await sendTelegramMessage\(token, ALLOWED_CHAT_ID, text\)\n\s*recordSchedulerAlert\(/g) ?? []
    const allSends = src.match(/await sendTelegramMessage\(/g) ?? []
    expect(allSends.length).toBeGreaterThan(0)
    expect(sends.length, 'a scheduler send exists that records nothing').toBe(allSends.length)
  })

  it('records only after the send, never before', () => {
    // Recording first would log an alert that may never have gone out -- the
    // same confident-but-wrong record this change removes.
    expect(src).not.toMatch(/recordSchedulerAlert\([^)]*\)\n\s*await sendTelegramMessage/)
  })
})
