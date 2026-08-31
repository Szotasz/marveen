#!/usr/bin/env node
/**
 * One-time (re-runnable) migration: read all file-based skills from
 *   ~/.claude/skills/<name>/SKILL.md          (global fleet skills)
 *   <project>/agents/<agentId>/.claude/skills/<name>/SKILL.md  (agent-local)
 *   <project>/.claude/skills/<name>/SKILL.md  (main-agent local)
 * and INSERT OR IGNORE them into the `skills` DB table.
 *
 * Idempotent: uses INSERT OR IGNORE so re-running never overwrites rows that
 * have been hand-edited in the DB.
 *
 * ID scheme (stable, collision-free):
 *   global skills  -> "global/<dirName>"
 *   agent-local    -> "agent/<agentId>/<dirName>"
 *
 * All file-based skills get tenant_id = 'fleet'.
 * Global skills:    is_global = true  (visible across the whole fleet)
 * Agent-local:      is_global = false (per-agent, not fleet-wide)
 *
 * Usage:
 *   npx tsx scripts/materialize-skills.ts [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { seedSkillIfAbsent, countSkills } from '../src/db.js'
import { AGENTS_BASE_DIR, listAgentNames } from '../src/web/agent-config.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../src/config.js'

const dryRun = process.argv.includes('--dry-run')

// ── helpers ──────────────────────────────────────────────────────────────────

function parseFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return ''
  const fm = fmMatch[1]
  const line = fm.match(new RegExp(`^${field}:\\s*(.+)`, 'im'))
  if (!line) return ''
  let val = line[1].trim()
  if (val.startsWith('"')) { const q = val.match(/^"(.*)"$/); return q ? q[1] : val.replace(/^"|"$/g, '') }
  if (val.startsWith("'")) { const q = val.match(/^'(.*)'$/); return q ? q[1] : val.replace(/^'|'$/g, '') }
  return val
}

interface SkillFile {
  id: string
  name: string
  description: string
  content: string
  tenant_id: 'fleet'
  is_global: boolean
  source: string   // human-readable path, for logging only
}

function collectSkillFiles(skillsDir: string, idPrefix: string, isGlobal: boolean): SkillFile[] {
  if (!existsSync(skillsDir)) return []
  const files: SkillFile[] = []
  let entries: string[] = []
  try { entries = readdirSync(skillsDir) } catch { return [] }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const dirPath = join(skillsDir, entry)
    try { if (!statSync(dirPath).isDirectory()) continue } catch { continue }
    const skillMdPath = join(dirPath, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    let content = ''
    try { content = readFileSync(skillMdPath, 'utf-8') } catch { continue }
    files.push({
      id: `${idPrefix}/${entry}`,
      name: entry,
      description: parseFrontmatterField(content, 'description'),
      content,
      tenant_id: 'fleet',
      is_global: isGlobal,
      source: skillMdPath,
    })
  }
  return files
}

// ── collect ───────────────────────────────────────────────────────────────────

const skills: SkillFile[] = []

// 1. Global fleet skills: ~/.claude/skills/
const globalSkillsDir = join(homedir(), '.claude', 'skills')
skills.push(...collectSkillFiles(globalSkillsDir, 'global', true))

// 2. Main-agent local skills: <project>/.claude/skills/
const mainAgentSkillsDir = join(PROJECT_ROOT, '.claude', 'skills')
skills.push(...collectSkillFiles(mainAgentSkillsDir, `agent/${MAIN_AGENT_ID}`, false))

// 3. Sub-agent local skills: <project>/agents/<agentId>/.claude/skills/
for (const agentId of listAgentNames()) {
  const agentSkillsDir = join(AGENTS_BASE_DIR, agentId, '.claude', 'skills')
  skills.push(...collectSkillFiles(agentSkillsDir, `agent/${agentId}`, false))
}

console.log(`Found ${skills.length} file-based skill(s).`)

if (dryRun) {
  console.log('[dry-run] Would seed (INSERT OR IGNORE):')
  for (const s of skills) {
    console.log(`  ${s.id}  [${s.is_global ? 'global' : 'agent-local'}]  ${s.source}`)
  }
  process.exit(0)
}

// ── insert ────────────────────────────────────────────────────────────────────

let inserted = 0
let skipped = 0

for (const s of skills) {
  try {
    const seeded = seedSkillIfAbsent({
      id:          s.id,
      name:        s.name,
      description: s.description,
      content:     s.content,
      tenant_id:   s.tenant_id,
      is_global:   s.is_global,
    })
    if (seeded) {
      console.log(`  NEW  ${s.id}`)
      inserted++
    } else {
      console.log(`  SKIP ${s.id} (already in DB, not overwritten)`)
      skipped++
    }
  } catch (err) {
    console.error(`  ERR  ${s.id}: ${err}`)
  }
}

console.log(`\nDone: ${inserted} newly inserted, ${skipped} already existed (preserved).`)
console.log(`DB now has ${countSkills()} skill rows.`)
