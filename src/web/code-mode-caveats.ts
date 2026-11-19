// CODEMODEFLAG1119 (Q2, Samu 81017): the owner's Code Mode switch IS the acceptance of Claude Code's two Code Mode
// confirmation windows. The first Code Mode session asks "Yes, turn on Code Mode" (Dani's live probe); in an
// unattended tmux pane nobody answers it. After the probe answered, its config dir held both keys below as true.
// The dashboard writes them ONLY into the agent's own isolated config dir (agents/<name>/.claude-config/.claude.json),
// ONLY while codeMode is true, and removes them again when the switch goes off. Never the shared ~/.claude.json.
//
// The edit is TEXTUAL where it can be, so off -> on -> off gives the original bytes back: "on" inserts one line per
// missing key right after the top-level "{", "off" removes exactly such a line. Every textual edit is checked by
// parsing the result; when it does not parse to the expected object (an empty object, a key with another value,
// a file Claude Code reformatted with the keys elsewhere), the file is rewritten as JSON instead.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { STORE_DIR } from '../config.js'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const CODE_MODE_CAVEAT_KEYS = ['codeModeCaveatsAcceptedV1', 'codeModeAutoModeCaveatAcceptedV1'] as const

/** The agent's own isolated config dir: the only place the caveat keys are ever written. */
export function agentIsolatedConfigDir(name: string): string {
  return join(agentDir(name), '.claude-config')
}

const line = (k: string) => `\n  "${k}": true,`
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Pure: the new file text with both keys true (on) or both removed (off); null when nothing changes.
 *  Throws when the text is not a JSON object (the caller leaves such a file alone). */
export function codeModeCaveatsText(text: string, on: boolean): string | null {
  const obj = JSON.parse(text) as unknown
  if (!isPlainObject(obj)) throw new Error('.claude.json is not a JSON object')
  const want: Record<string, unknown> = { ...obj }
  let candidate = text
  if (on) {
    if (CODE_MODE_CAVEAT_KEYS.every((k) => obj[k] === true)) return null
    const missing = CODE_MODE_CAVEAT_KEYS.filter((k) => !(k in obj))
    for (const k of CODE_MODE_CAVEAT_KEYS) want[k] = true
    const brace = text.indexOf('{')
    candidate = text.slice(0, brace + 1) + missing.map(line).join('') + text.slice(brace + 1)
  } else {
    if (CODE_MODE_CAVEAT_KEYS.every((k) => !(k in obj))) return null
    for (const k of CODE_MODE_CAVEAT_KEYS) {
      delete want[k]
      candidate = candidate.replace(line(k), '')
    }
  }
  try { if (isDeepStrictEqual(JSON.parse(candidate), want)) return candidate } catch { /* not valid: rewrite */ }
  return JSON.stringify(want, null, 2) + '\n'
}

export type CaveatsResult = 'written' | 'unchanged' | 'missing' | 'refused'

/** Set (on) or remove (off) the caveat keys in one .claude.json. 'missing': no such file (a never-launched agent;
 *  the launch stamps it after provisioning). 'refused': the shared ~/.claude.json, never written. Atomic, the file's
 *  mode kept (group bits added for a per-user agent, as writeJsonAtomic does). Throws on an unreadable file. */
export function setCodeModeCaveats(dotClaudePath: string, on: boolean, opts: { groupShared?: boolean } = {}): CaveatsResult {
  if (dotClaudePath === join(homedir(), '.claude.json')) return 'refused'
  if (!existsSync(dotClaudePath)) return 'missing'
  const next = codeModeCaveatsText(readFileSync(dotClaudePath, 'utf-8'), on)
  if (next === null) return 'unchanged'
  let mode = statSync(dotClaudePath).mode & 0o777
  if (opts.groupShared) mode |= 0o060
  atomicWriteFileSync(dotClaudePath, next, { mode })
  return 'written'
}

// CODEMODEFOLLOW1119: scripts/watchdog.sh relaunches a missing agent with its own command and cannot run
// resolveCodeModeLaunch. It reads this marker instead, the way it reads store/bash-sandbox/ (BASHSANDBOX1022): the
// file exists exactly when the last dashboard start ran the agent in Code Mode and the switch has not gone off since.
// A missing marker means off, the safe direction: an off launch only waits for the next dashboard start, while an on
// launch without the caveat keys parks the unattended pane on a confirmation. It lives under store/, outside the
// agent's own directory.
export const CODE_MODE_MARKER_DIR = join(STORE_DIR, 'code-mode')

export function codeModeMarkerPath(name: string, dir = CODE_MODE_MARKER_DIR): string {
  return join(dir, `${name}.on`)
}

/** Create (on) or remove (off) the agent's marker. Throws when it cannot. */
export function syncCodeModeMarker(name: string, on: boolean, dir = CODE_MODE_MARKER_DIR): void {
  const path = codeModeMarkerPath(name, dir)
  if (on) {
    mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(path, '')
  } else {
    rmSync(path, { force: true })
  }
}
