#!/usr/bin/env node
/**
 * Manual runner for the SQL -> file skill regeneration (716-D).
 *
 * Reads fleet skills from the SQL `skills` table and writes them back to
 * their canonical file locations. Safe to run repeatedly -- atomic writes,
 * skips content-equal files, never touches files not in SQL.
 *
 * Usage:
 *   npx tsx scripts/regen-skills.ts [--dry-run] [--force]
 *
 *   --dry-run   Log what would be written without touching disk. Works even
 *               when SKILL_SQL_REGEN is unset (useful for the proof step).
 *   --force     Bypass the SKILL_SQL_REGEN kill-switch for a live manual run.
 *               The startup hook still requires the env var.
 */
import { initDatabase, countSkills } from '../src/db.js'
import { regenSkillFilesFromSQL, findMissingSkillFiles } from '../src/web/skill-regen.js'
import { SKILL_SQL_REGEN } from '../src/config.js'

const dryRun = process.argv.includes('--dry-run')
const force  = process.argv.includes('--force')

// Initialize DB before any queries.
initDatabase()

if (!dryRun && !force && !SKILL_SQL_REGEN) {
  console.error('SKILL_SQL_REGEN kill-switch is off. Pass --dry-run for a preview, or --force for a live manual run.')
  process.exit(1)
}

const totalRows = countSkills()
console.log(`SQL skills table: ${totalRows} row(s) total.`)
console.log(dryRun ? '[dry-run] Simulating regen...' : `Running regen (force=${force}, kill-switch=${SKILL_SQL_REGEN})...`)

const result = regenSkillFilesFromSQL(dryRun, force || SKILL_SQL_REGEN)

console.log(`\nResult: enabled=${result.enabled}, written=${result.written}, skipped=${result.skipped}, errors=${result.errors}`)

if (result.errors > 0) {
  console.error('Some skills failed to write -- check logs above.')
  process.exit(1)
}

if (!dryRun && result.enabled) {
  const missing = findMissingSkillFiles()
  if (missing.length > 0) {
    console.error(`\nWARN: ${missing.length} SQL fleet skill(s) still have no on-disk SKILL.md:`)
    for (const id of missing) console.error(`  MISSING ${id}`)
    process.exit(1)
  } else {
    console.log('\nAll SQL fleet skills verified present on disk.')
  }
}
