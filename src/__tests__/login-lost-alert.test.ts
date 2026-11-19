import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

// LOGINKIESES1119: when an agent's Claude login is gone, every turn ends with a synthetic
// "Not logged in · Please run /login" message (measured 2026-11-19: 328 such turns of the main session,
// 02:07-17:16, and nobody told the owner). scripts/hooks/login-lost-alert.py (Stop + StopFailure) alerts the
// owner through scripts/notify.sh, at most once per 30 minutes per agent, and says when the agent is back.
//
// The hook runs from a tmp install: <tmp>/scripts/hooks links to the repo's hooks (the hook takes its root from
// abspath), and <tmp>/scripts/notify.sh is a recorder, so nothing leaves the machine.

const REPO = join(__dirname, '..', '..')
const TOKEN = '123456:SECRET-TEST-TOKEN-never-in-output'

let tmp = ''
let hook = ''

function notifyLog(): string[] {
  const p = join(tmp, 'notify.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').split('\n---\n').filter(Boolean)
}

function state(): Record<string, any> {
  const p = join(tmp, 'store', 'login-alert-state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8') || '{}') : {}
}

function transcriptFor(agent: string): string {
  // A sub-agent's transcript lives in its isolated config dir; the main agent's under .channels-config.
  const dir = agent === 'marveen'
    ? join(tmp, '.channels-config', 'projects', 'p')
    : join(tmp, 'agents', agent, '.claude-config', 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  return join(dir, 's.jsonl')
}

const loginEntry = (text = 'Not logged in · Please run /login') => ({
  type: 'assistant', isApiErrorMessage: true, error: 'authentication_failed',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
})
const normalEntry = (text: string) => ({
  type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }] },
})

function turn(agent: string, entry: object, extra: Record<string, unknown> = {}) {
  const t = transcriptFor(agent)
  writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: 'szia' } }) + '\n' + JSON.stringify(entry) + '\n')
  const payload = { hook_event_name: 'Stop', session_id: 's', transcript_path: t, cwd: tmp, ...extra }
  const r = spawnSync('python3', ['-I', '-S', hook], { input: JSON.stringify(payload), encoding: 'utf-8' })
  expect(r.status).toBe(0)
  expect(r.stdout).toBe('')
  return r
}

function stopFailure(agent: string, error: string) {
  const payload = { hook_event_name: 'StopFailure', session_id: 's', transcript_path: transcriptFor(agent), cwd: tmp, error }
  const r = spawnSync('python3', ['-I', '-S', hook], { input: JSON.stringify(payload), encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'login-alert-'))
  mkdirSync(join(tmp, 'scripts'))
  mkdirSync(join(tmp, 'store'))
  symlinkSync(join(REPO, 'scripts', 'hooks'), join(tmp, 'scripts', 'hooks'))
  writeFileSync(join(tmp, 'scripts', 'notify.sh'),
    '#!/bin/bash\nD="$(cd "$(dirname "$0")/.." && pwd)"\n[ -f "$D/notify-fail" ] && exit 1\nprintf \'%s\\n---\\n\' "$1" >> "$D/notify.log"\n')
  chmodSync(join(tmp, 'scripts', 'notify.sh'), 0o755)
  writeFileSync(join(tmp, '.env'), `MAIN_AGENT_ID=marveen\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`)
  hook = join(tmp, 'scripts', 'hooks', 'login-lost-alert.py')
})
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

describe('LOGINKIESES1119: login-lost-alert hook', () => {
  it('a logged-out turn sends exactly one alert; the next turns within 30 minutes send none', () => {
    turn('marveen', loginEntry())
    turn('marveen', loginEntry())
    turn('marveen', loginEntry('Login expired · Please run /login'))
    const log = notifyLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/^RIASZTÁS: a\(z\) marveen ügynök Claude-bejelentkezése kiesett \(\d\d:\d\d óta\)/)
    expect(log[0]).toContain('„Bejelentkezés” gomb')
    expect(state().marveen.failed_turns).toBe(3)
    expect(statSync(join(tmp, 'store', 'login-alert-state.json')).mode & 0o777).toBe(0o600)
  })

  it('after 30 minutes a still logged-out agent gets one reminder', () => {
    turn('marveen', loginEntry())
    const p = join(tmp, 'store', 'login-alert-state.json')
    const s = state()
    s.marveen.last_alert -= 31 * 60
    writeFileSync(p, JSON.stringify(s))
    turn('marveen', loginEntry())
    turn('marveen', loginEntry())
    const log = notifyLog()
    expect(log).toHaveLength(2)
    expect(log[1]).toMatch(/^RIASZTÁS, ismétlés: a\(z\) marveen ügynök \d\d:\d\d óta nincs bejelentkezve \(2 sikertelen kör\)/)
  })

  it('the first normal turn after the outage sends one "recovered" message and clears the state', () => {
    turn('marveen', loginEntry())
    turn('marveen', normalEntry('Kész, tessék.'))
    turn('marveen', normalEntry('Ez is kész.'))
    const log = notifyLog()
    expect(log).toHaveLength(2)
    expect(log[1]).toMatch(/^HELYREÁLLT: a\(z\) marveen ügynök újra rendesen válaszol/)
    expect(state().marveen).toBeUndefined()
  })

  it('StopFailure with authentication_failed alerts too; another API error says nothing about the login', () => {
    stopFailure('grafit', 'rate_limit')
    expect(notifyLog()).toHaveLength(0)
    expect(existsSync(join(tmp, 'store', 'login-alert-state.json'))).toBe(false)
    stopFailure('grafit', 'authentication_failed')
    expect(notifyLog()).toHaveLength(1)
    expect(notifyLog()[0]).toContain('grafit ügynök')
  })

  it('another synthetic API error (prompt too long) neither alerts nor counts as recovery', () => {
    turn('marveen', loginEntry())
    turn('marveen', { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request',
      message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Prompt is too long' }] } })
    expect(notifyLog()).toHaveLength(1)
    expect(state().marveen.failed_turns).toBe(1)
  })

  it('an agent that only talks about a lost login is not logged out', () => {
    turn('marveen', normalEntry('A transzkriptben ez állt: "Not logged in · Please run /login", ezt javítjuk.'))
    turn('marveen', normalEntry('ok'), { last_assistant_message: 'Login expired miatt állt le tegnap a flotta.' })
    expect(notifyLog()).toHaveLength(0)
    expect(existsSync(join(tmp, 'store', 'login-alert-state.json'))).toBe(false)
  })

  it('every agent has its own state: a sub-agent outage does not mute the main agent alert', () => {
    turn('grafit', loginEntry())
    turn('marveen', loginEntry())
    turn('grafit', loginEntry())
    const log = notifyLog()
    expect(log).toHaveLength(2)
    expect(log[0]).toContain('grafit ügynök')
    expect(log[1]).toContain('marveen ügynök')
    turn('grafit', normalEntry('vissza'))
    expect(Object.keys(state())).toEqual(['marveen'])
  })

  it('a failed notify.sh does not count as sent: the next logged-out turn tries again', () => {
    writeFileSync(join(tmp, 'notify-fail'), '')
    turn('marveen', loginEntry())
    expect(notifyLog()).toHaveLength(0)
    rmSync(join(tmp, 'notify-fail'))
    turn('marveen', loginEntry())
    expect(notifyLog()).toHaveLength(1)
    expect(notifyLog()[0]).toMatch(/^RIASZTÁS: /)
  })

  it('two sessions under one agent id: a good session does not "recover" a logged-out one (no alert / recovered flood)', () => {
    for (let i = 0; i < 3; i++) {
      turn('marveen', loginEntry(), { session_id: 'channels' })
      turn('marveen', normalEntry('rendes válasz'), { session_id: 'worker' })
    }
    expect(notifyLog()).toHaveLength(1)
    turn('marveen', normalEntry('újra bent'), { session_id: 'channels' })
    const log = notifyLog()
    expect(log).toHaveLength(2)
    expect(log[1]).toMatch(/^HELYREÁLLT: /)
    expect(state().marveen).toBeUndefined()
  })

  it('a logged-out session not seen for an hour counts as gone: the replacement session sends a "probably recovered"', () => {
    turn('marveen', loginEntry(), { session_id: 'old' })
    const p = join(tmp, 'store', 'login-alert-state.json')
    const s = state()
    s.marveen.sessions.old -= 59 * 60
    writeFileSync(p, JSON.stringify(s))
    turn('marveen', normalEntry('még nem'), { session_id: 'new' })
    expect(notifyLog()).toHaveLength(1)
    const s2 = state()
    s2.marveen.sessions.old -= 2 * 60
    writeFileSync(p, JSON.stringify(s2))
    turn('marveen', normalEntry('új munkamenet, bent vagyok'), { session_id: 'new' })
    expect(notifyLog()).toHaveLength(2)
    expect(notifyLog()[1]).toMatch(/^VALÓSZÍNŰLEG HELYREÁLLT: /)
    expect(state().marveen).toBeUndefined()
  })

  it('two logged-out sessions of one agent share the 30-minute brake: one alert, and recovery only after both are back', () => {
    for (let i = 0; i < 3; i++) {
      turn('marveen', loginEntry(), { session_id: 'a' })
      turn('marveen', loginEntry(), { session_id: 'b' })
    }
    expect(notifyLog()).toHaveLength(1)
    turn('marveen', normalEntry('a vissza'), { session_id: 'a' })
    expect(notifyLog()).toHaveLength(1)
    turn('marveen', normalEntry('b vissza'), { session_id: 'b' })
    expect(notifyLog()).toHaveLength(2)
    expect(notifyLog()[1]).toMatch(/^HELYREÁLLT: /)
  })

  it('a Stop and a StopFailure for the same turn count as one failed turn', () => {
    turn('marveen', loginEntry(), { session_id: 's' })
    stopFailure('marveen', 'authentication_failed')
    expect(notifyLog()).toHaveLength(1)
    expect(state().marveen.failed_turns).toBe(1)
    const p = join(tmp, 'store', 'login-alert-state.json')
    const st = state()
    st.marveen.last_down.t -= 11
    writeFileSync(p, JSON.stringify(st))
    turn('marveen', loginEntry(), { session_id: 's' })
    expect(state().marveen.failed_turns).toBe(2)
    turn('marveen', loginEntry(), { session_id: 's' })
    expect(state().marveen.failed_turns).toBe(3)
  })

  it('Revizor case 1: a logged-out session beside a good one, 3 rounds: at most one alert, no recovery until the logged-out one answers', () => {
    for (let i = 0; i < 3; i++) {
      turn('marveen', loginEntry(), { session_id: 'kint' })
      turn('marveen', normalEntry('jó válasz'), { session_id: 'bent' })
    }
    expect(notifyLog()).toHaveLength(1)
    expect(notifyLog()[0]).toMatch(/^RIASZTÁS: /)
    turn('marveen', normalEntry('vissza'), { session_id: 'kint' })
    expect(notifyLog()).toHaveLength(2)
    expect(notifyLog()[1]).toMatch(/^HELYREÁLLT: /)
  })

  it('Revizor case 2: an overload error of the logged-out session neither alerts nor recovers, the outage stays', () => {
    turn('marveen', loginEntry(), { session_id: 'kint' })
    const overload = { type: 'assistant', isApiErrorMessage: true, error: 'overloaded',
      message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }
    turn('marveen', overload, { session_id: 'kint' })
    turn('marveen', overload, { session_id: 'kint', last_assistant_message: 'API Error: 529 Overloaded' })
    stopFailure('marveen', 'overloaded')
    expect(notifyLog()).toHaveLength(1)
    expect(Object.keys(state().marveen.sessions)).toContain('kint')
  })

  it('S8: an own recovery that failed to send does not survive a new outage of that session', () => {
    turn('marveen', loginEntry(), { session_id: 'a' })
    writeFileSync(join(tmp, 'notify-fail'), '')
    turn('marveen', normalEntry('vissza'), { session_id: 'a' })
    rmSync(join(tmp, 'notify-fail'))
    turn('marveen', loginEntry(), { session_id: 'a' })
    const p = join(tmp, 'store', 'login-alert-state.json')
    const st = state()
    st.marveen.sessions.a -= 61 * 60
    writeFileSync(p, JSON.stringify(st))
    turn('marveen', normalEntry('másik munkamenet'), { session_id: 'b' })
    expect(notifyLog().at(-1)).toMatch(/^VALÓSZÍNŰLEG HELYREÁLLT: /)
  })

  it('another API error during an outage is no recovery (E1): transcript line and payload text are the same error', () => {
    turn('marveen', loginEntry())
    turn('marveen', { type: 'assistant', isApiErrorMessage: true, error: 'overloaded',
      message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } },
      { last_assistant_message: 'API Error: 529 Overloaded' })
    turn('marveen', loginEntry(), { last_assistant_message: 'API Error: 500 Internal server error' })
    expect(notifyLog()).toHaveLength(1)
    expect(state().marveen).toBeDefined()
  })

  it('a StopFailure without session_id keys the same session as its transcript file name', () => {
    const t = transcriptFor('marveen')
    const sid = 'abc-123'
    const t2 = join(t, '..', `${sid}.jsonl`)
    writeFileSync(t2, '')
    const r = spawnSync('python3', ['-I', '-S', hook], { input: JSON.stringify({ hook_event_name: 'StopFailure', transcript_path: t2, cwd: tmp, error: 'authentication_failed' }), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(Object.keys(state().marveen.sessions)).toEqual([sid])
    turn('marveen', normalEntry('bent vagyok'), { session_id: sid })
    expect(notifyLog()[1]).toMatch(/^HELYREÁLLT: /)
  })

  it('a failed "recovered" send is kept and retried on the next normal turn', () => {
    turn('marveen', loginEntry())
    writeFileSync(join(tmp, 'notify-fail'), '')
    turn('marveen', normalEntry('vissza'))
    expect(state().marveen).toBeDefined()
    rmSync(join(tmp, 'notify-fail'))
    turn('marveen', normalEntry('vissza megint'))
    const log = notifyLog()
    expect(log).toHaveLength(2)
    expect(log[1]).toMatch(/^HELYREÁLLT: /)
    expect(state().marveen).toBeUndefined()
  })

  it('the turn\'s own last_assistant_message wins over a transcript tail that still ends on the error line', () => {
    turn('marveen', loginEntry())
    turn('marveen', loginEntry(), { last_assistant_message: 'Megvan, itt az eredmény.' })
    expect(notifyLog()).toHaveLength(2)
    expect(notifyLog()[1]).toMatch(/^HELYREÁLLT: /)
  })

  it('the bot token never reaches the hook output or the state file; a broken payload is a silent exit 0', () => {
    const r = turn('marveen', loginEntry())
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
    expect(readFileSync(join(tmp, 'store', 'login-alert-state.json'), 'utf-8')).not.toContain(TOKEN)
    const bad = spawnSync('python3', ['-I', '-S', hook], { input: 'not json', encoding: 'utf-8' })
    expect(bad.status).toBe(0)
    expect(bad.stdout).toBe('')
  })
})

describe('LOGINKIESES1119: wiring', () => {
  const project = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8')).hooks
  const template = JSON.parse(readFileSync(join(REPO, 'templates', 'settings.json.template'), 'utf-8')
    .replace(/\{\{PROJECT_ROOT\}\}/g, '/install')).hooks
  const has = (hooks: any, event: string) => (hooks[event] ?? []).some((e: any) =>
    (e.hooks ?? []).some((h: any) => String(h.command).includes('scripts/hooks/login-lost-alert.py')))

  it('the main agent gets it on Stop and StopFailure (project settings)', () => {
    expect(has(project, 'Stop')).toBe(true)
    expect(has(project, 'StopFailure')).toBe(true)
  })

  it('every seeded and existing sub-agent gets it on Stop and StopFailure (template, merged by ensureAgentHooks)', () => {
    expect(has(template, 'Stop')).toBe(true)
    expect(has(template, 'StopFailure')).toBe(true)
  })
})
