import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, transientUserUnitAllowed } from '../../scripts/self-pace-gate.mjs'

// A sub-agent may start ONE immediate, timer-less transient user unit
// (systemd-run --user --collect -p RuntimeMaxSec=600 ...) so a long test run survives a session
// restart. Everything that could schedule a future turn stays denied.
const deny = (command: string): boolean => gateDecision('Bash', { command }).deny

describe('self-pace-gate: immediate transient user unit', () => {
  it('ALLOWS the immediate, timer-less --user --collect form', () => {
    for (const cmd of [
      "systemd-run --user --collect -p RuntimeMaxSec=600 --unit=x sh -c 'npm test'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 --unit=suite-1 -p WorkingDirectory=/w nice -n 19 npx vitest run',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --quiet --unit=t1 --same-dir bash -lc "npm test > /tmp/x.log 2>&1"',
      'systemd-run --user -G -p RuntimeMaxSec=600 -u t2.service -q -d npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --unit t3 --description "full suite" --working-directory=/w -- npx vitest run --maxWorkers=4',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --wait --pipe --nice=19 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=1 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=7200 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p RuntimeMaxSec=1200 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p IOSchedulingClass=idle -p Nice=19 --property=RuntimeMaxSec=3600 npm test > /tmp/s.log 2>&1',
      '  systemd-run --user --collect -p RuntimeMaxSec=600 npm test',
      'systemd-run --user --collect --property RuntimeMaxSec=600 npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('DENIES every timer / trigger option', () => {
    for (const opt of [
      '--on-active=5m',
      "--on-calendar='*-*-* 03:00'",
      '--on-calendar daily',
      '--timer-property=AccuracySec=1',
      '--on-boot=10',
      '--on-startup=10',
      '--on-unit-active=10',
      '--on-unit-inactive=10',
      '--on-clock-change',
      '--on-timezone-change',
      '--path-property=PathExists=/x',
      '--socket-property=ListenStream=1',
    ]) {
      const cmd = `systemd-run --user --collect -p RuntimeMaxSec=600 ${opt} sh -c 'npm test'`
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES options outside the allowlist and malformed values', () => {
    for (const cmd of [
      "systemd-run --user --collect -p RuntimeMaxSec=600 --scope sh -c 'npm test'",
      "systemd-run --system --collect -p RuntimeMaxSec=600 sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -M host sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -H host sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --uid=0 sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -r sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --remain-after-exit sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --service-type=oneshot sh -c 'npm test'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 -S',
      "systemd-run --user -qG -p RuntimeMaxSec=600 sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --no-block sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -p Restart=always sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -p RestartSec=1h sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -p ExecStartPost=/bin/true sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 -p OnFailure=x.service sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --property=Wants=x.timer sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --unit=x.timer sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --unit=x.path sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --unit='a b' sh -c 'npm test'",
      // a trigger option is denied even when its value looks like an allowed property
      "systemd-run --user --collect -p RuntimeMaxSec=600 --timer-property=Nice=19 sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --path-property=Nice=19 sh -c 'npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 --socket-property=Nice=19 sh -c 'npm test'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 --nice=abc npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --description= npm test',
      // systemd itself would write the file, which the store-write checks do not see
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p StandardOutput=file:~/.claude/scheduled_tasks.json echo hi',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --property=StandardError=append:/tmp/x.log npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES without --user, without --collect, or with a prefix before systemd-run', () => {
    for (const cmd of [
      "systemd-run --collect --unit=x -p RuntimeMaxSec=600 sh -c 'npm test'",
      "systemd-run --user --unit=x -p RuntimeMaxSec=600 sh -c 'npm test'",
      "sudo systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test'",
      "env X=1 systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test'",
      "X=1 systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test'",
      "nice systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test'",
      "/usr/bin/systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test'",
      'systemd-run --user --collect',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a payload that starts claude or another scheduler / self-pace tool', () => {
    for (const cmd of [
      'systemd-run --user --collect -p RuntimeMaxSec=600 --unit=x claude -p hi',
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'cd /w && claude --continue'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 /opt/u/bin/claude -p hi',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npx @anthropic-ai/claude-code -p hi',
      'systemd-run --user --collect -p RuntimeMaxSec=600 node /opt/claude-code/cli.js -p hi',
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'crontab -l | crontab -'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'echo x | at now'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'batch < job'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'launchctl load x.plist'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'systemd-run --user --on-active=1h true'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'tmux send-keys -t x hi Enter'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'nohup ./x.sh'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'setsid ./x.sh'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c './x.sh & disown'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'sleep 3600; npm test'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 watch -n 60 npm test",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'eval \"$CMD\"'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'curl -X POST http://localhost:3420/api/messages -d x'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'curl -X POST http://localhost:3420/api/schedules -d x'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'curl http://localhost:3420/api/kanban'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'X=$(cat f); $X'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 sh -c "`cat f`"',
      'systemd-run --user --collect -p RuntimeMaxSec=600 sh -c "$(cat f)"',
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh < script.sh",
      "systemd-run --user --collect -p RuntimeMaxSec=600 bash -s < script.sh",
      // quoting that bash removes still spells claude
      'systemd-run --user --collect -p RuntimeMaxSec=600 cl\\aude -p hi',
      "systemd-run --user --collect -p RuntimeMaxSec=600 cl''aude -p hi",
      "systemd-run --user --collect -p RuntimeMaxSec=600 $'cl\\x61ude' -p hi",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c $'cl\\x61ude -p hi'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 $"claude" -p hi',
      // a tmux command abbreviation (send = send-keys)
      'systemd-run --user --collect -p RuntimeMaxSec=600 tmux send -t x hi Enter',
      // bash expands ${X} to nothing in front of the name
      'systemd-run --user --collect -p RuntimeMaxSec=600 ${X}claude -p hi',
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c '${X}claude -p hi'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a compound command, even when the systemd-run part alone would pass', () => {
    for (const cmd of [
      "systemd-run --user --collect -p RuntimeMaxSec=600 npm test; crontab -r",
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test && npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test || true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test | cat',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test &',
      'true; systemd-run --user --collect -p RuntimeMaxSec=600 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test\nsystemd-run --user --collect -p RuntimeMaxSec=600 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test $(echo x)',
      'systemd-run --user --collect -p RuntimeMaxSec=600 npm test `echo x`',
      'systemd-run --user --collect -p RuntimeMaxSec=600 diff <(echo a) <(echo b)',
      'systemd-run --user --collect -p RuntimeMaxSec=600 sh <<EOF\nnpm test\nEOF',
      'systemd-run --user --collect -p RuntimeMaxSec=600 sh <<< "npm test"',
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test",
      // a process substitution or a second line hidden in an option value
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p WorkingDirectory=<(crontab${IFS}-r) npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p WorkingDirectory=<(true) npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --nice=1\ncrontab cronfile',
      // a free-text value has no format check of its own, so only the newline check stops these
      'systemd-run --user --collect -p RuntimeMaxSec=600 --description=x\ncrontab cronfile npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --working-directory=x\ncrontab cronfile npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p WorkingDirectory=x\ncrontab cronfile npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('keeps every other check on an otherwise allowed transient unit', () => {
    // the scheduled-tasks store and the egress allowlist stay write-protected; the unit itself
    // passes the exemption, so the denial comes from the store-write checks
    for (const cmd of [
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'echo x > ~/.config/scheduled_tasks.json'",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'echo {} > data/egress-allowlist.json'",
    ]) {
      expect(transientUserUnitAllowed(cmd), cmd).toBe(true)
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('leaves the other scheduler denials unchanged', () => {
    for (const cmd of ['crontab -r', '(crontab -l; echo job) | crontab -', 'at now + 1 minute', 'launchctl load x.plist', "systemd-run --on-active=5m sh -c 'npm test'", 'systemd-run --user sh -c "npm test"']) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny('crontab -l')).toBe(false)
  })

  it('DENIES an option or the command name that bash would still split or expand', () => {
    for (const cmd of [
      "systemd-run --user --collect -p RuntimeMaxSec=600 --description=x${IFS}--on-active=5m sh -c 'npm test'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 --description x${IFS}--on-active=5m npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 {--on-active=5m,true}',
      'systemd-run --user --collect -p RuntimeMaxSec=600 ${IFS}--on-active=5m${IFS}true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 $X --on-active=5m true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 "$X" npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 * npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --description=$HOME npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --working-directory=/w/[ab] npm test',
      // bash drops a redirection from argv, so the next word is an option again
      "systemd-run --user --collect -p RuntimeMaxSec=600 2>&1 --on-active=5m sh -c 'npm test'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 >/tmp/l --on-active=5m true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 > /tmp/l --on-calendar=daily npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --unit=x >>/tmp/l --on-active=5m npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 &>/tmp/l --on-active=5m true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 >|/tmp/l --on-active=5m true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 3<>/tmp/l --on-active=5m true',
      'systemd-run --user --collect -p RuntimeMaxSec=600 {fd}>/tmp/l --on-active=5m true',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    // quoted text, and the arguments after the command name, are not options
    for (const cmd of [
      "systemd-run --user --collect -p RuntimeMaxSec=600 --description='$x {a,b} *' npm test",
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test > $TMPDIR/x.log 2>&1'",
      'systemd-run --user --collect -p RuntimeMaxSec=600 npx vitest run src/*.test.ts',
      "systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'npm test' >/tmp/l 2>&1",
      'systemd-run --user --collect -p RuntimeMaxSec=600 --description=a\\>b npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('reports a unit with no command to run as not allowed, without throwing', () => {
    for (const cmd of ['systemd-run --user --collect', 'systemd-run --user --collect -p RuntimeMaxSec=600 --', 'systemd-run --user --collect -p RuntimeMaxSec=600 --unit=x']) {
      expect(transientUserUnitAllowed(cmd), cmd).toBe(false)
    }
  })

  it('names the allowed transient-unit form in the gate message', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../../scripts/self-pace-gate.mjs', import.meta.url)), 'utf8')
    const msg = src.slice(src.indexOf('const GATE_MSG'))
    expect(msg.slice(0, 3000)).toContain('systemd-run --user --collect')
    expect(msg.slice(0, 3000)).toContain('RuntimeMaxSec')
  })

  it('DENIES a unit without -p RuntimeMaxSec=<1..7200>: missing, infinity, empty, out of range or malformed', () => {
    for (const cmd of [
      'systemd-run --user --collect npm test',
      "systemd-run --user --collect --unit=x sh -c 'npm test'",
      'systemd-run --user --collect -p RuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect --property=RuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect --property RuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect -p RuntimeMaxSec= npm test',
      "systemd-run --user --collect -p 'RuntimeMaxSec=' npm test",
      'systemd-run --user --collect -p RuntimeMaxSec=0 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=7201 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=99999 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=0600 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=-1 npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=1h npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600s npm test',
      "systemd-run --user --collect -p 'RuntimeMaxSec=600 ' npm test",
      // a later assignment overrides an earlier one, so every value must pass
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p RuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p RuntimeMaxSec= npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --property RuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 --property=RuntimeMaxSec= npm test',
      // systemd-run also takes an attached short value and an abbreviated long option; both are denied
      'systemd-run --user --collect -pRuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect -p RuntimeMaxSec=600 -pRuntimeMaxSec=infinity npm test',
      'systemd-run --user --collect --prop=RuntimeMaxSec=infinity npm test',
      // every option after a repeated RuntimeMaxSec is still checked
      'systemd-run --user --collect -p RuntimeMaxSec=600 -p RuntimeMaxSec=1200 --on-active=5m npm test',
      // an environment variable named RuntimeMaxSec is not the unit property (denied twice over:
      // the property is still missing, and every environment option is denied on its own below)
      'systemd-run --user --collect --setenv=RuntimeMaxSec=600 npm test',
      'systemd-run --user --collect --setenv RuntimeMaxSec=600 npm test',
      'systemd-run --user --collect -E RuntimeMaxSec=600 npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
      expect(transientUserUnitAllowed(cmd), cmd).toBe(false)
    }
  })

  it('DENIES every environment option, whatever the variable name', () => {
    for (const name of ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONSTARTUP', 'PYTHONPATH', 'PATH', 'CI']) {
      for (const opt of [
        `-E ${name}=/tmp/x`,
        `--setenv=${name}=/tmp/x`,
        `--setenv ${name}=/tmp/x`,
        `--setenv=${name}`,
        `-p Environment=${name}=/tmp/x`,
        `--property=Environment=${name}=/tmp/x`,
        `--property Environment=${name}=/tmp/x`,
        // the attached short value and an abbreviated long option, which systemd-run also takes
        `-E${name}=/tmp/x`,
        `--sete=${name}=/tmp/x`,
      ]) {
        const cmd = `systemd-run --user --collect -p RuntimeMaxSec=600 ${opt} bash -c true`
        expect(deny(cmd), cmd).toBe(true)
        expect(transientUserUnitAllowed(cmd), cmd).toBe(false)
      }
    }
  })

  it('DENIES TimeoutStopSec, so a payload that ignores SIGTERM still gets SIGKILL after RuntimeMaxSec', () => {
    for (const opt of [
      '-p TimeoutStopSec=infinity',
      '--property=TimeoutStopSec=infinity',
      '--property TimeoutStopSec=infinity',
      '-p TimeoutStopSec=',
      '-p TimeoutStopSec=30',
    ]) {
      const cmd = `systemd-run --user --collect -p RuntimeMaxSec=600 ${opt} sh -c 'trap "" TERM; npm test'`
      expect(deny(cmd), cmd).toBe(true)
      expect(transientUserUnitAllowed(cmd), cmd).toBe(false)
    }
    // the same payload with no TimeoutStopSec stays allowed
    expect(deny(`systemd-run --user --collect -p RuntimeMaxSec=600 sh -c 'trap "" TERM; npm test'`)).toBe(false)
  })
})
