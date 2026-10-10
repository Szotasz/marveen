import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, unwrapHeavyScope, HEAVY_WRAPPER, HEAVY_WRAPPER_DEFAULT, heavyWrapperName } from '../../scripts/self-pace-gate.mjs'

// 90a2257b (074645b4): an install's heavy-run wrapper (HEAVY_WRAPPER) starts every heavy
// compile in a foreground, memory-capped systemd scope. That ONE systemd-run form is allowed,
// exactly as written, with its GNU time tail; every other systemd-run stays denied, and
// the command behind the tail is judged as if it were run directly. Every case below is
// the real form with one deviation. Labels, sizes and paths are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const GATE = fileURLToPath(new URL('../../scripts/self-pace-gate.mjs', import.meta.url))
const Q = String.fromCharCode(39)
const BQ = String.fromCharCode(96)
// The install's heavy-run wrapper, as the gate resolved it (SELF_PACE_HEAVY_WRAPPER, default heavy-run).
const W: string = HEAVY_WRAPPER
const P = `systemd-run --user --scope --quiet --collect --slice=${W}.slice --unit=${W}-tsc-4242 -p MemoryMax=16G --`
const T = '/usr/bin/time -o /tmp/heavy-demo.txt -f %M'
const TAIL = `${T} npx tsc --noEmit`

describe('90a2257b: the one systemd-run form is allowed', () => {
  it('the exact form the heavy-run wrapper runs, with its /usr/bin/time tail', () => {
    expect(bash(`${P} ${TAIL}`)).toBe(false)
  })
  it('other labels and sizes of the same form (the label charset such a wrapper writes)', () => {
    expect(bash(P.replace(`${W}-tsc-4242`, `${W}-next-77`) + ` ${T} npx next build`)).toBe(false)
    expect(bash(P.replace(`${W}-tsc-4242`, `${W}-tsc.js-9_1`) + ` ${TAIL}`)).toBe(false)
    expect(bash(P.replace('MemoryMax=16G', 'MemoryMax=512M') + ` ${TAIL}`)).toBe(false)
  })
  it('after a separator, and inside a command substitution', () => {
    expect(bash(`cd /repo && ${P} ${TAIL} -p tsconfig.json`)).toBe(false)
    expect(bash(`echo start; ${P} ${TAIL} | tail -3`)).toBe(false)
    expect(bash(`X=$(${P} ${TAIL})`)).toBe(false)
  })
  it('the time file as the wrapper may pass it: a path, a plain variable, a quoted string of those', () => {
    for (const file of ['/tmp/heavy-demo.txt', '$TF', '${TF}', '"$TF"', '"${OUT}/rss.4242"', `${Q}/tmp/a b.txt${Q}`, 'rss.4242']) {
      expect(bash(`${P} /usr/bin/time -o ${file} -f %M npx tsc --noEmit`)).toBe(false)
    }
  })
})

describe('90a2257b: every other systemd-run stays denied', () => {
  it('the card: --on-active=60, no --scope, another slice, --timer-property', () => {
    expect(bash(P.replace('--collect', '--collect --on-active=60') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace(' --scope', '') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace(`${W}.slice`, 'other.slice') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace('--collect', '--collect --timer-property=AccuracySec=1s') + ` ${T} /bin/true`)).toBe(true)
  })
  it('every --on-* option, before or after the others', () => {
    for (const on of ['--on-active=60', '--on-calendar=hourly', '--on-boot=10', '--on-startup=5', '--on-unit-active=60', '--on-unit-inactive=60', '--on-clock-change', '--on-timezone-change']) {
      expect(bash(P.replace('--user', `--user ${on}`) + ` ${T} /bin/true`)).toBe(true)
      expect(bash(P.slice(0, -2) + `${on} -- ${T} /bin/true`)).toBe(true)
    }
  })
  it('another property instead of or next to MemoryMax', () => {
    expect(bash(P.replace('-p MemoryMax=16G', '-p RuntimeMaxSec=60') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace('-p MemoryMax=16G', '-p MemoryMax=16G -p RuntimeMaxSec=60') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace('-p MemoryMax=16G', '--property=MemoryMax=16G') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace('MemoryMax=16G', 'MemoryMax=infinity') + ` ${T} /bin/true`)).toBe(true)
  })
  it('another unit name, another order, no command after the tail', () => {
    expect(bash(P.replace(`--unit=${W}-tsc-4242`, '--unit=demo-job') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace('--user --scope', '--scope --user') + ` ${T} /bin/true`)).toBe(true)
    expect(bash(P)).toBe(true)
    expect(bash(`${P} ${T}`)).toBe(true)
    expect(bash(`${P} ${T} ; echo x`)).toBe(true)
  })
  it('a wrapper or a path in front of the binary, and a quoted option value', () => {
    expect(bash(`sudo ${P} ${T} /bin/true`)).toBe(true)
    expect(bash(`env A=1 ${P} ${T} /bin/true`)).toBe(true)
    expect(bash(`exec ${P} ${T} /bin/true`)).toBe(true)
    expect(bash(`/usr/bin/${P} ${T} /bin/true`)).toBe(true)
    expect(bash(P.replace(`--slice=${W}.slice`, `--slice="${W}.slice"`) + ` ${T} /bin/true`)).toBe(true)
  })
  it('another tail is not the form: none, no -o, another format, another time, an expansion in the file name', () => {
    for (const tail of [
      '',
      '/usr/bin/time',
      '/usr/bin/time -p',
      '/usr/bin/time -f %M',
      '/usr/bin/time -o /tmp/heavy-demo.txt -f %e',
      `/usr/bin/time -o /tmp/heavy-demo.txt -f ${Q}%M${Q}`,
      '/usr/bin/time -a -o /tmp/heavy-demo.txt -f %M',
      'time -o /tmp/heavy-demo.txt -f %M',
      '/bin/time -o /tmp/heavy-demo.txt -f %M',
      '/usr/bin/time -o "$(mktemp)" -f %M',
      '/usr/bin/time -o $(mktemp) -f %M',
      `/usr/bin/time -o ${BQ}mktemp${BQ} -f %M`,
      '/usr/bin/time -o "${TF:-/tmp/x}" -f %M',
      '/usr/bin/time -o /tmp/x$(date +%s) -f %M',
    ]) {
      expect(bash(`${P} ${tail} npx tsc --noEmit`.replace('  ', ' '))).toBe(true)
    }
  })
})

describe('90a2257b: the command behind the tail is judged as if run directly', () => {
  it('the real form with a scheduler behind it is denied', () => {
    const t = '/usr/bin/time -o f -f %M'
    expect(bash(`${P} ${t} crontab -r`)).toBe(true)
    expect(bash(`${P} ${t} at now < x`)).toBe(true)
    expect(bash(`${P} ${t} systemd-run --user --on-active=60 true`)).toBe(true)
    expect(bash(`${P} ${t} systemctl --user enable --now x.timer`)).toBe(true)
    expect(bash(`cd /repo && ${P} ${T} crontab -r`)).toBe(true)
  })
  it('a timer armed, or a pane injected, behind the tail is denied', () => {
    expect(bash(`${P} ${T} systemctl --user enable --now demo-guard.timer`)).toBe(true)
    expect(bash(`${P} ${T} tmux send-keys -t demo ${Q}go${Q} Enter`)).toBe(true)
  })
  it('a read behind the tail stays allowed, as it is without the prefix', () => {
    expect(bash(`${P} ${T} crontab -l`)).toBe(false)
    expect(bash('crontab -l')).toBe(false)
  })
  it('the gate gives the same answer with the form as without it, for any command behind it', () => {
    for (const inner of [
      'crontab -r', 'crontab -l', 'at now < x', 'atq', 'systemd-run --user --on-active=60 true',
      'systemctl --user enable --now x.timer', 'systemctl --user status x.timer', 'npx tsc --noEmit',
      `tmux send-keys -t demo ${Q}go${Q} Enter`, 'npm run build && crontab -r', 'echo ok',
      `bash <<${Q}EOF${Q}${NL}tmux send-keys -t demo ${Q}go${Q} Enter${NL}EOF`,
      `cat > i.sh <<${Q}EOF${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}EOF${NL}bash i.sh`,
    ]) {
      expect(bash(`${P} ${T} ${inner}`), inner).toBe(bash(inner))
    }
  })
})

describe('90a2257b on develop 3f336c2c: a heredoc behind the tail is read as the command runs it', () => {
  // develop blanks a heredoc body unless the command owning the redirect runs it; the
  // owner behind the form is the command the scope runs, not systemd-run
  it('a heredoc fed to a shell, and an installer written and run in the same command', () => {
    expect(bash(`${P} ${T} bash <<${Q}EOF${Q}${NL}tmux send-keys -t demo ${Q}go${Q} Enter${NL}EOF`)).toBe(true)
    expect(bash(`${P} ${T} cat > i.sh <<${Q}EOF${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}EOF${NL}bash i.sh`)).toBe(true)
  })
  it('CONTROLS: the same bodies written to a file and not run are data', () => {
    expect(bash(`${P} ${T} cat > n.txt <<${Q}EOF${Q}${NL}tmux send-keys -t demo ${Q}go${Q} Enter${NL}EOF`)).toBe(false)
    expect(bash(`${P} ${T} cat > i.sh <<${Q}EOF${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}EOF`)).toBe(false)
  })
})

describe('90a2257b: the form is read in linear time (the hook fails open after 10 s)', () => {
  const timed = (command: string): { deny: boolean; ms: number } => {
    const t0 = performance.now()
    const deny = bash(command)
    return { deny, ms: performance.now() - t0 }
  }
  it('variables in the time file, with a tail that is not the form: each split of the names was retried', () => {
    for (const file of ['$AA'.repeat(28), `"${'$AA'.repeat(28)}`]) {
      const r = timed(`${P} /usr/bin/time -o ${file} -f %N true; systemd-run --on-active=60 x`)
      expect(r.deny).toBe(true)
      expect(r.ms).toBeLessThan(1000)
    }
  })
  it('a run of keyword lines with no form after it: every line was read to the end again', () => {
    const none = timed(('then' + NL).repeat(60000) + 'true')
    expect(none.deny).toBe(false)
    expect(none.ms).toBeLessThan(1000)
    const other = timed(('then' + NL).repeat(60000) + 'systemd-run --user --scope true')
    expect(other.deny).toBe(true)
    expect(other.ms).toBeLessThan(1000)
    const ok = timed(('then' + NL).repeat(30000) + `${P} ${T} npx tsc --noEmit`)
    expect(ok.deny).toBe(false)
    expect(ok.ms).toBeLessThan(1000)
    const bad = timed(('then' + NL).repeat(30000) + `${P} ${T} crontab -r`)
    expect(bad.deny).toBe(true)
    expect(bad.ms).toBeLessThan(1000)
  })
  it('a variable name is read whole, and the form with variables in the file name still unwraps', () => {
    expect(bash(`${P} /usr/bin/time -o $AA$BB$CC -f %M npx tsc --noEmit`)).toBe(false)
    expect(bash(`${P} /usr/bin/time -o "$HEAVY_FILE" -f %M npx tsc --noEmit`)).toBe(false)
    expect(bash(`${P} /usr/bin/time -o $AA$BB$CC -f %M crontab -r`)).toBe(true)
  })
})

describe('90a2257b: controls', () => {
  it('prose that quotes the form stays allowed, even with a scheduler after it', () => {
    expect(bash(`echo "${P} ${T} crontab -r"`)).toBe(false)
    expect(bash(`git commit -m "gate: ${P} ${T} crontab -r"`)).toBe(false)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}${P} ${T} crontab -r${NL}EOF`)).toBe(false)
  })
  it('unwrapHeavyScope replaces the exact prefix with its tail, and leaves any other command byte for byte', () => {
    expect(unwrapHeavyScope(`cd /repo && ${P} ${TAIL}`)).toBe('cd /repo && ; npx tsc --noEmit')
    for (const cmd of [
      `${P.replace(' --scope', '')} ${T} /bin/true`,
      `sudo ${P} ${T} /bin/true`,
      `echo "${P} ${T} x"`,
      `${P} /bin/true`,
      `${P} /usr/bin/time -o "$(mktemp)" -f %M /bin/true`,
      'systemctl --user status demo-guard.timer',
      `${P}`,
    ]) {
      expect(unwrapHeavyScope(cmd)).toBe(cmd)
    }
  })
})

describe('ffc45c28: the heavy-run wrapper name is an install setting', () => {
  it('the environment first, then the install .env, then the generic default', () => {
    expect(HEAVY_WRAPPER_DEFAULT).toBe('heavy-run')
    expect(heavyWrapperName({}, '')).toBe(HEAVY_WRAPPER_DEFAULT)
    expect(heavyWrapperName({ SELF_PACE_HEAVY_WRAPPER: 'my-heavy' }, 'SELF_PACE_HEAVY_WRAPPER=from-file')).toBe('my-heavy')
    expect(heavyWrapperName({}, `A=1${NL}SELF_PACE_HEAVY_WRAPPER=from-file${NL}B=2`)).toBe('from-file')
    expect(heavyWrapperName({}, 'SELF_PACE_HEAVY_WRAPPER="quoted.name"')).toBe('quoted.name')
    expect(heavyWrapperName({ SELF_PACE_HEAVY_WRAPPER: '  spaced  ' }, '')).toBe('spaced')
  })
  it('a name that cannot go into a regex or a unit name falls through to the next source', () => {
    for (const bad of ['', ' ', 'a b', 'x;y', 'a/b', '$(id)', 'x'.repeat(41), 'h\u00e9avy', 'a*b']) {
      expect(heavyWrapperName({ SELF_PACE_HEAVY_WRAPPER: bad }, ''), bad).toBe(HEAVY_WRAPPER_DEFAULT)
      expect(heavyWrapperName({ SELF_PACE_HEAVY_WRAPPER: bad }, 'SELF_PACE_HEAVY_WRAPPER=ok-name'), bad).toBe('ok-name')
      expect(heavyWrapperName({}, `SELF_PACE_HEAVY_WRAPPER=${bad}`), bad).toBe(HEAVY_WRAPPER_DEFAULT)
    }
  })
  it('the hook run with a configured name reads that wrapper and accepts that scope, not the default one', () => {
    const hook = (command: string, name: string): boolean => {
      const r = spawnSync(process.execPath, [GATE], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        env: { ...process.env, SELF_PACE_HEAVY_WRAPPER: name },
        encoding: 'utf-8',
      })
      expect(r.status).toBe(0)
      return r.stdout.includes('"permissionDecision":"deny"')
    }
    const scope = (n: string): string =>
      `systemd-run --user --scope --quiet --collect --slice=${n}.slice --unit=${n}-tsc-1 -p MemoryMax=1G -- /usr/bin/time -o f -f %M`
    expect(hook('demo-heavy -- crontab -r', 'demo-heavy')).toBe(true)
    expect(hook('demo-heavy --label tsc -- npx tsc --noEmit', 'demo-heavy')).toBe(false)
    expect(hook(`${scope('demo-heavy')} npx tsc --noEmit`, 'demo-heavy')).toBe(false)
    expect(hook(`${scope('demo-heavy')} crontab -r`, 'demo-heavy')).toBe(true)
    // the default's scope is not the form once another name is configured
    expect(hook(`${scope(HEAVY_WRAPPER_DEFAULT)} npx tsc --noEmit`, 'demo-heavy')).toBe(true)
    // CONTROL: the same scope with the default name is the form when nothing else is configured
    expect(hook(`${scope(HEAVY_WRAPPER_DEFAULT)} npx tsc --noEmit`, HEAVY_WRAPPER_DEFAULT)).toBe(false)
  })
})
