import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, maskInertLiterals } from '../../scripts/self-pace-gate.mjs'

// cc8e80d7: a systemd timer is an OS scheduler too. The gate caught `systemd-run`,
// but not the two-step form an agent used on 2026-09-27: write the unit files into
// ~/.config/systemd/user, then `systemctl --user enable --now <name>.timer`. The
// timer's job then messaged the agent's own queue, and the agent woke up on turns
// it had scheduled for itself. Each step is denied on its own, because in 9 of the
// 36 measured Bash creations the write and the enable were separate tool calls.
// The unit names, directories and paths below are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const Q = String.fromCharCode(39)
const heredoc = (target: string, body: string) => `cat > ${target} <<${Q}EOF${Q}${NL}${body}${NL}EOF`
const TIMER_UNIT = `[Timer]${NL}OnCalendar=*:0/5${NL}${NL}[Install]${NL}WantedBy=timers.target`
const SERVICE_UNIT = `[Service]${NL}Type=oneshot${NL}ExecStart=/bin/true`

describe('cc8e80d7 (a): arming a timer with systemctl is denied', () => {
  it('enable --now and start, the two measured forms', () => {
    expect(bash('systemctl --user enable --now demo-guard.timer')).toBe(true)
    expect(bash('systemctl --user start demo-guard.timer')).toBe(true)
  })
  it('the measured chained shape: daemon-reload, then enable --now, the output piped', () => {
    expect(bash('systemctl --user daemon-reload && systemctl --user enable --now demo-guard.timer 2>&1 | tail -2')).toBe(true)
    expect(bash('echo installing; systemctl --user start demo-guard.timer')).toBe(true)
  })
  it('every other verb that arms or re-arms a timer (an allowlist decides, not a verb list)', () => {
    for (const verb of ['restart', 'try-restart', 'reload-or-restart', 'reenable', 'link', 'edit --force --full', 'add-wants timers.target', 'unmask', 'preset']) {
      expect(bash(`systemctl --user ${verb} demo-guard.timer`)).toBe(true)
    }
    expect(bash('systemctl --user link /opt/units/demo-guard.timer')).toBe(true)
  })
  it('options before the verb, several units, a system timer behind sudo, an absolute path', () => {
    expect(bash('systemctl --user --now enable demo-guard.timer')).toBe(true)
    expect(bash('systemctl --user enable --now demo-a.timer demo-b.timer')).toBe(true)
    expect(bash('sudo systemctl enable --now demo-guard.timer')).toBe(true)
    expect(bash('/usr/bin/systemctl --user start demo-guard.timer')).toBe(true)
  })
  it('a quoted unit name, and a unit name held in a variable of the same command', () => {
    expect(bash('systemctl --user enable --now "demo-guard.timer"')).toBe(true)
    expect(bash(`systemctl --user start ${Q}demo-guard.timer${Q}`)).toBe(true)
    expect(bash('T=demo-guard.timer; systemctl --user enable --now "$T"')).toBe(true)
    expect(bash('T=demo-guard.timer && systemctl --user start ${T}')).toBe(true)
  })
  it('inside a command substitution', () => {
    expect(bash('X=$(systemctl --user start demo-guard.timer)')).toBe(true)
  })
})

describe('cc8e80d7 (b): writing a timer unit into a systemd unit directory is denied', () => {
  it('a heredoc redirect into the user unit directory', () => {
    expect(bash(heredoc('~/.config/systemd/user/demo-guard.timer', TIMER_UNIT))).toBe(true)
    expect(bash(heredoc('"$HOME/.config/systemd/user/demo-guard.timer"', TIMER_UNIT))).toBe(true)
  })
  it('the unit directory held in a variable (the most common measured shape)', () => {
    expect(bash(`U=~/.config/systemd/user; ${heredoc('"$U/demo-guard.timer"', TIMER_UNIT)}`)).toBe(true)
    expect(bash(`U=/home/agent/.config/systemd/user${NL}${heredoc('$U/demo-guard.timer', TIMER_UNIT)}`)).toBe(true)
  })
  it('cp, install, mv, ln and tee into the directory, including a brace pair of unit files', () => {
    expect(bash('cp units/demo-guard.{service,timer} ~/.config/systemd/user/')).toBe(true)
    expect(bash('cp -n units/demo-guard.service units/demo-guard.timer ~/.config/systemd/user/ && systemctl --user daemon-reload')).toBe(true)
    expect(bash('install -m 0644 units/demo-guard.timer "$HOME/.config/systemd/user/"')).toBe(true)
    expect(bash('mv /tmp/demo-guard.timer ~/.config/systemd/user/')).toBe(true)
    expect(bash('ln -s /opt/units/demo-guard.timer ~/.config/systemd/user/timers.target.wants/demo-guard.timer')).toBe(true)
    expect(bash(`printf ${Q}[Timer]\\nOnCalendar=hourly\\n${Q} | tee ~/.config/systemd/user/demo-guard.timer >/dev/null`)).toBe(true)
  })
  it('a for loop over the unit pair, and a cd into the directory first', () => {
    const loop = 'for f in demo-guard.service demo-guard.timer; do cp -p "$D/$f" "$U/$f"; done'
    expect(bash(`U=~/.config/systemd/user; D=units; ${loop}`)).toBe(true)
    expect(bash(`U=~/.config/systemd/user; D=units; for f in demo-guard.service demo-guard.timer; do echo "$f"; cp -p "$D/$f" "$U/$f"; done`)).toBe(true)
    expect(bash(`cd ~/.config/systemd/user && ${heredoc('demo-guard.timer', TIMER_UNIT)}`)).toBe(true)
  })
  it('a system unit directory, also behind sudo with options or timeout (a measured shape)', () => {
    expect(bash('echo x | sudo tee /etc/systemd/system/demo-guard.timer')).toBe(true)
    expect(bash(`sudo -n tee /etc/systemd/system/demo-guard.timer > /dev/null <<${Q}EOF${Q}${NL}${TIMER_UNIT}${NL}EOF`)).toBe(true)
    expect(bash('sudo -u root systemctl enable --now demo-guard.timer')).toBe(true)
    expect(bash('timeout 60 systemctl --user start demo-guard.timer')).toBe(true)
    // CONTROL: the same wrappers in front of a read
    expect(bash('sudo -n systemctl status demo-guard.timer')).toBe(false)
    expect(bash('timeout 200 systemctl --user start demo-guard.service')).toBe(false)
  })
  it('a script body writing the unit (python in a heredoc, node -e)', () => {
    const py = `python3 - <<${Q}PY${Q}${NL}import os${NL}open(os.path.expanduser(${Q}~/.config/systemd/user/demo-guard.timer${Q}), ${Q}w${Q}).write(${Q}[Timer]${Q})${NL}PY`
    expect(bash(py)).toBe(true)
    expect(bash(`node -e "require(${Q}fs${Q}).writeFileSync(process.env.HOME + ${Q}/.config/systemd/user/demo-guard.timer${Q}, ${Q}x${Q})"`)).toBe(true)
  })
  it('an installer written from a heredoc and run in the same command (a measured shape)', () => {
    const inst = `cat > install-demo-timer.sh <<${Q}EOF${Q}${NL}systemctl --user daemon-reload${NL}systemctl --user enable --now demo-guard.timer${NL}EOF${NL}chmod +x install-demo-timer.sh`
    expect(bash(`${inst}${NL}bash install-demo-timer.sh 2>&1 | head -25`)).toBe(true)
    expect(bash(`${inst} && ./install-demo-timer.sh`)).toBe(true)
    // CONTROLS: written but not run is only a file, and `bash -n` only parses it;
    // run, but a body that only reads, arms nothing
    expect(bash(inst)).toBe(false)
    expect(bash(`${inst} && bash -n install-demo-timer.sh && echo syntax-ok`)).toBe(false)
    const reads = `cat > check-demo-timer.sh <<${Q}EOF${Q}${NL}systemctl --user status demo-guard.timer${NL}EOF${NL}bash check-demo-timer.sh`
    expect(bash(reads)).toBe(false)
  })
  it('the native Write and Edit tools', () => {
    expect(gateDecision('Write', { file_path: '/home/agent/.config/systemd/user/demo-guard.timer', content: TIMER_UNIT }).deny).toBe(true)
    expect(gateDecision('Edit', { file_path: '/home/agent/.config/systemd/user/demo-guard.timer', old_string: 'a', new_string: 'b' }).deny).toBe(true)
  })
})

describe('cc8e80d7 negative controls: reading, disarming and quoting stay allowed', () => {
  it('status, list-timers, cat, is-active, is-enabled, show, list-unit-files', () => {
    for (const cmd of [
      'systemctl --user status demo-guard.timer',
      'systemctl --user list-timers --all',
      'systemctl --user cat demo-guard.timer',
      'systemctl --user is-active demo-guard.timer; systemctl --user is-enabled demo-guard.timer',
      'systemctl --user show demo-guard.timer -p NextElapseUSecRealtime',
      'systemctl --user list-unit-files --type=timer --no-pager',
    ]) {
      expect(bash(cmd)).toBe(false)
    }
  })
  it('a value-taking option in front of a read verb is not taken for the verb', () => {
    expect(bash('systemctl --user -p NextElapseUSecRealtime show demo-guard.timer')).toBe(false)
  })
  it('journalctl on the timer or its service', () => {
    expect(bash('journalctl --user -u demo-guard.timer --since today --no-pager')).toBe(false)
    expect(bash('journalctl --user -u demo-guard.service -n 20')).toBe(false)
  })
  it('stop, disable --now, mask, reset-failed, daemon-reload, and running the .service once', () => {
    for (const cmd of [
      'systemctl --user stop demo-guard.timer',
      'systemctl --user disable --now demo-guard.timer',
      'systemctl --user mask demo-guard.timer',
      'systemctl --user reset-failed demo-guard.service',
      'systemctl --user daemon-reload',
      'systemctl --user start demo-guard.service',
    ]) {
      expect(bash(cmd)).toBe(false)
    }
  })
  it('reading unit files: cat, ls, grep, sed -n, diff, systemd-analyze verify, a stderr redirect', () => {
    for (const cmd of [
      'cat ~/.config/systemd/user/demo-guard.timer',
      'ls ~/.config/systemd/user/*.timer 2>/dev/null',
      'grep -l OnCalendar ~/.config/systemd/user/*.timer',
      `sed -n ${Q}1,5p${Q} ~/.config/systemd/user/demo-guard.timer`,
      'diff units/demo-guard.timer ~/.config/systemd/user/demo-guard.timer',
      'systemd-analyze --user verify ~/.config/systemd/user/demo-guard.timer',
      'cat ~/.config/systemd/user/demo-guard.timer | tee /tmp/copy.timer',
    ]) {
      expect(bash(cmd)).toBe(false)
    }
  })
  it('copying a unit file OUT of the directory, and deleting one', () => {
    expect(bash('cp ~/.config/systemd/user/demo-guard.timer /tmp/backup/')).toBe(false)
    expect(bash('U=~/.config/systemd/user; D=units; cp -n "$U/demo-guard.service" "$U/demo-guard.timer" "$D/"')).toBe(false)
    expect(bash('rm ~/.config/systemd/user/demo-guard.timer')).toBe(false)
  })
  it('a timer template inside a repository, and a .service written into the unit directory', () => {
    expect(bash(heredoc('scripts/systemd/demo-guard.timer', TIMER_UNIT))).toBe(false)
    expect(bash(heredoc('~/.config/systemd/user/demo-guard.service', SERVICE_UNIT))).toBe(false)
    expect(gateDecision('Write', { file_path: '/repo/scripts/systemd/demo-guard.timer', content: TIMER_UNIT }).deny).toBe(false)
    expect(gateDecision('Write', { file_path: '/home/agent/.config/systemd/user/demo-guard.service', content: SERVICE_UNIT }).deny).toBe(false)
  })
  it('a message, an echo and a commit message that QUOTE the very commands', () => {
    const msg = `cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}proposal: systemctl --user enable --now demo-guard.timer${NL}and cat > ~/.config/systemd/user/demo-guard.timer${NL}EOF`
    expect(bash(msg)).toBe(false)
    expect(bash('echo "systemctl --user enable --now demo-guard.timer"')).toBe(false)
    expect(bash('git commit -m "gate: systemctl --user start demo-guard.timer"')).toBe(false)
  })
})

// The three false-positive shapes measured on real commands, pinned so they stay fixed.
describe('cc8e80d7: measured false positives stay allowed', () => {
  it('a quoted message body that quotes the commands, in a command that also has a "$(date)"', () => {
    // one `"...$(...)..."` used to send the whole command to the naive split, and the
    // body's prose read as commands (most real commands carry such a timestamp)
    const body = [
      'one command for the operator: `systemctl --user enable --now demo-guard.timer`, then list-timers',
      'cp .service + .timer -> ~/.config/systemd/user/ ; daemon-reload ; enable --now',
    ].join(NL)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}${body}${NL}EOF${NL}echo "sent at $(date -u +%FT%TZ)"`)).toBe(false)
  })
  it('moving units into a subdirectory systemd does not load (retiring them)', () => {
    expect(bash('mkdir -p ~/.config/systemd/user/retired && mv ~/.config/systemd/user/demo-guard.{service,timer} ~/.config/systemd/user/retired/')).toBe(false)
  })
  it('a backup copy of a .service next to it, then an in-place edit of that .service', () => {
    // the command also names the timer (a read), so a name with a `$` in it is not taken for one
    expect(bash(`U=~/.config/systemd/user/demo-guard.service; cp -a "$U" "$U.bak.$(date -u +%Y%m%dT%H%M%SZ)" && sed -i ${Q}s/^Description=.*/Description=x/${Q} "$U"; systemctl --user cat demo-guard.timer`)).toBe(false)
  })
})

describe('cc8e80d7: the earlier routes are unchanged', () => {
  it('systemd-run is still denied', () => {
    expect(bash(`systemd-run --user --on-calendar=${Q}*:0/10${Q} /bin/true`)).toBe(true)
  })
  it('maskInertLiterals({ quotes: false }) keeps quoted text, blanks heredoc bodies, keeps the length', () => {
    const cmd = `echo ${Q}a;b${Q} "c" <<${Q}EOF${Q}${NL}body; x${NL}EOF`
    const out = maskInertLiterals(cmd, { quotes: false }) as string
    expect(out.length).toBe(cmd.length)
    expect(out).toContain(`${Q}a;b${Q} "c"`)
    expect(out).not.toContain('body')
    // the default still blanks the quoted text as well
    expect(maskInertLiterals(cmd)).not.toContain('a;b')
  })
})
