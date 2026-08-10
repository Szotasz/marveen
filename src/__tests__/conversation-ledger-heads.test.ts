import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

const ROOT = join(import.meta.dirname, '..', '..')

// A channel-having agent is ALWAYS relaunched fresh (agent-process.ts: the
// `--continue` resume does not re-initialise the --channels plugin MCP server,
// so the bot would come up deaf). The conversation context is therefore lost on
// EVERY restart, and the agent comes back asking "this session just started, I
// don't have the history this is a reply to".
//
// The cure already exists and works for the main agent: the conversation ledger
// (conversation_log + scripts/hooks/ledger-*.py) replays the last ~20 channel
// turns plus the open question, from a hook, at zero model cost. It was simply
// never registered for the sub-agents -- their settings.json is generated from
// templates/settings.json.template, which carried none of the three hooks.
// These tests pin the registration so the gap cannot silently reopen.

function template(): Record<string, unknown> {
  const raw = readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
  return JSON.parse(raw.replace(/\{\{PROJECT_ROOT\}\}/g, '/ROOT')
    .replace(/\{\{WEB_PORT\}\}/g, '3420')
    .replace(/\{\{BOT_NAME\}\}/g, 'BOT'))
}

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }

function entriesFor(event: string): HookEntry[] {
  const hooks = template().hooks as Record<string, HookEntry[]> | undefined
  return hooks?.[event] ?? []
}

function commandsFor(event: string): string[] {
  return entriesFor(event).flatMap(e => (e.hooks ?? []))
    .filter(h => h.type === undefined || h.type === 'command')
    .map(h => h.command ?? '')
}

describe('conversation ledger is registered for sub-agents', () => {
  it('captures the inbound channel turn (UserPromptSubmit)', () => {
    expect(commandsFor('UserPromptSubmit').join('\n')).toContain('ledger-capture.py')
  })

  it('captures the outbound reply (PostToolUse on the channel reply tool)', () => {
    const post = entriesFor('PostToolUse')
    const withLedger = post.filter(e => JSON.stringify(e).includes('ledger-outbound.py'))
    expect(withLedger.length).toBeGreaterThan(0)
    // Without a matcher the hook would run after EVERY tool call.
    expect(withLedger[0].matcher ?? '').toMatch(/telegram/)
  })

  it('replays the ledger on session start', () => {
    expect(commandsFor('SessionStart').join('\n')).toContain('ledger-replay.py')
  })

  // The amnesia case IS `startup`: an auto-restart / watchdog respawn is not a
  // compact and not a resume. A matcher that omits it replays nothing exactly
  // when replay is needed.
  it('replays on startup, not only on compact/resume', () => {
    const entry = entriesFor('SessionStart')
      .find(e => JSON.stringify(e).includes('ledger-replay.py'))
    expect(entry?.matcher ?? '').toContain('startup')
  })
})

describe('template hook safety', () => {
  // 2026-07-11 fleet freeze: a UserPromptSubmit hook whose script was missing
  // exited non-zero and BLOCKED every prompt -- the agents went silently deaf.
  // Every prompt-gating hook must therefore be fail-open.
  it('every UserPromptSubmit hook is fail-open', () => {
    const cmds = commandsFor('UserPromptSubmit')
    expect(cmds.length).toBeGreaterThan(0)
    for (const c of cmds) {
      expect(c, `not fail-open: ${c}`).toMatch(/^bash -c '\[ -f .+ \] && exec .+; exit 0'$/)
    }
  })

  // Drift guard: agent-taskstate.ts REPLAY_SOURCES accepts 'startup' (added
  // 2026-07-27 for crash/watchdog respawns, the case it exists for), but the
  // matcher that fires the hook never followed.
  it('taskstate replay fires on every source the code accepts', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-taskstate.ts'), 'utf-8')
    const sources = [...src.matchAll(/REPLAY_SOURCES = new Set\(\[([^\]]+)\]/g)][0]?.[1] ?? ''
    const accepted = [...sources.matchAll(/'([a-z]+)'/g)].map(m => m[1])
    expect(accepted).toContain('startup')

    const entry = entriesFor('SessionStart')
      .find(e => JSON.stringify(e).includes('taskstate-replay.py'))
    for (const s of accepted) {
      expect(entry?.matcher ?? '', `matcher misses '${s}'`).toContain(s)
    }
  })

  it('the stale-hook pruner knows every ledger script', () => {
    for (const s of ['ledger-capture.py', 'ledger-outbound.py', 'ledger-replay.py']) {
      expect(KNOWN_HOOK_SCRIPTS).toContain(s)
    }
  })

  it('existing agents are backfilled on dashboard startup', () => {
    expect(readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')).toContain('ensureAgentHooks')
  })
})
