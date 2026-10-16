import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getAgentMessage } from '../db.js'
import { initIngestDb, closeIngestDb, createHandoffMessage, COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { isUrgentDelivery } from '../web/message-router-window.js'
import { MAIN_AGENT_ID } from '../config.js'

// Card 795d1f48 (a): the channel ingest's handoff is the one agent_messages writer that does not name the urgent
// column, so its rows take the column's DEFAULT from the migration. That DEFAULT must stay 0: an urgent row is typed
// into a busy pane, and a DEFAULT of 1 would let every inbound channel message interrupt the main agent. The dashboard
// and the coordinator share one database file, so the test does too (two in-memory databases would be two tables).
let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'urgent-default-ingest-'))
  const file = join(dir, 'claudeclaw.db')
  initDatabase(file)
  initIngestDb(file)
})

afterAll(() => {
  closeIngestDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('a writer that does not name the urgent column (795d1f48 a)', () => {
  it('the channel ingest handoff row is ordinary: urgent 0, not an urgent delivery', () => {
    const id = createHandoffMessage('<channel source="telegram" chat_id="1">szia</channel>')
    const row = getAgentMessage(id)
    if (!row) throw new Error('the handoff row was not written to the shared database')
    expect(row.from_agent).toBe(COORDINATOR_AGENT_ID)
    expect(row.urgent).toBe(0)
    expect(isUrgentDelivery(row, MAIN_AGENT_ID)).toBe(false)
  })
})
