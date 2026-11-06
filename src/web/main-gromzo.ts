// GROMZOMAINAGENT1106 phase 1: the main agent on Gromzo, through the same owner-consent path as a sub-agent.
//
// The consent itself is gromzo-agents.ts (enable/check, one pending map for every slug). What is different for
// the main agent is what the "flag" and the "restart" mean:
//  - the flag is the gromzo-channel id in .env CHANNEL_PLUGINS_EXTRA, which every main launcher reads
//    (scripts/main-gromzo-launch.sh, main-gromzo-launch.ts). It is written only after mxd added the main agent;
//  - before it, the staged gromzo-local marketplace is registered in the SHARED ~/.claude/plugins (the isolated
//    config dirs are re-seeded from there on every start, agent-process.ts provisionIsolatedConfigDir);
//  - the restart is the main session's own (gateManualRestart + hardRestartMarveenChannels), never the
//    sub-agent restartAgentProcess, which would start a second main session (main-agent.ts).
// The restart waits for mxd to answer again after its reload and for the main slug NOT to be held back
// (Samu 71193 D1: an observable signal, not a timed wait). The state is kept for the panel.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAIN_GROMZO_PLUGIN_ID } from './main-gromzo-launch.js'
import { ensureGromzoMarketplace, type GromzoMarketplaceResult } from './gromzo-marketplace.js'

const KEY = 'CHANNEL_PLUGINS_EXTRA'

export type MainGromzoTokenRead =
  | { ok: true, on: boolean, ids: string[] }
  /** ambiguous: the key appears more than once, or its value is quoted: the launchers (first line, raw) and a
   *  dotenv reader (last line, unquoted) would disagree, so nothing is written (EGM v2 codebase M3). */
  | { ok: false, code: 'env_ambiguous' | 'env_unreadable' }

function keyLines(lines: string[]): number[] {
  const out: number[] = []
  lines.forEach((l, i) => { if (l.startsWith(`${KEY}=`)) out.push(i) })
  return out
}

/** Whether .env lists the main agent's gromzo-channel id, read the way the launchers read it. */
export function readMainGromzoToken(projectRoot: string): MainGromzoTokenRead {
  const path = join(projectRoot, '.env')
  let text = ''
  try { text = existsSync(path) ? readFileSync(path, 'utf-8') : '' } catch { return { ok: false, code: 'env_unreadable' } }
  const lines = text.split('\n')
  const at = keyLines(lines)
  if (at.length > 1) return { ok: false, code: 'env_ambiguous' }
  if (at.length === 0) return { ok: true, on: false, ids: [] }
  const value = lines[at[0]].slice(KEY.length + 1)
  if (/["']/.test(value)) return { ok: false, code: 'env_ambiguous' }
  const ids = value.trim().split(/\s+/).filter(Boolean)
  return { ok: true, on: ids.includes(MAIN_GROMZO_PLUGIN_ID), ids }
}

/**
 * Adds or removes ONLY the gromzo-channel id; every other id and every other line stays as it is. Atomic
 * (temp + rename), the file's mode kept. Removing the last id drops the line (updateEnvFile cannot write an
 * empty value, EGM v2 codebase B2). Idempotent.
 */
export function setMainGromzoToken(projectRoot: string, on: boolean): { ok: true, changed: boolean } | { ok: false, code: 'env_ambiguous' | 'env_unreadable' } {
  const cur = readMainGromzoToken(projectRoot)
  if (!cur.ok) return cur
  if (cur.on === on) return { ok: true, changed: false }
  const path = join(projectRoot, '.env')
  let text = ''
  let mode = 0o600
  try {
    if (existsSync(path)) { text = readFileSync(path, 'utf-8'); mode = statSync(path).mode & 0o777 }
  } catch { return { ok: false, code: 'env_unreadable' } }
  const lines = text === '' ? [] : text.split('\n')
  const at = keyLines(lines)
  const ids = on ? [...cur.ids, MAIN_GROMZO_PLUGIN_ID] : cur.ids.filter((i) => i !== MAIN_GROMZO_PLUGIN_ID)
  const line = `${KEY}=${ids.join(' ')}`
  if (at.length === 1) {
    if (ids.length === 0) lines.splice(at[0], 1)
    else lines[at[0]] = line
  } else {
    // No line yet: append before a trailing empty line, so the file keeps ending in one newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line)
    else lines.push(line, '')
  }
  const tmp = `${path}.main-gromzo.${process.pid}.tmp`
  try {
    writeFileSync(tmp, lines.join('\n'), { mode })
    renameSync(tmp, path)
  } catch { return { ok: false, code: 'env_unreadable' } }
  return { ok: true, changed: true }
}

/** The staged gromzo-local marketplace in the SHARED ~/.claude/plugins, with the same arguments as the sub-agent path. */
export function registerMainGromzoMarketplace(projectRoot: string, home: string = homedir()): GromzoMarketplaceResult {
  return ensureGromzoMarketplace({
    pluginsDir: join(home, '.claude', 'plugins'),
    pluginRoot: join(home, 'marveen-local-plugins', 'gromzo'),
    projectRoot,
  })
}

/** What the panel shows for the main agent's launch side (the consent side is the shared pending map). */
export type MainGromzoLaunchState =
  | 'idle'
  | 'waiting_mxd'        // mxd added the main agent; waiting for it to answer again after its reload
  | 'restart_waiting'    // the main pane is busy (gateManualRestart): the owner restarts it from the panel
  | 'restarted'
  | 'held'               // mxd holds the main agent back (no consent it can use): no restart
  | 'marketplace_failed' // the plugin could not be registered: nothing written, no restart
  | 'env_failed'         // .env could not be written safely (ambiguous or unreadable): no restart
  | 'restart_failed'

let launchState: MainGromzoLaunchState = 'idle'
export function mainGromzoLaunchState(): MainGromzoLaunchState { return launchState }
/** Test seam. */
export function resetMainGromzoLaunchState(): void { launchState = 'idle' }

export interface MainGromzoRestartDeps {
  /** dash status: { ok, running, held_agents? } (or throws while mxd reloads). */
  status: () => Promise<{ ok?: unknown, running?: unknown, held_agents?: unknown }>
  gate: () => Promise<{ allow: boolean }>
  restart: () => { ok: boolean }
  sleep: (ms: number) => Promise<void>
  mainSlug: string
}

/**
 * After mxd added the main agent: wait until dash status answers again (it reloads ~0.5 s after an add), then
 * restart the main session only if the main slug is not held. A busy pane is not a failure: the state says
 * the restart is waiting, and the panel offers it (restartMainForGromzoNow).
 */
export async function restartMainAfterMxdReload(deps: MainGromzoRestartDeps): Promise<MainGromzoLaunchState> {
  launchState = 'waiting_mxd'
  await deps.sleep(2_000)
  let held: unknown = undefined
  let answered = false
  for (let i = 0; i < 30; i++) {
    try {
      const r = await deps.status()
      if (r.ok === true && r.running === true) { answered = true; held = r.held_agents; break }
    } catch { /* still reloading */ }
    await deps.sleep(2_000)
  }
  if (!answered) { launchState = 'restart_failed'; return launchState }
  if (Array.isArray(held) && held.includes(deps.mainSlug)) { launchState = 'held'; return launchState }
  return restartMainForGromzoNow(deps)
}

/** The panel's "restart now" (and the tail of the reload wait): the main pane gate first, never forced. */
export async function restartMainForGromzoNow(deps: Pick<MainGromzoRestartDeps, 'gate' | 'restart'>): Promise<MainGromzoLaunchState> {
  const gate = await deps.gate()
  if (!gate.allow) { launchState = 'restart_waiting'; return launchState }
  launchState = deps.restart().ok ? 'restarted' : 'restart_failed'
  return launchState
}

/**
 * The main agent's "flag on", after mxd added it: the marketplace first, then the .env id. Returns the state
 * that stops the run, or null when both are in place (the caller then schedules the restart).
 */
export function switchMainGromzoOn(projectRoot: string, home: string = homedir()): MainGromzoLaunchState | null {
  launchState = 'idle'
  const reg = registerMainGromzoMarketplace(projectRoot, home)
  if (reg !== 'present' && reg !== 'registered') { launchState = 'marketplace_failed'; return launchState }
  const w = setMainGromzoToken(projectRoot, true)
  if (!w.ok) { launchState = 'env_failed'; return launchState }
  return null
}

/** The main agent's "flag off": the .env id only. mxd keeps the agent (phase 1 never removes the main agent). */
export function switchMainGromzoOff(projectRoot: string): MainGromzoLaunchState | null {
  launchState = 'idle'
  const w = setMainGromzoToken(projectRoot, false)
  if (!w.ok) { launchState = 'env_failed'; return launchState }
  return null
}
