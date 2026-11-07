// MAINAUTH1107 (APIKULCSINDITAS1004 A): which credential the MAIN agent's pane runs on, decided in ONE place and
// applied by every path that launches it (channels.sh at boot through scripts/main-agent-auth.mjs, the dashboard's
// respawns in channel-monitor.ts, and the two bash watchdogs through the same helper).
//
// Why one place: the pane-auth file alone does not decide. A dashboard restart on Linux (and on macOS without the
// channels plist) is a `tmux respawn-pane`, not a channels.sh run, so a file only channels.sh writes keeps the old
// mode; and after that file the config branch (CFG_ENV) and the tmux global env add the OAuth token again. So every
// launch path calls applyMainAuth() right before it starts the pane, and every launch command sources the post-file
// right after its config branch (a static piece: the builders carry no mode logic).
//
// Measured 2026-11-07 on Claude Code 2.1.319 (agents/geri/work/apikulcs/meres.md, probe4): key + OAuth token + an
// approved stamp runs on the key without blocking, but the CLI warns "Both CLAUDE_CODE_OAUTH_TOKEN and
// ANTHROPIC_API_KEY set" and itself says to unset the token. So api mode is exactly one credential.
//
// Modes (the main agent's agent-config.json authMode, written by the owner-gated dashboard switch):
// - shared (default): the install mode decides (auth-key-mode.ts). On a subscription install the main pane gets NO
//   key (before this, it sourced the .env key and stopped at "Detected a custom API key"); on a key-only install it
//   runs on the key, stamped into its config dir's .claude.json, as the fleet does.
// - api: the key (vault agent-<main>-api-key, else .env) and no token, stamped into the main config dir's
//   .claude.json. On a non-isolated main that is the shared ~/.claude.json: the switch says so before Apply, and a
//   ledger removes exactly this approval again when the mode or the key changes (Samu 72304).
//   A conflict resolves to the side that does not bill, with a reason: an own-login config dir (explicit/rotated),
//   a token-mode rotated plan, a custom provider, or no key at all.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import { envFileValue, authKeyModeFrom, type AuthKeyMode } from './auth-key-mode.js'
import { readAgentAuthMode, readAgentCustomProvider, readJsonObjectForWrite } from './agent-config.js'
import { getSecret } from './vault.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'

export type MainCfgKind = 'own-login' | 'plan-token' | 'isolated' | 'shared'
export type MainAuthEffective = 'api' | 'subscription' | 'keyonly' | 'none'
export type MainAuthConflict = 'own-login' | 'plan-token' | 'custom-provider' | 'no-key' | 'own-team'
type CredVar = 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY'

export interface MainAuthInputs {
  /** The main agent's agent-config.json authMode ('own_team' is not offered for the main agent). */
  authMode: 'shared' | 'api' | 'own_team'
  installMode: AuthKeyMode
  /** The vault key agent-<main>-api-key ('' = none). */
  vaultKey: string
  /** .env ANTHROPIC_API_KEY ('' = none). */
  envKey: string
  /** .env CLAUDE_CODE_OAUTH_TOKEN, else the fleet token file ('' = none). */
  oauthToken: string
  cfgKind: MainCfgKind
  /** The main config dir for isolated/plan-token/own-login; null on the shared root. */
  cfgDir: string | null
  customProvider: boolean
  home?: string
}

export interface MainAuthDecision {
  configured: 'shared' | 'api'
  effective: MainAuthEffective
  keySource: 'vault' | 'env' | null
  /** The key the pane-auth file exports ('' = none). */
  key: string
  /** The token the pane-auth file exports ('' = none). */
  token: string
  /** Unset right AFTER the config branch (the post-file), so CFG_ENV and the tmux global env cannot add it back. */
  postUnset: CredVar[]
  /** The .claude.json the key is approved in (null = no stamp). */
  stampTarget: string | null
  /** True for the switch's own approval (api mode): recorded in the ledger, removed when no longer wanted. */
  ledgered: boolean
  conflict: MainAuthConflict | null
}

/** The config-dir mode as scripts/main-agent-isolated-config.mjs prints it ('' = nothing printed: the shared root). */
export function cfgKindFromHelperMode(mode: string): MainCfgKind {
  if (mode === 'explicit' || mode === 'rotated') return 'own-login'
  if (mode === 'token') return 'plan-token'
  if (mode === 'isolated') return 'isolated'
  return 'shared'
}

/** The same, from the dashboard's MainConfigDecision fields. */
export function cfgKindFromDecision(c: { isolatedConfigDir: string | null; ownCredentials: boolean; tokenSecretId?: string | null }): MainCfgKind {
  if (!c.isolatedConfigDir) return 'shared'
  if (c.ownCredentials) return 'own-login'
  if (c.tokenSecretId) return 'plan-token'
  return 'isolated'
}

function stampTargetFor(i: MainAuthInputs): string | null {
  if (i.cfgKind === 'own-login') return null // CFG_ENV unsets the key there: nothing would use the approval
  if ((i.cfgKind === 'isolated' || i.cfgKind === 'plan-token') && i.cfgDir) return join(i.cfgDir, '.claude.json')
  return join(i.home ?? homedir(), '.claude.json')
}

/** Pure: what the main pane runs on, from the inputs alone. */
export function decideMainAuth(i: MainAuthInputs): MainAuthDecision {
  const configured: 'shared' | 'api' = i.authMode === 'api' ? 'api' : 'shared'
  let conflict: MainAuthConflict | null = i.authMode === 'own_team' ? 'own-team' : null
  if (configured === 'api') {
    const key = (i.vaultKey || i.envKey).trim()
    if (i.customProvider) conflict = 'custom-provider'
    else if (i.cfgKind === 'own-login') conflict = 'own-login'
    else if (i.cfgKind === 'plan-token') conflict = 'plan-token'
    else if (!key) conflict = 'no-key'
    else {
      return {
        configured, effective: 'api', keySource: i.vaultKey.trim() ? 'vault' : 'env', key, token: '',
        postUnset: ['CLAUDE_CODE_OAUTH_TOKEN'], stampTarget: stampTargetFor(i), ledgered: true, conflict: null,
      }
    }
  }
  // shared, or api that fell back: the install mode decides (B's rule), never billing a key the owner did not choose.
  if (i.installMode === 'subscription') {
    return {
      configured, effective: 'subscription', keySource: null, key: '', token: i.oauthToken,
      postUnset: ['ANTHROPIC_API_KEY'], stampTarget: null, ledgered: false, conflict,
    }
  }
  if (i.installMode === 'keyonly' && i.envKey.trim()) {
    return {
      configured, effective: 'keyonly', keySource: 'env', key: i.envKey.trim(), token: '',
      postUnset: [], stampTarget: stampTargetFor(i), ledgered: false, conflict,
    }
  }
  return { configured, effective: 'none', keySource: null, key: '', token: '', postUnset: [], stampTarget: null, ledgered: false, conflict }
}

export interface MainAuthPaths {
  paneAuth: string
  paneAuthPost: string
  ledger: string
  launched: string
}

export function mainAuthPaths(storeDir: string): MainAuthPaths {
  return {
    paneAuth: join(storeDir, '.channels-pane-auth'),
    paneAuthPost: join(storeDir, '.channels-pane-auth-post'),
    ledger: join(storeDir, '.main-auth-stamps.json'),
    launched: join(storeDir, '.main-auth-launched'),
  }
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const suffixOf = (key: string) => key.trim().slice(-20)
const hashOf = (suffix: string) => createHash('sha256').update(suffix).digest('hex')

type LedgerEntry = { target: string; hash: string }

function readLedger(p: string): LedgerEntry[] {
  try {
    const v = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(v) ? v.filter((e) => e && typeof e.target === 'string' && typeof e.hash === 'string') : []
  } catch { return [] }
}

/** Adds the suffix to approved and takes it out of rejected (an old "No" at the prompt; measured on 2.1.319 that
 *  approved wins when both hold it, so this is tidiness, not a fix). Refuses a corrupt .claude.json (JSONCLOBBER926B).
 *  Returns 'added' only when THIS call put the suffix into approved: an approval that was already there (the owner's
 *  own Yes in a terminal, a key-only stamp of the same key) is not the switch's, so it is never ledgered. */
function stampApproved(target: string, suffix: string, clearRejected: boolean): 'added' | 'present' {
  const data = readJsonObjectForWrite(target)
  const existing = (data.customApiKeyResponses && typeof data.customApiKeyResponses === 'object' && !Array.isArray(data.customApiKeyResponses))
    ? data.customApiKeyResponses as Record<string, unknown>
    : {}
  const approved = Array.isArray(existing.approved) ? existing.approved as unknown[] : []
  const rejected = Array.isArray(existing.rejected) ? existing.rejected as unknown[] : []
  const nextRejected = clearRejected ? rejected.filter((s) => s !== suffix) : rejected
  const wasApproved = approved.includes(suffix)
  if (wasApproved && nextRejected.length === rejected.length) return 'present'
  data.customApiKeyResponses = {
    ...existing,
    approved: approved.includes(suffix) ? approved : [...approved, suffix],
    ...(Array.isArray(existing.rejected) || nextRejected.length ? { rejected: nextRejected } : {}),
  }
  atomicWriteFileSync(target, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  return wasApproved ? 'present' : 'added'
}

/** A crash between atomicWriteFileSync's tmp write and its rename leaves `<file>.<pid>.<ts>.<hex>.tmp` (0600, the
 *  credential in it). Only those older than a minute: a concurrent launch may be between its write and rename now. */
function sweepStaleTmp(file: string, nowMs: number): void {
  try {
    const dir = dirname(file)
    const prefix = `${basename(file)}.`
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.tmp')) continue
      const p = join(dir, f)
      try { if (nowMs - statSync(p).mtimeMs > 60_000) rmSync(p, { force: true }) } catch { /* gone already */ }
    }
  } catch { /* no dir yet */ }
}

/** Removes exactly the approvals whose suffix hashes to `hash`. A missing file is nothing to remove. */
function unstamp(target: string, hash: string): void {
  if (!existsSync(target)) return
  const data = readJsonObjectForWrite(target)
  const existing = data.customApiKeyResponses
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return
  const resp = existing as Record<string, unknown>
  const approved = Array.isArray(resp.approved) ? resp.approved as unknown[] : []
  const kept = approved.filter((s) => typeof s !== 'string' || hashOf(s) !== hash)
  if (kept.length === approved.length) return
  data.customApiKeyResponses = { ...resp, approved: kept }
  atomicWriteFileSync(target, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

export interface ApplyResult {
  ok: boolean
  /** Names what failed (never a value): 'pane-auth', 'post', 'stamp', 'unstamp', 'ledger'. */
  failed: string[]
}

/** Writes what the decision says: the pane-auth file, the post-file, the stamp (+ ledger) and the launched record.
 *  Each step is tried even when an earlier one failed, and every failure is named in the result. */
export function applyMainAuth(d: MainAuthDecision, paths: MainAuthPaths, now: Date = new Date()): ApplyResult {
  const failed: string[] = []
  sweepStaleTmp(paths.paneAuth, now.getTime())
  sweepStaleTmp(paths.paneAuthPost, now.getTime())
  // 1. pane-auth: sourced first by every launch (TOKENARGV929: the values never in argv).
  try {
    const lines = [
      ...(d.token ? [`export CLAUDE_CODE_OAUTH_TOKEN=${sq(d.token)}`] : []),
      ...(d.key ? [`export ANTHROPIC_API_KEY=${sq(d.key)}`] : []),
    ]
    if (lines.length) atomicWriteFileSync(paths.paneAuth, lines.join('\n') + '\n', { mode: 0o600 })
    else rmSync(paths.paneAuth, { force: true })
  } catch {
    failed.push('pane-auth')
    // The previous mode's credential must not be what the pane sources now; the caller falls back (channels.sh).
    try { rmSync(paths.paneAuth, { force: true }) } catch { /* reported above */ }
  }
  // 2. post-file: sourced right after the config branch. Always written (an empty file is a no-op), so a stale one
  //    from an earlier mode can never unset the credential this mode needs.
  try {
    atomicWriteFileSync(paths.paneAuthPost, d.postUnset.length ? `unset ${d.postUnset.join(' ')}\n` : '', { mode: 0o600 })
  } catch {
    failed.push('post')
    // A stale post-file from another mode could unset the very credential this mode needs: without one, nothing is
    // unset (the safe default).
    try { rmSync(paths.paneAuthPost, { force: true }) } catch { /* reported above */ }
  }
  // 3. stamps: the switch's own approval is ledgered; anything ledgered that is no longer wanted is removed.
  const wanted: LedgerEntry | null = d.stampTarget && d.key && d.ledgered ? { target: d.stampTarget, hash: hashOf(suffixOf(d.key)) } : null
  const ledger = readLedger(paths.ledger)
  const keep: LedgerEntry[] = []
  let wantedLedgered = false
  for (const e of ledger) {
    if (wanted && e.target === wanted.target && e.hash === wanted.hash) {
      // still ours, whatever happens to the stamp below: a failed re-stamp must not orphan the earlier approval
      if (!wantedLedgered) keep.push(e)
      wantedLedgered = true
      continue
    }
    try { unstamp(e.target, e.hash) } catch { failed.push('unstamp'); keep.push(e) }
  }
  if (d.stampTarget && d.key) {
    try {
      const r = stampApproved(d.stampTarget, suffixOf(d.key), true)
      if (wanted && r === 'added' && !wantedLedgered) keep.push(wanted)
    } catch { failed.push('stamp') }
  }
  try {
    if (keep.length || ledger.length) atomicWriteFileSync(paths.ledger, JSON.stringify(keep, null, 2) + '\n', { mode: 0o600 })
  } catch { failed.push('ledger') }
  // 4. what this launch runs on, for the dashboard ("configured" next to "running"). No value in it.
  try {
    atomicWriteFileSync(paths.launched, JSON.stringify({
      configured: d.configured, effective: d.effective, keySource: d.keySource, stampTarget: d.stampTarget,
      conflict: d.conflict, at: now.toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })
  } catch { /* informational only */ }
  return { ok: failed.length === 0, failed }
}

/** The OAuth token the way channels.sh reads it: .env first, else the fleet token file (trailing newlines dropped,
 *  as $(cat) does). */
export function readMainOauthToken(envText: string, tokenFile: string): string {
  const fromEnv = envFileValue(envText, 'CLAUDE_CODE_OAUTH_TOKEN')
  if (fromEnv) return fromEnv
  try {
    const t = readFileSync(tokenFile, 'utf-8').replace(/\n+$/, '')
    return t.trim() ? t : ''
  } catch { return '' }
}

/** The live inputs for the main agent (read at every launch: a key or token added later counts at once). */
export function gatherMainAuthInputs(cfgKind: MainCfgKind, cfgDir: string | null, opts: { projectRoot?: string; mainAgentId?: string } = {}): MainAuthInputs {
  const root = opts.projectRoot ?? PROJECT_ROOT
  const main = opts.mainAgentId ?? MAIN_AGENT_ID
  let envText = ''
  try { envText = readFileSync(join(root, '.env'), 'utf-8') } catch { /* none */ }
  const tokenFile = join(root, 'store', '.claude-oauth-token')
  let tokenFileNonEmpty = false
  try { tokenFileNonEmpty = readFileSync(tokenFile, 'utf-8').trim() !== '' } catch { /* none */ }
  const authMode = readAgentAuthMode(main)
  let vaultKey = ''
  try {
    vaultKey = getSecret(`agent-${main}-api-key`) ?? ''
  } catch (err) {
    // getSecret fails closed (e.g. the Keychain is not reachable from a launchd job). For api mode that is NOT "no
    // key": deciding on it would unstamp the owner's approval and send a false "no key stored". Give up instead;
    // the caller keeps the files of the last launch (channels.sh: its bash fallback).
    if (authMode === 'api') throw new Error(`main-auth: the vault is unreadable (${err instanceof Error ? err.name : 'error'}), this launch keeps the last decision`)
    vaultKey = ''
  }
  return {
    authMode,
    installMode: authKeyModeFrom({ envText, tokenFileNonEmpty }),
    vaultKey,
    envKey: envFileValue(envText, 'ANTHROPIC_API_KEY'),
    oauthToken: readMainOauthToken(envText, tokenFile),
    cfgKind,
    cfgDir,
    customProvider: !!readAgentCustomProvider(main),
  }
}

/** Gather, decide, apply: what every main launch path calls right before it starts the pane. */
export function prepareMainAuth(cfgKind: MainCfgKind, cfgDir: string | null, storeDir: string = STORE_DIR): { decision: MainAuthDecision; result: ApplyResult } {
  const decision = decideMainAuth(gatherMainAuthInputs(cfgKind, cfgDir))
  return { decision, result: applyMainAuth(decision, mainAuthPaths(storeDir)) }
}

/** The owner-facing reason a configured api mode did not take effect (null when it did, or was not asked for). */
export function mainAuthConflictText(c: MainAuthConflict | null): string | null {
  switch (c) {
    case 'own-login': return 'the main agent has its own Claude login (MAIN_AGENT_CONFIG_DIR or a rotated plan), which takes precedence'
    case 'plan-token': return 'a rotated Claude plan with its own token is active for the main agent'
    case 'custom-provider': return 'the main agent runs on a custom provider'
    case 'no-key': return 'no API key is stored for the main agent, in the vault or in the install env file'
    case 'own-team': return 'own_team is not available for the main agent'
    default: return null
  }
}

/** What the last main launch ran on, from store/.main-auth-launched (null when no launch recorded it yet). */
export function readMainAuthLaunched(storeDir: string = STORE_DIR): { configured: string; effective: MainAuthEffective; conflict: MainAuthConflict | null } | null {
  try {
    const v = JSON.parse(readFileSync(mainAuthPaths(storeDir).launched, 'utf-8'))
    if (v && typeof v.effective === 'string') return v
  } catch { /* none yet */ }
  return null
}

/** True when the main pane runs on an API key (api, or a key-only install): an auth failure there is the key's,
 *  so no OAuth-token probe and no restart can heal it. */
export function mainLaunchedOnKey(storeDir: string = STORE_DIR): boolean {
  const l = readMainAuthLaunched(storeDir)
  return l?.effective === 'api' || l?.effective === 'keyonly'
}
