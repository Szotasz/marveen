import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, heredocSpans, selfPaceShape } from '../../scripts/self-pace-gate.mjs'

// ffc45c28 (found in review): the PreToolUse hook fails OPEN after
// 10 s, so a gate that is slow on some input is a bypass for whatever that input carries. The
// words in front of a command word were read by overlapping regexes: `time ` x30000 + `true;
// crontab -r` (150 KB) took 10.05 s, and 40 option words of `sudo -u` over 20 s. They are read by
// a loop now (forEachCommandPosition). Every shape below was measured slow before this change
// (kimenet/ffc45c28 redos-meres-3/4); the limit is 1000 ms, and the decision is asserted too.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const Q = String.fromCharCode(39)
const BQ = String.fromCharCode(96)
const SCHED = 'true; crontab -r'
const timed = (command: string): { deny: boolean; ms: number } => {
  const t0 = performance.now()
  const deny = bash(command)
  return { deny, ms: performance.now() - t0 }
}
const within = (command: string, deny: boolean): void => {
  const r = timed(command)
  expect(r.deny).toBe(deny)
  expect(r.ms).toBeLessThan(1000)
}

describe('ffc45c28: a command position is read in linear time', () => {
  it('the tester input, and the same run of other prefix words', () => {
    within('time '.repeat(30000) + SCHED, true)
    within('sudo '.repeat(30000) + SCHED, true)
    within('nice '.repeat(30000) + SCHED, true)
    within('/usr/bin/time '.repeat(10000) + SCHED, true)
    within('then '.repeat(30000) + SCHED, true)
  })
  it('option words that take a value or none (exponential before)', () => {
    within('sudo ' + '-u '.repeat(40) + SCHED, true)
    within('time ' + '-o '.repeat(40) + SCHED, true)
    within('timeout ' + '-s '.repeat(40) + '60 ' + SCHED, true)
    within('xargs ' + '-n '.repeat(20000) + 'crontab -r', true)
    within('env ' + '-u '.repeat(20000) + 'crontab -r', true)
    within('flock ' + '-w '.repeat(20000) + 'f crontab -r', true)
  })
  it('runs of newlines, separators, keywords on their own lines and wrappers with their needed word', () => {
    within(NL.repeat(150000) + SCHED, true)
    within((' \t' + NL).repeat(50000) + SCHED, true)
    within(('then' + NL).repeat(30000) + SCHED, true)
    within(';'.repeat(150000) + 'crontab -r', true)
    within('|'.repeat(150000) + 'crontab -r', true)
    within('&'.repeat(150000) + 'crontab -r', true)
    within('flock f '.repeat(30000) + 'crontab -r', true)
    within('runuser -- '.repeat(30000) + 'crontab -r', true)
  })
  it('a start after every ( and backtick, and a case arm tried at each', () => {
    within('sudo('.repeat(30000) + SCHED, true)
    within('('.repeat(30000) + SCHED, true)
    within('$('.repeat(30000) + 'crontab -r', true)
    within(BQ.repeat(60000) + SCHED, true)
    within('(bash '.repeat(20000) + SCHED, true)
  })
  it('a heredoc body a shell runs', () => {
    within(`bash <<${Q}EOF${Q}${NL}` + ('then' + NL).repeat(30000) + `EOF${NL}crontab -r`, true)
    within('sudo -u a '.repeat(20000) + `bash <<${Q}EOF${Q}${NL}tmux send-keys -t x go Enter${NL}EOF`, true)
  })
})

describe('ffc45c28: the timer check (cc8e80d7) in linear time', () => {
  const unit = '~/.config/systemd/user'
  it('nested substitutions whose arguments each ran to the end of the segment: denied by the reading budget', () => {
    within('$(systemctl status '.repeat(20000) + 'demo.timer', true)
    within('$(systemctl enable '.repeat(20000) + ') demo.timer', true)
    within(BQ + 'systemctl status '.repeat(20000) + 'demo.timer', false)
  })
  it('many redirects, installers, open( calls and unit paths', () => {
    within(`> ${unit}/x `.repeat(20000), false)
    within(`cat > i.sh <<${Q}EOF${Q}${NL}x${NL}EOF${NL}`.repeat(5000) + 'bash i.sh', false)
    within(`cat > i.sh <<${Q}EOF${Q}${NL}`.repeat(5000) + 'bash i.sh demo.timer', false)
    within('demo.timer ' + 'open('.repeat(60000), false)
    within('open(p, ' + Q + 'w' + Q + ') demo.timer ' + 'systemd/user/'.repeat(20000) + 'x', false)
    within('tee ' + 'a '.repeat(20000) + `${unit}/demo.timer`, true)
    within('cp ' + 'demo.timer '.repeat(20000) + `${unit}/`, true)
  })
  it('a real command with several substitutions is far from the budget', () => {
    expect(bash('systemctl --user status $(systemctl --user list-timers --all | head -3) $(systemctl --user show -p Id demo-guard.timer)')).toBe(false)
  })
  it('the installer rule: every redirect on the line counts, and a file run by source, . or ./', () => {
    const body = `<<${Q}EOF${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}EOF${NL}`
    // before, only the first redirect of the line was read: here /dev/null, which is never run
    expect(bash(`cat 2>/dev/null > i.sh ${body}bash i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}source i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}. ./i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}chmod +x i.sh && ./i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}sh -e i.sh`)).toBe(true)
    // CONTROLS: parsed only, or never written (an opener inside another body is its text)
    expect(bash(`cat > i.sh ${body}bash -n i.sh`)).toBe(false)
    expect(bash(`cat > a.sh <<${Q}EOF${Q}${NL}cat > b.sh <<${Q}X${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}X${NL}EOF${NL}bash b.sh`)).toBe(false)
  })
})

describe('ffc45c28 on develop: the three A-then-B self-pace patterns in linear time', () => {
  // develop 6158290b's regexes as they were: the reference selfPaceShape must equal
  const OLD = [
    /\btmux\b[\s\S]*\b(send-keys|paste-buffer|run-shell|set-buffer)\b/i,
    /\b(nohup|setsid|disown)\b[\s\S]*\bclaude\b/i,
    /\bclaude\b[\s\S]*(?:^|[\s'"])\/loop(?=[\s'"]|$)/i,
  ]
  const old = (seg: string): boolean => OLD.some((re) => re.test(seg))
  it('the same answer as the old regexes, on hand-picked and 20000 generated segments', () => {
    const hand = ['tmux send-keys -t x go', 'nohup claude -p x', 'claude /loop 5m', 'claude -p "/loop x"',
      'ls ~/.claude/skills/loop/SKILL.md', 'tmux ls', 'claude /loopy', 'send-keys tmux', 'claude' + NL + '/loop',
      "claude'/loop'", '/loop claude', 'TMUX SEND-KEYS', 'setsid x claude']
    for (const seg of hand) expect(selfPaceShape(seg), seg).toBe(old(seg))
    // a fixed-seed generator over the words the patterns name and their near misses
    let seed = 20260930
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 }
    const T = ['tmux', 'send-keys', 'paste-buffer', 'run-shell', 'set-buffer', 'nohup', 'setsid', 'disown', 'claude', '/loop',
      "'/loop'", '"/loop"', '/loop-x', 'x/loop', 'tmuxx', 'xclaude', 'claude2', 'send-keysx', 'CLAUDE', 'Tmux', 'Send-Keys',
      '.claude', 'a', '-', '/', "'", '"']
    const SEP = [' ', '', NL, '\t', "'", '"', '/', '-']
    let yes = 0
    let differ = 0
    for (let i = 0; i < 20000; i++) {
      let seg = ''
      const k = 1 + Math.floor(rnd() * 8)
      for (let j = 0; j < k; j++) seg += T[Math.floor(rnd() * T.length)] + SEP[Math.floor(rnd() * SEP.length)]
      const want = old(seg)
      if (want) yes++
      if (selfPaceShape(seg) !== want) differ++
    }
    expect(differ).toBe(0)
    // both answers well represented, or the equivalence says little
    expect(yes).toBeGreaterThan(1000)
    expect(20000 - yes).toBeGreaterThan(1000)
  })
  it('a run of A with no B (quadratic before: 30000 claude 3.5 s)', () => {
    within('claude '.repeat(30000) + SCHED, true)
    within('tmux '.repeat(30000) + 'x', false)
    within('nohup '.repeat(30000) + 'x', false)
  })
})

describe('ffc45c28 on develop: the heredoc bodies found in one pass', () => {
  // develop 6158290b's regex as it was: the reference heredocSpans must equal, match for match
  const OLD_RX = /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2)([\s\S]*?)(^\s*\3\s*$)/gm
  const oldSpans = (s: string): unknown[] =>
    [...s.matchAll(OLD_RX)].map((m) => ({ offset: m.index, open: m[1], quote: m[2], body: m[4], close: m[5] }))
  const ch = (code: number): string => String.fromCharCode(code)
  it('the same matches as the old regex: its readings of a tag prefix, <<<, line breaks and whitespace lines', () => {
    const hand = [
      `cat <<EOF${NL}x${NL}EOF`, `cat <<EOF${NL}EOF`, `cat <<-EOF${NL}\tx${NL}\tEOF${NL}`, `cat <<${Q}EOF${Q}${NL}x${NL}EOF${NL}y`,
      `cat <<EOFX${NL}x${NL}EOF${NL}`, `cat <<<EOF${NL}x${NL}EOF`, `cat <<${Q}EOF${NL}x${NL}EOF`, `cat <<EOF${NL}x${NL}${NL}${NL}  EOF${NL}${NL}${NL}z`,
      `cat <<EOF\r${NL}x\r${NL}EOF\r${NL}`, `cat <<EOF\rx\rEOF\r`, `a <<A <<B${NL}x${NL}A${NL}y${NL}B${NL}`, `cat <<EOF${NL}x${NL}EOF x${NL}EOF${NL}`,
      `cat <<${NL}EOF${NL}x${NL}EOF`, `cat <<EOF`, `cat <<EOF   ${NL}${NL}  EOF`, `cat <<EOF${ch(0x2028)}x${ch(0x2028)}EOF${ch(0x2029)}y`,
      `cat <<EOF${NL}x${NL}${ch(0xa0)}EOF${ch(0xa0)}${NL}`, `<<<<<<EOF${NL}EOF`, `cat <<ABC${NL}AB${NL}A${NL}`, `cat <<${Q}ABC${Q}${NL}AB${NL}ABC${NL}`,
    ]
    for (const s of hand) expect(heredocSpans(s), JSON.stringify(s)).toEqual(oldSpans(s))
    let seed = 20260930
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 }
    const T = ['cat <<EOF', 'cat <<-EOF', `cat <<${Q}EOF${Q}`, 'cat <<"EOF"', 'cat <<EOFX', 'cat <<<EOF', 'cat <<E', 'bash <<X',
      `tee <<${Q}X`, '<<', 'EOF', '  EOF  ', '\tEOF', 'EOFX', 'EO', 'E', 'X', ' X ', 'x', '', ' ', '\t', '$(date)', 'a <<EOF <<X', 'EOF x']
    const BR = [NL, NL, NL, '\r' + NL, ' ', '']
    let withSpans = 0
    let differ = 0
    for (let i = 0; i < 20000; i++) {
      let s = ''
      const k = 1 + Math.floor(rnd() * 10)
      for (let j = 0; j < k; j++) s += T[Math.floor(rnd() * T.length)] + BR[Math.floor(rnd() * BR.length)]
      const want = oldSpans(s)
      if (want.length) withSpans++
      if (JSON.stringify(heredocSpans(s)) !== JSON.stringify(want)) differ++
    }
    expect(differ).toBe(0)
    expect(withSpans).toBeGreaterThan(1000)
    expect(20000 - withSpans).toBeGreaterThan(1000)
  })
  it('a run of unclosed openers (quadratic before: 20000 <<EOF lines 3.4 s, <<-EOF lines 4.6 s)', () => {
    within(`cat <<EOF${NL}`.repeat(20000) + 'crontab -r', true)
    within(`cat <<-EOF${NL}\t`.repeat(20000) + 'crontab -r', true)
    within(`cat <<${Q}EOF${Q} x${NL}`.repeat(20000) + 'crontab -r', true)
  })
})

describe('ffc45c28: what the loop reads that the regexes did not', () => {
  it('a wrapper by its path, and -- at the end of its options', () => {
    expect(bash('/usr/bin/env crontab -r')).toBe(true)
    expect(bash('/usr/bin/sudo -n crontab -r')).toBe(true)
    expect(bash('nice -- crontab -r')).toBe(true)
    expect(bash('sudo -- crontab -r')).toBe(true)
    expect(bash('timeout -- 60 crontab -r')).toBe(true)
  })
  it('prefix words in any order: an assignment in front of a wrapper with options', () => {
    expect(bash('A=1 sudo -u root crontab -r')).toBe(true)
    expect(bash('LC_ALL=C timeout 60 crontab -r')).toBe(true)
  })
  it('a script handed to a shell behind an assignment or a bare command', () => {
    expect(bash(`A=1 bash -c ${Q}crontab -r${Q}`)).toBe(true)
    expect(bash(`command bash -c ${Q}crontab -r${Q}`)).toBe(true)
  })
  it('a heredoc body fed to a shell behind a wrapper or a keyword (blanked on develop 3f336c2c)', () => {
    const body = `<<${Q}EOF${Q}${NL}tmux send-keys -t demo go Enter${NL}EOF`
    expect(bash(`timeout 60 bash ${body}`)).toBe(true)
    expect(bash(`sudo -u root bash ${body}`)).toBe(true)
    expect(bash(`setsid bash ${body}`)).toBe(true)
    expect(bash(`nice -n 5 bash ${body}`)).toBe(true)
    expect(bash(`for f in a; do bash ${body}${NL}done`)).toBe(true)
    expect(bash(`bash - "$(cat /tmp/demo-arg)" ${body}`)).toBe(true)
  })
})

describe('ffc45c28: controls', () => {
  it('a read of one own schedule behind the same wrappers stays allowed', () => {
    expect(bash('sudo -u root crontab -l')).toBe(false)
    expect(bash('timeout 60 crontab -l')).toBe(false)
    expect(bash('/usr/bin/env launchctl list')).toBe(false)
  })
  it('a heredoc body written to a file, and one a wrapped python runs, is not read as shell lines', () => {
    const body = `<<${Q}EOF${Q}${NL}tmux send-keys -t demo go Enter${NL}EOF`
    expect(bash(`sudo -u root tee /tmp/demo.txt ${body}`)).toBe(false)
    expect(bash(`timeout 60 cat > /tmp/demo.txt ${body}`)).toBe(false)
    // measured on the corpus (5 of 26653): prose in a python string, with a "$(...)" that makes
    // the quoting unresolvable, read as a shell line starting with `at`
    const py = `timeout 60 python3 - "$(cat /tmp/demo-arg)" <<${Q}PY${Q}${NL}txt = """${NL} at; this line is prose${NL}"""${NL}print(txt)${NL}PY`
    expect(bash(py)).toBe(false)
  })
  it('command -v only looks a scheduler up, and a word that only contains one is not it', () => {
    expect(bash('command -v crontab')).toBe(false)
    expect(bash('sudo -u root crontab-helper.sh')).toBe(false)
    expect(bash('timeout 60 netstat -an')).toBe(false)
  })
})
