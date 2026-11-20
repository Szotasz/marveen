// Card 47eeb016 (APPROVALDBGATE1030): the write+chmod pair and env-assignment
// false denials of scripts/hooks/db-write-gate.mjs (chmod is not a run, an env
// assignment value is not a run), the red controls, and the db-write-gate deadline pins.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let base: string
let root: string // the fake install
function scaffold(dir: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}')
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}')
  writeFileSync(join(dir, 'scripts', 'hooks', 'db-write-gate.mjs'), '')
  writeFileSync(join(dir, 'scripts', 'hooks', 'other.mjs'), '// DECISION\n')
  writeFileSync(join(dir, 'scripts', 'self-pace-gate.mjs'), '')
  writeFileSync(join(dir, 'store', 'config-overrides.json'), '{}')
  writeFileSync(join(dir, 'store', 'github-token.token'), 'x')
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'db-write-gate-')))
  root = join(base, 'Install')
  scaffold(root)
  mkdirSync(join(base, 'scratch'))
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

// @ROOT@ = the install (protected), @S@ = a scratch dir outside it
const bash = (command: string) =>
  gateDecision('Bash', { command: command.replaceAll('@ROOT@', root).replaceAll('@S@', join(base, 'scratch')) }, { cwd: root, root })
const ALLOW = { deny: false }
const isDeny = (r: { deny: boolean }) => r.deny === true

// Deadline pins: the FAULT_INJECT_HANG preload shape of governance-gates.test.ts, run against the real hook entry.
const PRELOAD = [
  'const orig = RegExp.prototype.test',
  'RegExp.prototype.test = function (s) {',
  "  if (String(s).includes('FAULT_INJECT_HANG')) { for (;;) {} }",
  '  return orig.call(this, s)',
  '}',
].join('\n')
const hangReason = (src: string, envVar: string, ms: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-deadline-'))
  try {
    const preload = join(dir, 'fault.mjs')
    writeFileSync(preload, PRELOAD)
    const r = spawnSync(process.execPath, ['--import', preload, src], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo FAULT_INJECT_HANG' } }),
      encoding: 'utf-8',
      timeout: 50_000,
      env: { ...process.env, [envVar]: ms },
    })
    const out = JSON.parse(r.stdout || '{}')?.hookSpecificOutput
    return { decision: out?.permissionDecision, reason: String(out?.permissionDecisionReason ?? ''), status: r.status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const WRITE = String.raw`S=@S@; printf '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) cat @ROOT@/store/github-token.token;; esac\n' > $S/askpass.sh`
const WRITE_SAFE = String.raw`S=@S@; printf '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) cat /etc/hostname;; esac\n' > $S/askpass.sh`
const RED_WRITE = (tail: string) =>
  String.raw`S=@S@; printf 'echo hi > @ROOT@/.claude/settings.json\n' > $S/a.sh; ` + tail

const GREEN_P = (tail: string) =>
  String.raw`S=@S@; printf 'echo hi > @ROOT@/.claude/settings.json\n' > $S/a.sh; ` + tail

describe('db-write-gate: written file + later chmod / env assignment (47eeb016)', () => {
  const green: Record<string, string> = {
    E1: WRITE,
    E2: WRITE + '; chmod 700 $S/askpass.sh',
    E3: WRITE_SAFE + '; chmod 700 $S/askpass.sh',
    E4: 'S=@S@; chmod 700 $S/askpass.sh',
    P4: GREEN_P('env -S "echo hi"'),
    P5: GREEN_P('env -u X true'),
    P6: GREEN_P('env -uS true'),
    P7: GREEN_P('env -C /tmp true'),
    P8: GREEN_P('env -S "A=1" true'),
    P10: GREEN_P('env -S "echo hi" true'),
    P15: GREEN_P('env nice cat < $S/a.sh'),
    P16: GREEN_P(`env nice cat < ''$S/a.sh`),
    CTRL1: String.raw`S=@S@; printf 'cat @ROOT@/store/github-token.token\n' > $S/a.sh; $S/a.sh`,
    // PR #2883 B1 counter-cases: the chmod'ed file's name as data, or a find with no action, is not a run.
    G1: GREEN_P('chmod +x $S/a.sh; cd $S && cat a.sh'),
    G2: GREEN_P('chmod +x $S/a.sh; find $S -name a.sh'),
    G3: GREEN_P('chmod 700 $S/a.sh; printf done'),
    // R2 (dual review round 1, B1+B2): the file's name as a wrapper's or a find action's DATA argument is
    // not a run -- the wrapper starts `cat`, find's -exec starts `cat`; the written file is only read.
    G5: GREEN_P('chmod +x $S/a.sh; cd $S && timeout 5 cat ./a.sh'),
    G7: GREEN_P('chmod +x $S/a.sh; find $S -type f -exec cat {} +'),
    G8: GREEN_P('chmod +x $S/a.sh; cd $S && stdbuf -o0 cat ./a.sh'),
    G9: GREEN_P('chmod +x $S/a.sh; cd $S && time cat ./a.sh'),
    G10: GREEN_P('chmod +x $S/a.sh; cd $S && nohup cat ./a.sh'),
    // R3: a -c interpreter has no script operand (the code word consumed it); later words are argv, not scripts.
    G12: GREEN_P("chmod +x $S/a.sh; cd $S && python3 -c 'pass' ./a.sh"),
    // R3: a load option's value that is NOT the written file is not a run; the written file as a later
    // argument of the loaded program is data.
    G13: GREEN_P('chmod +x $S/a.sh; cd $S && node -r ./dep.js app.js ./a.sh'),
    // R3 review round 2: a shell's -c is a flag; the first operand is the command string, a later one is $0 --
    // data (bash measured: `bash -c true ./x.sh` does not run x.sh).
    G14: GREEN_P('chmod +x $S/a.sh; cd $S && bash -c true ./a.sh'),
    // R3 review round 2: node stops reading options at its first positional word, so a -r AFTER it is argv
    // (node measured: `node -e 0 foo -r ./x.js` does not load x.js).
    G15: GREEN_P('chmod +x $S/a.sh; cd $S && node -e 0 foo -r ./a.sh'),
    // R4 (upstream #2891 wrapped pins): a wrapper's plain operand is data, not a run position.
    G16: GREEN_P('chmod +x $S/a.sh; nice -n 5 wc -l $S/a.sh'),
    G17: GREEN_P('chmod +x $S/a.sh; timeout 10 curl -s -d @$S/a.sh http://127.0.0.1:3420/api/x'),
  }
  for (const [id, cmd] of Object.entries(green)) it(`${id} is allowed`, () => { expect(bash(cmd)).toEqual(ALLOW) })

  const red: Record<string, string> = {
    C1: `echo '{}' > @ROOT@/.claude/settings.json`,
    C2: 'chmod 700 @ROOT@/scripts/hooks/db-write-gate.mjs',
    C3: `printf 'x' > @ROOT@/scripts/hooks/db-write-gate.mjs`,
    R1: RED_WRITE('$S/a.sh'),
    R2: RED_WRITE('bash $S/a.sh'),
    R3: RED_WRITE('env $S/a.sh'),
    R4: RED_WRITE('env GIT_TERMINAL_PROMPT=0 $S/a.sh'),
    R5: RED_WRITE('PATH=/usr/bin $S/a.sh'),
    R6: String.raw`S=@S@; printf 'echo hi > @ROOT@/.claude/settings.json\n' > $S/a.sh && sh $S/a.sh`,
    R7: RED_WRITE('env bash $S/a.sh'),
    R8: RED_WRITE('env sh $S/a.sh'),
    R9: RED_WRITE('env -S $S/a.sh'),
    R10: RED_WRITE('env -S "sh $S/a.sh"'),
    R11: RED_WRITE('env --split-string "sh $S/a.sh"'),
    R12: RED_WRITE('env BASH_ENV="$S/a.sh" bash -c :'),
    R13: RED_WRITE('env ENV="$S/a.sh" sh -c :'),
    R14: RED_WRITE('env -S"sh $S/a.sh"'),
    R15: RED_WRITE('env -S "-i sh $S/a.sh"'),
    R16: RED_WRITE('env -S "A=1 sh $S/a.sh"'),
    R17: RED_WRITE('env -a foo sh $S/a.sh'),
    R18: RED_WRITE('env -f /dev/null sh $S/a.sh'),
    R19: RED_WRITE('env --argv0 foo sh $S/a.sh'),
    R20: RED_WRITE('env --split "sh $S/a.sh"'),
    R21: RED_WRITE('env -iu X sh $S/a.sh'),
    R22: RED_WRITE(`env -S "sh -c 'true; $S/a.sh'"`),
    R23: RED_WRITE('env env sh $S/a.sh'),
    R24: RED_WRITE('env /usr/bin/env sh $S/a.sh'),
    R25: RED_WRITE('env xargs sh $S/a.sh'),
    R26: RED_WRITE('env bash -o errexit $S/a.sh'),
    R27: RED_WRITE(`env python3 -c"import os;os.system('sh $S/a.sh')"`),
    R28: RED_WRITE('env -S sh < $S/a.sh'),
    R29: RED_WRITE('env -- env sh $S/a.sh'),
    R30: RED_WRITE('env BASH_ENV=$S/a.sh env bash -c :'),
    R31: RED_WRITE('env ENV=$S/a.sh env sh -c :'),
    R32: RED_WRITE('env BASH_ENV=$S/a.sh env env bash -c :'),
    R33: RED_WRITE('env nice sh $S/a.sh'),
    R34: RED_WRITE('env timeout 5 sh $S/a.sh'),
    R35: RED_WRITE('env BASH_ENV=$S/a.sh nice bash -c :'),
    R36: RED_WRITE('env parallel sh ::: $S/a.sh'),
    R37: RED_WRITE('env nice -n 5 timeout 5 env sh $S/a.sh'),
    R38: RED_WRITE('env NODE_OPTIONS=--require=$S/a.sh node -e 1'),
    R39: RED_WRITE('env PERL5OPT=-M$S/a.sh nice perl -e 1'),
    R40: RED_WRITE('env NODE_OPTIONS=--require=$S/a.sh env -u X node -e 1'),
    R41: RED_WRITE('env nice sh < $S/a.sh'),
    R42: RED_WRITE('env timeout 5 bash < $S/a.sh'),
    R43: RED_WRITE(`env NODE_OPTIONS=--require=$S/a.sh timeout 5 env -S 'node -e 1'`),
    R44: RED_WRITE(`env nice sh < ''$S/a.sh`),
    R45: RED_WRITE(`env sh < ''$S/a.sh`),
    R46: RED_WRITE(`env nice sh < ""$S/a.sh`),
    R47: RED_WRITE(`env nice sh < ''"$S/a.sh"`),
    R48: RED_WRITE(`env nice sh <''$S/a.sh`),
    R49: RED_WRITE(`env nice sh < ""''$S/a.sh`),
    R50: RED_WRITE(`env nice sh < $''$S/a.sh`),
    R51: RED_WRITE(`env nice sh < $S''/a.sh`),
    R52: RED_WRITE(`sh < ''$S/a.sh`),
    'R3b (env -u X)': RED_WRITE('env -u X GIT_TERMINAL_PROMPT=0 $S/a.sh'),
    // PR #2883 review B1: chmod is not a run, but these run the chmod'ed file without its spelled path as the
    // command word (the base gate denied them through the chmod pairing).
    B1a: RED_WRITE('chmod +x $S/a.sh; cd $S && ./a.sh'),
    B1b: RED_WRITE(String.raw`chmod +x $S/a.sh; find $S -name a.sh -exec {} \;`),
    B1c: RED_WRITE('chmod +x $S/a.sh; timeout 5 $S/a.sh'),
    B1d: RED_WRITE('chmod +x $S/a.sh; nohup $S/a.sh'),
    B1e: RED_WRITE('chmod +x $S/a.sh; command $S/a.sh'),
    B1f: RED_WRITE(String.raw`chmod +x $S/a.sh; find $S -name 'a*' -execdir {} \;`),
    // The run position comes after the leading assignments.
    B1g: RED_WRITE('chmod +x $S/a.sh; cd $S && X=1 ./a.sh'),
    // PR #2883 review N1: env's command word holds the absolutely spelled target inside a longer path
    // (`./<abs path>` after `cd /`), the cmd.includes(t) half of envRunsTarget.
    N1: String.raw`printf 'echo hi > @ROOT@/.claude/settings.json\n' > @S@/a.sh; chmod +x @S@/a.sh; cd / && env .@S@/a.sh`,
    // R2 B1: the wrapper's EXECUTABLE is the word after its options (and timeout's duration operand);
    // option values (-n 5, -u root, -s KILL) and data arguments are not run positions.
    B1h: RED_WRITE('chmod +x $S/a.sh; cd $S && timeout 5 ./a.sh'),
    B1i: RED_WRITE('chmod +x $S/a.sh; cd $S && nice -n 5 ./a.sh'),
    B1j: RED_WRITE('chmod +x $S/a.sh; cd $S && sudo -u root ./a.sh'),
    B1k: RED_WRITE('chmod +x $S/a.sh; cd $S && timeout -s KILL 5 ./a.sh'),
    // R2 B2: find's -exec family runs the found file when the command word IS '{}' or an interpreter
    // that receives '{}' as an operand.
    B1l: RED_WRITE(String.raw`chmod +x $S/a.sh; find $S -name a.sh -exec sh {} \;`),
    // R2: an interpreter -- directly, or as the word a wrapper or env starts -- runs its relative script word.
    B1m: RED_WRITE('chmod +x $S/a.sh; cd $S && bash ./a.sh'),
    B1n: RED_WRITE('chmod +x $S/a.sh; cd $S && timeout 5 bash ./a.sh'),
    B1o: RED_WRITE('chmod +x $S/a.sh; cd $S && env X=1 timeout 5 ./a.sh'),
    // R2 findClauseWords: an unresolved `$var` from an -exec action word on could BE the command find executes;
    // the conservative re-split must refuse the clause (deny), not resolve nothing and allow.
    B1p: RED_WRITE('chmod +x $S/a.sh; find $S -name a.sh -exec $CMD {} \\;'),
    // R3 (dual review round 1, csani B1): an interpreter option's VALUE must not be taken for the script
    // operand -- -O/-o consume one word, the written file after them still runs.
    B1q: RED_WRITE('chmod +x $S/a.sh; cd $S && bash -O extglob ./a.sh'),
    // R3: the same shape with the path spelled (the named branch's script rule had the same flaw).
    B1q2: RED_WRITE('chmod +x $S/a.sh; bash -O extglob $S/a.sh'),
    B1q3: RED_WRITE('chmod +x $S/a.sh; cd $S && bash -o errexit ./a.sh'),
    // R3 (mutant L survived without it): a target written WITHOUT a slash is no relative-run word, so only the
    // named branch sees it -- its option walk must not take the -O value for the script either.
    B1q4: String.raw`S=@S@; cd $S && printf 'echo hi > @ROOT@/.claude/settings.json\n' > a.sh; bash -O extglob a.sh`,
    // R3 (round 1, both reviewers): a command wrapper INSIDE a find action runs the found file -- find
    // starts timeout, timeout executes {} after its duration operand.
    B1r: RED_WRITE(String.raw`chmod +x $S/a.sh; find $S -name a.sh -exec timeout 5 {} \;`),
    B1r2: RED_WRITE('chmod +x $S/a.sh; find $S -name a.sh -exec timeout 5 {} +'),
    // R3: the same through an env-wrapped wrapper in the action (env assignments, then timeout, then {}).
    B1s: RED_WRITE(String.raw`chmod +x $S/a.sh; find $S -name a.sh -exec env X=1 timeout 5 {} \;`),
    // R3: a load option's VALUE executes (node -r requires and runs the file): the written file there is a run.
    B1t: RED_WRITE('chmod +x $S/a.sh; cd $S && node -r ./a.sh app.js'),
    // R3 review round 2 (csani B1): a shell's -c is a FLAG, also inside a cluster or before other flags; the
    // first operand is the command string and runs (bash measured: -ce, -c -e and -co errexit all run x.sh).
    B1u: RED_WRITE('chmod +x $S/a.sh; cd $S && bash -ce ./a.sh'),
    B1u2: RED_WRITE('chmod +x $S/a.sh; cd $S && bash -c -e ./a.sh'),
    B1u3: RED_WRITE('chmod +x $S/a.sh; cd $S && bash -co errexit ./a.sh'),
    // R3 review round 2 (csani B2, a1 B1): a CODE value does not end node's option parsing -- a later -r still
    // loads and runs its file (node measured: `node -e 0 -r ./x.js` and `node -p 1 -r ./x.js` run x.js).
    B1v: RED_WRITE('chmod +x $S/a.sh; cd $S && node -e 0 -r ./a.sh'),
    B1v2: RED_WRITE('chmod +x $S/a.sh; cd $S && node -p 1 -r ./a.sh'),
    // The long forms too (node measured: `node --eval 0 --require ./x.js` runs x.js; R3b battery mutant N2L).
    B1v3: RED_WRITE('chmod +x $S/a.sh; cd $S && node --eval 0 --require ./a.sh'),
    B1w: RED_WRITE(String.raw`chmod +x $S/a.sh; find $S -name a.sh -exec node -e 0 -r {} \;`),
    // R4 (moved from green): upstream #2891 (found in review of #2883) keeps an env-value reference to a written
    // file denied; we follow the maintainer's merged direction (47eeb016 R4).
    P13: GREEN_P('env NODE_OPTIONS=--require=$S/a.sh nice true'),
    P14: GREEN_P('env BASH_ENV=$S/a.sh nice true'),
    P17: GREEN_P('env ENV=$S/a.sh timeout 5 true'),
    // R5 (moved from green): develop's #2934 (GATEPATHNORM1118 b-d) reads an assignment value that names the written
    // file as a run (GIT_ASKPASS, PAGER, EDITOR and the like do run it), and a find -exec action whose -name or path
    // reaches the file as a run, whatever the action is. We follow the maintainer's merged direction (47eeb016 R5).
    // E0 is the askpass push the card started from: git really runs the askpass, and its text names the token file.
    E0: WRITE + '; chmod 700 $S/askpass.sh; env -u GIT_DIR -u GIT_WORK_TREE GIT_ASKPASS=$S/askpass.sh GIT_TERMINAL_PROMPT=0 git -C @S@ push https://github.com/o/r.git aefc6054:refs/heads/feat/x 2>&1 | tail -3; shred -u $S/askpass.sh',
    P3: String.raw`S=@S@; printf 'echo hi > @ROOT@/.claude/settings.json\n' > $S/a.sh; env X="$S/a.sh" true`,
    P9: GREEN_P('env GIT_ASKPASS=$S/a.sh env -u X git status'),
    P11: GREEN_P('env X=$S/a.sh nice true'),
    P12: GREEN_P('env X=$S/a.sh timeout 5 git status'),
    G4: GREEN_P('chmod +x $S/a.sh; X=$S/a.sh true'),
    G6: GREEN_P(String.raw`chmod +x $S/a.sh; find $S -name a.sh -exec echo found \;`),
    G11: GREEN_P('chmod +x $S/a.sh; find $S -name a.sh -exec sh /dev/null {} +'),
  }
  for (const [id, cmd] of Object.entries(red)) it(`${id} is denied`, () => { expect(isDeny(bash(cmd))).toBe(true) })

  it('a script-rule denial names the written file and the protected name in its deny message (Fix 4)', () => {
    expect(isDeny(bash(RED_WRITE('bash $S/a.sh')))).toBe(true)
    // 47eeb016: the verdict object carries no detail field, so the pair is asserted on the deny MESSAGE the real
    // hook entry builds (INSTALL_FILE_GATE_MSG + the Fix-4 suffix). The protected target is this repo's own
    // .claude/settings.json; the hook only reads the command text, it never runs it.
    const scratch = join(base, 'scratch')
    const command = String.raw`printf 'echo hi > ${REPO}/.claude/settings.json\n' > ${scratch}/a.sh; bash ${scratch}/a.sh`
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'hooks', 'db-write-gate.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 50_000,
    })
    const out = JSON.parse(r.stdout || '{}')?.hookSpecificOutput
    expect(out?.permissionDecision).toBe('deny')
    expect(String(out?.permissionDecisionReason ?? '')).toContain('a.sh')
    expect(String(out?.permissionDecisionReason ?? '')).toContain('settings.json')
    expect(String(out?.permissionDecisionReason ?? '')).toContain(' [written file treated as run: ')
  }, 60_000)
})

describe('db-write-gate deadline: env can raise it, ceiling 30000 ms (47eeb016)', () => {
  const SRC = join(REPO, 'scripts', 'hooks', 'db-write-gate.mjs')
  it('DB_WRITE_GATE_DEADLINE_MS=7000 raises the deadline above 5000', () => {
    const r = hangReason(SRC, 'DB_WRITE_GATE_DEADLINE_MS', '7000')
    expect(r.decision, JSON.stringify(r)).toBe('deny')
    expect(r.reason).toContain('7000 ms')
  }, 60_000)
  it('DB_WRITE_GATE_DEADLINE_MS=60000 is clamped to 30000', () => {
    const r = hangReason(SRC, 'DB_WRITE_GATE_DEADLINE_MS', '60000')
    expect(r.decision, JSON.stringify(r)).toBe('deny')
    expect(r.reason).toContain('30000 ms')
  }, 60_000)
})
