// The config-dir path rules, dependency-free so the settings registry
// (config-registry.ts) can use them without importing web/agent-config.ts
// (which imports config.js, which imports the registry). Moved here verbatim
// from web/agent-config.ts, which re-exports them (SECSZIVEK1007).
import { join } from 'node:path'

// Allowed character set for the path: alphanumerics, dot, slash, hyphen,
// underscore, tilde. Anything else is rejected.
//
// This is a whitelist rather than a blacklist for a reason. The launcher
// inlines the path into a tmux command via nested template literals, which
// produces a shell string with both an outer and an inner double-quoted
// region. Bash treats the inner `"` as a quote delimiter, not a literal,
// so the path actually lands partly inside and partly outside double-quote
// context. Inside double quotes most metachars are tame; outside, almost
// anything (parens, single quote, spaces, semicolons, &, |) is shell-
// significant. Enumerating "safe outside double quotes" by blacklist is a
// trap -- a whitelist of characters that survive both layers is far
// shorter to write and more robust to future changes in the launcher.
//
// Local config is only writable by the host operator, so this is defense-
// in-depth rather than a hard security boundary, but it cheaply removes
// the trivial way to break the launcher with a config typo.
//
// Path values containing `..` segments are also rejected. Without this
// guard `path.join` would silently collapse them ("~/../../../etc/passwd"
// resolves to "/etc/passwd"), which is almost never what the operator
// meant. Absolute paths without `..` remain accepted, so legitimate non-
// home locations like "/var/lib/claude-coding" still work.
export const CLAUDE_CONFIG_DIR_ALLOWED = /^[A-Za-z0-9_./~-]+$/

// Only `..` segments are rejected, not `.` (current dir) or empty segments
// from doubled slashes (`//`). Both of those are no-ops -- the OS and
// `path.join` normalize them away without changing where the path points.
// `..` is the only segment that meaningfully alters the destination, so
// it's the only one we treat as suspicious.
export function hasParentTraversal(raw: string): boolean {
  return raw.split('/').some(segment => segment === '..')
}

// Expand + validate a raw config-dir string (already extracted from wherever
// it was stored) against the launcher's shell-safety rules. Shared by the
// per-agent `claudeConfigDir` resolver and the named-plan registry
// (claude-plans.ts) so both feed the tmux launcher through the exact same
// whitelist/traversal/tilde gauntlet -- there is only one place that decides
// what is safe to inline into the launch command. Returns the absolute path,
// or null when the value is blank/malformed/unsafe.
export function expandAndValidateConfigDir(
  rawValue: string,
  homeDir: string,
): string | null {
  const raw = rawValue.trim()
  if (!raw) return null
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(raw)) return null
  if (hasParentTraversal(raw)) return null
  // Tilde may appear at most once, and only as the bare `~` or as the
  // leading `~/` of a `~/...` form. `~user`, mid-string `~`, double tildes
  // -- all rejected because the runtime shell would re-expand them at
  // assignment time even though our resolver does not, and we do not want
  // the launcher to silently route an agent to a different user's home
  // directory or to a path the operator did not write.
  if (raw.includes('~')) {
    const tildeCount = raw.split('~').length - 1
    const validForm = raw === '~' || raw.startsWith('~/')
    if (!validForm || tildeCount > 1) return null
  }
  let resolved: string
  if (raw === '~') resolved = homeDir
  else if (raw.startsWith('~/')) resolved = join(homeDir, raw.slice(2))
  else resolved = raw
  // Re-validate after expansion: if `homeDir` itself contains a character
  // outside the whitelist (e.g. a space in a multi-word account name), the
  // resolved path would land in unquoted shell context and break the
  // launcher cmd. Reject rather than ship a broken export.
  if (!CLAUDE_CONFIG_DIR_ALLOWED.test(resolved)) return null
  return resolved
}
