#!/usr/bin/env node
// PreToolUse hook (matcher: Bash): a session whose Telegram poller can be killed
// must not start a child `claude` that would kill it (CHILDCLAUDEPOLLER1010).
//
// WHY. On start the Telegram plugin's server.ts reads $TELEGRAM_STATE_DIR/bot.pid
// and SIGTERMs the pid it finds there ("replacing stale poller"). In 0.0.6 it only
// checks that the pid is alive; 0.0.7 adds a check that it is a `server.ts`.
// Neither checks that the holder is orphaned. A child `claude` started from this
// session's Bash inherits TELEGRAM_STATE_DIR and CLAUDE_CONFIG_DIR, loads the
// enabled plugin, reads the SAME bot.pid and kills this session's live poller.
// When the child exits its own poller goes too, so nothing polls until the
// session restarts. Measured 2026-10-10 (three `claude -p` calls from a live
// sub-agent); `claude mcp list` is the same mechanism
// (docs/mcp-list-channel-plugin.md). The child exits 0 and nothing reports it.
//
// THE PRECONDITION. The plugin reaches the kill only with a bot token: it reads
// TELEGRAM_BOT_TOKEN from the real environment, else from <state dir>/.env, and
// exits before the bot.pid code when there is none. The sub-agent launcher
// exports TELEGRAM_STATE_DIR to every sub-agent, with or without a bot
// (buildChannelStateFence, SLACKDMVESZT1006), so the variable alone is not the
// hazard. The guard acts only where the state dir the CHILD's plugin would use
// holds a token, judged on the child's environment, not the session's: a
// token-less sub-agent that unsets or overrides TELEGRAM_STATE_DIR, or runs
// `env -i`, points its child at another state dir that may hold one. Without
// TELEGRAM_STATE_DIR the plugin falls back to ~/.claude/channels/telegram
// (0.0.6) or $CLAUDE_CONFIG_DIR/channels/telegram (0.0.7); both are checked.
//
// Telegram only: the installed discord 0.0.4 and slack-channel 0.1.0 sources
// have no bot.pid kill, so their state variables play no part here.
//
// A CHILD IS HARMLESS when either holds:
//   (a) it runs with a config dir of its own, so no channel plugin is enabled:
//       a non-empty CLAUDE_CONFIG_DIR that is neither this session's config dir
//       nor ~/.claude, and whose settings.json (if readable) does not enable a
//       telegram plugin. Measured 2026-10-10: a fresh config dir started no
//       telegram server, even from a cwd whose project settings enable it.
//   (b) the plugin would exit before the kill: the child's TELEGRAM_STATE_DIR is
//       set to a directory without a token, and the child has no
//       TELEGRAM_BOT_TOKEN in its environment. Measured 2026-10-10: with a
//       plugin-enabled config dir and an empty state dir the server logged
//       "TELEGRAM_BOT_TOKEN required" and exited; the parent's poller lived.
// Unsetting TELEGRAM_STATE_DIR is NOT harmless: the child then falls back to
// ~/.claude/channels/telegram, the main agent's state dir on a default install,
// and kills the main bot's poller instead. `env -i` is judged by the same rule
// on the environment the child actually gets.
//
// WHAT IS NOT SEEN. A `claude` started indirectly (a python/node script that
// spawns it) is invisible to a command-string check; that path is covered by
// the CLAUDE.md warning, not by this gate.
//
// Fail-open on unparseable input: this is a guard against an accident, not a
// security boundary, and a hook crash must not block every Bash call.

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAFE_FIRST_ARGS = new Set(['--version', '-v', '-V', '--help', '-h', 'install', 'update', 'auth'])
// Subcommands that only edit configuration and start no MCP or plugin server.
const SAFE_SUBCOMMANDS = [['mcp', 'add'], ['mcp', 'add-json'], ['mcp', 'remove']]
const SEGMENT_SPLIT = /\|\||&&|[;|&\n]|\$\(|`|\(/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(['exec', 'nohup', 'time', 'command', 'builtin', 'caffeinate'])
// Placeholders for whitespace and separators inside quoted text (see stripInertText).
const Q_SPACE = '\u0001'
const Q_SEP = '\u0002'

function homeOf(env) {
  return env.HOME || homedir()
}

function tokenIn(dir) {
  try { return /^TELEGRAM_BOT_TOKEN=\S/m.test(readFileSync(join(dir, '.env'), 'utf8')) } catch { return false }
}

// The state dirs the plugin would use with this environment (both fallbacks,
// since 0.0.6 and 0.0.7 differ when TELEGRAM_STATE_DIR is unset).
export function telegramStateDirs(env) {
  if (env.TELEGRAM_STATE_DIR) return [env.TELEGRAM_STATE_DIR]
  const dirs = [join(homeOf(env), '.claude', 'channels', 'telegram')]
  if (env.CLAUDE_CONFIG_DIR) dirs.push(join(env.CLAUDE_CONFIG_DIR, 'channels', 'telegram'))
  return dirs
}

// True when a Telegram plugin started with this environment would reach the
// bot.pid kill, i.e. it would find a bot token.
export function sessionOwnsChannel(env = process.env) {
  if (env.TELEGRAM_BOT_TOKEN) return true
  return telegramStateDirs(env).some(tokenIn)
}

// The same question for the child's environment. A state dir we cannot resolve
// may hold a token, so it counts as one; an unresolved config dir only drops
// the 0.0.7 fallback, since (a) below judges an own config dir separately.
export function childOwnsChannel({ values, unknown }) {
  if (values.TELEGRAM_BOT_TOKEN || unknown.has('TELEGRAM_STATE_DIR')) return true
  const known = unknown.has('CLAUDE_CONFIG_DIR') ? { ...values, CLAUDE_CONFIG_DIR: undefined } : values
  return sessionOwnsChannel(known)
}

function tokens(segment) {
  // Whitespace split is enough here: we only need the leading words of a
  // segment. Quotes are stripped from each token for the name comparison.
  return segment.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, ''))
}

// Returns null if the segment does not start a claude process, else what the
// segment does to the child's environment, in order.
export function inspectSegment(segment) {
  const t = tokens(segment)
  let i = 0
  let envEmpty = false
  const ops = [] // ['unset', NAME] | ['set', NAME, VALUE]
  const assign = (w) => {
    const eq = w.indexOf('=')
    ops.push(['set', w.slice(0, eq), w.slice(eq + 1).replace(/^['"]|['"]$/g, '')])
  }
  while (i < t.length) {
    const w = t[i]
    if (WRAPPERS.has(w)) { i++; continue }
    if (w === 'timeout' || w === 'gtimeout') { i += 2; continue }
    if (w === 'env' || w === '/usr/bin/env') {
      i++
      while (i < t.length && (t[i].startsWith('-') || ASSIGNMENT.test(t[i]))) {
        if (t[i] === '-i' || t[i] === '--ignore-environment' || t[i] === '-') envEmpty = true
        else if (t[i] === '-u' || t[i] === '--unset') { ops.push(['unset', t[i + 1]]); i += 2; continue }
        else if (t[i].startsWith('-u')) ops.push(['unset', t[i].slice(2)])
        else if (ASSIGNMENT.test(t[i])) assign(t[i])
        i++
      }
      continue
    }
    if (ASSIGNMENT.test(w)) { assign(w); i++; continue }
    break
  }
  const cmd = t[i]
  if (!cmd) return null
  const base = cmd.split('/').pop()
  if (base !== 'claude') return null
  return { args: t.slice(i + 1), envEmpty, ops }
}

// Expand $VAR / ${VAR} / a leading ~ from the session environment. Returns null
// when something cannot be resolved (an unknown variable, quoted text whose
// content we replaced, a command substitution).
function expandValue(raw, env) {
  let unresolved = raw.includes(Q_SEP)
  let v = raw.replaceAll(Q_SPACE, ' ').replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
    if (typeof env[name] === 'string') return env[name]
    unresolved = true
    return m
  })
  if (v.startsWith('~') && (v.length === 1 || v[1] === '/')) v = homeOf(env) + v.slice(1)
  return unresolved ? null : v
}

// The environment the child gets: { values, unknown } where unknown holds the
// names whose value could not be resolved.
export function childEnv(hit, env) {
  const values = hit.envEmpty ? {} : { ...env }
  const unknown = new Set()
  for (const op of hit.ops) {
    if (op[0] === 'unset') { delete values[op[1]]; unknown.delete(op[1]); continue }
    const v = expandValue(op[2], env)
    if (v === null) { values[op[1]] = op[2]; unknown.add(op[1]) } else { values[op[1]] = v; unknown.delete(op[1]) }
  }
  return { values, unknown }
}

function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && resolve(a) === resolve(b)
}

function enablesTelegram(configDir) {
  try {
    const s = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    return Object.entries(s?.enabledPlugins ?? {}).some(([k, on]) => on && k.startsWith('telegram@'))
  } catch { return false }
}

// (a) A config dir of its own, so no channel plugin is enabled.
function ownConfigDir({ values, unknown }, env) {
  const dir = values.CLAUDE_CONFIG_DIR
  if (typeof dir !== 'string' || dir.length === 0) return false
  // A value we cannot resolve but that has a literal part (`$S/cfg`) is a
  // deliberate, non-empty separate dir; the forms that would point back at a
  // plugin home resolve from the session environment. Unknown variables alone
  // (`$X`, `"${X}"`, `$X$Y`) may expand to nothing, and an empty
  // CLAUDE_CONFIG_DIR is not a config dir of its own, so they do not count.
  if (unknown.has('CLAUDE_CONFIG_DIR')) return !/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)+$/.test(dir)
  if (samePath(dir, env.CLAUDE_CONFIG_DIR)) return false
  if (samePath(dir, join(homeOf(values.HOME ? values : env), '.claude'))) return false
  return !enablesTelegram(dir)
}

// (b) The plugin would exit before the kill: an explicit token-less state dir.
function tokenlessStateDir({ values, unknown }) {
  const dir = values.TELEGRAM_STATE_DIR
  if (typeof dir !== 'string' || dir.length === 0 || unknown.has('TELEGRAM_STATE_DIR')) return false
  if (values.TELEGRAM_BOT_TOKEN) return false
  return !tokenIn(dir)
}

// Text the shell does not execute must not be read as a command: heredoc bodies
// (a commit message, a markdown note) and quoted strings routinely MENTION
// `claude`. Measured 2026-10-10: the first live version blocked a python heredoc
// that documented this very guard, because a backtick inside the heredoc text
// started a new segment. Heredoc bodies are removed. Inside quotes, whitespace
// and separators are replaced by placeholders, so the quoted text stays one
// token (an assignment like CLAUDE_CONFIG_DIR="$S/cfg" keeps a non-empty value)
// but can neither split a segment nor start a command. Known gap, accepted: a
// `$(claude ...)` inside double quotes is not seen.
export function stripInertText(command) {
  const mask = (s) => s.replace(/\s/g, Q_SPACE).replace(/[;|&()`]/g, Q_SEP)
  let out = command.replace(/<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, ' ')
  out = out.replace(/'[^']*'/g, (m) => mask(m))
  out = out.replace(/"(?:\\.|[^"\\])*"/g, (m) => mask(m))
  return out
}

function startsNoServer(args) {
  if (args.length > 0 && SAFE_FIRST_ARGS.has(args[0])) return true
  if (args.includes('--help') || args.includes('-h')) return true
  return SAFE_SUBCOMMANDS.some(([a, b]) => args[0] === a && args[1] === b)
}

export function decide(command, env = process.env) {
  if (typeof command !== 'string' || !command.includes('claude')) return { allow: true }
  for (const segment of stripInertText(command).split(SEGMENT_SPLIT)) {
    const hit = inspectSegment(segment)
    if (!hit) continue
    if (startsNoServer(hit.args)) continue
    const child = childEnv(hit, env)
    // The hazard is the child's: judge its environment, not the session's.
    if (!childOwnsChannel(child)) continue
    if (ownConfigDir(child, env) || tokenlessStateDir(child)) continue
    return { allow: false, segment: segment.trim().replaceAll(Q_SPACE, ' ').replaceAll(Q_SEP, '_').slice(0, 200) }
  }
  return { allow: true }
}

const REASON = [
  'child-claude-channel-guard (CHILDCLAUDEPOLLER1010): the Telegram state dir this child would use holds a bot',
  'token, and a child `claude` with that environment loads the Telegram plugin, which SIGTERMs the poller named',
  'in that dir\'s bot.pid ("replacing stale poller") -- this session\'s or the main bot\'s. The channel then stays',
  'dead until restart.',
  'Run the child with a config dir of its own AND an empty state dir, e.g.:',
  '  TELEGRAM_STATE_DIR=<empty-dir> CLAUDE_CONFIG_DIR=<empty-dir> claude -p ...',
  'Do NOT unset TELEGRAM_STATE_DIR: the plugin then falls back to ~/.claude/channels/telegram, the main',
  'agent\'s state dir on a default install, and kills the main bot\'s poller instead.',
  'Details: docs/mcp-list-channel-plugin.md',
].join('\n')

function main() {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  if (payload?.tool_name !== 'Bash') process.exit(0)
  const verdict = decide(payload?.tool_input?.command)
  if (verdict.allow) process.exit(0)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${REASON}\nBlocked segment: ${verdict.segment}`,
    },
  }))
  process.exit(0)
}

function isEntryPoint() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isEntryPoint()) main()
