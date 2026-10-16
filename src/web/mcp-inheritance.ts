// MCPOROKLES923: which MCP servers may a NEW agent inherit? An explicit list.
//
// Owner decision (b), 2026-09-23: an agent inherits connectors only from a named
// list; everything else stays out until someone grants it by name. Before this,
// two paths handed a new agent the operator's connectors wholesale:
//   1. agent-scaffold.ts copied the project-root .mcp.json (here: aiam-blog);
//   2. agent-process.ts seeded the isolated .claude.json from a FULL copy of the
//      shared ~/.claude.json and gap-filled it on every spawn. Measured on the
//      reference install: google-drive and Filesystem (the owner's Drive, full
//      access) were in all 15 agents' configs; over the last 30 days 9 of 14
//      sub-agents never called google-drive and none ever called Filesystem.
// On a customer install ~/.claude.json is exactly where Claude Code puts the mail
// or bank connector, so "inherit everything" meant "every new agent gets the
// mailbox". One list, enforced on every writer, closes the concept rather than
// one endpoint.
//
// The default is the NARROW reading: an empty list inherits nothing. The list is
// configuration (AGENT_INHERITED_MCP_SERVERS), not code, because each install's
// connectors are its own.
//
// Scope, stated: this filters what is INHERITED. It never removes a server an
// agent already has (the gap-fill is additive), and it does not apply to the
// main agent, whose isolated config is by design a mirror of the operator's own
// ~/.claude.json. The scope-collision rule (agent-process.ts, 2026-09-05) runs
// in addition, never instead.

import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'

export const INHERITED_MCP_SETTING = 'AGENT_INHERITED_MCP_SERVERS'

/** The inheritable server names. Unreadable or empty setting -> empty set (narrow). */
export function readInheritableMcpServerNames(): Set<string> {
  let raw = ''
  try {
    raw = String(getEffectiveSettingValue(INHERITED_MCP_SETTING) ?? '')
  } catch {
    return new Set()
  }
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
}

/**
 * Split an mcpServers map into what may be inherited and the names that may not.
 * Pure: never mutates `servers`.
 */
export function filterInheritableMcpServers(
  servers: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, def] of Object.entries(servers)) {
    if (allowed.has(key)) kept[key] = def
    else dropped.push(key)
  }
  return { kept, dropped }
}

/**
 * The trace every refusal leaves: which servers were NOT inherited, by name only
 * (never the definition -- it can carry credentials), and on which path.
 */
export function logNotInherited(name: string, path: 'scaffold' | 'seed' | 'gap-fill', dropped: string[]): void {
  if (dropped.length === 0) return
  logger.info(
    { event: 'mcp-not-inherited', name, path, notInherited: dropped, setting: INHERITED_MCP_SETTING },
    'MCP inheritance: servers not on the inheritable list were not given to the agent',
  )
}
