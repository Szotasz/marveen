// The /clear path used to be unprotected at BOTH ends:
// nothing saved the thread before the wipe (a /clear does not fire PreCompact,
// so the agent-hook that writes the task-state never ran) and nothing restored
// one after it (the SessionStart replay was wired to compact|resume). A cleared
// sub-agent session vanished without a trace -- including on the
// context-restart gate's own path, which sends /clear deliberately and then
// tells the fresh session to read blocks nobody had written.
//
// Behavioural tests run the python hooks as subprocesses (deterministic, no
// LLM). Static tests lock the wiring (template + KNOWN_HOOK_SCRIPTS) and the
// matcher migration that carries a widened matcher to the existing fleet.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { syncHookMatchers } from '../web/agent-scaffold.js'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const CAPTURE = join(ROOT, 'scripts', 'hooks', 'clear-capture.py')
const REPLAY = join(ROOT, 'scripts', 'hooks', 'clear-replay.py')
// The hooks resolve the agent id from cwd relative to their own install dir,
// so the payload cwd must sit under THIS checkout.
const AGENT_CWD = join(ROOT, 'agents', 'tester')

let store: string
let transcript: string

function runHook(script: string, payload: unknown): string {
  try {
    return execFileSync('python3', [script], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, CLEARSTATE_DIR: store },
    })
  } catch {
    return ''
  }
}

function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

const OWNER_TURN = (text: string) => ({ type: 'user', message: { content: text } })
const AGENT_TURN = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'clearstate-'))
  transcript = join(store, 'session.jsonl')
  writeFileSync(transcript, jsonl([
    // Harness noise: an injected reminder is not something the owner typed.
    { type: 'user', isMeta: true, message: { content: '<system-reminder>zaj</system-reminder>' } },
    OWNER_TURN('Javitsd meg a kanban szurot'),
    AGENT_TURN('Megnezem a route-ot.'),
    // Tool output arrives as a 'user' turn with a tool_result block, not a prompt.
    { type: 'user', message: { content: [{ tool_use_id: 'x', type: 'tool_result', content: 'kimenet' }] } },
    OWNER_TURN('A tesztet is ird meg hozza'),
    AGENT_TURN('Kesz a javitas, jon a teszt.'),
  ]))
})

afterEach(() => rmSync(store, { recursive: true, force: true }))

function capture(over: Record<string, unknown> = {}): void {
  runHook(CAPTURE, { reason: 'clear', cwd: AGENT_CWD, transcript_path: transcript, ...over })
}

function record(): Record<string, unknown> | null {
  const path = join(store, 'tester.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null
}

describe('clear-capture hook (SessionEnd)', () => {
  it('saves the owner prompts and the last reply of a cleared thread', () => {
    capture()
    const r = record()
    expect(r?.prompts).toEqual(['Javitsd meg a kanban szurot', 'A tesztet is ird meg hozza'])
    expect(r?.lastReply).toBe('Kesz a javitas, jon a teszt.')
    expect(r?.transcriptPath).toBe(transcript)
  })

  it('skips harness noise: meta turns and tool_result turns are not prompts', () => {
    capture()
    const prompts = (record()?.prompts ?? []) as string[]
    expect(prompts.join(' ')).not.toContain('system-reminder')
    expect(prompts.join(' ')).not.toContain('kimenet')
  })

  it('writes nothing for a SessionEnd that is not a /clear', () => {
    capture({ reason: 'logout' })
    expect(record()).toBeNull()
  })

  it('writes nothing for a session outside the install (the main hooks are user-global)', () => {
    capture({ cwd: '/Users/somebody/unrelated-repo' })
    expect(readdirSync(store).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it('survives an unreadable transcript without writing a record', () => {
    capture({ transcript_path: join(store, 'does-not-exist.jsonl') })
    expect(record()).toBeNull()
  })
})

describe('clear-replay hook (SessionStart)', () => {
  function replay(over: Record<string, unknown> = {}): string {
    return runHook(REPLAY, { source: 'clear', cwd: AGENT_CWD, ...over })
  }

  it('injects the cleared thread into the fresh session', () => {
    capture()
    const out = JSON.parse(replay())
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    const ctx = out.hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('Javitsd meg a kanban szurot')
    expect(ctx).toContain('Kesz a javitas, jon a teszt.')
    expect(ctx).toContain(transcript)
  })

  it('replays once: the record is dropped after a successful injection', () => {
    capture()
    expect(replay()).not.toBe('')
    expect(replay()).toBe('')
    expect(record()).toBeNull()
  })

  it('stays silent on the other SessionStart sources (taskstate-replay owns those)', () => {
    capture()
    expect(replay({ source: 'startup' })).toBe('')
    expect(replay({ source: 'compact' })).toBe('')
    expect(record()).not.toBeNull() // and leaves the record for the real clear
  })

  it('stays silent when nothing was captured', () => {
    expect(replay()).toBe('')
  })

  it('ignores a record past the TTL instead of injecting a stale thread', () => {
    capture()
    const stale = record() as Record<string, unknown>
    stale.ts = Math.floor(Date.now() / 1000) - 13 * 60 * 60
    writeFileSync(join(store, 'tester.json'), JSON.stringify(stale))
    expect(replay()).toBe('')
  })

  it('does not order the fresh session to resume work on its own', () => {
    capture()
    const ctx = JSON.parse(replay()).hookSpecificOutput.additionalContext as string
    // A /clear can be a deliberate fresh start; the block informs, the next
    // prompt decides. Anything stronger would invent work nobody asked for.
    expect(ctx).toContain('ne eleszd ujra a regi szalat magatol')
  })
})

describe('/clear wiring', () => {
  const tpl = JSON.parse(
    readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
      .replaceAll('{{PROJECT_ROOT}}', '/install')
      .replaceAll('{{WEB_PORT}}', '3420')
      .replaceAll('{{BOT_NAME}}', 'Bot'),
  ) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }

  function commandsFor(event: string, matcher: string | undefined): string[] {
    return (tpl.hooks[event] ?? [])
      .filter((g) => g.matcher === matcher)
      .flatMap((g) => g.hooks.map((h) => h.command))
  }

  it('replays the task-state on clear as well as compact and resume', () => {
    expect(commandsFor('SessionStart', 'compact|resume|clear').join(' ')).toContain('taskstate-replay.py')
  })

  it('registers the clear-replay hook on the clear source', () => {
    expect(commandsFor('SessionStart', 'clear').join(' ')).toContain('clear-replay.py')
  })

  it('registers the clear-capture hook on SessionEnd without a matcher', () => {
    // Deliberate: the SessionEnd matcher semantics are the reason to NOT rely on
    // them here. The hook itself filters on reason=clear, so the wiring stays
    // correct whatever the harness matches SessionEnd groups against.
    const group = tpl.hooks.SessionEnd ?? []
    expect(group).toHaveLength(1)
    expect(group[0].matcher).toBeUndefined()
    expect(group[0].hooks.map((h) => h.command).join(' ')).toContain('clear-capture.py')
  })

  it('knows both hooks as ours, so a stale entry is self-healed not orphaned', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain('clear-capture.py')
    expect(KNOWN_HOOK_SCRIPTS).toContain('clear-replay.py')
  })
})

// The migration gap that kept every existing agent on the old matcher: the add pass
// dedupes on the COMMAND string, so a matcher-only template change reached
// nobody and nothing errored.
describe('syncHookMatchers', () => {
  const tplHooks = () => ({
    SessionStart: [{ matcher: 'compact|resume|clear', hooks: [{ type: 'command', command: 'python3 /i/taskstate-replay.py' }] }],
  })

  it('widens a stale matcher on a group whose command is unchanged', () => {
    const existing = {
      SessionStart: [{ matcher: 'compact|resume', hooks: [{ type: 'command', command: 'python3 /i/taskstate-replay.py' }] }],
    }
    expect(syncHookMatchers(existing, tplHooks())).toBe(true)
    expect(existing.SessionStart[0].matcher).toBe('compact|resume|clear')
  })

  it('is idempotent once the matcher already matches', () => {
    const existing = {
      SessionStart: [{ matcher: 'compact|resume|clear', hooks: [{ type: 'command', command: 'python3 /i/taskstate-replay.py' }] }],
    }
    expect(syncHookMatchers(existing, tplHooks())).toBe(false)
  })

  it('leaves a group a human extended with their own hook alone', () => {
    const existing = {
      SessionStart: [{
        matcher: 'compact|resume',
        hooks: [
          { type: 'command', command: 'python3 /i/taskstate-replay.py' },
          { type: 'command', command: 'python3 /i/my-own-hook.py' },
        ],
      }],
    }
    expect(syncHookMatchers(existing, tplHooks())).toBe(false)
    expect(existing.SessionStart[0].matcher).toBe('compact|resume')
  })

  it('never removes a matcher when the template group has none', () => {
    const existing = {
      UserPromptSubmit: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /i/guard.py' }] }],
    }
    const tpl = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 /i/guard.py' }] }] }
    expect(syncHookMatchers(existing, tpl)).toBe(false)
    expect(existing.UserPromptSubmit[0].matcher).toBe('Bash')
  })

  it('ignores events the agent does not have', () => {
    expect(syncHookMatchers({}, tplHooks())).toBe(false)
  })
})
