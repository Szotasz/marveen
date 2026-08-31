#!/usr/bin/env node
/**
 * One-time migration: read all file-based scheduled tasks from
 * ~/.claude/scheduled-tasks/ and insert them into the `schedules` DB table.
 *
 * Idempotent: uses INSERT OR IGNORE so re-running is safe.
 * Fleet tasks get tenant_id = NULL.
 *
 * Usage:
 *   npx tsx scripts/migrate-schedules-to-db.ts [--dry-run]
 */
import { listScheduledTasksFromFiles } from '../src/web/scheduled-tasks-io.js'
import { upsertSchedule, countSchedules } from '../src/db.js'

const dryRun = process.argv.includes('--dry-run')

const tasks = listScheduledTasksFromFiles()
console.log(`Found ${tasks.length} file-based scheduled tasks.`)
if (dryRun) {
  console.log('[dry-run] Would insert:')
  for (const t of tasks) console.log(`  ${t.name} (agent=${t.agent}, type=${t.type})`)
  process.exit(0)
}

let inserted = 0
let skipped = 0
for (const t of tasks) {
  try {
    upsertSchedule(t.name, {
      prompt:                   t.prompt ?? '',
      description:              t.description ?? '',
      schedule:                 t.schedule,
      agent:                    t.agent,
      type:                     t.type ?? 'task',
      enabled:                  t.enabled,
      tenant_id:                null,   // fleet tasks
      skip_if_busy:             t.skipIfBusy ?? false,
      force_send:               t.forceSend ?? false,
      target_session:           t.targetSession ?? null,
      command:                  t.command ?? null,
      timeout_ms:               t.timeoutMs ?? null,
      fail_threshold:           t.failThreshold ?? null,
      pre_check:                t.preCheck ?? null,
      catch_up_max_age_minutes: t.catchUpMaxAgeMinutes ?? null,
      stuck_after_minutes:      t.stuckAfterMinutes ?? null,
      requires:                 t.requires ? JSON.stringify(t.requires) : null,
      created_at:               t.createdAt || Math.floor(Date.now() / 1000),
    })
    console.log(`  OK  ${t.name}`)
    inserted++
  } catch (err) {
    console.error(`  ERR ${t.name}: ${err}`)
    skipped++
  }
}

console.log(`\nDone: ${inserted} inserted/updated, ${skipped} errors.`)
console.log(`DB now has ${countSchedules()} schedule rows.`)
