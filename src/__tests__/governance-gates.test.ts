import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as selfPaceDecision, stripDataPayloads, stripGitCommitMessages } from '../../scripts/self-pace-gate.mjs'
import {
  agentGetsGovernanceGates,
  injectSelfPaceGate,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

// --- self-pace-gate: blocks the agent from scheduling its own future turns ---
describe('self-pace-gate gateDecision', () => {
  it('denies the ScheduleWakeup runtime tool', () => {
    expect(selfPaceDecision('ScheduleWakeup', { prompt: 'x' }).deny).toBe(true)
  })
  it('denies CronCreate / CronDelete / CronList / RemoteTrigger', () => {
    for (const t of ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) {
      expect(selfPaceDecision(t, {}).deny).toBe(true)
    }
  })
  it('denies tmux pane injection: send-keys / paste-buffer / run-shell / set-buffer', () => {
    for (const sub of ['send-keys -t agent-dev2 Enter', 'paste-buffer -t agent-dev2', 'run-shell "claude -p hi"', 'set-buffer "x"']) {
      expect(selfPaceDecision('Bash', { command: `tmux ${sub}` }).deny).toBe(true)
    }
  })
  it('denies tmux injection split across a newline (no [^newline] escape hatch)', () => {
    expect(selfPaceDecision('Bash', { command: 'tmux \\\n  send-keys -t agent-dev2 Enter' }).deny).toBe(true)
  })
  it('denies OS-level schedulers: crontab / at / launchctl', () => {
    expect(selfPaceDecision('Bash', { command: '(crontab -l; echo "*/5 * * * * claude -p poll") | crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "claude -p go" | at now + 5 minutes' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl submit -l self -- node respawn.mjs' }).deny).toBe(true)
  })
  it('denies nohup/setsid self-respawn of claude', () => {
    expect(selfPaceDecision('Bash', { command: 'nohup claude -p "keep going" &' }).deny).toBe(true)
  })
  it('does NOT misfire "at" on a substring (netstat / cat)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat file.txt && netstat -an' }).deny).toBe(false)
  })
  it('denies a WRITE to the self-schedule store (redirect)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "{}" > ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('ALLOWS a read-only inspection of the self-schedule store (F4)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep poll ~/.claude/scheduled_tasks.json' }).deny).toBe(false)
  })
  it('denies a WRITE method to the dashboard schedule API', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -X POST http://localhost:3420/api/schedules -d @x.json' }).deny).toBe(true)
  })
  it('ALLOWS a GET read of the schedule API (F2 -- diagnostics, not self-pace)', () => {
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules/pending' }).deny).toBe(false)
  })
  it('denies writing the schedule store via the native Write/Edit tool (F5)', () => {
    expect(selfPaceDecision('Write', { file_path: '/home/agent/.claude/scheduled_tasks.json', content: '{}' }).deny).toBe(true)
    expect(selfPaceDecision('Edit', { file_path: '~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('denies a shell-driven /loop', () => {
    expect(selfPaceDecision('Bash', { command: 'claude /loop "keep polling"' }).deny).toBe(true)
  })
  it('ALLOWS a normal Bash command', () => {
    expect(selfPaceDecision('Bash', { command: 'git status && ls -la' }).deny).toBe(false)
  })
  it('ALLOWS a legitimate inter-agent message (not self-schedule)', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -X POST http://localhost:3420/api/messages -d \'{"to":"dev4"}\'' }).deny).toBe(false)
  })
  it('ALLOWS read-only tools', () => {
    expect(selfPaceDecision('Read', {}).deny).toBe(false)
    expect(selfPaceDecision('Grep', {}).deny).toBe(false)
  })
})

// --- stripDataPayloads: a curl -d/--data body is DATA sent over the wire, never
// a shell invocation, so a trigger token INSIDE the payload must not false-deny a
// legit dispatch. Only provably-literal payloads are blanked; a payload that can
// command-substitute ($(...)/backtick) is kept so a real substitution still trips. ---
describe('self-pace-gate stripDataPayloads (data-payload false-positive guard)', () => {
  it('blanks a single-quoted -d payload but keeps the flag', () => {
    expect(stripDataPayloads(`curl -d '{"x":"/api/schedules"}' u`)).toBe(`curl -d '' u`)
  })
  it('blanks a double-quoted -d payload without substitution', () => {
    expect(stripDataPayloads(`curl -d "{tmux send-keys}" u`)).toBe(`curl -d "" u`)
  })
  it("blanks an ANSI-C $'...' payload", () => {
    expect(stripDataPayloads(`curl -d $'{"a":"/loop"}' u`)).toBe(`curl -d '' u`)
  })
  it('KEEPS a payload that can command-substitute ($(...))', () => {
    const cmd = `curl -d "$(crontab -r)" u`
    expect(stripDataPayloads(cmd)).toBe(cmd)
  })
  it('KEEPS a payload with a backtick substitution', () => {
    const cmd = 'curl -d "`crontab -r`" u'
    expect(stripDataPayloads(cmd)).toBe(cmd)
  })
  it('handles --data / --data-raw / --data-binary / --data-urlencode long forms', () => {
    for (const flag of ['--data', '--data-raw', '--data-binary', '--data-urlencode']) {
      expect(stripDataPayloads(`curl ${flag} '/api/schedules' u`)).toBe(`curl ${flag} '' u`)
    }
  })
  it('supports the --data=VALUE equals form', () => {
    expect(stripDataPayloads(`curl --data='{"/loop":1}' u`)).toBe(`curl --data='' u`)
  })
  it('leaves URL/method args outside the payload untouched', () => {
    expect(stripDataPayloads(`curl -X POST /api/schedules -d '{}'`)).toBe(`curl -X POST /api/schedules -d ''`)
  })
  it('is a no-op when there is no -d/--data flag', () => {
    expect(stripDataPayloads('git status && ls -la')).toBe('git status && ls -la')
  })
  it('matches bash single-quote parsing: backslash is literal, first quote closes', () => {
    // bash: the -d value is `x\`; a C-style escape regex would scan PAST the real
    // closing quote and blank the out-of-band `; crontab -r`.
    expect(stripDataPayloads(`curl -d 'x\\' ; crontab -r`)).toBe(`curl -d '' ; crontab -r`)
  })
})

// --- integration: the payload-blanking must NOT weaken real WRITE/substitution
// detection; only the false-deny on a legit dispatch body is removed ---
describe('self-pace-gate: data-payload guard does not weaken real detection', () => {
  it('ALLOWS a dispatch whose JSON body merely MENTIONS /api/schedules', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/messages -d '{"to":"dev4","content":"please read the /api/schedules docs"}'` }).deny).toBe(false)
  })
  it('ALLOWS a dispatch body mentioning tmux send-keys / scheduled_tasks.json / /loop as text', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/messages -d '{"to":"dev3","content":"the tmux send-keys path writes scheduled_tasks.json on /loop"}'` }).deny).toBe(false)
  })
  it('STILL denies a real WRITE to /api/schedules (URL/method live outside the payload)', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/schedules -d '{"schedule":"*/5 * * * *"}'` }).deny).toBe(true)
  })
  it('STILL denies a command-substitution payload ($(...) is kept, not blanked)', () => {
    expect(selfPaceDecision('Bash', { command: `curl -d "$(crontab -r)" http://x` }).deny).toBe(true)
  })
  it('STILL denies a blocked binary outside the payload after a separator', () => {
    expect(selfPaceDecision('Bash', { command: `curl -d '{}' http://x ; crontab -r` }).deny).toBe(true)
  })
  it('STILL denies a self-pace after a bash single-quote close (backslash-literal parity)', () => {
    // regression for the C-vs-bash single-quote desync: the -d value is `x\`, then
    // the real `; <blocked>` executes -- must still deny for every self-pace route.
    for (const tail of ['crontab -r', "tmux send-keys -t s 'go' Enter", 'curl -X POST http://h/api/schedules', 'claude /loop 5m foo']) {
      expect(selfPaceDecision('Bash', { command: `curl -d 'x\\' ; ${tail} ; echo 'z'` }).deny).toBe(true)
    }
  })
})

// --- compound-command false-positives: a token in one segment must NOT trip a
// check anchored in another (per-segment matching -- round-2 hardening) ---
describe('self-pace-gate compound-command false-positives', () => {
  it('ALLOWS a store read followed by an unrelated cp/mv in another segment', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json && cp other.txt backup.txt' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep poll scheduled_tasks.json; mv a.log b.log' }).deny).toBe(false)
  })
  it('ALLOWS a schedule-API GET with an unrelated -d flag in another segment', () => {
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules && date -d yesterday' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules | grep -d' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'ls -d */ && curl http://localhost:3420/api/schedules' }).deny).toBe(false)
  })
  it('ALLOWS "batch"/"crontab" as a word in a script name or commit message', () => {
    expect(selfPaceDecision('Bash', { command: 'npm run batch:migrate' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'git commit -m "add batch endpoint + crontab docs"' }).deny).toBe(false)
  })
  it('ALLOWS a legit tmux read with the injected word merely mentioned elsewhere', () => {
    expect(selfPaceDecision('Bash', { command: 'tmux list-sessions && echo "send-keys docs"' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'tmux ls && grep send-keys notes.md' }).deny).toBe(false)
  })
  it('STILL denies the real binary when it IS the command in a segment', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "claude -p go" | at now + 5 minutes' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'ls; tmux send-keys -t agent-dev2 Enter' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo cmd | batch' }).deny).toBe(true)
  })
  it('ALLOWS at/batch as a shell variable assignment, not the binary', () => {
    expect(selfPaceDecision('Bash', { command: 'at=$(git rev-parse HEAD); echo $at' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'start=1; batch=2; end=3' }).deny).toBe(false)
  })
  it('ALLOWS read-listing of schedulers (crontab -l / launchctl list / atq)', () => {
    expect(selfPaceDecision('Bash', { command: 'crontab -l' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'crontab -l | grep claude' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'launchctl list | grep agent' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'atq' }).deny).toBe(false)
  })
  it('STILL denies scheduler WRITE forms (crontab - / crontab -r / launchctl submit)', () => {
    expect(selfPaceDecision('Bash', { command: '(crontab -l; echo job) | crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'crontab -r' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl submit -l self -- node x.mjs' }).deny).toBe(true)
  })
  it('denies scheduler WRITE behind a sudo/env/PATH/absolute-path wrapper', () => {
    expect(selfPaceDecision('Bash', { command: 'sudo crontab -r' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: '/usr/bin/at now + 1 minute' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'PATH=/usr/bin crontab cronfile' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'env crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'sudo launchctl bootstrap gui/501 x.plist' }).deny).toBe(true)
  })
  it('ALLOWS a wrapped scheduler READ, and a crontab-prefixed script name', () => {
    expect(selfPaceDecision('Bash', { command: 'sudo crontab -l' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: './scripts/crontab-helper.sh status' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'at=$(date +%s); echo $at' }).deny).toBe(false)
  })
})

// --- scaffold wiring: main-exempt + idempotent ---
describe('governance gate scaffold wiring', () => {
  it('applies to sub-agents, exempts the main agent', () => {
    expect(agentGetsGovernanceGates('dev2')).toBe(true)
    expect(agentGetsGovernanceGates('dev3')).toBe(true)
    expect(agentGetsGovernanceGates(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectSelfPaceGate is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectSelfPaceGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('self-pace-gate.mjs')).length).toBe(1)
  })
  it('the hook MATCHER fires on native file tools too (not just Bash)', () => {
    // Regression guard: gateDecision blocks a Write/Edit to the schedule store,
    // but that branch only runs in production if the hook MATCHER covers those
    // tool names. A Bash-only matcher would leave the native-file route open
    // while the unit test (which calls gateDecision directly) still passes.
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))
    const re = new RegExp(`^(?:${entry!.matcher})$`)
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'ScheduleWakeup', 'CronCreate']) {
      expect(re.test(t)).toBe(true)
    }
    expect(re.test('Read')).toBe(false)
  })
  it('self-pace gate survives a respawn re-run, and NO operator-gate is wired', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectSelfPaceGate(s) // respawn re-run
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    // operator-confirmation-gate is intentionally NOT wired: merge/deploy is
    // operator-authorized autonomously; the self-decide vector is covered above.
    expect(pre.some((e) => JSON.stringify(e).includes('operator-confirmation-gate.mjs'))).toBe(false)
  })
})


// --- stripGitCommitMessages: a `git commit -m` message is PROSE, never a shell
// invocation, so a trigger token inside it must not false-deny (2026-07-13 DrCode
// report: long commit blocked, short passed). Same literal-only quote handling as
// stripDataPayloads; a $()/backtick double-quoted message is kept so a REAL
// substitution stays gated. ---
describe('self-pace-gate stripGitCommitMessages (commit-message false-positive guard)', () => {
  it('blanks a single-quoted commit message', () => {
    expect(stripGitCommitMessages(`git commit -m 'batch queue; at offset'`)).toBe(`git commit -m ''`)
  })
  it('blanks a double-quoted commit message with trigger words', () => {
    expect(stripGitCommitMessages(`git commit -m "orchestration: tmux send-keys nem"`)).toBe(`git commit -m ""`)
  })
  it('keeps a $()-substituting double-quoted message intact (still gated downstream)', () => {
    const cmd = `git commit -m "$(crontab -r)"`
    expect(stripGitCommitMessages(cmd)).toBe(cmd)
  })
  it('leaves non-git -m flags untouched', () => {
    const cmd = `mkdir -m 755 dir`
    expect(stripGitCommitMessages(cmd)).toBe(cmd)
  })
  it('gateDecision: legit commit with trigger words in the message is ALLOWED', () => {
    expect(selfPaceDecision('Bash', { command: `git commit -m "ETA; at offset; batch observe"` }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: `git commit -m "gui token-auth /api/schedules read-only"` }).deny).toBe(false)
  })
  it('gateDecision: a REAL self-pace after the commit (outside the message) is still DENIED', () => {
    expect(selfPaceDecision('Bash', { command: `git commit -m "ok" ; crontab -r` }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: `git commit -m "$(crontab -r)"` }).deny).toBe(true)
  })
})
