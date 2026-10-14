// ownerQuestionHolds: the drain-aware "does the owner's open question hold this
// agent back" rule, shared by the /clear gate and the context-guard's daily
// tier. Tested end to end on an in-memory ledger and a temp drain statefile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { ownerQuestionHolds } from '../web/open-question.js'
import { registerCommand, clearCommandsForTest } from '../web/commands.js'

const AGENT = 'agent-a'
let store: string
let clock = 1_000_000

function logIn(mid: string, text: string): void {
  getDb().prepare(
    `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES (?, '42', 'in', ?, ?, '', ?)`,
  ).run(AGENT, mid, text, ++clock)
}

beforeEach(() => {
  initDatabase(':memory:')
  clearCommandsForTest()
  registerCommand({ name: 'new', kind: 'write', description: 'új', run: async () => {} })
  store = mkdtempSync(join(tmpdir(), 'owner-q-'))
})

afterEach(() => { rmSync(store, { recursive: true, force: true }) })

describe('ownerQuestionHolds', () => {
  it('nothing in the ledger: does not hold', () => {
    expect(ownerQuestionHolds(AGENT, store)).toBe(false)
  })

  it('an open question holds until the drain has surfaced exactly that message', () => {
    logIn('8246', 'mikor lesz kész?')
    expect(ownerQuestionHolds(AGENT, store)).toBe(true)
    writeFileSync(join(store, `.ledger-drain-${AGENT}`), '8240\n')
    expect(ownerQuestionHolds(AGENT, store)).toBe(true)
    writeFileSync(join(store, `.ledger-drain-${AGENT}`), '8246\n')
    expect(ownerQuestionHolds(AGENT, store)).toBe(false)
  })

  it('a registry command as the newest inbound does not hold', () => {
    logIn('9001', '/new')
    expect(ownerQuestionHolds(AGENT, store)).toBe(false)
  })

  it('reads the statefile of this agent only', () => {
    logIn('8246', 'kérdés')
    writeFileSync(join(store, '.ledger-drain-agent-b'), '8246\n')
    expect(ownerQuestionHolds(AGENT, store)).toBe(true)
  })
})
