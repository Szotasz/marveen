// EGRESSSELFEDIT824: a hash baseline for store/egress-allowlist.json, and a report of every
// change to it, whoever made it and by whatever route.
//
// WHY: the allowlist is the gate egress-gate.mjs applies to every agent, and it is a plain
// file in the agents' own tree. On 2026-08-24 a nested sub-agent added a domain to it and
// removed it again. Afterwards nobody could prove the file was back to its old bytes: store/
// is gitignored, and no copy or hash existed. self-pace-gate.mjs now refuses the casual write
// routes for sub-agents, but a hook reads a command STRING -- a script that builds the path at
// runtime, or a glob that never spells the name, is invisible to it. This module is the layer
// that does not depend on the route: it compares the file's bytes with the last recorded ones.
//
// What it does on every check (dashboard boot + every change the file watcher sees):
//   - sha256 of the current bytes (or "missing");
//   - if that differs from the last history entry: a full copy into
//     store/egress-allowlist.history/<UTC-stamp>-<sha12>.json, a line in history.log, and a
//     report (the domain-level diff) to the main agent;
//   - the very first check only writes the baseline, it has nothing to compare against.
// The boot check is what catches a write made while the dashboard was down.
//
// HONEST LIMIT: every agent runs as the same OS user, so the history directory is as writable
// as the file itself. This makes a change VISIBLE and the previous bytes RECOVERABLE; it does
// not make the file unwritable. That needs an OS-level owner or flag, an owner decision.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'

export const HISTORY_DIRNAME = 'egress-allowlist.history'
const MISSING = 'missing'

export interface BaselineResult {
  /** sha256 of the current bytes, or 'missing' */
  sha: string
  /** the previous recorded sha, null on the very first check */
  previous: string | null
  /** true when a new history entry was written */
  recorded: boolean
  /** the report sent (null when nothing changed or on the first baseline) */
  report: string | null
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// History entries are named <stamp>-<sha12>.json (or .missing), so a lexical sort is a time sort.
function lastEntry(historyDir: string): { name: string; sha: string } | null {
  if (!existsSync(historyDir)) return null
  const names = readdirSync(historyDir).filter((n) => /^\d{8}T\d{6}\d{3}Z-/.test(n)).sort()
  const name = names[names.length - 1]
  if (!name) return null
  if (name.endsWith('.missing')) return { name, sha: MISSING }
  return { name, sha: sha256(readFileSync(join(historyDir, name))) }
}

type Lists = Record<string, string[] | string>
function parseLists(text: string | null): Lists | null {
  if (text === null) return {}
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const out: Lists = {}
    for (const [k, v] of Object.entries(j)) {
      if (Array.isArray(v)) out[k] = v.map((x) => String(x))
      else if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/** Human-readable, domain-level difference between two versions of the file. */
export function describeAllowlistChange(before: string | null, after: string | null): string {
  if (after === null) return 'the file was DELETED'
  const a = parseLists(before)
  const b = parseLists(after)
  if (b === null) return 'the new content is NOT valid JSON (egress-gate falls back to the built-in list)'
  if (a === null) return 'the previous content was not valid JSON; new keys: ' + Object.keys(b).join(', ')
  const lines: string[] = []
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[key]; const y = b[key]
    if (Array.isArray(x) || Array.isArray(y)) {
      const xs = new Set(Array.isArray(x) ? x : []); const ys = new Set(Array.isArray(y) ? y : [])
      const added = [...ys].filter((d) => !xs.has(d)); const removed = [...xs].filter((d) => !ys.has(d))
      if (added.length) lines.push(`${key} +${added.join(', +')}`)
      if (removed.length) lines.push(`${key} -${removed.join(', -')}`)
    } else if (x !== y) {
      lines.push(`${key}: ${x ?? '(none)'} -> ${y ?? '(none)'}`)
    }
  }
  return lines.length ? lines.join('; ') : 'bytes changed, lists unchanged (formatting only)'
}

// 2026-10-03T07:41:02.123Z -> 20261003T074102123Z (sortable, no characters a path dislikes)
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '')
}

/**
 * Compare the allowlist with its last recorded version; record and report a difference.
 * `notify` receives the report text (production: an agent message to the main agent).
 */
export function checkEgressAllowlistBaseline(
  storeDir: string,
  notify: (report: string) => void,
  now: Date = new Date(),
): BaselineResult {
  const file = join(storeDir, 'egress-allowlist.json')
  const historyDir = join(storeDir, HISTORY_DIRNAME)
  const bytes = existsSync(file) ? readFileSync(file) : null
  const sha = bytes ? sha256(bytes) : MISSING
  const prev = lastEntry(historyDir)
  if (prev && prev.sha === sha) return { sha, previous: prev.sha, recorded: false, report: null }

  mkdirSync(historyDir, { recursive: true })
  const name = `${stamp(now)}-${sha.slice(0, 12)}${bytes ? '.json' : '.missing'}`
  writeFileSync(join(historyDir, name), bytes ?? '')
  appendFileSync(join(historyDir, 'history.log'), `${now.toISOString()} ${sha} ${bytes ? bytes.length : 0} ${name}\n`)

  if (!prev) return { sha, previous: null, recorded: true, report: null }

  const before = prev.sha === MISSING ? null : readFileSync(join(historyDir, prev.name), 'utf-8')
  const report =
    `[EGRESS-ALLOWLIST] store/egress-allowlist.json CHANGED (${describeAllowlistChange(before, bytes ? bytes.toString('utf-8') : null)}). ` +
    `sha ${prev.sha.slice(0, 12)} -> ${sha.slice(0, 12)}. Previous version: store/${HISTORY_DIRNAME}/${prev.name}. ` +
    'If you did not make or approve this change, restore the previous version and find out who wrote it: ' +
    'sub-agents may not edit this file (EGRESSSELFEDIT824).'
  try { notify(report) } catch { /* the record above stands even if the report fails */ }
  return { sha, previous: prev.sha, recorded: true, report }
}

/**
 * Check once now (catches a change made while the dashboard was down), then on every change
 * the poller sees. fs.watchFile (mtime polling) for the same reason as the reader re-render
 * watcher: it survives the file being replaced. Returns a stop function.
 */
export function watchEgressAllowlistBaseline(
  storeDir: string,
  notify: (report: string) => void,
  intervalMs = 5000,
): () => void {
  const file = join(storeDir, 'egress-allowlist.json')
  const run = () => {
    try { checkEgressAllowlistBaseline(storeDir, notify) } catch { /* a failed check must not crash the server */ }
  }
  run()
  watchFile(file, { interval: intervalMs }, run)
  return () => unwatchFile(file, run)
}
