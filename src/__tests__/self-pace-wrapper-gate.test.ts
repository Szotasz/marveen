import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, HEAVY_WRAPPER } from '../../scripts/self-pace-gate.mjs'

// ffc45c28: the scheduler check did not read `sudo` with options or
// `timeout <duration>` in front of the command word. Measured 2026-09-30 on develop and on the
// branch base: `sudo -n crontab -r`, `sudo -u root crontab -r` and `timeout 60 crontab -r`
// passed, while `sudo crontab -r` was denied. The scheduler check and its read exemption now read
// the wrappers the timer check already read. Unit names and paths are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
// The install's heavy-run wrapper, as the gate resolved it (SELF_PACE_HEAVY_WRAPPER, default heavy-run).
const W: string = HEAVY_WRAPPER
const NL = '\n'
const Q = String.fromCharCode(39)

describe('ffc45c28: a scheduler behind an option sudo or a timeout is denied', () => {
  it('the three measured forms', () => {
    expect(bash('sudo -n crontab -r')).toBe(true)
    expect(bash('sudo -u root crontab -r')).toBe(true)
    expect(bash('timeout 60 crontab -r')).toBe(true)
  })
  it('other options and schedulers behind them', () => {
    expect(bash('sudo -n -u root crontab -e')).toBe(true)
    expect(bash('sudo --user=root at now')).toBe(true)
    expect(bash('timeout -s KILL 60 crontab -r')).toBe(true)
    expect(bash('timeout 30 systemd-run --user --on-active=60 /bin/true')).toBe(true)
    expect(bash('sudo -n launchctl load demo.plist')).toBe(true)
  })
  it('the timer check reads the same wrapper: a timeout with a valued option in front of systemctl', () => {
    // measured on the branch base: passed there, the plain `timeout 60` was denied
    expect(bash('timeout -s KILL 60 systemctl --user start demo-guard.timer')).toBe(true)
    expect(bash('timeout 60 systemctl --user start demo-guard.timer')).toBe(true)
  })
  it('after a separator, a keyword or a substitution', () => {
    expect(bash('cd /tmp && sudo -n crontab -r')).toBe(true)
    expect(bash('if true; then sudo -n crontab -r; fi')).toBe(true)
    expect(bash('X=$(timeout 60 crontab -r)')).toBe(true)
  })
})

describe('ffc45c28 (2): the other common wrappers and a script handed to a shell', () => {
  it('env, nice, nohup, command -p and exec -a with their options', () => {
    for (const c of ['env -i crontab -r', 'env -u HOME crontab -r', 'env - crontab -r', 'nice -n 10 crontab -r', 'nice -10 crontab -r',
      'nohup crontab -r', 'nohup at now', 'command -p crontab -r', 'exec -a demo crontab -r']) {
      expect(bash(c)).toBe(true)
    }
  })
  it('xargs at the head of a pipeline segment, stdbuf, setsid, flock, doas, runuser', () => {
    for (const c of ['echo x | xargs crontab -r', 'ls | xargs -I{} crontab {}', 'printf x | xargs -0 -n 1 crontab', 'stdbuf -oL crontab -r',
      'stdbuf -o L crontab -r', 'setsid crontab -r', 'flock /tmp/demo.lock crontab -r', 'doas crontab -r',
      'runuser -u root -- crontab -r']) {
      expect(bash(c)).toBe(true)
    }
  })
  it('a script handed to a shell as text: bash -c, sh -c, bash -lc, su -c, flock -c, nested', () => {
    expect(bash(`bash -c ${Q}crontab -r${Q}`)).toBe(true)
    expect(bash('sh -c "crontab -r"')).toBe(true)
    expect(bash(`bash -lc ${Q}at now${Q}`)).toBe(true)
    expect(bash(`su -c ${Q}crontab -r${Q} root`)).toBe(true)
    expect(bash(`flock /tmp/demo.lock -c ${Q}crontab -r${Q}`)).toBe(true)
    expect(bash(`bash -c "sh -c ${Q}crontab -r${Q}"`)).toBe(true)
    expect(bash(`cd /tmp && bash -c ${Q}systemctl --user enable --now demo-guard.timer${Q}`)).toBe(true)
  })
  it('what stays allowed: a read or a lookup, an ordinary shell script, prose that quotes one', () => {
    expect(bash('env crontab -l')).toBe(false)
    expect(bash('command -v crontab')).toBe(false)
    expect(bash(`bash -c ${Q}echo hi; ls -la${Q}`)).toBe(false)
    expect(bash('nice -n 10 npx tsc --noEmit')).toBe(false)
    expect(bash('ls | xargs -I{} echo {}')).toBe(false)
    expect(bash(`echo "bash -c ${Q}crontab -r${Q}"`)).toBe(false)
    expect(bash(`git commit -m "gate: bash -c ${Q}crontab -r${Q}"`)).toBe(false)
    expect(bash(`cat > /tmp/demo.sh <<${Q}EOF${Q}${NL}bash -c ${Q}crontab -r${Q}${NL}nohup at now${NL}EOF`)).toBe(false)
  })
})

describe('ffc45c28 (3): GNU time and the time keyword, by path and with options', () => {
  const SCOPE = `systemd-run --user --scope --quiet --collect --slice=${W}.slice --unit=${W}-tsc-4242 -p MemoryMax=16G --`
  const T = '/usr/bin/time -o /tmp/heavy-demo.txt -f %M'
  it('the three measured forms', () => {
    expect(bash('/usr/bin/time crontab -r')).toBe(true)
    expect(bash('/usr/bin/time -o f -f %M crontab -r')).toBe(true)
    expect(bash('time -p crontab -r')).toBe(true)
  })
  it('other options, a quoted format, other schedulers, a timer, a shell script, after a keyword', () => {
    expect(bash('/usr/bin/time -f "%e %M" crontab -r')).toBe(true)
    expect(bash('/usr/bin/time --output=f --format=%M at now')).toBe(true)
    expect(bash('/bin/time -v -a -o f systemd-run --user --on-active=60 /bin/true')).toBe(true)
    expect(bash('time -p systemctl --user enable --now demo-guard.timer')).toBe(true)
    expect(bash(`/usr/bin/time -o f -f %M bash -c ${Q}crontab -r${Q}`)).toBe(true)
    expect(bash('if true; then /usr/bin/time crontab -r; fi')).toBe(true)
    expect(bash('sudo -n /usr/bin/time -o f -f %M crontab -r')).toBe(true)
  })
  it('the heavy-run scope form with a time wrapper behind its own tail is denied as the wrapper is without it', () => {
    expect(bash(`${SCOPE} ${T} /usr/bin/time crontab -r`)).toBe(true)
    expect(bash(`${SCOPE} ${T} time -p at now`)).toBe(true)
    expect(bash(`${SCOPE} ${T} npx tsc --noEmit`)).toBe(false)
  })
  it('what stays allowed: an ordinary command or a read behind time, prose that quotes the forms', () => {
    expect(bash('/usr/bin/time -o f -f %M npx tsc --noEmit')).toBe(false)
    expect(bash('time -p crontab -l')).toBe(false)
    expect(bash('/usr/bin/time ls -la')).toBe(false)
    expect(bash('timeout 60 npx tsc --noEmit')).toBe(false)
    expect(bash('echo "/usr/bin/time -o f -f %M crontab -r"')).toBe(false)
    expect(bash('git commit -m "gate: time -p crontab -r"')).toBe(false)
  })
})

describe('ffc45c28 (4): a case arm and coproc', () => {
  const SCHED = ['crontab -r', 'at now < x', 'systemd-run --user --on-active=60 true', 'systemctl --user enable --now x.timer']
  it('the measured forms: a scheduler at the head of a case arm, or after coproc', () => {
    for (const s of SCHED) {
      expect(bash(`case x in *) ${s};; esac`), s).toBe(true)
      expect(bash(`coproc ${s}`), s).toBe(true)
    }
  })
  it('other arms: a quoted word, several patterns, a later arm, a parenthesised pattern, lines, a wrapper, a script', () => {
    expect(bash('case "$x" in *) crontab -r;; esac')).toBe(true)
    expect(bash('case "$x" in a|b) crontab -r;; esac')).toBe(true)
    expect(bash('case $1 in start) echo go;; *) crontab -r;; esac')).toBe(true)
    expect(bash('case x in (*) crontab -r;; esac')).toBe(true)
    expect(bash(`case x in${NL}  *)${NL}    crontab -r${NL}    ;;${NL}esac`)).toBe(true)
    expect(bash('case x in *) sudo -n crontab -r;; esac')).toBe(true)
    expect(bash(`case x in *) bash -c ${Q}crontab -r${Q};; esac`)).toBe(true)
    expect(bash('coproc demo { crontab -r; }')).toBe(true)
  })
  it('what stays allowed: a read or an ordinary command in an arm, coproc of an ordinary command, prose, an argument after a substitution', () => {
    expect(bash('case x in *) crontab -l;; esac')).toBe(false)
    expect(bash('case x in start) echo ok;; *) ls;; esac')).toBe(false)
    expect(bash('coproc cat')).toBe(false)
    expect(bash('echo "case x in *) crontab -r;; esac"')).toBe(false)
    expect(bash('echo $(date) at now')).toBe(false)
  })
  it('a long heredoc body does not slow the arm reading down (the hook has 10 s, and a timed-out hook lets the call through)', () => {
    // measured 2026-09-30: a first version of the arm pattern backtracked quadratically over the blanked body,
    // 5812 ms on this 104 KB command against 15 ms now
    const cmd = `cat > /tmp/demo.txt <<${Q}EOF${Q}${NL}${('a'.repeat(79) + NL).repeat(1300)}EOF${NL}crontab -r`
    const t0 = performance.now()
    expect(bash(cmd)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

describe('ffc45c28: what stays allowed', () => {
  it('a read behind the wrapper, as without it', () => {
    expect(bash('sudo -n crontab -l')).toBe(false)
    expect(bash('sudo -u root launchctl list')).toBe(false)
    expect(bash('timeout 10 crontab -l')).toBe(false)
  })
  it('ordinary commands behind the same wrappers', () => {
    expect(bash('sudo -n true')).toBe(false)
    expect(bash(`sudo -u postgres psql -c ${Q}select 1${Q}`)).toBe(false)
    expect(bash('timeout 60 npx tsc --noEmit')).toBe(false)
  })
  it('prose that quotes the forms: echo, a commit message, a heredoc body', () => {
    expect(bash('echo "sudo -n crontab -r"')).toBe(false)
    expect(bash('git commit -m "gate: timeout 60 crontab -r"')).toBe(false)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}sudo -n crontab -r${NL}timeout 60 crontab -r${NL}EOF`)).toBe(false)
  })
})

describe('ffc45c28 (5): the heavy-run wrapper runs its command, so the gate reads through it', () => {
  // <wrapper> [--no-wait] [--label NAME] [--] <command>: the first word that is not one of its options is the
  // command. Before, the gate saw the wrapper as the command and `<wrapper> -- crontab -r` passed.
  it('a scheduler, a timer, a pane injection or a shell script behind it is denied', () => {
    expect(bash(`${W} -- crontab -r`)).toBe(true)
    expect(bash(`${W} -- systemd-run --user --on-active=60 /bin/true`)).toBe(true)
    expect(bash(`${W} crontab -r`)).toBe(true)
    expect(bash(`${W} --no-wait --label=demo crontab -r`)).toBe(true)
    expect(bash(`${W} --label demo -- at now`)).toBe(true)
    expect(bash(`/opt/tools/${W} -- crontab -r`)).toBe(true)
    expect(bash(`${W} -- systemctl --user enable --now demo-guard.timer`)).toBe(true)
    expect(bash(`${W} -- bash -c ${Q}crontab -r${Q}`)).toBe(true)
    expect(bash(`${W} -- bash <<${Q}EOF${Q}${NL}tmux send-keys -t demo go Enter${NL}EOF`)).toBe(true)
  })
  it('CONTROLS: a compile through it, a read of one own schedule, and a <wrapper>-ctl, which runs no command', () => {
    expect(bash(`${W} -- npm test`)).toBe(false)
    expect(bash(`${W} --label tsc -- npx tsc --noEmit`)).toBe(false)
    expect(bash(`${W} -- crontab -l`)).toBe(false)
    expect(bash(`${W}-ctl drain crontab -r`)).toBe(false)
    expect(bash(`${W}-ctl status`)).toBe(false)
  })
})
