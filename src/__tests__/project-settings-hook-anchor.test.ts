// #1305 (ISSUE1305HOOKSCOPE): the tracked .claude/settings.json is the
// AUTHORITATIVE registration surface for the main agent's fleet hooks. The
// scaffold refuses to write them anywhere else (hook-scope-main-refusal
// pins that), so if an entry silently falls out of this file, nothing
// re-adds it -- the hook just stops firing. This anchor makes such a drop
// loud: the full expected set is spelled out, per event.
//
// Portability is part of the contract: every command must resolve through
// $CLAUDE_PROJECT_DIR (the file ships to every install), and the WebFetch
// egress gate must keep its fail-CLOSED preamble -- the user-global variant
// pinned a machine-local node path, which is exactly what broke in the
// owner's own sessions (#1305) and what a "simplifying" edit would
// reintroduce.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SETTINGS_PATH = join(ROOT, '.claude', 'settings.json')

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }
type Hooks = Record<string, HookEntry[]>

const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as { hooks?: Hooks }
const hooks: Hooks = settings.hooks ?? {}

// The full expected registration: event -> one entry per matcher group
// (order-free, duplicates count): the script basename, followed by
// ` @ <matcher>` when the group has a matcher. A change here is a REVIEWED
// decision about what runs in the main session, never a side effect.
//
// Group granularity matters because several scripts are registered under more
// than one matcher (outgoing-copy-gate.py and email-approval-gate.py: one group
// per mail surface and channel). A script-name set stays green when one of
// those groups is deleted or its matcher narrowed, and when a non-gate hook's
// matcher changes; this list does not.
//
// Both channel providers' progress hooks are listed unconditionally. That is
// deliberate: each one is provider-scoped internally and no-ops on the other
// provider's turns, so the cost of the idle set is a process spawn. Only the
// watchdog DAEMON -- which polls on a timer whether or not a turn is in
// flight -- is gated to the active CHANNEL_PROVIDER, by the two
// install-*-progress-hook.sh scripts.
const EXPECTED: Record<string, string[]> = {
  UserPromptSubmit: [
    'ledger-capture.py', 'inbox-drain.py', 'telegram-reply-directive.py',
    'provenance-gate.py', 'staleness-guard.py', 'memory-lookup-nudge.py', 'channel-inbox-drain.py',
    'voice-reply-directive.py', 'telegram_progress.py', 'slack_progress.py',
    'marveen-commands.py',
  ],
  PostToolUse: [
    'ledger-outbound.py @ mcp__plugin_[^_]+_[^_]+__reply', 'tool-log-capture.py',
    'telegram_progress_reply_clear.py @ telegram.*reply', 'slack_progress_reply_clear.py @ slack.*reply',
    'skill-usage-capture.py @ Skill|Read', 'memory-frontmatter-bash-gate.py @ Bash',
    // The persona guard watches the main agent's own CLAUDE.md/SOUL.md and
    // every agents/*/ pair, and it must fire on EVERY tool call: the first
    // version filtered on the Write/Edit file_path and a python3 heredoc
    // walked straight past it. PostToolUse is the event that cannot be
    // dodged by choosing a different tool.
    'persona-change-notify.py',
  ],
  // A failed tool call fires PostToolUseFailure, never PostToolUse
  // (TOOLLOGVAKSIKER921): without this entry tool_call_log cannot hold a 0.
  // KAPUEGYUT918: a failed Bash call can still have written a memory file.
  PostToolUseFailure: ['tool-log-capture.py', 'memory-frontmatter-bash-gate.py @ Bash'],
  PreToolUse: [
    'outgoing-copy-gate.py @ Bash',
    'outgoing-copy-gate.py @ .*send_email.*',
    'outgoing-copy-gate.py @ .*manage_email.*',
    'outgoing-copy-gate.py @ .*[Gg]mail.*__.*',
    'outgoing-copy-gate.py @ .*draft_email.*',
    'outgoing-copy-gate.py @ mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message',
    'outgoing-copy-gate.py @ mcp__plugin_discord_discord__reply|mcp__plugin_discord_discord__edit_message',
    'email-approval-gate.py @ Bash',
    'email-approval-gate.py @ .*send_email.*',
    'email-approval-gate.py @ .*manage_email.*',
    'email-approval-gate.py @ .*[Gg]mail.*__.*',
    'email-approval-gate.py @ .*draft_email.*',
    'channel-image-resize.sh @ Read', 'egress-gate.mjs @ WebFetch', 'memory-frontmatter-gate.py @ Write|Edit|MultiEdit',
    'memory-frontmatter-bash-gate.py @ Bash',
  ],
  Stop: ['marveen-commands.py', 'telegram-reply-guard.py', 'telegram_progress_clear.py', 'slack_progress_clear.py'],
  StopFailure: ['ledger-turn-failure.py'],
  SessionStart: [
    'ledger-replay.py @ startup|resume|clear', 'taskstate-replay.py @ compact|resume|clear',
    'clear-replay.py @ clear', 'marveen-commands.py',
  ],
  SessionEnd: ['clear-capture.py'],
}

function commands(event: string): string[] {
  return (hooks[event] ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command ?? '')
}

const scriptOf = (command: string) => command.match(/scripts\/hooks\/([^/\s'"]+?\.(?:py|sh|mjs))/)?.[1] ?? ''

function scriptNames(event: string): Set<string> {
  return new Set(commands(event).map(scriptOf).filter(Boolean))
}

// One descriptor per handler, in the EXPECTED form: '<script>' or '<script> @ <matcher>'.
function groupDescriptors(event: string): string[] {
  return (hooks[event] ?? []).flatMap((e) => (e.hooks ?? []).map((h) => {
    const script = scriptOf(h.command ?? '') || `<no script: ${h.command ?? ''}>`
    return e.matcher === undefined ? script : `${script} @ ${e.matcher}`
  }))
}

// The keys this file uses today. A new key (a stray `id` or `description`, a
// handler option nobody reviewed) has to be added here on purpose.
const GROUP_KEYS = new Set(['matcher', 'hooks'])
const HANDLER_KEYS = new Set(['type', 'command', 'timeout'])

describe('tracked .claude/settings.json hook anchor (#1305)', () => {
  it('registers exactly the expected script set per event', () => {
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const [event, expected] of Object.entries(EXPECTED)) {
      const names = expected.map((d) => d.split(' @ ')[0])
      expect([...scriptNames(event)].sort(), `event ${event}`).toEqual([...new Set(names)].sort())
    }
  })

  it('registers exactly the expected matcher groups per event (each group, each matcher)', () => {
    for (const [event, expected] of Object.entries(EXPECTED)) {
      expect(groupDescriptors(event).sort(), `event ${event}`).toEqual([...expected].sort())
    }
  })

  it('uses only the reviewed hook keys (matcher group: matcher, hooks; handler: type, command, timeout)', () => {
    for (const [event, entries] of Object.entries(hooks)) {
      entries.forEach((e, i) => {
        for (const k of Object.keys(e)) expect(GROUP_KEYS.has(k), `${event}[${i}] group key ${k}`).toBe(true)
        for (const h of e.hooks ?? []) {
          for (const k of Object.keys(h)) expect(HANDLER_KEYS.has(k), `${event}[${i}] handler key ${k}`).toBe(true)
        }
      })
    }
  })

  it('every referenced script exists in scripts/hooks/', () => {
    for (const event of Object.keys(EXPECTED)) {
      for (const name of scriptNames(event)) {
        expect(existsSync(join(ROOT, 'scripts', 'hooks', name)), `missing scripts/hooks/${name}`).toBe(true)
      }
    }
  })

  it('every command is portable: $CLAUDE_PROJECT_DIR, no machine-local paths', () => {
    for (const event of Object.keys(hooks)) {
      for (const cmd of commands(event)) {
        expect(cmd, `event ${event}`).toContain('$CLAUDE_PROJECT_DIR')
        expect(cmd).not.toMatch(/\/(Users|home|opt|var)\//)
      }
    }
  })

  it('the WebFetch egress gate keeps its fail-closed preamble', () => {
    const webfetch = (hooks.PreToolUse ?? []).filter((e) => e.matcher === 'WebFetch')
    expect(webfetch).toHaveLength(1)
    const cmd = webfetch[0].hooks?.[0]?.command ?? ''
    // No node -> BLOCK (exit 2), never fail-open silence.
    expect(cmd).toMatch(/command -v node[^;]*\|\|\s*\{[^}]*exit 2/)
    expect(cmd).toContain('egress-gate.mjs')
  })
})
