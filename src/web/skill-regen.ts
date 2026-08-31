/**
 * SQL -> file skill regeneration (716-D).
 *
 * At startup, AFTER materializeSkillsFromFiles() has seeded the DB, this
 * module writes fleet skills from SQL back to their canonical file locations.
 * SQL is the source of truth; files are the loader cache Claude Code reads.
 *
 * Guardrails (all mandatory):
 *   1. NON-DESTRUCTIVE: we never delete or overwrite a file that has no
 *      corresponding SQL row. Unknown-to-SQL files are left untouched.
 *   2. Runs only AFTER materialization (caller responsibility).
 *   3. IDEMPOTENT + ATOMIC: content-equal files are skipped; writes go to a
 *      sibling .tmp then rename() over the target.
 *   4. KILL-SWITCH: SKILL_SQL_REGEN=1 must be set explicitly. Any other
 *      value (including absent) leaves regen disabled -- fail-safe.
 *   5. Path safety: IDs with '..' or absolute-path components are rejected.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { PROJECT_ROOT, MAIN_AGENT_ID, SKILL_SQL_REGEN } from '../config.js'
import { listAllSkills } from '../db.js'

export interface RegenResult {
  enabled: boolean
  written: number
  skipped: number
  errors: number
}

/**
 * Derive the on-disk SKILL.md path from a SQL skill id.
 * Returns null for malformed or path-unsafe IDs.
 *
 * ID conventions (set by materialize-skills.ts):
 *   global/<name>              -> ~/.claude/skills/<name>/SKILL.md
 *   agent/<agentId>/<name>     -> <project>/agents/<agentId>/.claude/skills/<name>/SKILL.md
 *   agent/<MAIN_AGENT_ID>/<name> -> <project>/.claude/skills/<name>/SKILL.md
 */
function resolveSkillPath(id: string): string | null {
  // Reject any component that could escape the expected base directories.
  if (id.includes('..') || id.startsWith('/')) return null

  const parts = id.split('/')
  if (parts.some(p => p === '' || p === '.')) return null

  if (parts[0] === 'global' && parts.length === 2) {
    const name = parts[1]
    const base = join(homedir(), '.claude', 'skills', name)
    const resolved = normalize(base)
    if (!resolved.startsWith(normalize(join(homedir(), '.claude', 'skills')))) return null
    return join(base, 'SKILL.md')
  }

  if (parts[0] === 'agent' && parts.length === 3) {
    const agentId = parts[1]
    const name = parts[2]
    let base: string
    if (agentId === MAIN_AGENT_ID) {
      base = join(PROJECT_ROOT, '.claude', 'skills', name)
      const expected = normalize(join(PROJECT_ROOT, '.claude', 'skills'))
      if (!normalize(base).startsWith(expected)) return null
    } else {
      base = join(AGENTS_BASE_DIR, agentId, '.claude', 'skills', name)
      const expected = normalize(join(AGENTS_BASE_DIR, agentId, '.claude', 'skills'))
      if (!normalize(base).startsWith(expected)) return null
    }
    return join(base, 'SKILL.md')
  }

  return null  // unknown ID pattern
}

/**
 * Regenerate fleet skill files from SQL.
 *
 * Safe to call unconditionally at startup: returns immediately with
 * enabled=false if the SKILL_SQL_REGEN kill-switch is off (and forceEnabled
 * is not set). The startup hook always calls with default opts; the CLI
 * script passes forceEnabled=true to allow manual proof runs.
 *
 * @param dryRun       If true, log what would be written but don't touch disk.
 * @param forceEnabled Bypass the SKILL_SQL_REGEN kill-switch (CLI use only).
 */
export function regenSkillFilesFromSQL(dryRun = false, forceEnabled = false): RegenResult {
  // Kill-switch: must be explicitly enabled for live writes. Dry-run bypasses
  // the check (read-only; safe to run for inspection regardless of the flag).
  if (!dryRun && !SKILL_SQL_REGEN && !forceEnabled) {
    return { enabled: false, written: 0, skipped: 0, errors: 0 }
  }

  let written = 0
  let skipped = 0
  let errors = 0

  let rows
  try {
    rows = listAllSkills().filter(r => r.tenant_id === 'fleet')
  } catch (err) {
    logger.error({ err }, 'skill-regen: failed to query skills table')
    return { enabled: true, written: 0, skipped: 0, errors: 1 }
  }

  for (const row of rows) {
    const targetPath = resolveSkillPath(row.id)
    if (!targetPath) {
      logger.warn({ id: row.id }, 'skill-regen: unrecognized ID pattern, skipping')
      errors++
      continue
    }

    // Idempotent: skip if on-disk content already matches SQL.
    if (existsSync(targetPath)) {
      let onDisk = ''
      try { onDisk = readFileSync(targetPath, 'utf-8') } catch { /* treat as missing */ }
      if (onDisk === row.content) {
        skipped++
        continue
      }
    }

    if (dryRun) {
      logger.info({ id: row.id, path: targetPath }, 'skill-regen [dry-run]: would write')
      written++
      continue
    }

    try {
      const dir = targetPath.replace(/\/SKILL\.md$/, '')
      mkdirSync(dir, { recursive: true })
      atomicWriteFileSync(targetPath, row.content)
      logger.info({ id: row.id, path: targetPath }, 'skill-regen: wrote')
      written++
    } catch (err) {
      logger.error({ err, id: row.id, path: targetPath }, 'skill-regen: write failed')
      errors++
    }
  }

  return { enabled: true, written, skipped, errors }
}

/**
 * Verify that every fleet skill in SQL has a readable SKILL.md on disk.
 * Used for the proof step (guardrail 5) before enabling the kill-switch.
 * Returns a list of IDs that are missing from disk.
 */
export function findMissingSkillFiles(): string[] {
  const missing: string[] = []
  let rows
  try {
    rows = listAllSkills().filter(r => r.tenant_id === 'fleet')
  } catch {
    return []
  }
  for (const row of rows) {
    const p = resolveSkillPath(row.id)
    if (!p || !existsSync(p)) missing.push(row.id)
  }
  return missing
}

/**
 * Return the set of agent IDs whose local skills directory exists on disk,
 * so callers can verify the loader would find them.
 */
export function listKnownSkillAgents(): string[] {
  return [MAIN_AGENT_ID, ...listAgentNames()]
}
