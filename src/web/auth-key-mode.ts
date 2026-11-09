// APIKEYSCOPE1107 (APIKULCSINDITAS1004 B): where an ANTHROPIC_API_KEY may go, decided the same way here and in
// scripts/lib/auth-key-mode.sh (a parity test runs both on the same fixtures).
//
// Measured 2026-11-07 on Claude Code 2.1.319 (agents/geri/work/apikulcs/meres.md): with both set, the API key
// outranks CLAUDE_CODE_OAUTH_TOKEN; an interactive session with an unapproved key stops at "Detected a custom API key"
// (default No), with the approval stamp it bills the key; `claude -p` ignores the stamp and bills the key.
//
// Modes:
// - subscription: an OAuth token exists (.env CLAUDE_CODE_OAUTH_TOKEN, or the fleet token file). A key next to it is an
//   extra: it reaches no fleet agent, only an authMode=api agent, and its stamp never goes into the shared
//   ~/.claude.json (the main agent and the operator's own CLI read that file and would switch to billing the key).
// - keyonly: no OAuth token, the key IS the install's credential: it stays the fleet's, and its stamp may go into the
//   shared ~/.claude.json (there is no OAuth for it to shadow; Samu 72235).
// - none: neither.

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AuthKeyMode = 'subscription' | 'keyonly' | 'none'

/** The first `KEY=` line's raw value, as channels.sh reads .env (grep -E '^KEY=' | head -1 | cut -d= -f2-). */
export function envFileValue(envText: string, key: string): string {
  for (const line of envText.split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1)
  }
  return ''
}

/** The decision, from its two inputs only (pure; the parity test drives it). */
export function authKeyModeFrom(i: { envText: string; tokenFileNonEmpty: boolean }): AuthKeyMode {
  const oauth = envFileValue(i.envText, 'CLAUDE_CODE_OAUTH_TOKEN') !== '' || i.tokenFileNonEmpty
  if (oauth) return 'subscription'
  if (envFileValue(i.envText, 'ANTHROPIC_API_KEY') !== '') return 'keyonly'
  return 'none'
}

/** A token file that holds a token: whitespace-only is no token (agent-process trims it, channels.sh $(cat)s it). */
function fileNonEmpty(p: string): boolean {
  try { return readFileSync(p, 'utf-8').trim() !== '' } catch { return false }
}

/** The install's mode now (read at every launch: a token added later counts at once). */
export function currentAuthKeyMode(envPath: string, tokenPath: string): AuthKeyMode {
  let envText = ''
  try { envText = readFileSync(envPath, 'utf-8') } catch { /* no .env */ }
  return authKeyModeFrom({ envText, tokenFileNonEmpty: fileNonEmpty(tokenPath) })
}

/** The host key as channels.sh exports it (first raw line), or ''. */
export function hostApiKey(envPath: string): string {
  try { return envFileValue(readFileSync(envPath, 'utf-8'), 'ANTHROPIC_API_KEY') } catch { return '' }
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** True when `dotClaudePath` is (or resolves to) the shared ~/.claude.json. */
export function isSharedDotClaude(dotClaudePath: string, home: string = homedir()): boolean {
  return real(dotClaudePath) === real(join(home, '.claude.json'))
}

/** May an approval stamp for the key be written to `dotClaudePath` in this mode? */
export function stampAllowed(dotClaudePath: string, mode: AuthKeyMode, home: string = homedir()): boolean {
  if (mode === 'keyonly') return true
  return !isSharedDotClaude(dotClaudePath, home)
}

/**
 * One-time copy of an agent's own project dir (memory, transcripts) from the shared root into its new isolated
 * config dir, so moving the agent off ~/.claude loses nothing. Never overwrites (the target existing = done). Every
 * dir and file keeps the SOURCE mode (a 0700 dir or a 0600 transcript is never widened). Returns false on any
 * failure (the caller refuses the launch).
 */
export function copyProjectsOnce(srcProjectsRoot: string, dstProjectsRoot: string, encoded: string): boolean {
  const src = join(srcProjectsRoot, encoded)
  const dst = join(dstProjectsRoot, encoded)
  if (existsSync(dst)) return true // only ever a COMPLETE copy: it is renamed into place at the end
  if (!existsSync(src)) return true // nothing to carry over (a brand-new agent)
  const tmpDst = `${dst}.copying`
  try {
    if (lstatSync(src).isSymbolicLink()) return false // a linked project dir is not the agent's own tree
    mkdirSync(dstProjectsRoot, { recursive: true, mode: 0o700 })
    rmSync(tmpDst, { recursive: true, force: true }) // a leftover from an interrupted copy
    const walk = (s: string, d: string) => {
      const st = lstatSync(s)
      if (st.isSymbolicLink()) return // never follow a link out of the agent's own tree
      if (st.isDirectory()) {
        mkdirSync(d, { mode: st.mode & 0o777 })
        chmodSync(d, st.mode & 0o777) // mkdir's mode is masked by umask; set it exactly
        for (const e of readdirSync(s)) walk(join(s, e), join(d, e))
      } else if (st.isFile()) {
        copyFileSync(s, d)
        chmodSync(d, st.mode & 0o777)
      }
    }
    walk(src, tmpDst)
    renameSync(tmpDst, dst)
    return true
  } catch {
    return false
  }
}

/** The isolated dir's .claude.json parses and is past onboarding (else the agent would stop at the first-run screen). */
export function isolatedDirReady(configDir: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8')) as { hasCompletedOnboarding?: unknown }
    return data.hasCompletedOnboarding === true
  } catch {
    return false
  }
}
