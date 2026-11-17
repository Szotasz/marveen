// FLEETRESERVEDNAME1021: FIXED_RESERVED_AGENT_IDS is built from two literal lists
// (the migration script keeps the same two in shell), so the message layer part is
// pinned here to the constants that make each id reserved, and both parts to the
// script's copies. The route names (AGENTROUTERESERVED1114) are pinned to the routes
// themselves in agent-route-reserved-names.test.ts. The voice channel id is
// the one in effect (VOICECHANNELID1022): config.ts builds RESERVED_AGENT_IDS, and
// the script appends the VOICE_CHANNEL_ID it resolves from .env (none when off).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXED_RESERVED_AGENT_IDS, MESSAGE_LAYER_RESERVED_AGENT_IDS, AGENT_ROUTE_RESERVED_IDS } from '../web/sanitize.js'
import { SYSTEM_DIRECTIVE_SENDER } from '../web/system-directive.js'
import { HEARTBEAT_AGENT_ID, VOICE_CHANNEL_ID, RESERVED_AGENT_IDS } from '../config.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { CHAT_SYSTEM_AGENTS } from '../db.js'

describe('RESERVED_AGENT_IDS', () => {
  it('is exactly the ids the message layer owns, plus the fixed route names of the agents API', () => {
    const owned = new Set<string>([
      SYSTEM_DIRECTIVE_SENDER, HEARTBEAT_AGENT_ID, COORDINATOR_AGENT_ID, ...CHAT_SYSTEM_AGENTS,
      ...(VOICE_CHANNEL_AGENT_ID === null ? [] : [VOICE_CHANNEL_AGENT_ID]),
    ])
    const messageLayer = RESERVED_AGENT_IDS.filter((id) => !AGENT_ROUTE_RESERVED_IDS.includes(id))
    expect([...messageLayer].sort()).toEqual([...owned].sort())
    expect([...RESERVED_AGENT_IDS].sort()).toEqual([...owned, ...AGENT_ROUTE_RESERVED_IDS].sort())
    // No id is in both parts: the filter above would otherwise hide a message layer id.
    expect(MESSAGE_LAYER_RESERVED_AGENT_IDS.filter((id) => AGENT_ROUTE_RESERVED_IDS.includes(id))).toEqual([])
  })

  it('matches the list in scripts/migrate-main-agent-id.sh', () => {
    const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate-main-agent-id.sh'), 'utf-8')
    const list = (name: string) => {
      const m = script.match(new RegExp(`^${name}="([^"$]*)"$`, 'm'))
      expect([name, m !== null]).toEqual([name, true])
      return m![1].split(/\s+/).filter(Boolean)
    }
    const messageLayer = list('MESSAGE_LAYER_RESERVED_AGENT_IDS')
    const routes = list('AGENT_ROUTE_RESERVED_IDS')
    expect([...messageLayer].sort()).toEqual([...MESSAGE_LAYER_RESERVED_AGENT_IDS].sort())
    expect([...routes].sort()).toEqual([...AGENT_ROUTE_RESERVED_IDS].sort())
    // The list the new id is checked against is both parts, as FIXED_RESERVED_AGENT_IDS is.
    expect(script).toMatch(/^RESERVED_AGENT_IDS="\$MESSAGE_LAYER_RESERVED_AGENT_IDS \$AGENT_ROUTE_RESERVED_IDS"$/m)
    const fixed = [...messageLayer, ...routes]
    expect([...fixed].sort()).toEqual([...FIXED_RESERVED_AGENT_IDS].sort())
    // Both voice id resolutions get the message layer ids only, as resolveVoiceChannelId does.
    const resolverCalls = [...script.matchAll(/="\$\(resolve_voice_channel_id "[^"]+" "\$([A-Z_]+)" /g)].map((c) => c[1])
    expect(resolverCalls).toEqual(['MESSAGE_LAYER_RESERVED_AGENT_IDS', 'MESSAGE_LAYER_RESERVED_AGENT_IDS'])
    // The voice id is appended only when the lane is on, as in config.ts.
    expect(script).toMatch(/^if \[ -n "\$VOICE_CHANNEL_ID" \]; then\n\s+RESERVED_AGENT_IDS="\$RESERVED_AGENT_IDS \$VOICE_CHANNEL_ID"\nfi$/m)
    const full = VOICE_CHANNEL_ID === null ? fixed : [...fixed, VOICE_CHANNEL_ID]
    expect([...full].sort()).toEqual([...RESERVED_AGENT_IDS].sort())
  })
})
