// Shared local-catalog helpers: which local agents (and which of their
// skills) are visible to federation surfaces. Extracted from
// routes/federation.ts so the capability-summary runner and the routing
// directory can reuse them without importing a route module (which would be
// a circular import once the route imports the summary cache).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { agentDir, listAgentNames } from '../agent-config.js'

// System/plumbing agents never cross the wire: a peer's chat sidebar and
// Agents view would otherwise fill with 'teodor/heartbeat'-style noise. The
// capability runner and the directory reuse the same set so no LLM call and
// no catalog row is ever spent on plumbing (defense-in-depth: heartbeat is
// normally sentinel-hidden from listAgentNames anyway).
export const MANIFEST_EXCLUDED_AGENTS = new Set<string>(['heartbeat', COORDINATOR_AGENT_ID, 'channel-coordinator'])

/** Local sub-agents visible to federation surfaces (manifest, directory,
 *  capability runner). The main agent is NOT in this list -- callers add it
 *  explicitly where it belongs. */
export function catalogAgentNames(): string[] {
  return listAgentNames().filter((n) => !MANIFEST_EXCLUDED_AGENTS.has(n))
}

// Frontmatter `description:` of a SKILL.md, single line, capped. Mirrors the
// dashboard's reader; shared here so the manifest, the directory and the
// capability-summary source hash all read skills identically.
export function readSkillDescription(skillDir: string): string {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')
    const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const block = fm ? fm[1] : md.slice(0, 600)
    const m = block.match(/^description:\s*(.+)$/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 300) : ''
  } catch {
    return ''
  }
}

// ONLY each sub-agent's own local skills (agents/<name>/.claude/skills). The
// main agent's skill root is the operator's personal ~/.claude/skills -- that
// inventory (names, projects, workflows) must never ship to a peer.
export function listAgentLocalSkills(agentName: string): Array<{ agent: string; name: string; description: string }> {
  const dir = join(agentDir(agentName), '.claude', 'skills')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => { try { return statSync(join(dir, f)).isDirectory() } catch { return false } })
      .map((f) => ({ agent: agentName, name: f, description: readSkillDescription(join(dir, f)) }))
  } catch {
    return []
  }
}
