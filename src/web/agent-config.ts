import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { safeJoin } from './sanitize.js'

export const AGENTS_BASE_DIR = join(PROJECT_ROOT, 'agents')

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

// Map short model names to full Claude model IDs (backwards compat with old configs)
export const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
  'inherit': DEFAULT_MODEL,
}

export function agentDir(name: string): string {
  // safeJoin rejects path-traversal components. The first line of defense is
  // still sanitizeAgentName() at the create-endpoint, but going through
  // safeJoin turns every non-whitelisted `name` (e.g. a buggy internal caller
  // that forgot to sanitize) into an explicit throw instead of silently
  // writing outside AGENTS_BASE_DIR.
  return safeJoin(AGENTS_BASE_DIR, name)
}

export function readFileOr(path: string, fallback: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return fallback }
}

export function extractDescriptionFromClaudeMd(content: string): string {
  // Try to grab first meaningful paragraph after any heading
  const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  return lines[0]?.trim().slice(0, 200) || ''
}

export function findAvatarForAgent(name: string): string | null {
  const dir = agentDir(name)
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = join(dir, `avatar${ext}`)
    if (existsSync(p)) return p
  }
  return null
}

export function resolveModelId(raw: string): string {
  return MODEL_ALIASES[raw] || raw
}

export function readAgentModel(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    return resolveModelId(config.model || DEFAULT_MODEL)
  } catch {
    return DEFAULT_MODEL
  }
}

export function writeAgentModel(name: string, model: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.model = model
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentDisplayName(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const raw = typeof config.displayName === 'string' ? config.displayName.trim() : ''
    if (raw) return raw
  } catch { /* fall through */ }
  // Fall back to a title-cased version of the sanitized name.
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function writeAgentDisplayName(name: string, displayName: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.displayName = displayName
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function readAgentSecurityProfile(name: string): string {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    if (typeof config.securityProfile === 'string' && config.securityProfile.trim()) {
      return config.securityProfile.trim()
    }
  } catch { /* fall through */ }
  return 'default'
}

export function writeAgentSecurityProfile(name: string, profileId: string): void {
  const configPath = join(agentDir(name), 'agent-config.json')
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(readFileOr(configPath, '{}')) } catch {}
  config.securityProfile = profileId
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

export function listAgentNames(): string[] {
  if (!existsSync(AGENTS_BASE_DIR)) return []
  return readdirSync(AGENTS_BASE_DIR).filter((f) => {
    try { return statSync(join(AGENTS_BASE_DIR, f)).isDirectory() } catch { return false }
  })
}

// Does this identifier refer to a registered agent? MAIN_AGENT_ID always
// counts (it lives outside agents/ but is a first-class peer). Sub-agents
// need a directory on disk. One fs stat per call -- the router calls this
// twice per pending message on its 5s tick, roughly 10-20 stats per tick
// in practice, no memoisation needed.
export function isKnownAgent(name: string): boolean {
  if (!name) return false
  if (name === MAIN_AGENT_ID) return true
  try {
    const dir = agentDir(name)
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}
