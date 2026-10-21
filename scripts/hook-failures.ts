// One-shot report of the hook failures Claude Code recorded in the agents'
// transcripts (src/web/hook-failure-scan.ts).
//
//   npm run hook-failures                 # last 7 days, grouped summary
//   npm run hook-failures -- --days 1     # narrower window
//   npm run hook-failures -- --json       # machine-readable, ungrouped
//
// Read-only: it opens transcripts and prints. Exit 0 = no hook failure in the
// window, 1 = at least one found, 2 = bad usage or a crash. The exit code makes it usable
// from a script without parsing the text.

import { pathToFileURL } from 'node:url'
import { logger } from '../src/logger.js'
import { scanHookFailures } from '../src/web/hook-failure-scan.js'
import { USAGE, parseArgs, renderReport } from '../src/hook-failure-report.js'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const scan = scanHookFailures({ sinceMs: args.windowMs })
  console.log(args.json ? JSON.stringify(scan, null, 2) : renderReport(scan, args.windowMs))
  // exitCode, not exit(): exit() can cut off a large --json write still in flight.
  process.exitCode = scan.failures.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (err) {
    logger.error({ err }, 'hook-failures: crashed')
    process.exitCode = 2
  }
}
