#!/usr/bin/env node
// Merge the shipped seed-config/autonomy-config.json into an install's store/autonomy-config.json.
//
// Called by update.sh and by the dashboard at start (src/web/autonomy-config-boot.ts), and only there: an agent's own session may not write
// store/autonomy-config.json at all, the db-write-gate refuses it, GATEFILES1110). Two things, both
// idempotent, so a second run writes nothing:
//   1. A category the install does not have yet is added from the seed, as the seed ships it.
//   2. A category's maxLevel is raised where the product raised the ceiling, but ONLY while the
//      install still holds the factory value it replaces (MAX_LEVEL_RAISES). A ceiling the owner
//      narrowed or changed stays as it is, and the category's level is never touched: raising the
//      level itself stays the owner's step on the dashboard (an owner session, routes/autonomy.ts).
//
// Usage: node autonomy-config-merge.mjs <seed.json> <store/autonomy-config.json>
// Prints one line, `added=<n> raised=<keys or ->`, and exits 0; a file that is missing or does not
// parse is left alone (exit 1, nothing written).
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// EMAILMAX3-1115 (owner decision 2026-11-15): the email_send ceiling is 3. The install's own value
// moves only from the factory 2 that every release up to v1.49.x shipped.
export const MAX_LEVEL_RAISES = Object.freeze([Object.freeze({ key: 'email_send', from: 2, to: 3 })])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Pure: the merged config and what changed. `live` is not modified. */
export function mergeAutonomyConfig(seed, live, raises = MAX_LEVEL_RAISES) {
  if (!isObj(seed) || !Array.isArray(seed.categories)) throw new Error('seed: no categories')
  if (!isObj(live) || !Array.isArray(live.categories)) throw new Error('live: no categories')
  const out = { ...live, categories: live.categories.map((c) => (isObj(c) ? { ...c } : c)) }
  const have = new Set(out.categories.filter(isObj).map((c) => c.key))
  let added = 0
  for (const c of seed.categories) {
    if (isObj(c) && !have.has(c.key)) { out.categories.push({ ...c }); have.add(c.key); added++ }
  }
  const raised = []
  for (const r of raises) {
    const shipped = seed.categories.find((c) => isObj(c) && c.key === r.key)
    // The raise rides the seed: a seed that does not ship the new ceiling raises nothing.
    if (!shipped || shipped.maxLevel !== r.to) continue
    const c = out.categories.find((x) => isObj(x) && x.key === r.key)
    if (!c || c.locked === true || c.maxLevel !== r.from) continue
    c.maxLevel = r.to
    raised.push(r.key)
  }
  return { config: out, added, raised }
}

/**
 * Read both files, merge, and write the target only if something changed (same mode, a sibling temp file
 * renamed over it; the temp name ends in .tmp, which the store watcher counts as a system file).
 * Throws on a file that is missing or does not parse; the target is then left alone.
 */
export function mergeAutonomyConfigFiles(seedPath, targetPath) {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
  const live = JSON.parse(readFileSync(targetPath, 'utf8'))
  const { config, added, raised } = mergeAutonomyConfig(seed, live)
  if (!added && !raised.length) return { added, raised, wrote: false }
  config.updated_at = Math.floor(Date.now() / 1000)
  let mode = 0o644
  try { mode = statSync(targetPath).mode & 0o777 } catch { /* keep the default */ }
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  // flag 'wx': the temp file is created here and now, never opened through something already at that name
  // (a planted link would otherwise send the config text into another file).
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode, flag: 'wx' })
  renameSync(tmp, targetPath)
  return { added, raised, wrote: true }
}

/** The one line both callers print or log. */
export const describeMerge = ({ added, raised }) => `added=${added} raised=${raised.length ? raised.join(',') : '-'}`

function main(argv) {
  const [seedPath, targetPath] = argv
  if (!seedPath || !targetPath) { process.stderr.write('usage: autonomy-config-merge.mjs <seed.json> <target.json>\n'); return 2 }
  try {
    process.stdout.write(describeMerge(mergeAutonomyConfigFiles(seedPath, targetPath)) + '\n')
    return 0
  } catch (err) {
    process.stderr.write(`autonomy-config-merge: left alone (${err instanceof Error ? err.message : String(err)})\n`)
    return 1
  }
}

// Run as a command, not when imported. Compared as real paths: started through a path with a link in it
// (macOS /tmp -> /private/tmp, a linked install root) argv[1] and import.meta.url name the same file
// differently, and a plain string compare made the command a silent no-op.
function startedAsCommand() {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}
if (startedAsCommand()) process.exitCode = main(process.argv.slice(2))
