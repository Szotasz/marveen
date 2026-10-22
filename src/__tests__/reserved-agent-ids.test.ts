// FLEETRESERVEDNAME1021: FIXED_RESERVED_AGENT_IDS is a literal list (the migration
// script keeps the same one in shell), so it is pinned here to the constants
// that make each id reserved, and to the script's copy. The voice channel id is
// the one in effect (VOICECHANNELID1022): config.ts builds RESERVED_AGENT_IDS, and
// the script appends the VOICE_CHANNEL_ID it resolves from .env (none when off).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXED_RESERVED_AGENT_IDS } from '../web/sanitize.js'
import { SYSTEM_DIRECTIVE_SENDER } from '../web/system-directive.js'
import { HEARTBEAT_AGENT_ID, VOICE_CHANNEL_ID, RESERVED_AGENT_IDS } from '../config.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { CHAT_SYSTEM_AGENTS } from '../db.js'

describe('RESERVED_AGENT_IDS', () => {
  it('is exactly the ids the message layer owns', () => {
    const owned = new Set<string>([
      SYSTEM_DIRECTIVE_SENDER, HEARTBEAT_AGENT_ID, COORDINATOR_AGENT_ID, ...CHAT_SYSTEM_AGENTS,
      ...(VOICE_CHANNEL_AGENT_ID === null ? [] : [VOICE_CHANNEL_AGENT_ID]),
    ])
    expect([...RESERVED_AGENT_IDS].sort()).toEqual([...owned].sort())
  })

  it('matches the list in scripts/migrate-main-agent-id.sh', () => {
    const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate-main-agent-id.sh'), 'utf-8')
    const m = script.match(/^RESERVED_AGENT_IDS="([^"$]*)"$/m)
    expect(m).not.toBeNull()
    const fixed = m![1].split(/\s+/).filter(Boolean)
    expect([...fixed].sort()).toEqual([...FIXED_RESERVED_AGENT_IDS].sort())
    // The voice id is appended only when the lane is on, as in config.ts.
    expect(script).toMatch(/^if \[ -n "\$VOICE_CHANNEL_ID" \]; then\n\s+RESERVED_AGENT_IDS="\$RESERVED_AGENT_IDS \$VOICE_CHANNEL_ID"\nfi$/m)
    const full = VOICE_CHANNEL_ID === null ? fixed : [...fixed, VOICE_CHANNEL_ID]
    expect([...full].sort()).toEqual([...RESERVED_AGENT_IDS].sort())
  })
})
