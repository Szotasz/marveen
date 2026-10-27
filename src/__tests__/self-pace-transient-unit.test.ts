import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, transientUserUnitAllowed } from '../../scripts/self-pace-gate.mjs'

// A sub-agent may start ONE immediate, timer-less transient user unit
// (systemd-run --user --collect ...) so a long test run survives a session
// restart. Everything that could schedule a future turn stays denied.
const deny = (command: string): boolean => gateDecision('Bash', { command }).deny

describe('self-pace-gate: immediate transient user unit', () => {
  it('ALLOWS the immediate, timer-less --user --collect form', () => {
    for (const cmd of [
      "systemd-run --user --collect --unit=x sh -c 'npm test'",
      'systemd-run --user --collect --unit=suite-1 -p WorkingDirectory=/w nice -n 19 npx vitest run',
      'systemd-run --user --collect --quiet --unit=t1 --same-dir bash -lc "npm test > /tmp/x.log 2>&1"',
      'systemd-run --user -G -u t2.service -q -d npm test',
      'systemd-run --user --collect --unit t3 --description "full suite" --working-directory=/w -- npx vitest run --maxWorkers=4',
      'systemd-run --user --collect --wait --pipe --nice=19 -E CI=1 --setenv=TZ=UTC npm test',
      'systemd-run --user --collect -p IOSchedulingClass=idle -p Nice=19 --property=RuntimeMaxSec=3600 npm test > /tmp/s.log 2>&1',
      '  systemd-run --user --collect npm test',
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
      const cmd = `systemd-run --user --collect ${opt} sh -c 'npm test'`
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES options outside the allowlist and malformed values', () => {
    for (const cmd of [
      "systemd-run --user --collect --scope sh -c 'npm test'",
      "systemd-run --system --collect sh -c 'npm test'",
      "systemd-run --user --collect -M host sh -c 'npm test'",
      "systemd-run --user --collect -H host sh -c 'npm test'",
      "systemd-run --user --collect --uid=0 sh -c 'npm test'",
      "systemd-run --user --collect -r sh -c 'npm test'",
      "systemd-run --user --collect --remain-after-exit sh -c 'npm test'",
      "systemd-run --user --collect --service-type=oneshot sh -c 'npm test'",
      'systemd-run --user --collect -S',
      "systemd-run --user -qG sh -c 'npm test'",
      "systemd-run --user --collect --no-block sh -c 'npm test'",
      "systemd-run --user --collect -p Restart=always sh -c 'npm test'",
      "systemd-run --user --collect -p RestartSec=1h sh -c 'npm test'",
      "systemd-run --user --collect -p ExecStartPost=/bin/true sh -c 'npm test'",
      "systemd-run --user --collect -p OnFailure=x.service sh -c 'npm test'",
      "systemd-run --user --collect --property=Wants=x.timer sh -c 'npm test'",
      "systemd-run --user --collect --unit=x.timer sh -c 'npm test'",
      "systemd-run --user --collect --unit=x.path sh -c 'npm test'",
      "systemd-run --user --collect --unit='a b' sh -c 'npm test'",
      "systemd-run --user --collect -E '1BAD=x' sh -c 'npm test'",
      // a trigger option is denied even when its value looks like an allowed property
      "systemd-run --user --collect --timer-property=Nice=19 sh -c 'npm test'",
      "systemd-run --user --collect --path-property=Nice=19 sh -c 'npm test'",
      "systemd-run --user --collect --socket-property=Nice=19 sh -c 'npm test'",
      'systemd-run --user --collect --nice=abc npm test',
      'systemd-run --user --collect --description= npm test',
      // systemd itself would write the file, which the store-write checks do not see
      'systemd-run --user --collect -p StandardOutput=file:~/.claude/scheduled_tasks.json echo hi',
      'systemd-run --user --collect --property=StandardError=append:/tmp/x.log npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES without --user, without --collect, or with a prefix before systemd-run', () => {
    for (const cmd of [
      "systemd-run --collect --unit=x sh -c 'npm test'",
      "systemd-run --user --unit=x sh -c 'npm test'",
      "sudo systemd-run --user --collect sh -c 'npm test'",
      "env X=1 systemd-run --user --collect sh -c 'npm test'",
      "X=1 systemd-run --user --collect sh -c 'npm test'",
      "nice systemd-run --user --collect sh -c 'npm test'",
      "/usr/bin/systemd-run --user --collect sh -c 'npm test'",
      'systemd-run --user --collect',
      'systemd-run --user --collect --',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a payload that starts claude or another scheduler / self-pace tool', () => {
    for (const cmd of [
      'systemd-run --user --collect --unit=x claude -p hi',
      "systemd-run --user --collect sh -c 'cd /w && claude --continue'",
      'systemd-run --user --collect /opt/u/bin/claude -p hi',
      'systemd-run --user --collect npx @anthropic-ai/claude-code -p hi',
      'systemd-run --user --collect node /opt/claude-code/cli.js -p hi',
      "systemd-run --user --collect sh -c 'crontab -l | crontab -'",
      "systemd-run --user --collect sh -c 'echo x | at now'",
      "systemd-run --user --collect sh -c 'batch < job'",
      "systemd-run --user --collect sh -c 'launchctl load x.plist'",
      "systemd-run --user --collect sh -c 'systemd-run --user --on-active=1h true'",
      "systemd-run --user --collect sh -c 'tmux send-keys -t x hi Enter'",
      "systemd-run --user --collect sh -c 'nohup ./x.sh'",
      "systemd-run --user --collect sh -c 'setsid ./x.sh'",
      "systemd-run --user --collect sh -c './x.sh & disown'",
      "systemd-run --user --collect sh -c 'sleep 3600; npm test'",
      "systemd-run --user --collect watch -n 60 npm test",
      "systemd-run --user --collect sh -c 'eval \"$CMD\"'",
      "systemd-run --user --collect sh -c 'curl -X POST http://localhost:3420/api/messages -d x'",
      "systemd-run --user --collect sh -c 'curl -X POST http://localhost:3420/api/schedules -d x'",
      "systemd-run --user --collect sh -c 'curl http://localhost:3420/api/kanban'",
      "systemd-run --user --collect sh -c 'X=$(cat f); $X'",
      'systemd-run --user --collect sh -c "`cat f`"',
      'systemd-run --user --collect sh -c "$(cat f)"',
      "systemd-run --user --collect sh < script.sh",
      "systemd-run --user --collect bash -s < script.sh",
      // quoting that bash removes still spells claude
      'systemd-run --user --collect cl\\aude -p hi',
      "systemd-run --user --collect cl''aude -p hi",
      "systemd-run --user --collect $'cl\\x61ude' -p hi",
      "systemd-run --user --collect sh -c $'cl\\x61ude -p hi'",
      'systemd-run --user --collect $"claude" -p hi',
      // a tmux command abbreviation (send = send-keys)
      'systemd-run --user --collect tmux send -t x hi Enter',
      // bash expands ${X} to nothing in front of the name
      'systemd-run --user --collect ${X}claude -p hi',
      "systemd-run --user --collect sh -c '${X}claude -p hi'",
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('DENIES a compound command, even when the systemd-run part alone would pass', () => {
    for (const cmd of [
      "systemd-run --user --collect npm test; crontab -r",
      'systemd-run --user --collect npm test && npm test',
      'systemd-run --user --collect npm test || true',
      'systemd-run --user --collect npm test | cat',
      'systemd-run --user --collect npm test &',
      'true; systemd-run --user --collect npm test',
      'systemd-run --user --collect npm test\nsystemd-run --user --collect npm test',
      'systemd-run --user --collect npm test $(echo x)',
      'systemd-run --user --collect npm test `echo x`',
      'systemd-run --user --collect diff <(echo a) <(echo b)',
      'systemd-run --user --collect sh <<EOF\nnpm test\nEOF',
      'systemd-run --user --collect sh <<< "npm test"',
      "systemd-run --user --collect sh -c 'npm test",
      // a process substitution or a second line hidden in an option value
      'systemd-run --user --collect -p WorkingDirectory=<(crontab${IFS}-r) npm test',
      'systemd-run --user --collect -p WorkingDirectory=<(true) npm test',
      'systemd-run --user --collect -E A=1\ncrontab cronfile',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
  })

  it('keeps every other check on an otherwise allowed transient unit', () => {
    // the scheduled-tasks store and the egress allowlist stay write-protected
    expect(deny("systemd-run --user --collect sh -c 'echo x > ~/.claude/scheduled_tasks.json'")).toBe(true)
    expect(deny("systemd-run --user --collect sh -c 'echo {} > data/egress-allowlist.json'")).toBe(true)
  })

  it('leaves the other scheduler denials unchanged', () => {
    for (const cmd of ['crontab -r', '(crontab -l; echo job) | crontab -', 'at now + 1 minute', 'launchctl load x.plist', "systemd-run --on-active=5m sh -c 'npm test'", 'systemd-run --user sh -c "npm test"']) {
      expect(deny(cmd), cmd).toBe(true)
    }
    expect(deny('crontab -l')).toBe(false)
  })

  it('DENIES an option or the command name that bash would still split or expand', () => {
    for (const cmd of [
      "systemd-run --user --collect --description=x${IFS}--on-active=5m sh -c 'npm test'",
      'systemd-run --user --collect --description x${IFS}--on-active=5m npm test',
      'systemd-run --user --collect {--on-active=5m,true}',
      'systemd-run --user --collect ${IFS}--on-active=5m${IFS}true',
      'systemd-run --user --collect $X --on-active=5m true',
      'systemd-run --user --collect "$X" npm test',
      'systemd-run --user --collect * npm test',
      'systemd-run --user --collect -E A=$HOME npm test',
      'systemd-run --user --collect --working-directory=/w/[ab] npm test',
      // bash drops a redirection from argv, so the next word is an option again
      "systemd-run --user --collect 2>&1 --on-active=5m sh -c 'npm test'",
      'systemd-run --user --collect >/tmp/l --on-active=5m true',
      'systemd-run --user --collect > /tmp/l --on-calendar=daily npm test',
      'systemd-run --user --collect --unit=x >>/tmp/l --on-active=5m npm test',
      'systemd-run --user --collect &>/tmp/l --on-active=5m true',
      'systemd-run --user --collect >|/tmp/l --on-active=5m true',
      'systemd-run --user --collect 3<>/tmp/l --on-active=5m true',
      'systemd-run --user --collect {fd}>/tmp/l --on-active=5m true',
    ]) {
      expect(deny(cmd), cmd).toBe(true)
    }
    // quoted text, and the arguments after the command name, are not options
    for (const cmd of [
      "systemd-run --user --collect --description='$x {a,b} *' npm test",
      "systemd-run --user --collect sh -c 'npm test > $TMPDIR/x.log 2>&1'",
      'systemd-run --user --collect npx vitest run src/*.test.ts',
      "systemd-run --user --collect sh -c 'npm test' >/tmp/l 2>&1",
      'systemd-run --user --collect --description=a\\>b npm test',
    ]) {
      expect(deny(cmd), cmd).toBe(false)
    }
  })

  it('reports a unit with no command to run as not allowed, without throwing', () => {
    for (const cmd of ['systemd-run --user --collect', 'systemd-run --user --collect --', 'systemd-run --user --collect --unit=x']) {
      expect(transientUserUnitAllowed(cmd), cmd).toBe(false)
    }
  })

  it('names the allowed transient-unit form in the gate message', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../../scripts/self-pace-gate.mjs', import.meta.url)), 'utf8')
    const msg = src.slice(src.indexOf('const GATE_MSG'))
    expect(msg.slice(0, 3000)).toContain('systemd-run --user --collect')
  })
})
