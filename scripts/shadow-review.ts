// Shadow review of an eco-worker run, in one command.
//
//   npx tsx scripts/shadow-review.ts vesta [--hours 10] [--compare claude-opus-5]
//
// Prints the boundaries of the measurement next to its numbers, so a figure
// quoted a day later still says what it was measured against: which transcript,
// which window, whether the run had settled, and whether the token collector had
// caught up. The first review of this kind (2026-08-01) produced two findings
// that were about the measurement rather than the worker -- this script exists
// so the method stays the fixed variable when the numbers feed a decision.
//
// Read-only: opens the database read-only, writes nothing anywhere.

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR, DB_FILENAME, MAIN_AGENT_ID, PROJECT_ROOT } from '../src/config.js'
import { extractNotifyMessages, groundTruthCards, evaluateRun } from '../src/costops/shadow-eval.js'
import {
  pickTranscript, transcriptSettle, collectorState, priceRun, runUsageRows,
  averageContextPerCall, runWindow, lastRunStartMs, DEFAULT_WINDOW_HOURS, SETTLE_THRESHOLD_MS,
} from '../src/costops/shadow-review.js'

const args = process.argv.slice(2)
const agent = args.find(a => !a.startsWith('--'))
if (!agent) {
  console.error('usage: shadow-review.ts <agent> [--hours N] [--compare <model>] [--json]')
  process.exit(2)
}
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const hours = Number(flag('hours') ?? DEFAULT_WINDOW_HOURS)
const compare = flag('compare') ?? 'claude-opus-5'
const asJson = args.includes('--json')

const projectDir = join(homedir(), '.claude', 'projects', `${PROJECT_ROOT.replace(/\//g, '-')}-agents-${agent}`)
if (!existsSync(projectDir)) {
  console.error(`No transcript directory for '${agent}': ${projectDir}`)
  process.exit(1)
}

const candidates = readdirSync(projectDir)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => ({ path: join(projectDir, f), mtimeMs: statSync(join(projectDir, f)).mtimeMs }))
const transcript = pickTranscript(candidates)
if (!transcript) {
  // "No run to measure" is a result, not a failure to be papered over.
  console.error(`No transcript found for '${agent}' -- has it run yet?`)
  process.exit(1)
}

const nowMs = Date.now()
const settle = transcriptSettle(transcript.mtimeMs, nowMs, SETTLE_THRESHOLD_MS)
const lines = readFileSync(transcript.path, 'utf-8').split('\n').filter(Boolean)
const messages = extractNotifyMessages(lines)

// The window ends when the LATEST run started -- the worker queried the board
// in its first seconds, so anything created later was never answerable, and a
// session that has been alive for days must not drag the window back with it.
const win = runWindow(lastRunStartMs(lines), transcript.mtimeMs, hours)
const { start: windowStart, end: runEnd } = win

const db = new Database(join(STORE_DIR, DB_FILENAME), { readonly: true })
const moved = groundTruthCards(db, windowStart, runEnd)
const evaluation = evaluateRun(messages, moved, { start: windowStart, end: runEnd }, { runComplete: settle.settled })

const cursor = db.prepare('SELECT last_size FROM token_usage_cursors WHERE file_path = ?').get(transcript.path) as { last_size: number } | undefined
const collector = collectorState(cursor?.last_size ?? null, statSync(transcript.path).size)
const usage = runUsageRows(db, agent, windowStart, runEnd + 3600)
const cost = usage.length > 0 ? priceRun(usage, compare) : null
const mainScale = averageContextPerCall(db, MAIN_AGENT_ID, windowStart, runEnd)

if (asJson) {
  console.log(JSON.stringify({
    boundaries: {
      transcript: transcript.path, window: win,
      settle, collector, compare_model: compare,
    },
    evaluation, cost, main_agent_scale: mainScale,
  }, null, 2))
  process.exit(0)
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19)
console.log(`\nSHADOW REVIEW -- ${agent}\n`)
console.log('BOUNDARIES OF THIS MEASUREMENT')
console.log(`  transcript        ${transcript.path}`)
console.log(`  window            ${iso(windowStart)} .. ${iso(runEnd)} UTC (${win.hours}h, end = ${win.endSource})`)
console.log(`  run settled       ${settle.settled ? 'yes' : 'NO'} (unchanged for ${Math.round(settle.settledForMs / 1000)}s, threshold ${settle.thresholdMs / 1000}s)`)
console.log(`  token collector   ${collector}${collector !== 'current' ? '  <-- cost figures are INCOMPLETE, not zero' : ''}`)
console.log(`  comparison model  ${compare}`)

console.log('\nCOVERAGE')
console.log(`  verdict           ${evaluation.verdict}`)
console.log(`  recall            ${evaluation.coverage.recall.toFixed(3)} (${evaluation.coverage.mentioned}/${evaluation.coverage.moved})`)
console.log(`  messages sent     ${evaluation.coverage.messages}`)
if (evaluation.coverage.missed.length > 0) {
  console.log('  missed:')
  for (const m of evaluation.coverage.missed) {
    // Title length is the split the review asks for: short/generic titles
    // indict the matcher, long/distinctive ones indict the worker.
    console.log(`    #${m.seq ?? '?'} [${m.via}] (${m.title.length} chars) ${m.title}`)
  }
}
console.log(`  note              ${evaluation.note}`)

console.log('\nCOST')
if (!cost) {
  console.log('  no usage rows for this agent in the window -- see the collector line above')
} else {
  console.log(`  calls             ${cost.calls} (${cost.models.join(', ') || 'unknown model'})`)
  console.log(`  entry context     ${cost.entry_context_tokens?.toLocaleString() ?? '?'} tokens (first call)`)
  console.log(`  tokens            in ${cost.input_tokens.toLocaleString()} / out ${cost.output_tokens.toLocaleString()} / cache r ${cost.cache_read_tokens.toLocaleString()} w ${cost.cache_creation_tokens.toLocaleString()}`)
  console.log(`  list-price equiv  $${cost.list_price_equivalent_usd.toFixed(4)}  (NOT an invoice)`)
  if (cost.comparison) {
    console.log(`  same volume on    ${cost.comparison.model}: $${cost.comparison.usd.toFixed(4)}${cost.comparison.ratio ? ` (${cost.comparison.ratio}x)` : ''}`)
    console.log('                    ^ model-swap effect only; the inherited-context saving is a separate measurement')
  }
  if (cost.unpriced_calls > 0) console.log(`  unpriced calls    ${cost.unpriced_calls} (no published rate -- surfaced, not counted as 0)`)
}
if (mainScale) {
  console.log(`\n  for scale: ${MAIN_AGENT_ID} averaged ${mainScale.avg_cache_read.toLocaleString()} cache-read tokens per call over ${mainScale.calls} calls in the same window`)
}
console.log()
