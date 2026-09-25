// Per-agent setup-token file: agent-config.json "oauthTokenFile" (2fb86ef2).
//
// An agent with this field authenticates from ITS OWN long-lived setup-token
// file instead of the fleet file (store/.claude-oauth-token). The launcher
// exports it with exactly the fleet token's shape,
//   export CLAUDE_CODE_OAUTH_TOKEN="$(cat '<file>')" &&
// so the secret is read by the shell at launch and never enters the JS-built
// command string or `ps`.
//
// FAIL-CLOSED. "Unset" means one thing only: the key is absent. A key that is
// present but unusable -- malformed path, missing file, wrong owner, a mode
// wider than 0600, empty or non-setup-token content, the fleet file itself or a
// copy of it, or a setting the field cannot take effect under -- refuses the
// start. It never degrades to the fleet token: an agent that was given its own
// token and silently ran on the fleet's would spend exactly the quota the field
// exists to protect, and nothing would show it.
//
// Only the path and a fingerprint (first 8 hex chars of the token's sha256)
// ever leave this module. The token value does not, not even inside a
// rejection detail.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import type { AuthMode } from './agent-config.js'

export const OAUTH_TOKEN_FILE_KEY = 'oauthTokenFile'
export const SETUP_TOKEN_PREFIX = 'sk-ant-oat'

// Absolute path, whitelisted characters only: the launcher inlines the path
// between single quotes, so a quote or any shell-significant character must
// not be able to reach it (same whitelist philosophy as claudeConfigDir,
// agent-config.ts). No tilde: the shell would re-expand it at launch.
const TOKEN_FILE_PATH_ALLOWED = /^\/[A-Za-z0-9_./-]+$/

export type OauthTokenFileSetting =
  | { state: 'unset' }
  | { state: 'invalid'; reason: string }
  | { state: 'set'; path: string }

// Pure: raw agent-config.json text -> the field's state.
export function resolveOauthTokenFileSetting(rawConfigJson: string): OauthTokenFileSetting {
  let config: unknown
  try {
    config = JSON.parse(rawConfigJson)
  } catch {
    // Every other reader treats an unparseable config as {}. Here that would
    // mean "unset", i.e. the fleet token -- so a broken file that mentions the
    // key refuses instead.
    return rawConfigJson.includes(`"${OAUTH_TOKEN_FILE_KEY}"`)
      ? { state: 'invalid', reason: 'config-unparseable' }
      : { state: 'unset' }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { state: 'unset' }
  if (!Object.prototype.hasOwnProperty.call(config, OAUTH_TOKEN_FILE_KEY)) return { state: 'unset' }
  const value = (config as Record<string, unknown>)[OAUTH_TOKEN_FILE_KEY]
  if (typeof value !== 'string') return { state: 'invalid', reason: 'not-a-string' }
  const path = value.trim()
  if (!path) return { state: 'invalid', reason: 'blank' }
  if (!path.startsWith('/')) return { state: 'invalid', reason: 'not-absolute' }
  if (!TOKEN_FILE_PATH_ALLOWED.test(path)) return { state: 'invalid', reason: 'path-bad-characters' }
  if (path.split('/').some((segment) => segment === '..')) return { state: 'invalid', reason: 'path-parent-traversal' }
  return { state: 'set', path }
}

// Pure: a setting the field cannot take effect under is a conflict, and a
// conflict refuses the start -- ignoring the field would leave the operator
// believing the agent runs on its own token when it does not.
export function oauthTokenFileConflict(input: {
  isMainAgent: boolean
  isRemote: boolean
  isCustomProvider: boolean
  isClaudeModel: boolean
  authMode: AuthMode
  hasExplicitConfigDir: boolean
  hasClaudePlan: boolean
}): string | null {
  // The main agent launches through scripts/channels.sh, not this launcher.
  if (input.isMainAgent) return 'main-agent'
  // A remote agent's session runs on another host; a local path means nothing there.
  if (input.isRemote) return 'remote-agent'
  // A setup-token is a Claude OAuth credential. A custom-provider or a non-Claude
  // (Ollama, DeepSeek, OpenRouter, ...) agent authenticates with the provider's
  // own key, and the launcher never exports an OAuth token for it: exported
  // anyway, the CLI would send it to the third-party endpoint instead of the
  // provider credential (the 2026-08-05 custom-provider 401). So the field
  // cannot take effect there, and ignoring it would leave the operator believing
  // the agent runs on its own token.
  if (input.isCustomProvider) return 'custom-provider'
  if (!input.isClaudeModel) return 'non-claude-model'
  // own_team authenticates from its own /login; api from its own API key.
  if (input.authMode === 'own_team') return 'auth-mode-own_team'
  if (input.authMode === 'api') return 'auth-mode-api'
  // An explicit config dir (or a named plan) carries its own login, and Claude
  // Code prefers an on-disk credential over the CLAUDE_CODE_OAUTH_TOKEN env var,
  // so the exported token would not be the one in use.
  if (input.hasExplicitConfigDir || input.hasClaudePlan) return 'explicit-config-dir'
  return null
}

export type OauthTokenFileCheck =
  | { ok: true; path: string; fingerprint: string }
  | { ok: false; path: string; reason: string; detail: string }

// What `"$(cat file)"` hands the process: the content minus trailing newlines.
function exportedValue(raw: string): string {
  return raw.replace(/\n+$/, '')
}

export function tokenFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)
}

// Validates the token file itself. `uid` is the launching user's uid, or null
// on a platform without POSIX ownership (the check cannot be made -> refuse).
export function checkOauthTokenFile(
  path: string,
  opts: { uid: number | null; fleetTokenPath: string },
): OauthTokenFileCheck {
  const refuse = (reason: string, detail = ''): OauthTokenFileCheck => ({ ok: false, path, reason, detail })
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? refuse('missing') : refuse('unreadable')
  }
  // lstat, not stat: a symlink could point at the fleet file or at another
  // agent's token, and neither is this agent's own file.
  if (!st.isFile()) return refuse('not-regular-file')
  // The same inode as the fleet file (the path itself, or a hard link to it).
  try {
    const fleet = statSync(opts.fleetTokenPath)
    if (fleet.ino === st.ino && fleet.dev === st.dev) return refuse('is-fleet-file')
  } catch { /* no fleet file: nothing to be identical to */ }
  if (opts.uid === null) return refuse('unsupported-platform', 'no POSIX owner check on this platform')
  if (st.uid !== opts.uid) return refuse('wrong-owner', `owner uid ${st.uid}, launcher uid ${opts.uid}`)
  // "0600 or stricter": no owner-execute bit and nothing for group or other.
  if ((st.mode & 0o177) !== 0) return refuse('mode-too-open', `mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}`)
  let value: string
  try {
    value = exportedValue(readFileSync(path, 'utf-8'))
  } catch {
    return refuse('unreadable')
  }
  if (!value) return refuse('empty')
  if (!value.startsWith(SETUP_TOKEN_PREFIX)) return refuse('bad-prefix', `does not start with ${SETUP_TOKEN_PREFIX}`)
  // A setup-token never contains whitespace or control characters; one that
  // does would reach the environment verbatim and fail as a login, not here.
  if (/[\s\x00-\x1f\x7f]/.test(value)) return refuse('content-bad-characters')
  // A copy of the fleet token under another name is the fleet token.
  try {
    if (exportedValue(readFileSync(opts.fleetTokenPath, 'utf-8')) === value) return refuse('same-as-fleet-token')
  } catch { /* no fleet file: nothing to be a copy of */ }
  return { ok: true, path, fingerprint: tokenFingerprint(value) }
}

// The launch-command fragment: the fleet token's shape, with this file.
export function ownOauthTokenExport(path: string): string {
  return `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${path}')" && `
}

export type OwnOauthTokenDecision =
  | { kind: 'unset' }
  | { kind: 'ok'; path: string; fingerprint: string }
  | { kind: 'refused'; path: string | null; reason: string; detail: string }

// The whole decision from its inputs, so it is testable without an agent dir.
export function decideOwnOauthToken(input: {
  rawConfigJson: string
  isMainAgent: boolean
  isRemote: boolean
  isCustomProvider: boolean
  isClaudeModel: boolean
  authMode: AuthMode
  hasExplicitConfigDir: boolean
  hasClaudePlan: boolean
  fleetTokenPath: string
  uid: number | null
}): OwnOauthTokenDecision {
  const setting = resolveOauthTokenFileSetting(input.rawConfigJson)
  if (setting.state === 'unset') return { kind: 'unset' }
  if (setting.state === 'invalid') return { kind: 'refused', path: null, reason: setting.reason, detail: '' }
  const conflict = oauthTokenFileConflict(input)
  if (conflict) return { kind: 'refused', path: setting.path, reason: conflict, detail: '' }
  const check = checkOauthTokenFile(setting.path, { uid: input.uid, fleetTokenPath: input.fleetTokenPath })
  if (!check.ok) return { kind: 'refused', path: check.path, reason: check.reason, detail: check.detail }
  return { kind: 'ok', path: check.path, fingerprint: check.fingerprint }
}

// Pure: does the launch env actually carry the decided own token? The launcher
// derives its "own token exported" log line from THIS, not from the decision,
// and refuses the start when an 'ok' decision did not reach the export -- so a
// wiring slip can neither run the agent on the fleet token nor log that it did
// not. 'unset' and 'refused' never carry an own export, so they never mismatch.
export function ownOauthExportMissing(decision: OwnOauthTokenDecision, oauthTokenEnv: string): boolean {
  if (decision.kind !== 'ok') return false
  return oauthTokenEnv !== ownOauthTokenExport(decision.path)
}

// Pure: the ONE verdict the launcher acts on after the last write to
// oauthTokenEnv, for both the refusal and the "own token" log line. Its only
// inputs are the decision and the actual launch env, so the log cannot claim
// the own token unless the env carries exactly the own export, and an 'ok'
// decision that did not reach the env can only end in a refusal (#1511 review:
// never "runs on the fleet token while the log says its own").
export type OwnOauthLaunchVerdict =
  | { kind: 'not-own' }
  | { kind: 'refuse'; path: string }
  | { kind: 'own'; path: string; fingerprint: string }

export function ownOauthLaunchVerdict(decision: OwnOauthTokenDecision, oauthTokenEnv: string): OwnOauthLaunchVerdict {
  if (decision.kind !== 'ok') return { kind: 'not-own' }
  if (ownOauthExportMissing(decision, oauthTokenEnv)) return { kind: 'refuse', path: decision.path }
  return { kind: 'own', path: decision.path, fingerprint: decision.fingerprint }
}
