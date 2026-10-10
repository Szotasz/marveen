#!/usr/bin/env node
// PreToolUse hook (matcher: Bash): a channel-owning session must not start a
// child `claude` that inherits its channel state (CHILDCLAUDEPOLLER1010).
//
// WHY. The Telegram plugin's server.ts reads $TELEGRAM_STATE_DIR/bot.pid on
// start and SIGTERMs the server.ts named there ("replacing stale poller"). It
// checks that the pid is a server.ts, not that it is orphaned. A child `claude`
// started from this session's Bash inherits TELEGRAM_STATE_DIR and
// CLAUDE_CONFIG_DIR, loads the enabled channel plugin, reads the SAME bot.pid
// and kills this session's live poller. When the child exits its own poller
// goes too, so nothing polls until the session restarts. Measured 2026-10-10
// (three `claude -p` calls from a live sub-agent); `claude mcp list` is the
// same mechanism (docs/mcp-list-channel-plugin.md). Nothing reports it: the
// child exits 0 and the parent only notices that its channel tools are gone.
//
// WHAT IS BLOCKED. A `claude` invocation in command position whose arguments
// can start MCP/plugin servers, unless the same command isolates the child:
//   - `env -i ...` (empty environment), or
//   - it sets its own CLAUDE_CONFIG_DIR= AND neutralises TELEGRAM_STATE_DIR
//     (`env -u TELEGRAM_STATE_DIR` or a `TELEGRAM_STATE_DIR=` assignment).
// Read-only subcommands that start no plugin servers stay allowed
// (`--version`, `--help`, `install`, `update`, `auth ...`).
//
// WHAT IS NOT SEEN. A `claude` started indirectly (a python/node script that
// spawns it) is invisible to a command-string check; that path is covered by
// the CLAUDE.md warning, not by this gate. Sessions without a channel state
// dir in their environment are left alone.
//
// Fail-open on unparseable input: this is a guard against an accident, not a
// security boundary, and a hook crash must not block every Bash call.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHANNEL_STATE_VARS = ['TELEGRAM_STATE_DIR', 'DISCORD_STATE_DIR', 'SLACK_STATE_DIR']
const SAFE_FIRST_ARGS = new Set(['--version', '-v', '-V', '--help', '-h', 'install', 'update', 'auth'])
const SEGMENT_SPLIT = /\|\||&&|[;|&\n]|\$\(|`|\(/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(['exec', 'nohup', 'time', 'command', 'builtin', 'caffeinate'])

export function sessionOwnsChannel(env = process.env) {
  return CHANNEL_STATE_VARS.some((v) => typeof env[v] === 'string' && env[v].length > 0)
}

function tokens(segment) {
  // Whitespace split is enough here: we only need the leading words of a
  // segment. Quotes are stripped from each token for the name comparison.
  return segment.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, ''))
}

// Returns null if the segment does not start a claude process, else what the
// segment does to the child's environment.
export function inspectSegment(segment) {
  const t = tokens(segment)
  let i = 0
  let envEmpty = false
  let setsConfigDir = false
  const neutralised = new Set()
  while (i < t.length) {
    const w = t[i]
    if (WRAPPERS.has(w)) { i++; continue }
    if (w === 'timeout' || w === 'gtimeout') { i += 2; continue }
    if (w === 'env' || w === '/usr/bin/env') {
      i++
      while (i < t.length && (t[i].startsWith('-') || ASSIGNMENT.test(t[i]))) {
        if (t[i] === '-i' || t[i] === '--ignore-environment' || t[i] === '-') envEmpty = true
        if (t[i] === '-u' || t[i] === '--unset') {
          if (CHANNEL_STATE_VARS.includes(t[i + 1])) neutralised.add(t[i + 1])
          i += 2
          continue
        }
        if (t[i].startsWith('-u') && CHANNEL_STATE_VARS.includes(t[i].slice(2))) neutralised.add(t[i].slice(2))
        if (t[i].startsWith('CLAUDE_CONFIG_DIR=')) setsConfigDir = true
        for (const v of CHANNEL_STATE_VARS) if (t[i].startsWith(`${v}=`)) neutralised.add(v)
        i++
      }
      continue
    }
    if (ASSIGNMENT.test(w)) {
      if (w.startsWith('CLAUDE_CONFIG_DIR=')) setsConfigDir = true
      for (const v of CHANNEL_STATE_VARS) if (w.startsWith(`${v}=`)) neutralised.add(v)
      i++
      continue
    }
    break
  }
  const cmd = t[i]
  if (!cmd) return null
  const base = cmd.split('/').pop()
  if (base !== 'claude') return null
  const args = t.slice(i + 1)
  return { args, envEmpty, setsConfigDir, neutralised }
}

// Text the shell does not execute must not be read as a command: heredoc bodies
// (a commit message, a markdown note) and quoted strings routinely MENTION
// `claude`. Measured 2026-10-10: the first live version blocked a python heredoc
// that documented this very guard, because a backtick inside the heredoc text
// started a new segment. Removing inert text before the split keeps the check on
// what actually runs. Known gap, accepted: a `$(claude ...)` inside double
// quotes is not seen.
export function stripInertText(command) {
  let out = command.replace(/<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, ' ')
  out = out.replace(/'[^']*'/g, "''")
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""')
  return out
}

export function decide(command, env = process.env) {
  if (typeof command !== 'string' || !command) return { allow: true }
  if (!sessionOwnsChannel(env)) return { allow: true }
  for (const segment of stripInertText(command).split(SEGMENT_SPLIT)) {
    const hit = inspectSegment(segment)
    if (!hit) continue
    if (hit.args.length > 0 && SAFE_FIRST_ARGS.has(hit.args[0])) continue
    // Isolated = empty environment, or its own config dir AND every channel
    // state variable THIS session carries is unset/overridden for the child
    // (the launcher may export TELEGRAM_, DISCORD_ and SLACK_STATE_DIR at once).
    const present = CHANNEL_STATE_VARS.filter((v) => typeof env[v] === 'string' && env[v].length > 0)
    if (hit.envEmpty || (hit.setsConfigDir && present.every((v) => hit.neutralised.has(v)))) continue
    return { allow: false, segment: segment.trim().slice(0, 200) }
  }
  return { allow: true }
}

const REASON = [
  'child-claude-channel-guard (CHILDCLAUDEPOLLER1010): this session owns a channel, and a child `claude`',
  'started with the inherited environment loads the channel plugin, which SIGTERMs THIS session\'s live',
  'poller via the shared bot.pid ("replacing stale poller"). The channel then stays dead until restart.',
  'Run the child isolated instead, e.g.:',
  '  env -u TELEGRAM_STATE_DIR -u DISCORD_STATE_DIR -u SLACK_STATE_DIR CLAUDE_CONFIG_DIR=<empty-dir> claude -p ...',
  '(unset every *_STATE_DIR this session carries)',
  'or `env -i PATH="$PATH" HOME="$HOME" ...`. Details: docs/mcp-list-channel-plugin.md',
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
