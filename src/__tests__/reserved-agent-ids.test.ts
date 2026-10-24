// FLEETRESERVEDNAME1021: RESERVED_AGENT_IDS is a literal list (the migration
// script keeps the same one in shell), so it is pinned here to the constants
// that make each id reserved, and to the script's copy.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESERVED_AGENT_IDS } from '../web/sanitize.js'
import { SYSTEM_DIRECTIVE_SENDER } from '../web/system-directive.js'
import { HEARTBEAT_AGENT_ID } from '../config.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { CHAT_SYSTEM_AGENTS } from '../db.js'

describe('RESERVED_AGENT_IDS', () => {
  it('is exactly the ids the message layer owns', () => {
    const owned = new Set<string>([
      SYSTEM_DIRECTIVE_SENDER, HEARTBEAT_AGENT_ID, COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID, ...CHAT_SYSTEM_AGENTS,
    ])
    expect([...RESERVED_AGENT_IDS].sort()).toEqual([...owned].sort())
  })

  it('matches the list in scripts/migrate-main-agent-id.sh', () => {
    const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate-main-agent-id.sh'), 'utf-8')
    const m = script.match(/^RESERVED_AGENT_IDS="([^"]*)"$/m)
    expect(m).not.toBeNull()
    expect(m![1].split(/\s+/).filter(Boolean).sort()).toEqual([...RESERVED_AGENT_IDS].sort())
  })
})
