// The pure core of scripts/hook-failures.ts: argument parsing and the grouped
// report. Kept in src so it is type-checked and tested with the rest; the script
// is only the process wrapper (scan, print, exit code).
import {
  groupHookFailures,
  DEFAULT_WINDOW_MS,
  type HookFailureScan,
} from './web/hook-failure-scan.js'

export const USAGE = 'usage: npm run hook-failures -- [--days N] [--json]'

export function parseArgs(argv: string[]): { windowMs: number; json: boolean } | null {
  let windowMs = DEFAULT_WINDOW_MS
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') {
      json = true
      continue
    }
    if (a === '--days') {
      const days = Number(argv[++i])
      windowMs = days * 24 * 60 * 60 * 1000
      // Checked after the multiplication too: --days 1e306 is finite, its window is not.
      if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(windowMs)) return null
      continue
    }
    return null
  }
  return { windowMs, json }
}

/** The grouped, human-readable report. */
export function renderReport(scan: HookFailureScan, windowMs: number): string {
  // Three significant digits: --days 0.001 must not print as "0d".
  const days = Number((windowMs / (24 * 60 * 60 * 1000)).toPrecision(3))
  // The window selects transcripts by modification time; every record in a selected
  // transcript is reported, so an old failure in a session still in use shows up too.
  const out = [
    `hook failures in transcripts modified in the last ${days}d: ${scan.failures.length} record(s) ` +
    `(${scan.filesScanned} transcripts read, ${scan.filesSkippedByAge} older than the window, ` +
    `${scan.filesUnreadable} unreadable, ${scan.rootsScanned} transcript roots)`,
  ]
  for (const g of groupHookFailures(scan.failures)) {
    const mode = g.blocking ? 'BLOCKED the operation' : 'fail-open (the operation proceeded)'
    const when = g.firstTimestamp === g.lastTimestamp ? g.firstTimestamp : `${g.firstTimestamp} .. ${g.lastTimestamp}`
    out.push('', `  ${g.count}x  ${g.agent}  ${g.event ?? '?'}  exit=${g.exitCode ?? '-'}  ${mode}`)
    out.push(`      when:    ${when}`)
    if (g.command) out.push(`      command: ${g.command}`)
    if (g.stderrHead) out.push(`      stderr:  ${g.stderrHead}`)
  }
  return out.join('\n')
}
