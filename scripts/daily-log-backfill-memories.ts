#!/usr/bin/env tsx
// Mirror existing daily-log rows into the searchable memories table (card f90928e3).
//
//   npx tsx scripts/daily-log-backfill-memories.ts            # dry run: counts only
//   npx tsx scripts/daily-log-backfill-memories.ts --apply    # write the mirrors
//   npx tsx scripts/daily-log-backfill-memories.ts --db <path> [--apply]
//
// New entries are mirrored by POST /api/daily-log itself; this only catches up
// the rows written before that. Idempotent: the daily_log_memory link table
// marks finished rows, so running it twice writes nothing the second time.
// Each mirror keeps the log row's own created_at, is tier cold / sector
// episodic, and goes through the same content filter as POST /api/memories
// (a refused row stays in the diary and is counted as "skipped").
//
// Talks to SQLite directly, no HTTP and no token. Embeddings are NOT created
// here (the process exits first); the existing embedding backfill fills them.
// Stop the dashboard's writers or run it off-hours on a busy install: SQLite
// serialises the writes, but this is a bulk insert.

import { initDatabase, backfillDailyLogMemories } from '../src/db.js'
import { containsSuspiciousContent } from '../src/web/routes/memories.js'

function usage(): never {
  process.stderr.write('Usage: daily-log-backfill-memories [--apply] [--db <path>]\n')
  process.exit(2)
}

const args = process.argv.slice(2)
let apply = false
let dbPath: string | undefined
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') apply = true
  else if (args[i] === '--db' && args[i + 1]) dbPath = args[++i]
  else usage()
}

initDatabase(dbPath)
const r = backfillDailyLogMemories({ apply, reject: (c) => containsSuspiciousContent(c) })
const mode = apply ? 'APPLY' : 'DRY RUN (use --apply to write)'
process.stdout.write(
  `daily-log -> memories backfill [${mode}]\n` +
  `  daily_logs rows:   ${r.total}\n` +
  `  already mirrored:  ${r.already}\n` +
  `  ${apply ? 'new mirrors:       ' : 'would create:      '} ${apply ? r.created : r.wouldCreate}\n` +
  `  skipped (filter/empty): ${r.skipped}\n` +
  `  failed:            ${r.failed}\n`,
)
process.exit(r.failed > 0 ? 1 : 0)
