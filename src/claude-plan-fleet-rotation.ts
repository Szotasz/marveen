// Fleet leg of a Claude plan rotation (opt-in, CLAUDE_ROTATION_FLEET).
//
// Why: on the recorded outages the WEEKLY limit ran out and the whole fleet
// went down at once -- the main agent AND every sub-agent authenticating from
// the shared fleet token (store/.claude-oauth-token). Rotating only the main
// agent (the pre-existing behaviour) leaves the sub-agents on the spent plan.
// With this opt-in on, when the main agent rotates to a TOKEN-mode plan, that
// plan's token also becomes the fleet token and the sub-agents that use the
// shared token are restarted onto it.
//
// Shape: everything here is IO-injected (FleetRotationDeps) so the decision
// ("who is a shared-token agent", "what happens when a restart fails") is
// unit-tested without tmux, vault or the real store. The one real-fs helper,
// writeFleetTokenFile, is tested against a temp dir. The production wiring
// (real deps) is src/web/claude-plan-fleet-wiring.ts.
//
// Token hygiene: the token is read in-process (vault getSecret via deps),
// written straight to the 0600 file, and never appears in a returned value,
// a log line, an error string or argv.
import { copyFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from './web/atomic-write.js'
import type { ClaudePlan } from './web/claude-plans.js'
import type { FleetRotationRecord } from './web/claude-plans-state.js'

/** Gap between two sub-agent restarts: sequential, never a thundering herd of
 *  simultaneous Claude Code boots on the same token. */
export const FLEET_RESTART_GAP_MS = 5_000

/**
 * Pure: does this agent authenticate from the SHARED fleet token file?
 * Mirrors the launcher's rule (agent-process.ts startAgentProcess, the
 * oauthTokenEnv branches): a Claude-model sub-agent with no configured config
 * dir (no resolving claudePlan configDir, no raw claudeConfigDir), whose
 * authMode is neither 'api' (own API key) nor 'own_team' (own /login), and
 * that runs on this host. Everything else keeps its own credential and must
 * be left alone.
 */
export function agentUsesFleetToken(input: {
  name: string
  mainAgentId: string
  /** Model id after openrouter-auto resolution. */
  model: string
  authMode: string
  /** resolveAgentConfigDir(name).configDir -- the operator-configured dir. */
  configuredConfigDir: string | null
  /** Agent runs on another host (remote agent): its token lives there. */
  remote: boolean
}): boolean {
  if (input.name === input.mainAgentId) return false
  if (input.remote) return false
  if (!input.model.startsWith('claude-')) return false
  if (input.authMode === 'api' || input.authMode === 'own_team') return false
  if (input.configuredConfigDir) return false
  return true
}

/** Compact UTC stamp for backup names: 20260924T083015Z. */
export function utcStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export type FleetFileWriteResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; backupPath: string | null }
  | { ok: false; error: string }

/**
 * Replace the fleet token file with `token`: back up the current content to
 * `<path>.bak.rotation.<UTC>` (0600), then atomic write (tmp + rename, 0600
 * from the first byte) -- the file is either the old token or the new one,
 * never half-written. Same format as scripts/auth.sh writes (no trailing
 * newline). No-op when the file already holds exactly this token.
 * Never throws; errors are fixed strings (no fs message, which can carry the
 * path but must never carry content).
 */
export function writeFleetTokenFile(path: string, token: string, nowMs: number): FleetFileWriteResult {
  let current: string | null = null
  try {
    current = existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return { ok: false, error: 'fleet token file unreadable' }
  }
  if (current !== null && current.trim() === token) return { ok: true, changed: false }

  let backupPath: string | null = null
  if (current !== null && current.trim().length > 0) {
    backupPath = `${path}.bak.rotation.${utcStamp(nowMs)}`
    try {
      copyFileSync(path, backupPath)
      chmodSync(backupPath, 0o600)
    } catch {
      // No backup, no overwrite: the current token is the only way back.
      return { ok: false, error: 'fleet token backup failed' }
    }
  }
  try {
    atomicWriteFileSync(path, token, { mode: 0o600 })
  } catch {
    return { ok: false, error: 'fleet token write failed' }
  }
  return { ok: true, changed: true, backupPath }
}

export interface FleetRotationDeps {
  /** The plan's raw token from the vault, or null when missing. */
  readPlanToken(plan: ClaudePlan): string | null
  writeFleetToken(token: string, nowMs: number): FleetFileWriteResult
  listAgents(): string[]
  usesFleetToken(name: string): boolean
  isRunning(name: string): boolean
  /** Conversation-preserving restart (NOT fresh). */
  restart(name: string): Promise<{ ok: boolean; error?: string }>
  sleep(ms: number): Promise<void>
  nowMs(): number
  gapMs?: number
}

/** The one structured stdout line describing a fleet leg. */
export function formatFleetLine(r: Omit<FleetRotationRecord, 'line' | 'reportedAt'>, label: string): string {
  if (r.outcome === 'skipped') return `FLEET_SKIPPED plan=${r.fleetPlanId} label=${label} reason=${r.reason ?? 'unknown'}`
  if (r.outcome === 'failed') return `FLEET_FAILED plan=${r.fleetPlanId} label=${label} reason=${r.reason ?? 'unknown'}`
  const list = (xs: string[]) => (xs.length ? xs.join(',') : '-')
  return `FLEET_ROTATE plan=${r.fleetPlanId} label=${label} tokenChanged=${r.reason === 'token-unchanged' ? 'no' : 'yes'} restarted=${list(r.restarted)} failed=${list(r.failed.map((f) => f.agent))} notRunning=${list(r.notRunning)}`
}

/**
 * Run the fleet leg for a main-agent rotation onto `target`.
 *
 * - configDir-mode target: skipped (the fleet needs a raw token; a configDir
 *   plan's credential is not something this code reads).
 * - token missing from the vault: skipped, nothing touched.
 * - file write fails: 'failed', NO restarts (they would just come back on the
 *   old token, pure disruption).
 * - token already in the file: nothing written, and no restarts either --
 *   the fleet is already on this plan.
 * - otherwise: every running shared-token sub-agent restarted in turn with a
 *   gap; a failing (or throwing) restart is recorded and the loop goes on.
 */
export async function performFleetRotation(target: ClaudePlan, deps: FleetRotationDeps): Promise<FleetRotationRecord> {
  const rotatedAt = deps.nowMs()
  const base = { fleetPlanId: target.id, rotatedAt, restarted: [] as string[], failed: [] as Array<{ agent: string; error: string }>, notRunning: [] as string[] }
  const finish = (r: Omit<FleetRotationRecord, 'line' | 'reportedAt'>): FleetRotationRecord => ({ ...r, line: formatFleetLine(r, target.label) })

  if (!target.tokenSecretId) {
    return finish({ ...base, outcome: 'skipped', reason: 'config-dir-plan-fleet-needs-token' })
  }
  let token: string | null = null
  try { token = deps.readPlanToken(target) } catch { token = null }
  if (!token || !token.trim()) {
    return finish({ ...base, outcome: 'skipped', reason: 'token-missing-from-vault' })
  }

  const written = deps.writeFleetToken(token.trim(), rotatedAt)
  token = null
  if (!written.ok) return finish({ ...base, outcome: 'failed', reason: written.error.replace(/\s+/g, '-') })
  if (!written.changed) return finish({ ...base, outcome: 'rotated', reason: 'token-unchanged' })

  const shared = deps.listAgents().filter((n) => {
    try { return deps.usesFleetToken(n) } catch { return false }
  })
  const gap = deps.gapMs ?? FLEET_RESTART_GAP_MS
  let first = true
  for (const name of shared) {
    let running = false
    try { running = deps.isRunning(name) } catch { running = false }
    if (!running) {
      base.notRunning.push(name)
      continue
    }
    if (!first) await deps.sleep(gap)
    first = false
    try {
      const r = await deps.restart(name)
      if (r.ok) base.restarted.push(name)
      else base.failed.push({ agent: name, error: r.error || 'restart failed' })
    } catch (err) {
      base.failed.push({ agent: name, error: err instanceof Error ? err.name : 'restart threw' })
    }
  }
  return finish({ ...base, outcome: 'rotated' })
}
