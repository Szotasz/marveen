// --- Team / hierarchy ---
//
// Each agent can declare its role (leader | member), who it reports to, who it
// delegates to, and whether it's allowed to split a task by itself. Mostly
// routing + visualization for multi-tier setups, with ONE security hook:
// resolveSecurityProfileId() derives the applier-pool from `role` (a `leader`
// is the install's tech-lead and keeps Supabase; everyone else is deny-by-default).

import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir, readFileOr, listAgentNames, readAgentSecurityProfile } from './agent-config.js'

export interface TeamConfig {
  role: 'leader' | 'member'
  reportsTo: string | null
  delegatesTo: string[]
  autoDelegation: boolean
  // Optional override so an operator can grant "trusted peer" status to an
  // agent outside the usual reportsTo / delegatesTo derivation -- e.g. a
  // cross-team collaborator. Unknown names and self-references are stripped
  // at write time (see writeAgentTeam + sanitizeTeamConfig).
  trustFrom?: string[]
}

export const DEFAULT_TEAM: TeamConfig = {
  role: 'member',
  reportsTo: null,
  delegatesTo: [],
  autoDelegation: false,
  trustFrom: [],
}

export function readAgentTeam(name: string): TeamConfig {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const raw = config.team
    if (raw && typeof raw === 'object') {
      const role = raw.role === 'leader' ? 'leader' : 'member'
      const reportsTo = typeof raw.reportsTo === 'string' && raw.reportsTo.trim() ? raw.reportsTo.trim() : null
      const delegatesTo = Array.isArray(raw.delegatesTo) ? raw.delegatesTo.filter((x: unknown) => typeof x === 'string') : []
      const autoDelegation = !!raw.autoDelegation
      const trustFrom = Array.isArray(raw.trustFrom) ? raw.trustFrom.filter((x: unknown) => typeof x === 'string') : []
      return { role, reportsTo, delegatesTo, autoDelegation, trustFrom }
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_TEAM, trustFrom: [] }
}

/**
 * Resolve an agent's effective security profile (per-agent Supabase governance,
 * 2026-06-22). Pure + name-agnostic so it is testable and distribution-safe:
 *
 *  - An EXPLICIT non-default stored profile wins (e.g. an agent pinned to
 *    'sub-dev' or 'applier' on this install).
 *  - Otherwise it is ROLE-derived: a `leader` (the install's tech-lead) joins
 *    the applier-pool ('applier' = Supabase retained); everyone else gets the
 *    deny-by-default 'default'. The rule keys off ROLE, never a hardcoded agent
 *    name, so a customer install elevates ITS OWN tech-lead, not ours.
 *
 * NOTE: `reportsTo === null` is the DEFAULT_TEAM value, so it must NOT be the
 * applier signal -- that would exempt every default/new agent and defeat the
 * deny-by-default. The signal is `role === 'leader'`.
 *
 * MAIN_AGENT_ID is exempt by construction: the main agent is not profile-managed
 * (it runs from the host, account-level), so this resolver is never called for it.
 */
export function resolveSecurityProfileId(
  storedProfile: string | null | undefined,
  team: Pick<TeamConfig, 'role'>,
): string {
  const explicit = typeof storedProfile === 'string' ? storedProfile.trim() : ''
  if (explicit && explicit !== 'default') return explicit
  return team.role === 'leader' ? 'applier' : 'default'
}

/** Read-and-resolve convenience over resolveSecurityProfileId for a live agent. */
export function resolveAgentSecurityProfile(name: string): string {
  return resolveSecurityProfileId(readAgentSecurityProfile(name), readAgentTeam(name))
}

export function writeAgentTeam(name: string, team: TeamConfig): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.team = team
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

// Scrub self-references and unknown agent names from a TeamConfig's name
// fields. Returns the cleaned config plus a warnings object the caller
// (the PUT handler) can surface to the UI so an operator isn't silently
// missing the name they just typed.
export interface TeamSanitizeWarnings {
  droppedSelf: string[]   // field names that referenced the agent itself
  droppedUnknown: string[]  // agent ids not present on disk + not MAIN
}

export function sanitizeTeamConfig(
  agentName: string,
  team: TeamConfig,
): { team: TeamConfig; warnings: TeamSanitizeWarnings } {
  const known = new Set<string>(listAgentNames())
  known.add(MAIN_AGENT_ID)
  const warnings: TeamSanitizeWarnings = { droppedSelf: [], droppedUnknown: [] }

  const cleanList = (ids: string[], fieldName: string): string[] => {
    const out: string[] = []
    for (const id of ids) {
      if (id === agentName) {
        if (!warnings.droppedSelf.includes(fieldName)) warnings.droppedSelf.push(fieldName)
        continue
      }
      if (!known.has(id)) {
        warnings.droppedUnknown.push(id)
        continue
      }
      if (!out.includes(id)) out.push(id)  // de-dupe too
    }
    return out
  }

  let reportsTo = team.reportsTo
  if (reportsTo === agentName) {
    warnings.droppedSelf.push('reportsTo')
    reportsTo = null
  } else if (reportsTo && !known.has(reportsTo)) {
    warnings.droppedUnknown.push(reportsTo)
    reportsTo = null
  }

  return {
    team: {
      role: team.role,
      reportsTo,
      delegatesTo: cleanList(team.delegatesTo, 'delegatesTo'),
      autoDelegation: team.autoDelegation,
      trustFrom: cleanList(team.trustFrom ?? [], 'trustFrom'),
    },
    warnings,
  }
}

// Guard against reporting cycles before persisting a new reportsTo. Dragging a
// manager under one of its own (transitive) reports in the Team graph would
// otherwise create a loop (A reports to B, B reports to A), detaching the whole
// subtree from the main agent -- the render only reaches nodes from MAIN, so a
// cycle silently orphans everyone in it. Pure + reader-injected so it is
// testable without touching disk.
//
// Semantics: `reportsTo` is the manager. Setting agentName.reportsTo =
// proposedReportsTo forms the chain agentName -> proposedReportsTo -> (its
// manager) -> ... A cycle exists iff walking that chain upward reaches
// agentName again. MAIN never reports to anyone, so it terminates the walk.
export function reportsToCreatesCycle(
  agentName: string,
  proposedReportsTo: string | null,
  readTeam: (name: string) => Pick<TeamConfig, 'reportsTo'>,
  mainAgentId: string,
): boolean {
  if (!proposedReportsTo || proposedReportsTo === mainAgentId) return false
  if (proposedReportsTo === agentName) return true
  let cursor: string | null = proposedReportsTo
  const visited = new Set<string>()
  while (cursor && cursor !== mainAgentId) {
    if (cursor === agentName) return true
    if (visited.has(cursor)) break  // pre-existing loop elsewhere; don't spin
    visited.add(cursor)
    cursor = readTeam(cursor).reportsTo
  }
  return false
}

// Removing an agent leaves dangling references in other agents' team configs.
// Call this from the DELETE handler: members who reported to the removed leader
// fall back to the main agent, and anyone who delegated to them drops the id.
export function cleanupTeamReferences(removedName: string): void {
  for (const other of listAgentNames()) {
    const team = readAgentTeam(other)
    let dirty = false
    if (team.reportsTo === removedName) {
      team.reportsTo = removedName === MAIN_AGENT_ID ? null : MAIN_AGENT_ID
      dirty = true
    }
    const filteredDelegates = team.delegatesTo.filter(n => n !== removedName)
    if (filteredDelegates.length !== team.delegatesTo.length) {
      team.delegatesTo = filteredDelegates
      dirty = true
    }
    const filteredTrust = (team.trustFrom ?? []).filter(n => n !== removedName)
    if (filteredTrust.length !== (team.trustFrom ?? []).length) {
      team.trustFrom = filteredTrust
      dirty = true
    }
    if (dirty) writeAgentTeam(other, team)
  }
}
