import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentHooks } from '../web/agent-scaffold.js'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'
import { PROJECT_ROOT } from '../config.js'

// PELENKAGCHAT1113: the Google Chat thread guard is ONE script on TWO events.
// UserPromptSubmit records which thread an inbound arrived in; PreToolUse on the
// Google Chat reply tool stops a reply that would not land in such a thread.
// Either half alone does nothing: a guard with no recorder never has a thread
// to hold a reply to (it passes everything), a recorder with no guard only
// writes a file. So the wiring is asserted as a PAIR, in both places it lives:
//   - the tracked .claude/settings.json (the main agent's session),
//   - templates/settings.json.template (every sub-agent, where Google Chat
//     normally runs), which ensureAgentHooks merges into existing agents.
// The effect cases run the commands the template actually registers.

const SCRIPT = 'googlechat-thread-guard.py'
const MATCHER = 'mcp__plugin_googlechat_googlechat__reply'

interface Hook { type?: string; command?: string; timeout?: number }
interface Group { matcher?: string; hooks?: Hook[] }
type Hooks = Record<string, Group[]>

function guardEntries(hooks: Hooks): Array<{ event: string; matcher: string | undefined; command: string }> {
  const out: Array<{ event: string; matcher: string | undefined; command: string }> = []
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        if ((h.command ?? '').includes(SCRIPT)) out.push({ event, matcher: g.matcher, command: h.command ?? '' })
      }
    }
  }
  return out
}
const shape = (hooks: Hooks): string[] => guardEntries(hooks).map((e) => `${e.event} @ ${e.matcher ?? '-'}`).sort()
const PAIR = [`PreToolUse @ ${MATCHER}`, 'UserPromptSubmit @ -']

function templateHooks(): Hooks {
  const raw = readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')
    .replace(/\{\{PROJECT_ROOT\}\}/g, PROJECT_ROOT).replace(/\{\{BOT_NAME\}\}/g, 'B').replace(/\{\{WEB_PORT\}\}/g, '3420')
  return (JSON.parse(raw) as { hooks: Hooks }).hooks
}

describe('PELENKAGCHAT1113: the Google Chat thread guard is wired as a pair', () => {
  it('the tracked project settings register both halves, the guard only on the Google Chat reply tool', () => {
    const hooks = (JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8')) as { hooks: Hooks }).hooks
    expect(shape(hooks)).toEqual(PAIR)
  })

  it('the sub-agent template registers both halves, the guard only on the Google Chat reply tool', () => {
    expect(shape(templateHooks())).toEqual(PAIR)
  })

  it('the template commands are the fail-open wrapper form (a missing script cannot block a prompt or a reply)', () => {
    for (const e of guardEntries(templateHooks())) {
      expect(e.command).toMatch(/^bash -c '\[ -f \S+\/scripts\/hooks\/googlechat-thread-guard\.py \] && exec python3 -I -S \S+\/scripts\/hooks\/googlechat-thread-guard\.py; exit 0'$/)
    }
  })

  it('the script is one of ours for the stale-entry prune', () => {
    expect(KNOWN_HOOK_SCRIPTS).toContain(SCRIPT)
  })

  it('the matcher is the reply tool alone: the edit tool and other plugins are not matched', () => {
    const rx = new RegExp(`^(?:${MATCHER})$`)
    expect(rx.test('mcp__plugin_googlechat_googlechat__reply')).toBe(true)
    expect(rx.test('mcp__plugin_googlechat_googlechat__edit_message')).toBe(false)
    expect(rx.test('mcp__plugin_telegram_telegram__reply')).toBe(false)
  })
})

// The migration: an agent scaffolded BEFORE this change has every template hook
// except the pair. ensureAgentHooks (run for every agent at dashboard start)
// must add both halves, each under its own event and matcher, and adding them
// twice must not happen.
describe('PELENKAGCHAT1113: an existing sub-agent gets the pair from ensureAgentHooks', () => {
  const PROBE = 'gchat1113-probe'
  const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
  const settingsPath = join(probeDir, '.claude', 'settings.json')
  let fakeHome: string
  let realHome: string | undefined

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), 'gchat1113-'))
    process.env.HOME = fakeHome
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{}')
    if (existsSync(join(probeDir, 'HANDOFF.md'))) throw new Error(`refusing: agents/${PROBE} looks live`)
    rmSync(probeDir, { recursive: true, force: true })
    mkdirSync(probeDir, { recursive: true })
  })
  afterEach(() => {
    process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(probeDir, { recursive: true, force: true })
  })

  const read = (): { hooks: Hooks } => JSON.parse(readFileSync(settingsPath, 'utf-8')) as { hooks: Hooks }
  const commandCount = (hooks: Hooks): number =>
    Object.values(hooks).reduce((n, groups) => n + groups.reduce((m, g) => m + (g.hooks?.length ?? 0), 0), 0)

  it('a pre-change agent (every template hook but the pair) gains exactly the pair, once', () => {
    ensureAgentHooks(PROBE)
    const full = read()
    expect(shape(full.hooks), 'a fresh agent has the pair').toEqual(PAIR)

    // The pre-change agent: the same file with the two guard entries removed.
    const before = read()
    for (const event of Object.keys(before.hooks)) {
      before.hooks[event] = before.hooks[event]
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !(h.command ?? '').includes(SCRIPT)) }))
        .filter((g) => (g.hooks?.length ?? 0) > 0)
    }
    expect(shape(before.hooks), 'the fixture really lacks the pair').toEqual([])
    const without = commandCount(before.hooks)
    writeFileSync(settingsPath, JSON.stringify(before, null, 2))

    ensureAgentHooks(PROBE)
    const after = read()
    expect(shape(after.hooks), 'the migration adds both halves under their own event and matcher').toEqual(PAIR)
    expect(commandCount(after.hooks), 'and nothing else').toBe(without + 2)

    ensureAgentHooks(PROBE)
    expect(commandCount(read().hooks), 'a second run adds nothing').toBe(without + 2)
  })
})

// Effect, not registration: the commands the template registers are run as the
// harness runs them (the hook's JSON on stdin), against a tmp state dir.
describe('PELENKAGCHAT1113: the registered commands do the job', () => {
  let sd: string
  beforeEach(() => { sd = mkdtempSync(join(tmpdir(), 'gchat1113-fx-')) })
  afterEach(() => rmSync(sd, { recursive: true, force: true }))

  const command = (event: string): string => {
    const e = guardEntries(templateHooks()).find((x) => x.event === event)
    if (!e) throw new Error(`no ${event} entry for ${SCRIPT} in the template`)
    return e.command
  }
  const run = (event: string, payload: unknown): string =>
    execFileSync('bash', ['-c', command(event)], {
      input: JSON.stringify(payload), encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '', HOME: sd, GOOGLECHAT_STATE_DIR: sd, MARVEEN_LANG: 'en' },
    })

  const SPACE = 'spaces/AAAA1'
  const THREAD = `${SPACE}/threads/TTT1`
  const inbound = {
    hook_event_name: 'UserPromptSubmit',
    prompt: `<channel source="plugin:googlechat:googlechat" chat_id="${SPACE}" message_id="${SPACE}/messages/M1.M1" `
      + `user="anna@example.com" user_id="users/200" ts="2026-11-13T13:00:00.123456Z" role="user" thread="${THREAD}">\nkerdes\n</channel>`,
  }
  const reply = (tool_input: Record<string, unknown>): unknown =>
    ({ hook_event_name: 'PreToolUse', tool_name: MATCHER, tool_input: { chat_id: SPACE, text: 'valasz', ...tool_input } })

  it('the recorder alone writes the thread; the guard then stops a reply with no reply_to and names the thread', () => {
    expect(run('UserPromptSubmit', inbound)).toBe('')
    expect(existsSync(join(sd, 'thread-guard', 'threads.json'))).toBe(true)
    const out = JSON.parse(run('PreToolUse', reply({}))) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(`reply_to="${THREAD}"`)
  })

  it('a reply into the recorded thread passes, silently', () => {
    run('UserPromptSubmit', inbound)
    expect(run('PreToolUse', reply({ reply_to: THREAD }))).toBe('')
  })

  it('without the recorder the guard holds nothing: the pair is what makes it work', () => {
    expect(run('PreToolUse', reply({}))).toBe('')
  })
})
