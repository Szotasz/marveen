// --- Team / hierarchy ---
//
// Pure convenience feature: each agent can declare its role (leader | member),
// who it reports to, who it delegates to, and whether it's allowed to split a
// task by itself. No security implications, just routing + visualization for
// multi-tier agent setups.

import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir, readFileOr, listAgentNames } from './agent-config.js'

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
