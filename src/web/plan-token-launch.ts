// SUBPLANTOKEN1110: a sub-agent on a TOKEN-mode Claude plan.
//
// Before this, resolveAgentConfigDir() read a token plan as "unresolved" and the
// launcher booted the sub-agent on the fleet token, while POST
// /api/claude-plans/rotate answered 200 (measured: Iris's restart log line
// "configured plan id does not resolve ... falling back"). The rule now:
//
//   - the agent runs in its own isolated config dir (agents/<name>/.claude-config),
//     and the plan's vault secret is exported as CLAUDE_CODE_OAUTH_TOKEN at launch
//     time by scripts/resolve-plan-token-env.mjs --strict (the token never enters
//     this process's strings, argv or a log);
//   - before the launch, the launcher checks that the secret exists; if it does
//     not, or the agent cannot take a plan token at all, the agent is NOT started,
//     loudly (log + owner alert + the status file the dashboard shows). There is
//     no silent fall-back to the fleet token anywhere on this path;
//   - the helper writes the launch outcome to store/plan-token-launch/<name>.json,
//     which the dashboard's agent state and the rotate endpoint read back.
//
// Everything that decides is pure (planTokenLaunchDecision), so the four branches
// are unit-tested without tmux, vault or the real store.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

export const PLAN_TOKEN_LAUNCH_DIR = join(PROJECT_ROOT, 'store', 'plan-token-launch')
export const RESOLVE_PLAN_TOKEN_SCRIPT = join(PROJECT_ROOT, 'scripts', 'resolve-plan-token-env.mjs')

export type PlanTokenLaunchState = 'pending' | 'plan-token' | 'failed' | 'fleet-fallback' | 'refused'

/** The status file's shape. No token value, ever: only the vault reference id. */
export interface PlanTokenLaunchStatus {
  state: PlanTokenLaunchState
  secretId: string
  /** ms epoch of the write. */
  at: number
  planId?: string
  reason?: string
}

export type PlanTokenLaunchDecision =
  | { kind: 'none' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'plan-token'; secretId: string }

/**
 * Pure: may this start run on the plan's token? `tokenSecretId` is
 * resolveAgentConfigDir(name).tokenSecretId (null = not a token plan -> 'none',
 * every other branch of the launcher runs exactly as before).
 */
export function planTokenLaunchDecision(i: {
  tokenSecretId: string | null
  isMainAgent: boolean
  isClaudeModel: boolean
  isCustomProvider: boolean
  authMode: string
  /** agent-config.json names an oauthTokenFile (set or invalid). */
  hasOwnTokenFile: boolean
  /** The vault has a non-empty value under tokenSecretId (checked by the caller, value discarded). */
  secretPresent: boolean
}): PlanTokenLaunchDecision {
  if (!i.tokenSecretId) return { kind: 'none' }
  // The main agent launches through channels.sh / channel-monitor.ts, which have their own token path.
  if (i.isMainAgent) return { kind: 'none' }
  // A setup-token is a Claude OAuth credential: a custom provider or a non-Claude model cannot use it.
  if (i.isCustomProvider || !i.isClaudeModel) return { kind: 'refuse', reason: 'plan-token-needs-a-claude-oauth-agent' }
  // api: the agent's own API key; own_team: its own /login. A plan token would silently replace either.
  if (i.authMode === 'api' || i.authMode === 'own_team') return { kind: 'refuse', reason: `plan-token-conflicts-with-authMode-${i.authMode}` }
  // Two token sources for one agent: fail closed, never pick one.
  if (i.hasOwnTokenFile) return { kind: 'refuse', reason: 'plan-token-conflicts-with-oauthTokenFile' }
  if (!i.secretPresent) return { kind: 'refuse', reason: 'plan-token-missing-from-vault' }
  return { kind: 'plan-token', secretId: i.tokenSecretId }
}

/** Single-quote a value as one inert shell word (same rule as agent-process.ts shSingleQuote). */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The launch-command piece that exports the plan's token. `_plan_token=$(...)` is
 * a BARE assignment, so the helper's own exit status stops the `&&` chain before
 * `claude` when the secret is gone (--strict: no fleet fallback). Every path is
 * single-quoted; the token is resolved inside the launched shell only.
 */
export function planTokenExport(i: {
  secretId: string
  nodeBin: string
  scriptPath: string
  fleetTokenPath: string
  failuresLogPath: string
  statusPath: string
}): string {
  return `_plan_token="$(${q(i.nodeBin)} ${q(i.scriptPath)} ${q(i.secretId)} ${q(i.fleetTokenPath)} ${q(i.failuresLogPath)} --strict --status ${q(i.statusPath)})" && export CLAUDE_CODE_OAUTH_TOKEN="$_plan_token" && `
}

export function planTokenStatusPath(name: string, dir: string = PLAN_TOKEN_LAUNCH_DIR): string {
  return join(dir, `${name}.json`)
}

export function writePlanTokenStatus(name: string, rec: PlanTokenLaunchStatus, dir: string = PLAN_TOKEN_LAUNCH_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = planTokenStatusPath(name, dir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/** Removes the status of an agent that is no longer on a token plan (the dashboard then shows nothing). */
export function clearPlanTokenStatus(name: string, dir: string = PLAN_TOKEN_LAUNCH_DIR): void {
  try { rmSync(planTokenStatusPath(name, dir), { force: true }) } catch { /* nothing to clear */ }
}

const STATES: ReadonlySet<string> = new Set(['pending', 'plan-token', 'failed', 'fleet-fallback', 'refused'])

export function readPlanTokenStatus(name: string, dir: string = PLAN_TOKEN_LAUNCH_DIR): PlanTokenLaunchStatus | null {
  const path = planTokenStatusPath(name, dir)
  if (!existsSync(path)) return null
  try {
    const o = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (typeof o.state !== 'string' || !STATES.has(o.state)) return null
    if (typeof o.secretId !== 'string' || typeof o.at !== 'number') return null
    return {
      state: o.state as PlanTokenLaunchState,
      secretId: o.secretId,
      at: o.at,
      ...(typeof o.planId === 'string' ? { planId: o.planId } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Waits for the launched shell's helper to report, i.e. a status written AFTER
 * `sinceMs` whose state is no longer 'pending'. Returns the last status read
 * (possibly 'pending' or null) when the time runs out.
 */
export async function waitPlanTokenOutcome(
  name: string,
  sinceMs: number,
  opts: { timeoutMs?: number; stepMs?: number; dir?: string; read?: typeof readPlanTokenStatus } = {},
): Promise<PlanTokenLaunchStatus | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const stepMs = opts.stepMs ?? 250
  const read = opts.read ?? readPlanTokenStatus
  const deadline = Date.now() + timeoutMs
  let last: PlanTokenLaunchStatus | null = null
  for (;;) {
    last = read(name, opts.dir ?? PLAN_TOKEN_LAUNCH_DIR)
    if (last && last.at >= sinceMs && last.state !== 'pending') return last
    if (Date.now() >= deadline) return last
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

// One owner alert per agent+reason per hour: an auto-restart loop on a missing
// secret must stay loud without flooding the channel.
const ALERT_GAP_MS = 60 * 60 * 1000
const lastAlert = new Map<string, number>()
export function shouldAlertPlanToken(name: string, reason: string, nowMs: number): boolean {
  const key = `${name}\u0000${reason}`
  const prev = lastAlert.get(key)
  if (prev !== undefined && nowMs - prev < ALERT_GAP_MS) return false
  lastAlert.set(key, nowMs)
  return true
}
export function resetPlanTokenAlerts(): void { lastAlert.clear() }
