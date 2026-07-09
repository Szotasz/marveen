import { execFileSync } from 'node:child_process'
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
