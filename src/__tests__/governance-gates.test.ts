import { describe, it, expect, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as selfPaceDecision, stripDataPayloads, stripGitCommitMessages, stripHeredocBodies, stripProseArguments } from '../../scripts/self-pace-gate.mjs'
// newer exports read through the namespace, so this file still loads (and its
// cases fail one by one) against a gate that does not have them yet
// @ts-expect-error -- plain .mjs hook script, no types
import * as selfPaceGateModule from '../../scripts/self-pace-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashViolation, isExactInstall } from '../../scripts/readonly-repo-gate.mjs'
import {
  agentGetsGovernanceGates,
  agentGetsTelegramCopyGate,
  injectSelfPaceGate,
  injectTelegramCopyGate,
  TELEGRAM_COPY_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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
  // Regression (2026-07-25, found by JogAsz): splitSegments splits on NEWLINES, so
  // every prose line of a multi-line commit body became its own "segment". A line
  // starting with the English words "at" / "batch" then looked like the at(1) /
  // batch(1) binaries and false-denied a plain `git commit`. The `-m "$(...)"`
  // form is deliberately NOT blanked by stripGitCommitMessages (a real command
  // substitution could hide there), so the body does reach the splitter.
  it('does NOT misfire on PROSE starting with "at"/"batch" in a heredoc commit body', () => {
    const body = (line: string) => `git commit -m "$(cat <<'EOF'\nfix(lib): parser tweak\n\n${line}\nEOF\n)"`
    for (const line of [
      'at least 80% of parsed entries must carry a date',
      'at most 3 retries before giving up',
      'at runtime the parser reads the header',
      'at the same time we clear the cache',
      'batch size is 50 by default',
    ]) {
      expect(selfPaceDecision('Bash', { command: body(line) }).deny).toBe(false)
    }
  })
  it('STILL denies a real at/batch submit (timespec, flag, redirect, bare batch)', () => {
    for (const cmd of [
      'at now + 1 minute',
      'at 14:00',
      'at tomorrow',
      'at -f /tmp/x.sh now',
      'batch',
      'batch < /tmp/x.sh',
      'echo hi ; at now + 5 min',
      '/usr/bin/at now',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('STILL denies a real command substitution hidden in a commit message', () => {
    expect(selfPaceDecision('Bash', { command: 'git commit -m "$(crontab -r)"' }).deny).toBe(true)
    // unquoted heredoc delimiter DOES expand -> must stay caught
    expect(selfPaceDecision('Bash', { command: 'git commit -m "$(cat <<EOF\nfix\n$(at now)\nEOF\n)"' }).deny).toBe(true)
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
    // -q first: without it curl reads ~/.curlrc, which can turn the GET into a
    // write, so the bare form is no longer provably a read
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules/pending' }).deny).toBe(false)
  })
  it('denies writing the schedule store via the native Write/Edit tool (F5)', () => {
    expect(selfPaceDecision('Write', { file_path: '/home/agent/.claude/scheduled_tasks.json', content: '{}' }).deny).toBe(true)
    expect(selfPaceDecision('Edit', { file_path: '~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('denies a shell-driven /loop', () => {
    expect(selfPaceDecision('Bash', { command: 'claude /loop "keep polling"' }).deny).toBe(true)
  })
  // Two forms the slash-command-position match regressed on (upstream review,
  // 2026-07-27): both EXECUTE `claude /loop` in bash but the char before `/loop`
  // was `\` / end-of-`$IFS`, not in the [\s'"] class. Fixed by normalising the
  // segment (resolve `\X`->`X`, `$IFS`->space) before the pattern runs.
  it('denies a /loop hidden by a backslash-escaped slash (claude \\/loop)', () => {
    expect(selfPaceDecision('Bash', { command: 'claude \\/loop "keep polling"' }).deny).toBe(true)
  })
  it('denies a /loop hidden by $IFS word-splitting (claude$IFS/loop)', () => {
    expect(selfPaceDecision('Bash', { command: 'claude$IFS/loop 5m' }).deny).toBe(true)
  })
  it('denies the /lo\\op mid-token backslash form (side effect of the same fix)', () => {
    expect(selfPaceDecision('Bash', { command: 'claude /lo\\op' }).deny).toBe(true)
  })
  it('ALLOWS reading a memory path with a loop- prefix (normalisation keeps prose through)', () => {
    // `.claude` matches \bclaude\b and the name starts `loop-`, but `/loop` is not
    // in slash-command position (a `-` follows), so it must still pass.
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/memory/loop-stop-vs-truncation.md' }).deny).toBe(false)
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
describe('self-pace-gate stripHeredocBodies (quoted vs unquoted marker)', () => {
  // A heredoc body is data -- unless the shell will expand it. A quoted marker
  // is literal, an unquoted one is not, and blanking an unquoted body would
  // hide a live command substitution from the scheduler patterns. Reported on
  // PR #770; the gate-level assertion for the same hole lives above.
  const PROSE = 'at the same time we fixed the parser'

  it('blanks a QUOTED heredoc body (the false positive this strip exists for)', () => {
    const cmd = `git commit -F - <<'EOF'\n${PROSE}\nEOF`
    expect(stripHeredocBodies(cmd)).not.toContain(PROSE)
  })

  it('blanks a double-quoted marker too', () => {
    const cmd = `git commit -F - <<"EOF"\n${PROSE}\nEOF`
    expect(stripHeredocBodies(cmd)).not.toContain(PROSE)
  })

  it('blanks an UNQUOTED body that has nothing to expand', () => {
    const cmd = `git commit -F - <<EOF\n${PROSE}\nEOF`
    expect(stripHeredocBodies(cmd)).not.toContain(PROSE)
  })

  it('KEEPS an unquoted body containing $( ) -- the shell would run it', () => {
    const cmd = 'git commit -m "$(cat <<EOF\nfix\n$(at now)\nEOF\n)"'
    expect(stripHeredocBodies(cmd)).toContain('$(at now)')
  })

  it('KEEPS an unquoted body containing a backtick', () => {
    const cmd = 'git commit -F - <<EOF\nfix `at now`\nEOF'
    expect(stripHeredocBodies(cmd)).toContain('`at now`')
  })

  it('still blanks a QUOTED body that merely mentions $( ) as text', () => {
    // Quoted marker: the shell does not expand, so the text is data even when
    // it looks like a substitution.
    const cmd = "git commit -F - <<'EOF'\nwe replaced $(at now) with cron\nEOF"
    expect(stripHeredocBodies(cmd)).not.toContain('$(at now)')
  })

  it('the <<- variant follows the same rule', () => {
    expect(stripHeredocBodies(`git commit -F - <<-'EOF'\n\t${PROSE}\n\tEOF`)).not.toContain(PROSE)
    expect(stripHeredocBodies('git commit -F - <<-EOF\n\t$(at now)\n\tEOF')).toContain('$(at now)')
  })

  // PR #770 review (Szotasz): a QUOTED body is literal to the SHELL, but an
  // interpreter/remote-executor that OWNS the redirect runs it -- blanking would
  // hide a live scheduler command. Keep the body visible for those owners.
  const RUNS = 'crontab -r; at now'

  it('KEEPS a quoted heredoc body owned by bash (it executes the body)', () => {
    expect(stripHeredocBodies(`bash <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('KEEPS a quoted heredoc body owned by sh / bash -s', () => {
    expect(stripHeredocBodies(`sh <<"EOF"\n${RUNS}\nEOF`)).toContain(RUNS)
    expect(stripHeredocBodies(`bash -s <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('KEEPS a quoted heredoc body owned by ssh / python / docker exec', () => {
    expect(stripHeredocBodies(`ssh box <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
    expect(stripHeredocBodies(`python3 - <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
    expect(stripHeredocBodies(`docker exec c bash <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('sees through a sudo/env prefix to the interpreter owner', () => {
    expect(stripHeredocBodies(`sudo bash <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('still blanks when a non-interpreter (git/tee) owns the redirect', () => {
    expect(stripHeredocBodies(`git commit -F - <<'EOF'\n${RUNS}\nEOF`)).not.toContain(RUNS)
    expect(stripHeredocBodies(`tee f <<'EOF'\n${RUNS}\nEOF`)).not.toContain(RUNS)
  })
})

describe('self-pace-gate stripProseArguments (scoped to gh/git/glab)', () => {
  // PR #770 review (Szotasz): the prose-flag blanking is for a PR/issue body or
  // release note, so it must be scoped to gh/git/glab. A short flag means
  // something else to other tools, and blanking it there hides real data.
  it('blanks a prose flag on gh', () => {
    expect(stripProseArguments("gh pr create --body 'runs at midnight, cron style'"))
      .not.toContain('midnight')
  })

  it('leaves a same-named flag on an unrelated tool alone', () => {
    // tar -t is "list", cut -b is "bytes" -- not prose, must not be blanked.
    const tar = "tar -t 'archive at now.tar'"
    expect(stripProseArguments(tar)).toBe(tar)
    const cut = "cut -b '1-3 at now'"
    expect(stripProseArguments(cut)).toBe(cut)
  })
})

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
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules && date -d yesterday' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules | grep -d' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'ls -d */ && curl -q http://localhost:3420/api/schedules' }).deny).toBe(false)
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
  // Measured false positive, 2026-07-26 (found by Hacker): the heartbeats ORDER every
  // agent to report `launchctl list | grep com.jarvis.channels` output, so a launchd
  // job LABEL shows up in prose constantly. splitSegments splits on `;`, which put
  // `launchctl <label>` at a segment start and it read as a real invocation -- a status
  // report was denied. Same shape as the at/batch "at least" case, different binary.
  // The narrowing requires the SHAPE of an invocation (a bare lowercase subcommand
  // word), not a denylist of subcommands.
  it('does NOT deny a launchd job LABEL appearing in prose (no subcommand follows)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo hello; launchctl com.jarvis.channels PID 555' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'launchctl com.marveen.dashboard is up' }).deny).toBe(false)
  })
  it('STILL denies every real launchctl form after that narrowing', () => {
    // a subcommand word follows -> real invocation
    expect(selfPaceDecision('Bash', { command: 'launchctl load ~/Library/LaunchAgents/x.plist' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl kickstart -k gui/501/com.jarvis.channels' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl bootout gui/501' }).deny).toBe(true)
    // a bare `launchctl` is interactive, and a flag form is an invocation: both stay denied
    expect(selfPaceDecision('Bash', { command: 'launchctl' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl -h' }).deny).toBe(true)
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

// --- backtick command substitution: the boundary anchor recognises `...` the
// same as $(...), so a scheduler binary inside a legacy backtick substitution is
// caught (was a documented pre-existing denylist gap: $() denied, backtick not).
describe('self-pace-gate backtick command-substitution boundary', () => {
  it('denies a bare backtick scheduler substitution', () => {
    expect(selfPaceDecision('Bash', { command: 'git status `crontab -r`' }).deny).toBe(true)
  })
  it('denies an assignment via backtick substitution', () => {
    expect(selfPaceDecision('Bash', { command: 'X=`crontab -r`' }).deny).toBe(true)
  })
  it('denies a backtick substitution after a commit message (message blanked, op remains)', () => {
    expect(selfPaceDecision('Bash', { command: 'git commit -m "a" `crontab -r`' }).deny).toBe(true)
  })
  it('denies a backtick launchctl load', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `launchctl load x`' }).deny).toBe(true)
  })
  it('parity with $(): both substitution forms of the same op are denied', () => {
    expect(selfPaceDecision('Bash', { command: 'git status $(crontab -r)' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'git status `crontab -r`' }).deny).toBe(true)
  })
  it('does not over-fire: a backtick substitution of a NON-scheduler binary is allowed', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `date`' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'FILES=`ls -1`' }).deny).toBe(false)
  })
  it('still allows a legit read-listing inside a substitution (crontab -l)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `crontab -l`' }).deny).toBe(false)
  })
})

// --- inert quoted / heredoc text must not be able to fake a command position ---
//
// Five denials in one morning (2026-08-05, three jayce + two taric), all one
// cause: an inter-agent message quoting the grep pattern
//   Minta: stop.sh | launchctl | com.janna.dashboard
// The bars split it, the middle piece trimmed to the bare word `launchctl`, and
// the anchored scheduler check read that as a real interactive invocation. The
// messages never went out, and from outside a denial looks like an agent that
// simply stayed silent.
//
// What made it a design bug rather than a bad pattern: the SAME text passed as
// `curl -d '<json>'` (payload blanked) and was denied from a python heredoc
// (nothing to blank). The send route had become a security decision.
const BAR = String.fromCharCode(124)
const Q = String.fromCharCode(39)
const heredoc = (body: string) => `python3 - <<${Q}PY${Q}\n${body}\nPY`
const PATTERN = `Minta: stop.sh ${BAR} launchctl ${BAR} com.janna.dashboard`

describe('self-pace-gate: quoted prose cannot fake a command position', () => {
  it('allows the measured pattern inside a heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: heredoc(`t = "${PATTERN}"`) }).deny).toBe(false)
  })
  it('allows it in single quotes, double quotes, and a python triple-quote', () => {
    expect(selfPaceDecision('Bash', { command: `echo ${Q}${PATTERN}${Q}` }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: `echo "${PATTERN}"` }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: heredoc(`t = """${PATTERN}"""`) }).deny).toBe(false)
  })
  it('allows a bar-separated pattern naming crontab too', () => {
    // This is the case that proved masking is the right primitive: with only a
    // quote-aware SPLITTER this stayed denied, because SCHEDULER_RX carries its
    // own boundary anchor and re-found a command position inside the segment.
    expect(selfPaceDecision('Bash', { command: `echo ${Q}foo ${BAR} crontab ${BAR} bar${Q}` }).deny)
      .toBe(false)
  })

  // --- and the whole point: none of the above may cost real detection ---
  it('still denies a real scheduler call after a genuine separator', () => {
    expect(selfPaceDecision('Bash', { command: `echo ${Q}harmless${Q} ; crontab -r` }).deny).toBe(true)
  })
  it('still denies tmux injection hidden inside a heredoc body', () => {
    // The unanchored patterns deliberately keep scanning the RAW segments.
    // Handing them masked text would have removed the detection of this gate's
    // founding incident vector -- measured before the change, not assumed.
    expect(selfPaceDecision('Bash', {
      command: heredoc(`subprocess.run([${Q}tmux${Q},${Q}send-keys${Q},${Q}-t${Q},${Q}x${Q}])`),
    }).deny).toBe(true)
  })
  it('fails CLOSED on an unterminated quote', () => {
    // Unresolvable quoting must mean "scan more", never "scan less".
    expect(selfPaceDecision('Bash', { command: `echo ${Q}oops ; crontab -r` }).deny).toBe(true)
  })
  it('fails CLOSED when a double-quoted region can command-substitute', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "$(date)" ; crontab -r' }).deny).toBe(true)
  })
  it('fails CLOSED on an UNQUOTED heredoc tag whose body substitutes', () => {
    // <<PY (no quotes) expands the body, so its contents are not inert.
    expect(selfPaceDecision('Bash', { command: 'cat <<PY\n$(crontab -r)\nPY' }).deny).toBe(true)
  })
})

// --- the dashboard schedule surface, for EVERY client ---
//
// Measured on a live install: a sub-agent created four schedules with a python
// urllib POST, 4x HTTP 200. The old check only knew curl's spelling of a write
// (-X POST / -d / --data). The fix is not a longer list of spellings: any
// command that references the schedule API or its store is denied unless every
// segment carrying the reference is provably unable to write it.
// A disposable project root with the token files form (a) may read in a header:
// the shared <root>/store/.dashboard-token and per-agent <root>/agents/<name>/
// .dashboard-token files (agent-c's carries a CR/LF request-smuggling payload).
const GATE_ROOT = mkdtempSync(join(tmpdir(), 'selfpace-root-'))
mkdirSync(join(GATE_ROOT, 'store'), { recursive: true })
for (const a of ['agent-a', 'agent-b', 'agent-c']) mkdirSync(join(GATE_ROOT, 'agents', a), { recursive: true })
writeFileSync(join(GATE_ROOT, 'store', '.dashboard-token'), 'example-token_0123.~+/=\n')
writeFileSync(join(GATE_ROOT, 'agents', 'agent-a', '.dashboard-token'), 'agent-a-token\n')
writeFileSync(join(GATE_ROOT, 'agents', 'agent-b', '.dashboard-token'), 'agent-b-token\n')
writeFileSync(join(GATE_ROOT, 'agents', 'agent-c', '.dashboard-token'), 'x\r\n\r\nPOST /api/schedules HTTP/1.1\r\nHost: localhost\r\n')
afterAll(() => rmSync(GATE_ROOT, { recursive: true, force: true }))
const GATE_OPTS = { projectRoot: GATE_ROOT, selfAgent: 'agent-a' }
const deny = (command: string, opts: Record<string, unknown> = GATE_OPTS) => selfPaceDecision('Bash', { command }, opts).deny
// the shared token file, absolute: the file form (a) accepts in a header
const TOKEN_PATH = join(GATE_ROOT, 'store', '.dashboard-token')
const TOKEN_H = `-H "Authorization: Bearer $(cat ${TOKEN_PATH})"`
const tokenHeader = (path: string) => `-H "Authorization: Bearer $(cat ${path})"`

describe('self-pace-gate: schedule API writes through any HTTP client', () => {
  it('denies the measured python urllib POST (heredoc form)', () => {
    expect(deny([
      `python3 - <<${Q}PY${Q}`,
      'import json, urllib.request',
      `tok = open(${Q}/srv/app/store/.dashboard-token${Q}).read().strip()`,
      `req = urllib.request.Request(${Q}http://localhost:3420/api/schedules${Q}, data=json.dumps({${Q}name${Q}: ${Q}x${Q}, ${Q}schedule${Q}: ${Q}0 9 * * *${Q}}).encode(), headers={${Q}Authorization${Q}: ${Q}Bearer ${Q} + tok}, method=${Q}POST${Q})`,
      'print(urllib.request.urlopen(req).status)',
      'PY',
    ].join('\n'))).toBe(true)
  })
  it('denies python requests', () => {
    expect(deny(`python3 -c "import requests; requests.post('http://127.0.0.1:3420/api/schedules', json={'name':'x'})"`)).toBe(true)
  })
  it('denies node fetch', () => {
    expect(deny(`node -e "fetch('http://[::1]:3420/api/schedules',{method:'POST',body:JSON.stringify({name:'x'})})"`)).toBe(true)
  })
  it('denies wget --post-data', () => {
    expect(deny(`wget -qO- --post-data='{"name":"x"}' http://0.0.0.0:3420/api/schedules`)).toBe(true)
  })
  it('denies httpie', () => {
    expect(deny(`http POST localhost:3420/api/schedules name=x schedule='*/5 * * * *'`)).toBe(true)
  })
  it('denies a variable host (the path is the reference, not the host)', () => {
    expect(deny(`python3 -c "import os,urllib.request as u; h=os.environ['DASH_HOST']; u.urlopen(u.Request(f'http://{h}/api/schedules', data=b'{}'))"`)).toBe(true)
    expect(deny(`curl -X POST "http://$HOST:$PORT/api/schedules" --data-binary @x.json`)).toBe(true)
  })
  it('denies perl, nc, bash -c, and a pipe into an interpreter', () => {
    expect(deny(`perl -MHTTP::Tiny -e 'HTTP::Tiny->new->post("http://localhost:3420/api/schedules")'`)).toBe(true)
    expect(deny(`printf 'POST /api/schedules HTTP/1.1\\r\\n\\r\\n' | nc localhost 3420`)).toBe(true)
    expect(deny(`bash -c "curl -X POST localhost:3420/api/schedules -d x"`)).toBe(true)
    expect(deny(`cat <<${Q}EOF${Q} | python3\nimport urllib.request as u\nu.urlopen(u.Request('http://localhost:3420/api/schedules', data=b'{}'))\nEOF`)).toBe(true)
  })
  it('denies spellings the shell or the interpreter resolves: quotes, concatenation, escapes, dot segments', () => {
    expect(deny(`python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:3420/api/' + 'schedules', data=b'{}'))"`)).toBe(true)
    expect(deny(`python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:3420/api/\\x73chedules', data=b'{}'))"`)).toBe(true)
    expect(deny(`node -e "fetch('http://localhost:3420/api/sch'+'edules',{method:'POST'})"`)).toBe(true)
    expect(deny(`curl -X POST http://localhost:3420/api/%2e/schedules -d x`)).toBe(true)
  })
  it('STILL denies a curl POST', () => {
    expect(deny(`curl -s -X POST http://localhost:3420/api/schedules ${TOKEN_H} -d '{"name":"x"}'`)).toBe(true)
  })
  it('ALLOWS the plain curl GET, with the token header, and with a pipe consumer', () => {
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(false)
    expect(deny(`curl -q -s ${TOKEN_H} "http://localhost:$PORT/api/schedules/pending"`)).toBe(false)
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"`)).toBe(false)
  })
  it('does NOT accept a "GET" that is not provably one', () => {
    // the scheme comes from a variable -> gopher:// would write raw bytes
    expect(deny(`curl -q -s "$D/api/schedules"`)).toBe(true)
    expect(deny(`curl -q -s gopher://localhost:3420/_POST%20/api/schedules`)).toBe(true)
    // unquoted substitution word-splits into -X POST -d ...
    expect(deny(`curl -q -s -H $(cat /tmp/args) http://localhost:3420/api/schedules`)).toBe(true)
    // a CR/LF header smuggles a second, pipelined request (curl sends it verbatim)
    expect(deny(`curl -q -s -H $'X: a\\r\\n\\r\\nPOST /api/schedules HTTP/1.1' http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s -H "X: $V" http://localhost:3420/api/schedules`)).toBe(true)
    // the "payload" is really the URL: -H swallowed the -d
    expect(deny(`curl -X POST -H -d 'http://localhost:3420/api/schedules' --data x`)).toBe(true)
    // a separator INSIDE a quoted argv string is not a real command boundary
    expect(deny(`python3 -c 'import sys,urllib.request as u; u.urlopen(u.Request(sys.argv[1], data=b"{}"))' 'a;curl -s http://localhost:3420/api/schedules;b'`)).toBe(true)
  })
  it('ALLOWS the reference when it is only message data (curl -d body, heredoc @-, git -m, agent-msg.sh)', () => {
    expect(deny(`curl -s -X POST http://localhost:3420/api/messages ${TOKEN_H} --data-binary @- <<${Q}JSON${Q}\n{"from":"agent-a","to":"agent-b","content":"wanted POST /api/schedules"}\nJSON`)).toBe(false)
    expect(deny(`git commit -m "$(cat <<${Q}EOF${Q}\nfix: /api/schedules gate\n\nsee ~/.claude/scheduled-tasks\nEOF\n)"`)).toBe(false)
    expect(deny(`bash scripts/agent-msg.sh agent-a agent-b "cannot create /api/schedules entries"`)).toBe(false)
  })
  it('ALLOWS read-only file commands that mention the path', () => {
    expect(deny(`grep -rn "/api/schedules" src/web | head -20`)).toBe(false)
  })
})

describe('self-pace-gate: the scheduled-tasks store', () => {
  it('denies Bash writes into the store: cp, redirect, tee, python open, a glob', () => {
    expect(deny(`cp /tmp/t.json ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(true)
    expect(deny(`mkdir -p ~/.claude/scheduled-tasks/x && echo '{}' > ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(true)
    expect(deny(`echo hi | tee ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`python3 -c "open('/home/agent/.claude/scheduled-tasks/x/SKILL.md','w').write('x')"`)).toBe(true)
    expect(deny(`cp x.json ~/.claude/sched*/x/`)).toBe(true)
    expect(deny(`curl -s -o ~/.claude/scheduled-tasks/x/SKILL.md http://example.com/x`)).toBe(true)
  })
  it('denies a read whose output is piped into an interpreter', () => {
    expect(deny(`cat ~/.claude/scheduled-tasks/x/SKILL.md |\npython3 -c 'x'`)).toBe(true)
  })
  it('denies the native Write / Edit / NotebookEdit tools on the store', () => {
    expect(selfPaceDecision('Write', { file_path: '/home/agent/.claude/scheduled-tasks/x/SKILL.md', content: 'x' }).deny).toBe(true)
    expect(selfPaceDecision('Edit', { file_path: '/srv/app/.channels-config/scheduled-tasks/x/task-config.json' }).deny).toBe(true)
    expect(selfPaceDecision('NotebookEdit', { notebook_path: '/home/agent/.claude/scheduled-tasks/x/n.ipynb' }).deny).toBe(true)
  })
  // Shapes from a replay of real sub-agent tool calls: the store path travels
  // in a VARIABLE or in the WORKING DIRECTORY, not in the segment that writes.
  // The first is a measured SKILL.md append by a sub-agent.
  it('denies a write through a variable or a cd that holds the store path', () => {
    expect(deny(`F=~/.claude/scheduled-tasks/x/SKILL.md; cat >> $F <<${Q}EOF${Q}\nmore\nEOF`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks && echo x > a/SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks/x && sed -i 's/a/b/' SKILL.md`)).toBe(true)
    expect(deny(`for f in ~/.claude/scheduled-tasks/*/SKILL.md; do echo x >> $f; done`)).toBe(true)
  })
  it('ALLOWS reads through a variable and a loop (no cd into the store)', () => {
    expect(deny(`D=~/.claude/scheduled-tasks/x; ls $D 2>/dev/null && cat $D/task-config.json`)).toBe(false)
    expect(deny(`for t in a b; do sed -n '1,60p' ~/.claude/scheduled-tasks/$t/SKILL.md; done`)).toBe(false)
    // reading the store from the repo root, by absolute path, is fine
    expect(deny(`cd /srv/app && cat ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(false)
  })
  it('ALLOWS a literal note that mentions the API written to an unrelated file', () => {
    expect(deny(`echo '- /api/schedules write is forbidden for sub-agents' >> MEMORY.md; cat MEMORY.md`)).toBe(false)
  })
  it('ALLOWS reads, and source files that only share the name', () => {
    expect(deny(`ls ~/.claude/scheduled-tasks/`)).toBe(false)
    expect(deny(`cat ~/.claude/scheduled-tasks/*/task-config.json 2>/dev/null | grep agent`)).toBe(false)
    expect(deny(`sed -n 1,40p src/web/scheduled-tasks-io.ts`)).toBe(false)
    expect(selfPaceDecision('Write', { file_path: '/home/x/src/web/scheduled-tasks-io.ts', content: 'x' }).deny).toBe(false)
  })
})

// --- review holes in a first draft of the check. Each case below was allowed
// (or crashed the gate open) there. ---
describe('self-pace-gate schedule surface: parser holes', () => {
  // 1) A zero-word segment (only redirects / a bare heredoc) made words[0]
  // throw. A throwing gate exits 1, which PreToolUse does NOT block: the whole
  // command ran, and every pre-existing denial after it was skipped too.
  it('a redirect-only or bare-heredoc segment denies instead of crashing', () => {
    expect(deny(`< /api/schedules; tmux send-keys -t x 'hi' Enter`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks; >/dev/null; python3 -c 'open("x/SKILL.md","w")'`)).toBe(true)
    expect(deny(`<<${Q}E${Q}\n/api/schedules\nE\npython3 -c "print(1)"`)).toBe(true)
  })

  // 2) -w %output{file} / %output{>>file} writes a file (curl >= 8.3.0; 8.5.0
  // measured), and a GET without -q first reads ~/.curlrc.
  it('form (a) refuses -w/--write-out, and requires -q as the first argument', () => {
    expect(deny(`curl -q -s -w '%output{>>/home/agent/.claude/scheduled-tasks/x/SKILL.md}new' http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s --write-out '%output{/tmp/x}' http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -s http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -s -q http://localhost:3420/api/schedules`)).toBe(true) // -q only counts first
    expect(deny(`curl -q -s localhost:3420/api/schedules`)).toBe(true) // no literal scheme
  })

  // 3) Brace expansion and curl URL globbing spell the path without spelling it.
  it('brace expansion and bracket globs count as a reference', () => {
    expect(deny(`curl -s -X POST http://localhost:3420/api/sch{e,}dules -d x`)).toBe(true)
    expect(deny(`wget -qO- --post-data=x http://localhost:3420/api/sch[e]dules`)).toBe(true)
    expect(deny(`python3 -c "import sys,urllib.request as u; u.urlopen(u.Request(sys.argv[1], data=b'{}'))" http://localhost:3420/api/{schedules,x}`)).toBe(true)
    expect(deny(`cp /tmp/e ~/.claude/sch{e,}duled-tasks/x/SKILL.md`)).toBe(true)
    // curl globs {a,b} / [x-y] in a URL even inside quotes
    expect(deny(`curl -X POST "http://localhost:3420/api/sch{e,}dules" -d x`)).toBe(true)
    expect(deny(`cp /tmp/e ~/.claude/{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}{a,b,s}cheduled-tasks/x`)).toBe(true)
  })

  // 4) A cd into the store denies the whole command (a flat rule instead of
  // an in-store substitution check).
  it('a cd into the store, with anything after it, denies', () => {
    expect(deny(`cd ~/.claude/scheduled-tasks && cat a $(cp /tmp/e x/SKILL.md)`)).toBe(true)
    expect(deny('cd ~/.claude/scheduled-tasks && cat a `cp /tmp/e x/SKILL.md`')).toBe(true)
  })

  // 5) Globs outside a literal .claude/ prefix.
  it('globs in any path segment are matched against the store name', () => {
    expect(deny(`cp /tmp/e ~/.c*/sch*/x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/e /srv/app/.channels-config/sched*/x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/e ~/.claude-config/sched*/x/SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude && cd sched* && echo x > y/SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude && cp /tmp/e s*/x/SKILL.md`)).toBe(true)
  })

  // 6) Any file named .dashboard-token could carry a CR/LF header payload; only
  // the shared token file, by its literal absolute path, is trusted as a header
  // value (per-agent files: see the token-file suite below).
  it('the token-header exception is pinned to the absolute token path', () => {
    expect(deny(`curl -q -s -H "Authorization: Bearer $(cat /tmp/.dashboard-token)" http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(false)
  })

  it('does NOT over-fire on ordinary globs, braces and dict literals', () => {
    expect(deny(`ls src/*/ && cp a b`)).toBe(false)
    expect(deny(`cp src/*.ts /tmp/`)).toBe(false)
    expect(deny(`python3 -c "d={'a':1,'b':2}; print(d)"`)).toBe(false)
    expect(deny(`ls ~/.claude/* | head`)).toBe(false) // a read under the parent stays a read
    // replay shapes: a quoted grep regex, a bare */* loop, a regex in a heredoc body
    expect(deny(`grep -o 'https\\?://[^ )]*' f.md | sort -u; cp a b`)).toBe(false)
    expect(deny(`for f in */*; do cp "$f" /tmp/; done`)).toBe(false)
    expect(deny(`python3 - <<${Q}PY${Q}\nimport re; print(re.findall(r'[a-z]*', 'x'))\nPY`)).toBe(false)
  })
})

// The hook ENTRY must fail closed on any error or hang: exit 1 and a harness
// timeout are both non-blocking in PreToolUse. The fault is injected INSIDE the
// decision with a --import preload that makes RegExp.prototype.test throw or
// spin on a marker; SELF_PACE_GATE_SRC_MJS points the run at another gate file,
// which is how a control run shows these FAIL on the previous gate.
describe('self-pace-gate hook entry: an internal error or hang denies, never exits 1', () => {
  const SRC = process.env.SELF_PACE_GATE_SRC_MJS ?? join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
  const PRELOAD = [
    'const orig = RegExp.prototype.test',
    'RegExp.prototype.test = function (s) {',
    "  const t = String(s)",
    "  if (t.includes('FAULT_INJECT_THROW')) throw new Error('injected fault')",
    "  if (t.includes('FAULT_INJECT_HANG')) { for (;;) {} }",
    '  return orig.call(this, s)',
    '}',
  ].join('\n')
  const run = (command: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'selfpace-fault-'))
    try {
      const preload = join(dir, 'fault.mjs')
      writeFileSync(preload, PRELOAD)
      return spawnSync(process.execPath, ['--import', preload, SRC], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf-8',
        timeout: 8_000,
        env: { ...process.env, SELF_PACE_GATE_DEADLINE_MS: '300' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const denied = (r: ReturnType<typeof run>) => r.status === 0
    && JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.permissionDecision === 'deny'

  it('a thrown error inside the decision is a DENY', () => {
    const r = run('echo FAULT_INJECT_THROW')
    expect(r.status, r.stderr.slice(-300)).not.toBe(1)
    expect(denied(r), `status=${r.status} stdout=${r.stdout} stderr=${r.stderr.slice(-300)}`).toBe(true)
  })
  it('a decision that never returns is a DENY within the deadline', () => {
    const r = run('echo FAULT_INJECT_HANG')
    expect(denied(r), `status=${r.status} signal=${r.signal} stdout=${r.stdout}`).toBe(true)
  })
  it('control: the same preload leaves an ordinary command allowed', () => {
    const r = run('ls -la')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
  it('gateDecision itself returns deny on a throw (in-process callers)', () => {
    const bomb = { get command(): string { throw new Error('boom') } }
    expect(selfPaceDecision('Bash', bomb).deny).toBe(true)
  })
})

// --- bypasses of a cwd/shadow-modelling draft. The fix replaced the modelling
// with flat, fail-closed invariants. ---
describe('self-pace-gate schedule surface: flat invariants', () => {
  // A shell function or alias shadowing an allowed read-only / GET name.
  it('denies a function or alias that shadows an allowed command', () => {
    expect(deny(`ls() { cp "$@"; }; ls /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`cat() { cp /tmp/e "$1"; }; cat ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`function ls { cp "$@"; }; ls /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`curl() { python3 -c 'x' "$2"; }; curl -q http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`alias ls=cp; ls /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`command cp /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`exec cp /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`builtin cd ~/.claude/scheduled-tasks`)).toBe(true)
  })

  // Trust a command only by a bare name or an exact system-binary path.
  it('denies a command given by a non-system path (basename spoof)', () => {
    expect(deny(`/tmp/cat ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`./curl -q http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`/tmp/curl -q -s http://localhost:3420/api/schedules`)).toBe(true)
    // an exact system path stays trusted
    expect(deny(`/usr/bin/curl -q -s http://localhost:3420/api/schedules`)).toBe(false)
    expect(deny(`/bin/cat ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(false)
  })

  // Any cd/pushd/popd whose argument references the store denies the whole
  // command -- no cwd state machine, so cd -/OLDPWD/failed-cd/popd cannot lose it.
  it('denies any cd/pushd/popd into the store, and the return-to-store shapes', () => {
    expect(deny(`cd ~/.claude/scheduled-tasks`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks/x && cd /tmp && cd - && cp /tmp/e SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks/x; cd /nonexistent; echo x > SKILL.md`)).toBe(true)
    expect(deny(`pushd ~/.claude/scheduled-tasks; pushd /tmp; popd; echo x > a/b`)).toBe(true)
    expect(deny(`cd "$OLDPWD/.claude/scheduled-tasks" && echo x > a`)).toBe(true)
    // a cd to somewhere else, reading the store by an explicit path, is fine
    expect(deny(`cd /tmp && cat ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(false)
  })

  // The token marker is a per-run NUL nonce, not the literal ${DASHBOARD_TOKEN},
  // so an agent cannot forge it with a real shell expansion (CR/LF smuggling).
  it('denies a ${DASHBOARD_TOKEN}-style expansion in a header, even self-assigned', () => {
    expect(deny(`DASHBOARD_TOKEN=$'x\r\n\r\nPOST /api/schedules HTTP/1.1'; curl -q -s -H "X: \${DASHBOARD_TOKEN}" http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s -H "X: \${DASHBOARD_TOKEN}" http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s -H "X: $(printf 'a\r\nb')" http://localhost:3420/api/schedules`)).toBe(true)
  })

  it('does NOT over-fire: the shadow words as arguments, a plain read', () => {
    expect(deny(`grep command ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(false)
    expect(deny(`ls ~/.claude/scheduled-tasks/`)).toBe(false)
  })
})

// --- three more holes in the flat-invariant draft. Each case below was
// ALLOWED there. ---
describe('self-pace-gate schedule surface: subshells, variable writers, path normalisation', () => {
  // 1) A definition opening a subshell/group is not at a segment start, so the
  // segment-start test missed it; the shadowed `ls` then passed as form (b).
  it('denies a function/alias definition at any command position (subshell, group)', () => {
    expect(deny(`(ls(){ cp /tmp/x "$1"; }; ls ~/.claude/scheduled-tasks/a/SKILL.md; )`)).toBe(true)
    expect(deny(`(ls(){ cp /tmp/x "$1"; }\nls ~/.claude/scheduled-tasks/a/SKILL.md\n)`)).toBe(true)
    expect(deny(`(alias ls=cp\nls /tmp/x ~/.claude/scheduled-tasks/a/SKILL.md\n)`)).toBe(true)
  })

  // 2) Builtins that assign a variable without a NAME=value word escape the
  // taint tracking; once the command references the surface they deny (flat).
  it('denies printf -v, read, mapfile and a nameref next to a surface reference', () => {
    expect(deny(`printf -v D %s ~/.claude/scheduled-tasks; mkdir -p "$D/x"; cp /tmp/s "$D/x/SKILL.md"`)).toBe(true)
    expect(deny(`ls -d ~/.claude/scheduled-tasks > /tmp/l; read D < /tmp/l; cp /tmp/s "$D/x/SKILL.md"`)).toBe(true)
    expect(deny(`ls -d ~/.claude/scheduled-tasks > /tmp/l; mapfile -t A < /tmp/l; cp /tmp/s "\${A[0]}/x/SKILL.md"`)).toBe(true)
    expect(deny(`ls -d ~/.claude/scheduled-tasks > /tmp/l; while read f; do cp /tmp/s "$f/x"; done < /tmp/l`)).toBe(true)
    expect(deny(`declare -n R=X; X=~/.claude/scheduled-tasks; cp /tmp/s "$R/x"`)).toBe(true)
  })

  // 3) An empty or dot segment hid the store parent from a short glob.
  it('normalises // /./ and .. before reading a glob segment', () => {
    expect(deny(`cd ~/.claude//sc* && cp /tmp/s x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/s ~/.claude/./sc*/x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/s ~/.claude/foo/../sc*/x/SKILL.md`)).toBe(true)
  })

  it('does NOT over-fire: the words as arguments or prose, readlink, a plain read', () => {
    expect(deny(`grep -rn "readonly" ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(false)
    expect(deny(`readlink -f ~/.claude/scheduled-tasks`)).toBe(false)
    expect(deny(`cat ~/.claude/scheduled-tasks/*/task-config.json 2>/dev/null | grep agent`)).toBe(false)
    expect(deny(`git commit -m "$(cat <<${Q}EOF${Q}\nfix: read the /api/schedules docs; command() in prose\nEOF\n)"`)).toBe(false)
  })
})

describe('self-pace-gate schedule surface: more clients, the environment, prose carriers', () => {
  it('denies store writes by any file tool, and wrappers that run a write', () => {
    expect(deny(`mkdir -p ~/.claude/scheduled-tasks/x`)).toBe(true)
    expect(deny(`rm -rf ~/.claude/scheduled-tasks/x`)).toBe(true)
    expect(deny(`ln -s /tmp/x ~/.claude/scheduled-tasks/x`)).toBe(true)
    expect(deny(`rsync -a /tmp/x/ ~/.claude/scheduled-tasks/x/`)).toBe(true)
    expect(deny(`tee -a ~/.claude/scheduled-tasks/x/SKILL.md < /tmp/x`)).toBe(true)
    expect(deny(`eval "cp /tmp/x ~/.claude/scheduled-tasks/x/SKILL.md"`)).toBe(true)
    expect(deny(`cat <<${Q}EOF${Q} | bash\ncurl -X POST localhost:3420/api/schedules -d x\nEOF`)).toBe(true)
  })
  // A program reads its environment without spelling $NAME on the command
  // line, so a tainted variable must not be exported (os.environ / process.env).
  it('denies a reference that is exported into a program environment', () => {
    expect(deny(`export U=http://localhost:3420/api/schedules; python3 -c "import os,urllib.request as u; u.urlopen(u.Request(os.environ['U'], data=b'{}'))"`)).toBe(true)
    expect(deny(`U=http://localhost:3420/api/schedules; export U; node x.js`)).toBe(true)
    expect(deny(`set -a; U=http://localhost:3420/api/schedules; node -e 'fetch(process.env.U, {method: "POST"})'`)).toBe(true)
    expect(deny(`declare -x D=~/.claude/scheduled-tasks/x; python3 w.py`)).toBe(true)
    // a variable that stays in the shell and only feeds read-only commands is fine
    expect(deny(`set -euo pipefail; D=~/.claude/scheduled-tasks/x; ls $D`)).toBe(false)
    expect(deny(`export PATH=/usr/bin:$PATH; ls ~/.claude/scheduled-tasks`)).toBe(false)
  })
  // Same scope as stripProseArguments: a PR body / comment / release note is prose.
  it('ALLOWS gh/glab prose that mentions the surface, never gh api', () => {
    expect(deny(`gh pr create --title t --body 'this blocks /api/schedules writes'`)).toBe(false)
    expect(deny(`gh pr comment 1 --body="see ~/.claude/scheduled-tasks"`)).toBe(false)
    expect(deny(`gh pr create --body-file - <<${Q}EOF${Q}\nPOST /api/schedules is denied\nEOF`)).toBe(false)
    expect(deny(`gh api -X POST /api/schedules -f name=x`)).toBe(true)
    expect(deny(`gh pr create --body x http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`gh pr create --body "$(curl -X POST localhost:3420/api/schedules -d x)"`)).toBe(true)
  })
  it('does NOT touch commands that never mention the surface', () => {
    for (const c of ['ls -la', 'git status', 'npm test', 'curl -s http://localhost:3420/api/kanban',
      `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"hi"}'`, 'cat docs/scheduled-tasks.md']) {
      expect(deny(c), c).toBe(false)
    }
  })
})

// --- the registry tool, the database file, token files, heredoc-to-script ---
describe('self-pace-gate schedule surface: registry tool, database, token files, heredoc scripts', () => {
  // The registry operator tool opens the database directly, so a task planted
  // in the store and registered through it never passes the dashboard routes.
  it('denies the registry tool except its read-only subcommands, in every runner form', () => {
    for (const c of [
      'node dist/web/schedule-registry-cli.js register --all',
      'node /srv/app/dist/web/schedule-registry-cli.js register task-a',
      'node dist/web/schedule-registry-cli.js unregister task-a',
      'node dist/web/schedule-registry-cli.js',
      'node dist/web/schedule-registry-cli.js register --source x --all',
      'npx tsx src/web/schedule-registry-cli.ts register --all',
      'npx --no-install tsx src/web/schedule-registry-cli.ts register --all',
      'tsx src/web/schedule-registry-cli.ts register --all',
      `node "dist/web/schedule-registry-cli.js" register --all`,
      `node 'dist/web/schedule-'registry-cli.js register --all`,
      'C=dist/web/schedule-registry-cli.js; node $C register --all',
      'node dist/web/schedule-reg*-cli.js register --all',
      `node -e "import('./dist/web/schedule-registry.js').then((m) => m.registerAllScheduledTasks())"`,
      'cd dist/web && node schedule-registry-cli.js register --all',
      'node --import x dist/web/schedule-registry-cli.js status',
      `git -c alias.x="!node dist/web/schedule-registry-cli.js register --all" x`,
    ]) expect(deny(c), c).toBe(true)
    for (const c of [
      'node dist/web/schedule-registry-cli.js status',
      'node dist/web/schedule-registry-cli.js verify task-a task-b',
      'npx tsx src/web/schedule-registry-cli.ts status | head -20',
      'cat src/web/schedule-registry-cli.ts',
      'git diff -- src/web/schedule-registry-cli.ts',
      'npx vitest run src/__tests__/schedule-registry-shell-paths.test.ts',
    ]) expect(deny(c), c).toBe(false)
  })

  it('denies file-level writes to the database file and SQL writes on schedule tables', () => {
    for (const c of [
      'cp /tmp/x.db store/claudeclaw.db',
      'echo x > store/claudeclaw.db-wal',
      'tee store/claudeclaw.db-shm < /tmp/x',
      `sqlite3 store/claudeclaw.db ".restore /tmp/x.db"`,
      `sqlite3 store/claudeclaw.db "INSERT INTO scheduled_task_registry VALUES (1)"`,
      `python3 -c "import sqlite3; sqlite3.connect('store/claudeclaw.db').execute('UPDATE scheduled_tasks SET enabled=1')"`,
      `sqlite3 /tmp/a.db "ATTACH 'store/claudeclaw.db' AS m; DELETE FROM m.scheduled_task_registry"`,
    ]) expect(deny(c), c).toBe(true)
    // reads of the database stay allowed (a worker reads the board this way)
    for (const c of [
      `sqlite3 store/claudeclaw.db "SELECT id, status FROM kanban_cards" | while read l; do echo "$l"; done`,
      `python3 -c "import sqlite3; print(sqlite3.connect('store/claudeclaw.db').execute('select 1').fetchall())"`,
      'ls -la store/claudeclaw.db',
      `grep -n "INSERT INTO scheduled_tasks" src/db.ts`,
    ]) expect(deny(c), c).toBe(false)
  })

  // A sub-agent runs in agents/<name>/: a RELATIVE store/.dashboard-token there
  // is a file it can create itself, with a CR/LF in it, and curl sends a header
  // value verbatim -- a second, pipelined POST rides inside the allowed GET.
  it('accepts only the literal absolute token path, never a relative or ~/$HOME one', () => {
    const get = (h: string) => `curl -q -s ${h} http://localhost:3420/api/schedules`
    expect(deny(get(TOKEN_H))).toBe(false)
    for (const p of ['store/.dashboard-token', './store/.dashboard-token', '~/app/store/.dashboard-token', '$HOME/app/store/.dashboard-token']) {
      expect(deny(get(tokenHeader(p))), p).toBe(true)
    }
  })
  it('the token file content must look like a token (a CR/LF payload, a missing file: deny)', () => {
    const ok = (selfPaceGateModule as Record<string, unknown>).tokenFileContentOk as (p: string) => boolean
    expect(ok(TOKEN_PATH)).toBe(true)
    expect(ok(join(GATE_ROOT, 'agents', 'agent-c', '.dashboard-token'))).toBe(false)
    expect(ok(join(GATE_ROOT, 'no-such-file'))).toBe(false)
    const crlf = join(GATE_ROOT, 'agents', 'agent-c', '.dashboard-token')
    expect(deny(`curl -q -s ${tokenHeader(crlf)} http://localhost:3420/api/schedules`, { projectRoot: GATE_ROOT, selfAgent: 'agent-c' })).toBe(true)
  })
  it('a token file rewritten in the same command is refused', () => {
    expect(deny(`echo x > ${TOKEN_PATH}; curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`cp /tmp/t ${TOKEN_PATH} && curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(true)
  })
  // Per-agent token files: the calling agent's own, never another agent's.
  it('accepts the calling agent own per-agent token file, not another agent one', () => {
    const own = join(GATE_ROOT, 'agents', 'agent-a', '.dashboard-token')
    const other = join(GATE_ROOT, 'agents', 'agent-b', '.dashboard-token')
    const get = (p: string) => `curl -q -s ${tokenHeader(p)} http://localhost:3420/api/schedules`
    expect(deny(get(own))).toBe(false)
    expect(deny(get(other))).toBe(true)
    // no calling agent known: only the shared file
    expect(deny(get(own), { projectRoot: GATE_ROOT })).toBe(true)
    const derive = (selfPaceGateModule as Record<string, unknown>).selfAgentFromProjectDir as (d: string | undefined, r: string) => string | undefined
    expect(derive(join(GATE_ROOT, 'agents', 'agent-a'), GATE_ROOT)).toBe('agent-a')
    expect(derive(join(GATE_ROOT, 'agents', 'agent-a', 'sub'), GATE_ROOT)).toBe(undefined)
    expect(derive(GATE_ROOT, GATE_ROOT)).toBe(undefined)
    expect(derive('/elsewhere/agents/agent-a', GATE_ROOT)).toBe(undefined)
    expect(derive(undefined, GATE_ROOT)).toBe(undefined)
  })

  // A heredoc that carries a reference, written to a file and run afterwards.
  it('denies a heredoc or here-string carrying a reference that is redirected to a file', () => {
    for (const c of [
      `cat <<${Q}X${Q} > /tmp/s.sh\ncurl -X POST localhost:3420/api/schedules -d x\nX\nbash /tmp/s.sh`,
      `cat > /tmp/f <<${Q}X${Q}\ncurl -X POST localhost:3420/api/schedules -d x\nX\nsh /tmp/f`,
      `grep -h . <<${Q}X${Q} > /tmp/s.py\nimport urllib.request as u; u.urlopen(u.Request("http://localhost:3420/api/schedules", data=b"{}"))\nX\npython3 /tmp/s.py`,
      `grep -h . <<<${Q}curl -X POST localhost:3420/api/schedules -d x${Q} > /tmp/s.sh; bash /tmp/s.sh`,
    ]) expect(deny(c), c).toBe(true)
    // the same heredoc fed to a message or commit, with no file redirect, is data
    expect(deny(`curl -s -X POST http://localhost:3420/api/messages --data-binary @- <<${Q}J${Q}\n{"content":"wanted POST /api/schedules"}\nJ`)).toBe(false)
    expect(deny(`git commit -F - <<${Q}EOF${Q}\nfix /api/schedules docs\nEOF`)).toBe(false)
  })
})

// --- telegram copy gate: the outgoing-copy-gate must actually be WIRED ---
//
// GATECOPY828. The check itself lived in outgoing-copy-gate.py since 2026-08-27
// and passed its own unit tests, but no sub-agent's settings.json bound a
// Telegram tool to that script, so it never ran for them and an unusable code
// block went out again. These tests assert the WIRING, which is the half that
// was missing: a gate's script passing is not evidence that the gate runs.
describe('telegram copy gate wiring', () => {
  const copyEntries = (s: Record<string, unknown>) => {
    const hooks = s.hooks as Record<string, unknown>
    const ptu = hooks.PreToolUse as Array<Record<string, unknown>>
    return ptu.filter((e) => JSON.stringify(e).includes('outgoing-copy-gate.py'))
  }

  it('exempts the main agent (it carries the hook in its own project settings)', () => {
    expect(agentGetsTelegramCopyGate(MAIN_AGENT_ID)).toBe(false)
  })
  it('covers every sub-agent', () => {
    for (const n of ['social', 'emma', 'chris', 'heartbeat-worker']) {
      expect(agentGetsTelegramCopyGate(n)).toBe(true)
    }
  })
  it('wires the gate onto the Telegram send AND edit tools', () => {
    const settings: Record<string, unknown> = {}
    injectTelegramCopyGate(settings)
    const [entry] = copyEntries(settings)
    expect(entry.matcher).toBe(TELEGRAM_COPY_GATE_MATCHER)
    expect(String(entry.matcher)).toContain('mcp__plugin_telegram_telegram__reply')
    expect(String(entry.matcher)).toContain('mcp__plugin_telegram_telegram__edit_message')
  })
  it('is idempotent: a second pass does not accumulate a duplicate', () => {
    const settings: Record<string, unknown> = {}
    injectTelegramCopyGate(settings)
    injectTelegramCopyGate(settings)
    expect(copyEntries(settings)).toHaveLength(1)
  })
  it('keeps the SAME script wired under a different matcher', () => {
    // The main agent legitimately runs this script on Bash and on the email
    // tools too. A dedupe filter keyed on the script basename alone would have
    // deleted those entries on every pass -- closing one hole by opening two.
    const settings: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/outgoing-copy-gate.py"' }] },
          { matcher: '.*send_email.*', hooks: [{ type: 'command', command: 'python3 "/x/scripts/hooks/outgoing-copy-gate.py"' }] },
        ],
      },
    }
    injectTelegramCopyGate(settings)
    const matchers = copyEntries(settings).map((e) => e.matcher)
    expect(matchers).toContain('Bash')
    expect(matchers).toContain('.*send_email.*')
    expect(matchers).toContain(TELEGRAM_COPY_GATE_MATCHER)
  })
  it('leaves unrelated PreToolUse entries alone', () => {
    const settings: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node "/x/egress-gate.mjs"' }] }] },
    }
    injectTelegramCopyGate(settings)
    const ptu = (settings.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(JSON.stringify(ptu)).toContain('egress-gate.mjs')
    expect(ptu).toHaveLength(2)
  })
})

// --- readonly-repo-gate: only the EXACT install command is exempt ---
//
// Maintainer decision on #770 (2026-09-25): package installs are allowed, but
// only the exact install command with nothing appended -- `npm install`,
// `npm ci`, `yarn install`, bare `yarn`, `pnpm install`. The yarn branch used
// to read `yarn\s+(install)?\b`, which matched `yarn ` + anything, so
// `yarn add left-pad` and `yarn exec rm -rf src` skipped the gate. INSTALL_RX
// is now anchored to the whole segment, and an appended form is judged (and,
// inside a protected root, refused) like any other package-manager call.
describe('readonly-repo-gate: only the exact install command is exempt', () => {
  // ROOTS defaults to <home>/projects, resolved when the module loads.
  const repo = join(homedir(), 'projects', 'app')
  const outside = join(homedir(), 'agents', 'qa-worker')

  const EXACT = ['npm install', 'npm ci', 'yarn install', 'yarn', 'pnpm install']

  it('recognises exactly the five decided install commands', () => {
    for (const cmd of EXACT) expect(isExactInstall(cmd), cmd).toBe(true)
    for (const cmd of [
      'yarn add left-pad',
      'yarn exec rm -rf src',
      'yarn dlx some-codemod',
      'npm install evil-pkg',
      'npm ci --prefix=src',
      'npm i',
      'pnpm install left-pad',
      'pnpm add left-pad',
      'yarn install --modules-folder=src',
      'yarn --cwd src',
      'npm ci --include=../src',
      'npm ci --silent>src/x',
      'CI=1 npm ci',
      'pip install -r requirements.txt',
    ]) {
      expect(isExactInstall(cmd), cmd).toBe(false)
    }
  })

  it('an install followed only by allowlisted flags is still the exact install', () => {
    // Review question on #770 (2026-09-26): the updater runs `npm ci` with
    // flags. An allowlist, not "anything starting with -": the flags that
    // matter are the ones that move where the install writes.
    for (const cmd of [
      'npm ci --include=dev',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'yarn install --frozen-lockfile',
      'yarn --frozen-lockfile',
      'pnpm install --frozen-lockfile',
      'npm install --legacy-peer-deps',
    ]) {
      expect(isExactInstall(cmd), cmd).toBe(true)
      expect(bashViolation(cmd, repo), cmd).toBeNull()
    }
  })

  it('allows the exact installs inside a protected repo', () => {
    for (const cmd of EXACT) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).toBeNull()
      expect(bashViolation(cmd, repo), `${cmd} (session cwd)`).toBeNull()
    }
  })

  it('refuses yarn add and yarn exec inside a protected repo', () => {
    for (const cmd of ['yarn add left-pad', 'yarn exec rm -rf src', 'yarn exec tsx build.ts', 'yarn dlx some-codemod']) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).not.toBeNull()
      expect(bashViolation(cmd, repo), `${cmd} (session cwd)`).not.toBeNull()
    }
  })

  it('refuses an install with anything appended', () => {
    for (const cmd of [
      'npm install evil-pkg',
      'npm install --save left-pad',
      'npm ci --prefix=src',
      'npm ci --include=dev --cwd=src',
      'yarn --cwd src',
      'yarn --cwd src add left-pad',
      'npm --prefix src install left-pad',
      'pnpm -C src add left-pad',
      'pnpm install left-pad',
      'yarn install --modules-folder src',
      'npm i left-pad',
    ]) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).not.toBeNull()
    }
  })

  it('an appended redirect is no longer hidden behind the install', () => {
    expect(bashViolation(`npm ci > ${repo}/src/index.ts`)).not.toBeNull()
    expect(bashViolation(`yarn install > ${repo}/src/index.ts`)).not.toBeNull()
  })

  it('the exemption is per-segment, so a chained non-install is still judged', () => {
    expect(bashViolation(`cd ${repo} && yarn install && yarn add left-pad`)).not.toBeNull()
    expect(bashViolation(`cd ${repo} && npm ci && yarn exec rm -rf src`)).not.toBeNull()
  })

  it('judges from the session cwd the hook payload carries', () => {
    // `cd <repo>` in one Bash call, `yarn add x` in the next: the shell kept
    // the cwd, so the second call must be judged from the repo.
    expect(bashViolation('yarn add left-pad', repo)).not.toBeNull()
    expect(bashViolation('yarn add left-pad', outside)).toBeNull()
  })

  it('leaves read-only package-manager use alone', () => {
    for (const cmd of ['npm test', 'npm run build', 'yarn test', 'pnpm run lint']) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).toBeNull()
    }
  })
})

// --- readonly-repo-gate: the artifact exemption is decided PER TARGET ---
//
// Review on #770 (2026-09-26): the exemption used to test the whole segment,
// so one artifact-looking word (`node_modules/...`) exempted a command that
// also named source. Every word that resolves into a protected root must now
// itself be an artifact path, resolved the way the kernel resolves it.
describe('readonly-repo-gate: artifact exemption per target', () => {
  const home = homedir()
  const repo = join(home, 'projects', 'app')
  const outside = join(home, 'agents', 'qa-worker')

  it('refuses the two shapes the review measured', () => {
    expect(bashViolation('rm -rf src node_modules/.cache', repo)).not.toBeNull()
    expect(bashViolation(`cd ${repo} && rm -rf src node_modules/.cache`)).not.toBeNull()
    expect(bashViolation('./node_modules/.bin/yarn add x', repo)).not.toBeNull()
    expect(bashViolation(`rm -rf ${repo}/src ${repo}/node_modules/.cache`)).not.toBeNull()
  })

  it('refuses a source target hidden among artifact targets, in any spelling', () => {
    for (const cmd of [
      'rm -rf -- src node_modules',
      `rm -rf "src" 'node_modules/.cache'`,
      'rm -rf node_modules/* src/*',
      'rm -rf {src,node_modules}',
      'mv src node_modules/x',
      'mv dist src',
      'cp node_modules/x/a.ts src/a.ts',
      'cp -r dist/. src/',
      'cp -t src node_modules/x',
      'cp -tsrc node_modules/x',
      'cp --target-directory=src node_modules/x',
      'install -Dm644 node_modules/x src/y',
      'echo x | tee src/a.ts node_modules/.cache/x',
      'git rm -r src node_modules',
      'sed -i s/a/b/ src/a.ts node_modules/x',
      'sudo rm -rf src node_modules',
      'env rm -rf src node_modules',
      'FOO=1 rm -rf src node_modules',
      '(rm -rf src node_modules)',
      'bash -c "rm -rf src node_modules"',
      'rm -rf node_modules && rm -rf src',
      'rm -rf node_modules; rm -rf src',
    ]) {
      expect(bashViolation(cmd, repo), cmd).not.toBeNull()
    }
  })

  it('an artifact directory is not a way out through .. or shell expansion', () => {
    for (const cmd of [
      'rm -rf node_modules/../src',
      'rm -rf node_modules/.cache/../../src',
      'rm -rf ./dist/.././src',
      `rm -rf ${repo}/node_modules/../src`,
      'echo x > node_modules/../src/a.ts',
      `echo x > ${repo}/dist/../src/a.ts`,
      'rm -rf node_modules/{..,x}/src',
      'rm -rf node_modules/[.][.]/src',
      'rm -rf node_modules/.?/src',
      'rm -rf node_modules/$X/src',
      'rm -rf node_modules/`echo ..`/src',
      "rm -rf $'node_modules/../src'",
    ]) {
      expect(bashViolation(cmd, repo), cmd).not.toBeNull()
    }
  })

  it('a safe-looking tail no longer exempts the segment', () => {
    // GIT_SAFE_RX was unanchored: the segment was skipped if it merely ENDED
    // in a branch switch or CONTAINED `git worktree list`.
    expect(bashViolation('rm -rf src git checkout main', repo)).not.toBeNull()
    expect(bashViolation('rm -rf src # git worktree list', repo)).not.toBeNull()
    expect(bashViolation('echo x > src/a.ts # git worktree list', repo)).not.toBeNull()
    expect(bashViolation('git checkout main', repo)).toBeNull()
    expect(bashViolation('git worktree list', repo)).toBeNull()
  })

  it('finds the repo behind ~, $HOME and relative paths from outside it', () => {
    for (const cmd of [
      'rm -rf ~/projects/app/src',
      'rm -rf $HOME/projects/app/src',
      'rm -rf ${HOME}/projects/app/src',
      '(cd ~/projects/app && rm -rf src node_modules)',
      `cd ${home} && rm -rf projects/app/src node_modules`,
      `cd ${home} && cd projects/app && rm -rf src`,
      `echo ${repo}/src | xargs rm -rf`,
    ]) {
      expect(bashViolation(cmd, outside), cmd).not.toBeNull()
    }
    expect(bashViolation('rm -rf ../../projects/app/src', outside)).not.toBeNull()
    expect(bashViolation('rm -rf projects/app/src', home)).not.toBeNull()
  })

  it('refuses package-manager writes with the flags in front of the subcommand', () => {
    for (const cmd of [
      'yarn --cwd src add left-pad',
      'npm --prefix src install left-pad',
      'pnpm -C src add left-pad',
      'yarn --cwd src',
    ]) {
      expect(bashViolation(cmd, repo), cmd).not.toBeNull()
    }
  })

  it('still allows commands whose every repo target is an artifact', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'rm -rf node_modules/.cache dist',
      'rm -rf node_modules/*',
      'rm -rf node_modules /tmp/x',
      'mkdir -p node_modules/.cache',
      'mv node_modules/x dist/y',
      'touch dist/x',
      'cp /tmp/x.txt dist/x.txt',
      'echo x > dist/out.txt',
      'echo x > node_modules/.cache/x',
      'rm -rf /tmp/x',
      'grep -rn foo src',
      'cat src/a.ts | grep x',
    ]) {
      expect(bashViolation(cmd, repo), cmd).toBeNull()
    }
    expect(bashViolation(`rm -rf ${repo}/node_modules ${repo}/dist`)).toBeNull()
    expect(bashViolation(`cat ${repo}/a | tee /tmp/out`, outside)).toBeNull()
    expect(bashViolation('rm -rf src', outside)).toBeNull()
  })
})

// The hook as the runtime calls it: a real root on disk (READONLY_REPO_ROOTS),
// a JSON payload on stdin. This is where a symlinked workspace package counts:
// `node_modules/@ws/core` pointing back at `packages/core` is SOURCE.
describe('readonly-repo-gate: the hook end to end', () => {
  const script = join(__dirname, '..', '..', 'scripts', 'readonly-repo-gate.mjs')
  const root = mkdtempSync(join(tmpdir(), 'rorg-'))
  const repo = join(root, 'app')
  mkdirSync(join(repo, 'packages', 'core', 'src'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', '@ws'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', '.cache'), { recursive: true })
  symlinkSync(join(repo, 'packages', 'core'), join(repo, 'node_modules', '@ws', 'core'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const run = (payload: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      env: { ...process.env, READONLY_REPO_ROOTS: root },
      encoding: 'utf-8',
    })
    return r.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow'
  }

  it('refuses a write through a symlinked workspace package', () => {
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'rm -rf node_modules/@ws/core/src' } })).toBe('deny')
    expect(run({ tool_name: 'Write', cwd: repo, tool_input: { file_path: join(repo, 'node_modules', '@ws', 'core', 'src', 'a.ts') } })).toBe('deny')
  })

  it('refuses a Write whose artifact directory is climbed out of with ..', () => {
    expect(run({ tool_name: 'Write', tool_input: { file_path: join(repo, 'node_modules') + '/../packages/core/src/a.ts' } })).toBe('deny')
    expect(run({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'packages', 'core', 'src', 'a.ts') } })).toBe('deny')
  })

  it('allows real artifact writes and the review shapes are denied', () => {
    expect(run({ tool_name: 'Write', tool_input: { file_path: join(repo, 'node_modules', '.cache', 'x') } })).toBe('allow')
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'rm -rf node_modules/.cache' } })).toBe('allow')
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'rm -rf packages node_modules/.cache' } })).toBe('deny')
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: './node_modules/.bin/yarn add x' } })).toBe('deny')
  })
})
