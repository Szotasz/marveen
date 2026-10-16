import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsPermissionDialog } from '../pane-state.js'
import {
  DEFAULT_PERMISSION_ALERT_MARKS,
  DEFAULT_PERMISSION_REMINDER_MARKS_MS,
  parsePermissionAlertMarks,
  permissionReminderDueAt,
  permissionPromptAsk,
  permissionPromptIdentity,
  decidePermissionReminder,
  formatPermissionPromptAlert,
  humanWaitHu,
  nextPermissionPromptAlert,
  runPermissionPromptPass,
  clearPermissionPromptAlert,
  resetPermissionPromptAlerts,
} from '../web/permission-prompt-alert.js'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'pane', name), 'utf-8')

const MIN = 60 * 1000
const HOUR = 60 * MIN

// The shape that produced the measured flood: an Edit on a file under
// ~/.claude, which --dangerously-skip-permissions does not cover.
// Two captures of ONE prompt, shaped after a live pane (CLI 2.1.110; the diff
// is replaced with filler): what the screen shows, and the same with scrollback.
const EDIT_PROMPT = fixture('permission-prompt-edit-own-config.txt')
const EDIT_PROMPT_DEEP = fixture('permission-prompt-edit-own-config-scrollback.txt')
const BASH_PROMPT = fixture('permission-prompt-bash-grep.txt')

describe('the fixture is a real permission prompt', () => {
  it('is recognised by the detector the monitor branches on', () => {
    expect(detectsPermissionDialog(EDIT_PROMPT)).toBe(true)
  })

  it('the visible pane does NOT carry the path -- the diff pushed it off screen', () => {
    expect(EDIT_PROMPT).not.toContain('Edit file')
    expect(EDIT_PROMPT_DEEP).toContain('Edit file')
  })
})

describe('permissionPromptAsk: what is being asked', () => {
  it('with scrollback, an edit prompt names the file by its path', () => {
    expect(permissionPromptAsk(EDIT_PROMPT, EDIT_PROMPT_DEEP)).toBe('Edit file: ../.claude/skills/example-skill/SKILL.md')
  })

  it('without scrollback, the question line is all there is', () => {
    expect(permissionPromptAsk(EDIT_PROMPT)).toBe('Do you want to make this edit to SKILL.md?')
  })

  it('reads the LAST question: scrollback may quote the same words earlier', () => {
    const deep = '● The prompt said: Do you want to make this edit to OTHER.md?\n\n' + EDIT_PROMPT_DEEP
    expect(permissionPromptAsk(EDIT_PROMPT, deep)).toBe('Edit file: ../.claude/skills/example-skill/SKILL.md')
  })

  it('a rule that is not a card header is not mistaken for one', () => {
    // Scrollback cut short: the nearest rule above the question belongs to
    // something else, so the header guard must fall back to the question.
    const cut = '────────────────────\n some transcript sentence that is not a title.\n more text\n' + EDIT_PROMPT
    expect(permissionPromptAsk(EDIT_PROMPT, cut)).toBe('Do you want to make this edit to SKILL.md?')
  })

  it('a tool card with a reason block uses the card summary', () => {
    const ask = permissionPromptAsk(BASH_PROMPT)
    expect(ask).not.toBeNull()
    expect(ask).toContain(' -- ')
  })

  it('a "Create file" card names the path too (the other measured file card)', () => {
    const create = EDIT_PROMPT_DEEP.replace(' Edit file', ' Create file').replace('make this edit to SKILL.md', 'create SKILL.md')
    expect(permissionPromptAsk(EDIT_PROMPT, create)).toBe('Create file: ../.claude/skills/example-skill/SKILL.md')
  })

  it('a bare "Do you want to proceed?" adds nothing, so there is no quote', () => {
    expect(permissionPromptAsk(' Bash command\n\n Do you want to proceed?\n ❯ 1. Yes\n   3. No\n')).toBeNull()
  })

  it('nothing readable -> null, and the alert stays usable', () => {
    expect(permissionPromptAsk(null)).toBeNull()
    expect(permissionPromptAsk('')).toBeNull()
    const text = formatPermissionPromptAlert('Suzy', 'suzy-channels', null, 10 * MIN, 20 * MIN)
    expect(text).toContain('tmux attach -t suzy-channels')
    expect(text).not.toContain('Ezt kérdezi')
  })

  it('caps a runaway question', () => {
    const long = ` Do you want to make this edit to ${'a'.repeat(150)}?`
    const ask = permissionPromptAsk(long) as string
    expect(ask.length).toBeLessThanOrEqual(260)
  })
})

// Feed the decision the way the monitor does: once per 5-minute dedup window.
function runTicks(untilMs: number, marks?: readonly number[], id = 'q'): number[] {
  let state: ReturnType<typeof decidePermissionReminder>['next'] | undefined
  const sentAt: number[] = []
  for (let now = 0; now <= untilMs; now += 5 * MIN) {
    const d = decidePermissionReminder(state, id, now, marks)
    state = d.next
    if (d.send) sentAt.push(now / MIN)
  }
  return sentAt
}

describe('parsePermissionAlertMarks: the configurable schedule', () => {
  it('the shipped default is 10 min, 30 min, 1 h, 2 h, 8 h, 24 h', () => {
    expect(DEFAULT_PERMISSION_ALERT_MARKS).toBe('10m,30m,1h,2h,8h,24h')
    expect(DEFAULT_PERMISSION_REMINDER_MARKS_MS.map((m) => m / MIN)).toEqual([10, 30, 60, 120, 480, 1440])
  })

  it('empty means the default, and is not an error', () => {
    expect(parsePermissionAlertMarks('')).toEqual({ marks: [...DEFAULT_PERMISSION_REMINDER_MARKS_MS], valid: true })
    expect(parsePermissionAlertMarks(undefined).valid).toBe(true)
  })

  it('reads s, m, h and d', () => {
    expect(parsePermissionAlertMarks('90s,2m,3h,4d').marks).toEqual([90 * 1000, 2 * MIN, 3 * HOUR, 4 * 24 * HOUR])
  })

  it('a bare number is minutes, as in the /model hold', () => {
    expect(parsePermissionAlertMarks('15,1h').marks).toEqual([15 * MIN, HOUR])
  })

  it('sorts, drops duplicates (60m is 1h), tolerates spaces and case', () => {
    expect(parsePermissionAlertMarks(' 1H, 5m ,60m; 15M ').marks.map((m) => m / MIN)).toEqual([5, 15, 60])
  })

  it('1d and 24h are the same mark', () => {
    expect(parsePermissionAlertMarks('10m,1d').marks).toEqual(parsePermissionAlertMarks('10m,24h').marks)
  })

  it('0 as the first mark is allowed', () => {
    expect(parsePermissionAlertMarks('0,30m').marks).toEqual([0, 30 * MIN])
  })

  it.each(['abc', '10m,x,30m', '-5m,10m', '0', '1.5h', '10w', '10m,31d'])('rejects %s whole and falls back to the default', (raw) => {
    const r = parsePermissionAlertMarks(raw)
    expect(r.valid).toBe(false)
    expect(r.marks).toEqual([...DEFAULT_PERMISSION_REMINDER_MARKS_MS])
  })
})

// Review of #1907: on a Bash card the line under the header is the command, and
// the ask quoted it -- token and all -- into an alert that goes to a chat
// channel. The card below is the shape the review used (synthetic: no capture
// of a reason-less Bash card exists), with a literal token in the command.
describe('a command line never reaches the alert', () => {
  const RULE = '─'.repeat(60)
  const TOKEN = 'sk-live-AAAABBBBCCCCDDDD'
  const BASH_NO_REASON = [
    '● I will call the API now.',
    '',
    RULE,
    ' Bash command',
    '',
    `   curl -s -H "Authorization: Bearer ${TOKEN}" https://example.invalid/x`,
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for curl commands in /srv/app",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel',
  ].join('\n')

  it('the fixture is a permission prompt', () => {
    expect(detectsPermissionDialog(BASH_NO_REASON)).toBe(true)
  })

  it('the ask is the card header alone', () => {
    expect(permissionPromptAsk(BASH_NO_REASON)).toBe('Bash command')
  })

  it.each(['password=hunter2 ./deploy.sh', 'mysql -u root:s3cret db', 'export TOKEN=abc123 && run', 'rm -rf ./build'])(
    'whatever the command is, none of it is quoted: %s',
    (command) => {
      const card = BASH_NO_REASON.replace(/   curl .*/, `   ${command}`)
      expect(permissionPromptAsk(card)).toBe('Bash command')
    },
  )

  it('the message that would be sent carries no part of the command', () => {
    resetPermissionPromptAlerts()
    const text = nextPermissionPromptAlert('Suzy', 'suzy-channels', BASH_NO_REASON, BASH_NO_REASON, 0, [0, 30 * MIN]) as string
    expect(text).toContain('Ezt kérdezi: „Bash command”')
    for (const leaked of [TOKEN, 'Bearer', 'curl', 'example.invalid', 'Authorization']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('two different commands are still two questions (the command is compared, never sent)', () => {
    const other = BASH_NO_REASON.replace('example.invalid/x', 'example.invalid/y')
    expect(permissionPromptIdentity(BASH_NO_REASON)).not.toBe(permissionPromptIdentity(other))
  })

  it('only a "<Verb> file" card has its second line quoted', () => {
    const fileCard = BASH_NO_REASON.replace(' Bash command', ' Edit file').replace(/   curl .*/, ' src/app.ts').replace('proceed?', 'make this edit to app.ts?')
    expect(permissionPromptAsk(fileCard)).toBe('Edit file: src/app.ts')
  })
})

describe('decidePermissionReminder: one question, thinning reminders', () => {
  it('the first sighting only starts the clock', () => {
    const d = decidePermissionReminder(undefined, 'q', 1000)
    expect(d.send).toBe(false)
    expect(d.next).toEqual({ id: 'q', firstSeenAt: 1000, sent: 0 })
  })

  it('a prompt answered inside ten minutes never produces a message', () => {
    expect(runTicks(5 * MIN)).toEqual([])
  })

  it('speaks at each mark, then once per last-mark period', () => {
    expect(runTicks(80 * HOUR)).toEqual([10, 30, 60, 120, 480, 1440, 2880, 4320])
  })

  it('the measured incident (04:19 -> 12:14, 95 ticks) is 4 messages, not 95', () => {
    expect(runTicks(94 * 5 * MIN)).toHaveLength(4)
  })

  it('a DIFFERENT question starts its own clock', () => {
    let state = decidePermissionReminder(undefined, 'q1', 0).next
    state = decidePermissionReminder(state, 'q1', 10 * MIN).next
    expect(state.sent).toBe(1)
    const d = decidePermissionReminder(state, 'q2', 15 * MIN)
    expect(d.send).toBe(false)
    expect(d.next).toEqual({ id: 'q2', firstSeenAt: 15 * MIN, sent: 0 })
    expect(decidePermissionReminder(d.next, 'q2', 25 * MIN).send).toBe(true)
  })

  it('a message reports the age and the distance to the next mark', () => {
    const first = decidePermissionReminder(undefined, 'q', 0)
    const d = decidePermissionReminder(first.next, 'q', 10 * MIN)
    expect(d.send).toBe(true)
    if (d.send) {
      expect(d.waitingMs).toBe(10 * MIN)
      expect(d.nextGapMs).toBe(20 * MIN)
    }
  })

  it('marks missed while nobody looked cost ONE message, not a burst', () => {
    const first = decidePermissionReminder(undefined, 'q', 0)
    const late = decidePermissionReminder(first.next, 'q', 3 * HOUR)
    expect(late.send).toBe(true)
    expect(late.next.sent).toBe(4) // 10 min, 30 min, 1 h and 2 h are all behind us
    expect(decidePermissionReminder(late.next, 'q', 3 * HOUR + 5 * MIN).send).toBe(false)
    expect(decidePermissionReminder(late.next, 'q', 8 * HOUR).send).toBe(true)
  })

  it('a clock stepped backwards restarts the clock instead of stalling', () => {
    const first = decidePermissionReminder(undefined, 'q', 10 * HOUR)
    const skewed = decidePermissionReminder(first.next, 'q', 1 * HOUR)
    expect(skewed.send).toBe(false)
    expect(skewed.next.firstSeenAt).toBe(1 * HOUR)
    expect(decidePermissionReminder(skewed.next, 'q', 1 * HOUR + 10 * MIN).send).toBe(true)
  })

  it('a configured schedule is honoured, and its last mark is the repeat period', () => {
    const marks = parsePermissionAlertMarks('0,15m').marks
    expect(runTicks(60 * MIN, marks)).toEqual([0, 15, 30, 45, 60])
    expect(permissionReminderDueAt(4, marks)).toBe(45 * MIN)
  })
})

describe('the message', () => {
  it('quotes the question, says how long it has stood and when the next one comes', () => {
    const text = formatPermissionPromptAlert('Suzy', 'suzy-channels', 'Edit file: ../.claude/skills/example-skill/SKILL.md', 10 * MIN, 20 * MIN)
    expect(text).toContain('Ezt kérdezi: „Edit file: ../.claude/skills/example-skill/SKILL.md”')
    expect(text).toContain('10 perce vár válaszra')
    expect(text).toContain('20 perc múlva szólok újra')
  })

  it('whole hours read as hours', () => {
    const text = formatPermissionPromptAlert('Suzy', 'suzy-channels', null, 8 * HOUR, 16 * HOUR)
    expect(text).toContain('8 órája vár válaszra')
    expect(text).toContain('16 óra múlva szólok újra')
  })

  it('an immediate message (first mark 0) does not claim a wait', () => {
    const text = formatPermissionPromptAlert('Suzy', 'suzy-channels', null, 0, 15 * MIN)
    expect(text).not.toContain('vár válaszra')
    expect(text).toContain('15 perc múlva szólok újra')
  })

  it('humanWaitHu rounds to the minute', () => {
    expect(humanWaitHu(30 * MIN)).toBe('30 perce')
    expect(humanWaitHu(2 * HOUR)).toBe('2 órája')
    expect(humanWaitHu(150 * MIN)).toBe('2 óra 30 perce')
  })
})

describe('permissionPromptIdentity: telling two prompts apart', () => {
  it('two edits of the same file are two questions', () => {
    const second = EDIT_PROMPT_DEEP.replace('new line 3 of the skill text', 'a different replacement')
    expect(second).not.toBe(EDIT_PROMPT_DEEP)
    expect(permissionPromptAsk(EDIT_PROMPT, second)).toBe(permissionPromptAsk(EDIT_PROMPT, EDIT_PROMPT_DEEP))
    expect(permissionPromptIdentity(EDIT_PROMPT, second)).not.toBe(permissionPromptIdentity(EDIT_PROMPT, EDIT_PROMPT_DEEP))
  })

  it('transcript above the card does not change the identity', () => {
    const more = '● an unrelated earlier line\n' + EDIT_PROMPT_DEEP
    expect(permissionPromptIdentity(EDIT_PROMPT, more)).toBe(permissionPromptIdentity(EDIT_PROMPT, EDIT_PROMPT_DEEP))
  })

  it('a terminal resize does not make it a new question', () => {
    // What tmux does to the card when a wider or narrower client attaches:
    // rules change width, and a wrapped diff line repeats its +/- marker on
    // the continuation.
    const rewrap = (pane: string, width: number) => pane.split('\n').flatMap((line) => {
      if (/^\s*[─╌]{8,}\s*$/.test(line)) return [line.trim()[0].repeat(width)]
      if (line.length <= width) return [line]
      const marker = /^\s*\d+ ([+-])/.exec(line)?.[1] ?? ' '
      return [line.slice(0, width), `     ${marker}${line.slice(width)}`]
    }).join('\n')
    const narrow = rewrap(EDIT_PROMPT_DEEP, 60)
    const wide = rewrap(EDIT_PROMPT_DEEP, 160)
    expect(narrow).not.toBe(EDIT_PROMPT_DEEP)
    expect(narrow.split('\n').length).toBeGreaterThan(EDIT_PROMPT_DEEP.split('\n').length)
    const id = permissionPromptIdentity(EDIT_PROMPT, EDIT_PROMPT_DEEP)
    expect(permissionPromptIdentity(EDIT_PROMPT, narrow)).toBe(id)
    expect(permissionPromptIdentity(EDIT_PROMPT, wide)).toBe(id)
  })

  it('no prompt -> empty identity', () => {
    expect(permissionPromptIdentity('❯ \n')).toBe('')
  })
})

describe('nextPermissionPromptAlert: the monitor-facing half', () => {
  beforeEach(() => resetPermissionPromptAlerts())
  const NOW_MARKS = parsePermissionAlertMarks('0,30m').marks
  const ask = (session: string, deep: string, now: number, marks?: readonly number[]) =>
    nextPermissionPromptAlert(session === 'suzy-channels' ? 'Suzy' : 'Alfa', session, EDIT_PROMPT, deep, now, marks)

  it('default schedule: silent on sight, speaks at ten minutes with the path, then waits for the next mark', () => {
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 0, DEFAULT_PERMISSION_REMINDER_MARKS_MS)).toBeNull()
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 5 * MIN, DEFAULT_PERMISSION_REMINDER_MARKS_MS)).toBeNull()
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 10 * MIN, DEFAULT_PERMISSION_REMINDER_MARKS_MS)).toContain('Ezt kérdezi: „Edit file: ../.claude/skills/example-skill/SKILL.md”')
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 15 * MIN, DEFAULT_PERMISSION_REMINDER_MARKS_MS)).toBeNull()
  })

  it('a second, different edit of the same file is a new question', () => {
    const second = EDIT_PROMPT_DEEP.replace('new line 3 of the skill text', 'a different replacement')
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 0, NOW_MARKS)).not.toBeNull()
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 5 * MIN, NOW_MARKS)).toBeNull()
    expect(ask('suzy-channels', second, 6 * MIN, NOW_MARKS)).not.toBeNull()
  })

  it('two sessions do not silence each other', () => {
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 0, NOW_MARKS)).not.toBeNull()
    expect(ask('agent-alfa', EDIT_PROMPT_DEEP, 1 * MIN, NOW_MARKS)).not.toBeNull()
  })

  it('once the spell is cleared, the same prompt is a new question', () => {
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 0, NOW_MARKS)).not.toBeNull()
    clearPermissionPromptAlert('suzy-channels')
    expect(ask('suzy-channels', EDIT_PROMPT_DEEP, 5 * MIN, NOW_MARKS)).not.toBeNull()
  })
})

// What the menu pass does for a parked permission prompt, end to end, with the
// two things it touches stubbed: the scrollback capture and the alert sink.
// Review of #1907 applied four mutations at the call site and the suite stayed
// green on all of them; each has a case here, and the call site itself is
// pinned in the last block.
describe('runPermissionPromptPass: the behaviour of the menu pass branch', () => {
  beforeEach(() => resetPermissionPromptAlerts())

  function harness(deep: string | null = EDIT_PROMPT_DEEP) {
    const sent: string[] = []
    const captured: string[] = []
    const deps = {
      captureWithHistory: (session: string) => { captured.push(session); return deep },
      send: (text: string) => { sent.push(text) },
    }
    const pass = (now: number, marks: readonly number[] = DEFAULT_PERMISSION_REMINDER_MARKS_MS) =>
      runPermissionPromptPass('Suzy', 'suzy-channels', EDIT_PROMPT, deps, now, marks)
    return { sent, captured, pass }
  }

  it('one alert at the first mark, none inside the window, one at the next mark', () => {
    const h = harness()
    expect(h.pass(0)).toBe(false)
    expect(h.pass(5 * MIN)).toBe(false)
    expect(h.sent).toHaveLength(0)

    expect(h.pass(10 * MIN)).toBe(true)
    expect(h.sent).toHaveLength(1)

    expect(h.pass(15 * MIN)).toBe(false)
    expect(h.pass(20 * MIN)).toBe(false)
    expect(h.pass(25 * MIN)).toBe(false)
    expect(h.sent).toHaveLength(1)

    expect(h.pass(30 * MIN)).toBe(true)
    expect(h.sent).toHaveLength(2)
  })

  it('never alerting is a failure, not a quiet success', () => {
    const h = harness()
    for (let t = 0; t <= 24 * HOUR; t += 5 * MIN) h.pass(t)
    expect(h.sent.length).toBe(6) // 10 min, 30 min, 1 h, 2 h, 8 h, 24 h
  })

  it('alerting on every pass is the flood again', () => {
    const h = harness()
    let passes = 0
    for (let t = 0; t < 8 * HOUR; t += 5 * MIN) { h.pass(t); passes++ }
    expect(passes).toBe(96)
    expect(h.sent.length).toBe(4)
  })

  it('reads the card WITH scrollback: the path is above the diff, off the visible pane', () => {
    const h = harness()
    h.pass(0, [0, 30 * MIN])
    expect(h.captured).toEqual(['suzy-channels'])
    expect(h.sent[0]).toContain('Ezt kérdezi: „Edit file: ../.claude/skills/example-skill/SKILL.md”')
  })

  it('with only the visible pane the alert could not name the file', () => {
    const h = harness(EDIT_PROMPT)
    h.pass(0, [0, 30 * MIN])
    expect(h.sent[0]).toContain('Do you want to make this edit to SKILL.md?')
    expect(h.sent[0]).not.toContain('example-skill')
  })

  it('a failed scrollback capture falls back to the visible pane instead of going silent', () => {
    const h = harness(null)
    expect(h.pass(0, [0, 30 * MIN])).toBe(true)
    expect(h.sent).toHaveLength(1)
  })

  it('after the prompt clears nothing is sent, and a later prompt starts its own clock', () => {
    const h = harness()
    h.pass(0)
    h.pass(10 * MIN)
    expect(h.sent).toHaveLength(1)

    // The owner answers; the menu spell ends and the monitor forgets the prompt.
    clearPermissionPromptAlert('suzy-channels')

    // The same edit is asked again two hours later. Without the clear it would
    // inherit the old clock: 2 h is past four marks, so it would alert at once.
    expect(h.pass(2 * HOUR)).toBe(false)
    expect(h.pass(2 * HOUR + 5 * MIN)).toBe(false)
    expect(h.sent).toHaveLength(1)
    expect(h.pass(2 * HOUR + 10 * MIN)).toBe(true)
    expect(h.sent).toHaveLength(2)
  })
})

describe('channel-monitor is wired to it', () => {
  const MONITOR = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  const branch = MONITOR.slice(
    MONITOR.indexOf('detectsPermissionDialog(paneNow)'),
    MONITOR.indexOf("'Session parked in a blocking interactive menu -- sending Escape to recover'"),
  )

  it('the permission branch exists and is the slice under test', () => {
    expect(branch.length).toBeGreaterThan(200)
    expect(branch).toContain('PERMDENY905')
  })

  it('it runs the pass with the scrollback capture and the real alert sink', () => {
    expect(branch).toMatch(/runPermissionPromptPass\(label, t\.session, paneNow, \{ captureWithHistory: capturePaneWithHistory, send: sendAlert \}\)/)
  })

  it('it sends nothing itself: no second alert path beside the pass, and no keystroke', () => {
    expect(branch).not.toMatch(/sendAlert\(`/)
    expect(branch).not.toMatch(/sendRoutineAlert\(/)
    expect(branch).not.toMatch(/send-keys/)
  })

  it('the end of the menu spell forgets the prompt', () => {
    expect(MONITOR).toMatch(/if \(decision\.next\.firstSeenAt === null\) \{\s*paneMenuState\.delete\(t\.session\)[\s\S]{0,160}clearPermissionPromptAlert\(t\.session\)/)
  })
})
