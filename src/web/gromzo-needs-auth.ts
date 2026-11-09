// GROMZONEEDSAUTH1109 (Samu 74033): Claude Code's needs-auth cache must not keep the main session's Gromzo channel off.
//
// Measured on the QA VPS 11-09 (V30, V31; Claude Code 2.1.319): a gromzo-PENDING main session started the Gromzo plugin
// without MXD_AGENT (the isolated config enabled it; fixed in #2646), the plugin exited, and Claude Code wrote
// "plugin:gromzo-channel:gromzo" into <config dir>/mcp-needs-auth-cache.json. The NEXT session, started with
// --channels plugin:gromzo-channel@gromzo-local, then skipped that server at start ("Skipping connection (cached
// needs-auth)") and stayed deaf until the dashboard's /mcp reconnect, minutes later. Only that file decided it: putting
// back that one file made the next session hear in 2 s; putting back everything else but that file left it deaf.
//
// So every launch that carries the Gromzo channel first takes THAT ONE key out of the cache of the config dir it
// launches with. Nothing else in the file changes: the file is rewritten only when its bytes are exactly the compact or
// the 2-space JSON of its own content (then every other entry stays byte for byte), atomically (a temp file in the same
// directory, the old mode, then rename). A missing file, a non-JSON or unknown-shape file, a symlink or a key that is not
// there: no write, and the outcome says why. The cache is Claude Code's internal file (measured on 2.1.319): if its name
// or shape changes, this becomes a no-op, never an error.
//
// One helper for every launcher: channels.sh calls it through scripts/gromzo-needs-auth-clear.mjs, the dashboard's
// main-session respawns (channel-monitor.ts) import it. No logger here: the CLI's stdout/stderr carry only its line.
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const NEEDS_AUTH_CACHE_FILE = 'mcp-needs-auth-cache.json'
/** Claude Code's server key for the gromzo-channel plugin's "gromzo" MCP server (plugin:<plugin>:<server>). */
export const GROMZO_NEEDS_AUTH_KEY = 'plugin:gromzo-channel:gromzo'
/** The --channels word that loads the Gromzo plugin (agent-extra-channels.ts GROMZO_PLUGIN_ID). */
const GROMZO_CHANNELS_WORD = 'plugin:gromzo-channel@gromzo-local'

export type NeedsAuthClearOutcome =
  | 'removed' // the key was there and is gone; every other entry kept
  | 'absent' // no cache file
  | 'no_key' // a cache file without the key
  | 'not_json' // the file does not parse
  | 'unknown_shape' // not a JSON object, a symlink or not a regular file
  | 'unknown_format' // valid JSON, but neither compact nor 2-space: a rewrite would touch the other entries' bytes
  | 'error' // read or write failed

export interface NeedsAuthClearResult {
  outcome: NeedsAuthClearOutcome
  file: string
  detail?: string
}

/** The config dir a main session launches with: its isolated dir, else CLAUDE_CONFIG_DIR, else ~/.claude. */
export function mainNeedsAuthConfigDir(isolatedConfigDir?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return isolatedConfigDir || env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

/** True when a launch command loads the Gromzo plugin on its --channels. */
export function launchLoadsGromzo(cmd: string): boolean {
  return cmd.split(/\s+/).includes(GROMZO_CHANNELS_WORD)
}

function serializeLike(raw: string, obj: Record<string, unknown>): string | null {
  const nl = raw.endsWith('\n') ? '\n' : ''
  const body = nl ? raw.slice(0, -1) : raw
  if (JSON.stringify(JSON.parse(body)) === body) return JSON.stringify(obj) + nl
  if (JSON.stringify(JSON.parse(body), null, 2) === body) return JSON.stringify(obj, null, 2) + nl
  return null
}

/** Take the Gromzo server's key out of <configDir>/mcp-needs-auth-cache.json; every other byte stays. */
export function clearGromzoNeedsAuth(configDir: string): NeedsAuthClearResult {
  const file = join(configDir, NEEDS_AUTH_CACHE_FILE)
  let st
  try {
    st = lstatSync(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { outcome: 'absent', file } : { outcome: 'error', file, detail: `stat: ${code ?? String(err)}` }
  }
  if (!st.isFile()) return { outcome: 'unknown_shape', file, detail: st.isSymbolicLink() ? 'a symlink' : 'not a regular file' }
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (err) {
    return { outcome: 'error', file, detail: `read: ${(err as NodeJS.ErrnoException).code ?? String(err)}` }
  }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { outcome: 'not_json', file }
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { outcome: 'unknown_shape', file, detail: 'not a JSON object' }
  const cache = obj as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(cache, GROMZO_NEEDS_AUTH_KEY)) return { outcome: 'no_key', file }
  const rest: Record<string, unknown> = {}
  for (const k of Object.keys(cache)) if (k !== GROMZO_NEEDS_AUTH_KEY) rest[k] = cache[k]
  const out = serializeLike(raw, rest)
  if (out === null) return { outcome: 'unknown_format', file }
  const tmp = join(configDir, `.${NEEDS_AUTH_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`)
  try {
    const fd = openSync(tmp, 'wx', st.mode & 0o7777)
    try {
      writeSync(fd, out)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmp, st.mode & 0o7777)
    if (typeof process.getuid === 'function' && process.getuid() === 0) chownSync(tmp, st.uid, st.gid)
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* nothing to remove */ }
    return { outcome: 'error', file, detail: `write: ${(err as NodeJS.ErrnoException).code ?? String(err)}` }
  }
  return { outcome: 'removed', file }
}

/** One log line for every outcome, the same from the CLI and the dashboard. */
export function describeNeedsAuthClear(r: NeedsAuthClearResult): string {
  const why: Record<NeedsAuthClearOutcome, string> = {
    removed: `removed the cached needs-auth entry ${GROMZO_NEEDS_AUTH_KEY}, so this launch starts the Gromzo channel`,
    absent: 'no-op: no needs-auth cache file',
    no_key: `no-op: no ${GROMZO_NEEDS_AUTH_KEY} entry`,
    not_json: 'no-op: the file is not JSON, left as it is',
    unknown_shape: 'no-op: unknown shape, left as it is',
    unknown_format: 'no-op: unknown JSON formatting (a rewrite would change other entries), left as it is',
    error: 'no-op: failed, left as it is',
  }
  return `gromzo-needs-auth: ${why[r.outcome]}${r.detail ? ` (${r.detail})` : ''}: ${r.file}`
}
