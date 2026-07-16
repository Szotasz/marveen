import { execFileSync, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { PLATFORM, resolveFromPath } from '../platform.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { FLEET_OAUTH_TOKEN_PATH } from './agent-process.js'

// --- Linux shared-credentials race guard (opt-in) ----------------------------
//
// On Linux there is no OS-level file lock around ~/.claude/.credentials.json,
// which holds a short-lived, self-ROTATING OAuth token. When several Claude
// Code processes hit its expiry at once (nightly), their refresh writes race
// and corrupt the file -> every agent then demands /login next morning. macOS
// serialises this through the Keychain, so it is a Linux-only failure.
//
// The fix: with a long-lived setup-token exported via CLAUDE_CODE_OAUTH_TOKEN,
// Claude Code does not need the rotating credentials.json at all. Renaming it
// out of the way (.bak) removes the file the refresh race writes to. The rename
// is guarded so it can NEVER lock an agent out:
//   - opt-in flag (default OFF): nothing happens without CLAUDE_CREDENTIALS_GUARD;
//   - Linux only (macOS has no credentials.json);
//   - only when a VALID setup-token exists -- structural check plus a cached
//     live test (a real `claude -p` call, run once per token value, keyed by
//     the token hash so a healthy token is not re-tested on every launch);
//   - idempotent, and reversible (mv .bak back).
// If any guard fails, the credentials.json is left untouched.
//
// The token value is NEVER logged, committed, or echoed: the live test passes
// it through the child's env only, and this module logs booleans/paths only.

const HOME_CREDENTIALS = join(homedir(), '.claude', '.credentials.json')
const BAK_CREDENTIALS = HOME_CREDENTIALS + '.bak'
// sha256(token) of the last token that PASSED the live test. Lets a healthy
// token skip the (network) re-test on subsequent launches.
const VERIFIED_STAMP = join(STORE_DIR, '.claude-oauth-token.verified')
const OAUTH_TOKEN_RX = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/
const LIVE_TEST_MODEL = 'claude-haiku-4-5-20251001'

/** Opt-in, default OFF. Env flag so a pilot host enables it in isolation. */
export function credentialsGuardEnabled(): boolean {
  return process.env['CLAUDE_CREDENTIALS_GUARD'] === '1'
}

function readFleetToken(): string | null {
  try {
    const t = readFileSync(FLEET_OAUTH_TOKEN_PATH, 'utf-8').trim()
    return t.length > 0 ? t : null
  } catch { return null }
}

/** Bare setup-token shape check (the ~109-byte sk-ant-oat01- form). */
export function looksLikeSetupToken(token: string): boolean {
  return OAUTH_TOKEN_RX.test(token)
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readVerifiedHash(): string | null {
  try { return readFileSync(VERIFIED_STAMP, 'utf-8').trim() || null } catch { return null }
}

/**
 * Live-test a token exactly like the runbook step 5: an isolated CLAUDE_CONFIG_DIR
 * plus CLAUDE_CODE_OAUTH_TOKEN, one `claude -p` that must answer "OK". Returns
 * true only on a clean OK. The token is passed via env, never on argv/logs.
 */
export function liveTestToken(token: string, claudeBin: string): boolean {
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'cred-guard-'))
    const out = execFileSync(
      claudeBin,
      ['-p', 'Reply with exactly: OK', '--model', LIVE_TEST_MODEL],
      {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: token },
      },
    )
    return /\bOK\b/.test(out.trim())
  } catch {
    return false
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}

/**
 * Resolve whether the fleet token is currently VALID, using the cached stamp to
 * avoid a network call when the token is unchanged and already verified.
 * Writes the stamp on a fresh pass. Returns false (and does NOT rename) if the
 * token is missing, malformed, or the live test fails.
 */
function tokenIsValid(claudeBin: string): boolean {
  const token = readFleetToken()
  if (!token) { logger.warn('credentials-guard: no fleet setup-token (store/.claude-oauth-token); leaving credentials.json untouched'); return false }
  if (!looksLikeSetupToken(token)) { logger.warn('credentials-guard: fleet token is not a well-formed setup-token; leaving credentials.json untouched'); return false }
  const h = tokenHash(token)
  if (readVerifiedHash() === h) return true
  logger.info('credentials-guard: live-testing the fleet setup-token (once per token value)')
  if (!liveTestToken(token, claudeBin)) { logger.warn('credentials-guard: fleet token failed the live test; leaving credentials.json untouched'); return false }
  try { writeFileSync(VERIFIED_STAMP, h + '\n', { mode: 0o600 }) } catch { /* stamp is an optimisation; a write failure only costs a re-test */ }
  return true
}

// --- Live auth probe (async) --------------------------------------------------
//
// `claude auth status` does NOT validate a credential remotely -- it reports
// the auth SOURCE and exits 0 even for a garbage token (proven live on the
// bootcamp reference VPS, claude 2.1.110). The only real validation is a tiny
// `claude -p` call. This is the async twin of liveTestToken with a three-way
// answer, so callers can tell "the credential is dead" (quarantine/reject)
// apart from "the probe could not run / network flake" (do nothing harmful).

export type AuthProbeResult = 'ok' | 'auth-rejected' | 'inconclusive'

const AUTH_FAILURE_RX =
  /\b401\b|Invalid bearer token|Invalid API key|authentication_error|Invalid authentication|Failed to authenticate|OAuth (?:token|authentication) (?:has )?expired/i

/** Pure classifier for a probe run. Exported for tests. */
export function classifyAuthProbe(input: { ran: boolean; exitedNonZero: boolean; output: string }): AuthProbeResult {
  if (!input.ran) return 'inconclusive'
  if (!input.exitedNonZero && /\bOK\b/.test(input.output)) return 'ok'
  if (AUTH_FAILURE_RX.test(input.output)) return 'auth-rejected'
  return 'inconclusive'
}

/**
 * Probe ONE credential in an isolated CLAUDE_CONFIG_DIR. Sibling auth env vars
 * are stripped first: CLAUDE_CODE_OAUTH_TOKEN strictly overrides everything
 * else, so a stale inherited token would otherwise be the credential under
 * test instead of `envOverride`. Never logs or returns the secret.
 */
export async function liveProbeAuth(envOverride: Record<string, string>, claudeBin?: string): Promise<AuthProbeResult> {
  let dir: string | null = null
  try {
    const bin = claudeBin ?? resolveFromPath('claude')
    dir = mkdtempSync(join(tmpdir(), 'auth-probe-'))
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: dir }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.ANTHROPIC_API_KEY
    Object.assign(env, envOverride)
    const run = await new Promise<{ ran: boolean; exitedNonZero: boolean; output: string }>((resolve) => {
      execFile(
        bin,
        ['-p', 'Reply with exactly: OK', '--model', LIVE_TEST_MODEL],
        { timeout: 60_000, encoding: 'utf-8', env: env as NodeJS.ProcessEnv },
        (err, stdout, stderr) => {
          if (err && (err as { code?: unknown }).code === 'ENOENT') { resolve({ ran: false, exitedNonZero: true, output: '' }); return }
          resolve({ ran: true, exitedNonZero: Boolean(err), output: `${stdout ?? ''}\n${stderr ?? ''}` })
        },
      )
    })
    return classifyAuthProbe(run)
  } catch {
    return 'inconclusive'
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
}

/** Record a token as live-verified (skips future re-tests). Exported for the wizard. */
export function stampTokenVerified(token: string): void {
  try { writeFileSync(VERIFIED_STAMP, tokenHash(token) + '\n', { mode: 0o600 }) } catch { /* optimisation only */ }
}

// --- Fleet-token promotion + lifecycle ----------------------------------------

/**
 * Promotion discriminator. The sk-ant-oat01 PREFIX alone does NOT distinguish a
 * long-lived `claude setup-token` credential from a rotating browser-login
 * access token (both can carry it; verified on a live install 2026-07-16).
 * The reliable signal is LONGEVITY: setup-tokens are issued for ~1 year,
 * rotating session tokens expire within hours/days. Promoting a rotating token
 * would self-inflict the exact bootcamp incident on healthy installs: the env
 * token strictly overrides the (still-refreshing) credentials file, so once it
 * rotates every agent launched with it 401s. Pure + exported for tests.
 */
export const MIN_PROMOTABLE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000
export function isPromotableSetupCredential(
  cred: { accessToken?: string; expiresAt?: number },
  nowMs: number,
): boolean {
  if (!looksLikeSetupToken((cred.accessToken ?? '').trim())) return false
  if (typeof cred.expiresAt !== 'number') return false
  return cred.expiresAt - nowMs >= MIN_PROMOTABLE_LIFETIME_MS
}

/**
 * Backfill the fleet token file from a setup-token that was pasted into a bare
 * terminal `claude setup-token` run instead of the wizard.
 *
 * 2026-07-15 bootcamp root gap: `claude setup-token` writes its sk-ant-oat01
 * pair ONLY into ~/.claude/.credentials.json. The wizard's claudeAuthPresent()
 * then passes from that file alone, so the token-paste step is silently
 * skipped, store/.claude-oauth-token is never created, and BOTH the per-agent
 * config-dir isolation and this guard stay disabled -- the whole fleet keeps
 * sharing one credentials.json. This sync closes that path: when the fleet
 * file is missing but the shared credentials.json holds a long-lived
 * setup-token (see isPromotableSetupCredential), live-probe it and promote it
 * to store/.claude-oauth-token (plus the verified stamp).
 *
 * Deliberately does NOT touch .env: the wizard/auth.sh own that file, and a
 * boot-time .env rewrite would silently flip the MAIN agent's auth source on
 * existing installs. Sub-agent launches read the store file directly.
 */
export type FleetTokenSyncResult =
  | 'fleet-token-present' | 'no-credentials' | 'not-setup-token' | 'live-test-failed' | 'synced' | 'error'

export async function syncFleetTokenFromSharedCredentials(claudeBin?: string): Promise<FleetTokenSyncResult> {
  try {
    if (readFleetToken()) return 'fleet-token-present'
    let cred: { accessToken?: string; expiresAt?: number } = {}
    try {
      const parsed = JSON.parse(readFileSync(HOME_CREDENTIALS, 'utf-8')) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
      cred = parsed?.claudeAiOauth ?? {}
    } catch { return 'no-credentials' }
    if (!isPromotableSetupCredential(cred, Date.now())) return 'not-setup-token'
    const accessToken = (cred.accessToken ?? '').trim()
    logger.info('credentials-guard: found a long-lived terminal-pasted setup-token in ~/.claude/.credentials.json with no fleet token file; live-probing before promoting it')
    if ((await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: accessToken }, claudeBin)) !== 'ok') {
      logger.warn('credentials-guard: setup-token in credentials.json did not pass the live probe; not promoted')
      return 'live-test-failed'
    }
    writeFileSync(FLEET_OAUTH_TOKEN_PATH, accessToken, { mode: 0o600 })
    stampTokenVerified(accessToken)
    logger.warn({ to: FLEET_OAUTH_TOKEN_PATH }, 'credentials-guard: promoted the setup-token from ~/.claude/.credentials.json to the fleet token file; per-agent config isolation is now active for newly launched sub-agents')
    return 'synced'
  } catch (err) {
    logger.warn({ err }, 'credentials-guard: fleet-token sync failed (continuing)')
    return 'error'
  }
}

// --- Fleet-token quarantine (stale-token recovery) -----------------------------
//
// Once respawns/launches bind to the fleet token, a token that later goes bad
// (server-side revocation) would 401 every NEW launch while nothing removes it
// -- and the operator's manual delete would be undone by the boot sync above.
// Quarantine (rename to .bad + drop the stamp) is the demotion path: after it,
// hasFleetOauthToken() is false, launches fall back to shared-file auth, and
// the boot sync will only re-promote a credential that passes a live probe.

// Lazy: FLEET_OAUTH_TOKEN_PATH comes through the agent-process <-> guard
// import cycle, so a module-level concatenation evaluates in the TDZ and
// crashes boot (ReferenceError; found live on the round-2 verify deploy).
const badFleetTokenPath = () => FLEET_OAUTH_TOKEN_PATH + '.bad'

export function quarantineFleetToken(reasonLabel: string): boolean {
  try {
    if (!existsSync(FLEET_OAUTH_TOKEN_PATH)) return false
    renameSync(FLEET_OAUTH_TOKEN_PATH, badFleetTokenPath())
    try { rmSync(VERIFIED_STAMP, { force: true }) } catch { /* best effort */ }
    logger.error(
      { to: badFleetTokenPath(), reason: reasonLabel },
      'credentials-guard: QUARANTINED the fleet token (dead on live probe); newly launched agents fall back to shared-file auth. Restore with mv if this was a false positive.',
    )
    return true
  } catch (err) {
    logger.warn({ err }, 'credentials-guard: fleet-token quarantine failed')
    return false
  }
}

/**
 * Probe the CURRENT fleet token and quarantine it if the probe proves it dead.
 * Called by the reauth-healer when an agent shows a confirmed 401 family
 * failure while a fleet token is present -- the event-driven recovery for a
 * token that was valid at write time but got revoked later. 'inconclusive'
 * (network flake / no binary) never quarantines.
 */
export async function quarantineFleetTokenIfDead(claudeBin?: string): Promise<'no-token' | 'healthy' | 'quarantined' | 'inconclusive'> {
  const token = readFleetToken()
  if (!token) return 'no-token'
  const probe = await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: token }, claudeBin)
  if (probe === 'ok') { stampTokenVerified(token); return 'healthy' }
  if (probe === 'auth-rejected') { quarantineFleetToken('reauth-healer: agent 401 + fleet token failed live probe'); return 'quarantined' }
  return 'inconclusive'
}

/**
 * One boot-time pass over the fleet-token lifecycle. Deferred + async at the
 * call site (a real API probe must never block boot):
 *  - fleet token present but never live-verified (no/stale stamp): probe it;
 *    dead -> quarantine (a bad paste from the pre-verify-first era, or a
 *    revoked token, stops poisoning launches at the next boot);
 *  - fleet token absent: try promoting a long-lived terminal setup-token from
 *    the shared credentials.json (see syncFleetTokenFromSharedCredentials).
 */
export type FleetTokenBootPassResult = FleetTokenSyncResult | 'validated' | 'validated-cached' | 'quarantined' | 'validate-inconclusive' | 'malformed-left-alone'

export async function fleetTokenBootPass(claudeBin?: string): Promise<FleetTokenBootPassResult> {
  const token = readFleetToken()
  if (!token) return syncFleetTokenFromSharedCredentials(claudeBin)
  if (!looksLikeSetupToken(token)) {
    logger.warn('credentials-guard: fleet token file content is not a well-formed setup-token; leaving it alone (operator-managed?)')
    return 'malformed-left-alone'
  }
  if (readVerifiedHash() === tokenHash(token)) return 'validated-cached'
  const probe = await liveProbeAuth({ CLAUDE_CODE_OAUTH_TOKEN: token }, claudeBin)
  if (probe === 'ok') { stampTokenVerified(token); return 'validated' }
  if (probe === 'auth-rejected') { quarantineFleetToken('boot validation: live probe auth-rejected'); return 'quarantined' }
  return 'validate-inconclusive'
}

/**
 * The guarded, idempotent, reversible action. Returns a short status for logging
 * and tests. Never throws; never logs the token.
 */
export type CredentialsGuardResult =
  | 'disabled' | 'not-linux' | 'no-credentials' | 'already-renamed'
  | 'token-invalid' | 'renamed' | 'error'

export function renameSharedCredentialsIfSafe(claudeBin?: string): CredentialsGuardResult {
  try {
    if (!credentialsGuardEnabled()) return 'disabled'
    if (PLATFORM === 'macos') return 'not-linux'
    if (!existsSync(HOME_CREDENTIALS)) {
      // Nothing to rename. If a .bak already exists this is the steady state.
      return existsSync(BAK_CREDENTIALS) ? 'already-renamed' : 'no-credentials'
    }
    const bin = claudeBin ?? resolveFromPath('claude')
    if (!tokenIsValid(bin)) return 'token-invalid'
    // Overwrite any prior .bak (a newer credentials.json is the one to retire).
    renameSync(HOME_CREDENTIALS, BAK_CREDENTIALS)
    logger.warn({ from: HOME_CREDENTIALS, to: BAK_CREDENTIALS }, 'credentials-guard: renamed the rotating ~/.claude/.credentials.json out of the way (valid setup-token present); agents authenticate from CLAUDE_CODE_OAUTH_TOKEN. Reverse with: mv .credentials.json.bak .credentials.json')
    return 'renamed'
  } catch (err) {
    logger.warn({ err }, 'credentials-guard: rename pass failed (continuing); credentials.json left as-is')
    return 'error'
  }
}
