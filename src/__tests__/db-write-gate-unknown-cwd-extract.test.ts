// UNKCWDEXTRACT1121: after a directory change the gate cannot follow (`cd "$X"`, `cd $(...)`,
// `cd -`, `popd`), an extracting program with no target directory (tar -x, unzip, patch, cpio -i, 7z x) writes into a
// directory the gate does not know, and a relative extract target (`tar -x -C .`) is relative to it. The install's own
// rule says such an extract is denied in the root or under scripts/; with the directory unknown that cannot be ruled out,
// so it is denied (fail closed, as WRITEGATERELPATH1115 reads a relative word after such a cd). Decisions only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let sp: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'unk-cwd-')))
  root = join(base, 'Install')
  sp = join(base, 'scratch')
  mkdirSync(join(root, 'agents', 'samu'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(join(sp, 'fc'), { recursive: true })
  mkdirSync(join(sp, 'ctx'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const cwd = () => join(root, 'agents', 'samu')
const bash = (c: string, subAgent = false) => gateDecision('Bash', { command: c }, { root, cwd: cwd(), subAgent, projectDir: subAgent ? cwd() : root, configDir: null })
const PASS = { deny: false }
const both = (c: string) => [bash(c, true), bash(c, false)]

describe('UNKCWDEXTRACT1121: a target-less extract after an unknown directory change is denied', () => {
  // RED on the base: every case passes there (measured af5c-j2). Mutation Ma (the unknown-cwd clause dropped) -> red.
  it('U1-U11 a target-less extractor after a cd the gate cannot follow, for a sub-agent and the main agent', () => {
    const cases: [string, string][] = [
      ['U1 cd "$X" && tar -x', 'cd "$X" && tar -x < /tmp/a.tar'],
      ['U2 cd $X && unzip', 'cd $X && unzip /tmp/a.zip'],
      ['U3 cd $X && patch', 'cd $X && patch -p1 < /tmp/p.diff'],
      ['U4 cd $X && cpio -i', 'cd $X && cpio -i < /tmp/a.cpio'],
      ['U6 cd $(cat ..) && tar -x', 'cd $(cat /tmp/w) && tar -x < /tmp/a.tar'],
      ['U7 S=<root>/scripts/hooks; cd $S && tar -xf', `S=${root}/scripts/hooks; cd $S && tar -xf /tmp/a.tar`],
      ['U8 S=<root>/scripts; cd $S/hooks && tar -x', `S=${root}/scripts; cd $S/hooks && tar -x < /tmp/a.tar`],
      ['U9 cd $X && 7z x', 'cd $X && 7z x /tmp/a.7z'],
      ['U10 pushd $X && tar -x', 'pushd $X && tar -x < /tmp/a.tar'],
      ['U11 cd - && gtar --extract', 'cd - && gtar --extract -f /tmp/a.tar'],
    ]
    for (const [n, c] of cases) for (const v of both(c)) expect(v, n).toMatchObject({ deny: true })
  })

  // RED on the base. Mutation Mb (the relative-target clause dropped) -> red.
  it('U5, U12 a relative extract target after an unknown cd', () => {
    for (const c of ['cd $X && tar -x -C . < /tmp/a.tar', 'cd "$X" && tar -x -C sub < /tmp/a.tar', 'cd $X && unzip /tmp/a.zip -d out']) {
      for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
    }
  })

  // INVARIANTS (green on the base and after): the ways around stay open.
  it('K1-K6 a literal cd, an absolute target, a listing and a non-extracting command pass', () => {
    const cases = [
      `cd ${sp}/fc && tar -x < /tmp/a.tar`, // K1 literal cd outside the install
      `cd "$X" && tar -x -C ${sp}/ctx < /tmp/a.tar`, // K2 absolute target outside
      'cd "$X" && tar -tf /tmp/a.tar', // K3 a listing is no extract
      'cd "$X" && ls -la', // K4
      `cd ${sp}/fc && rm -rf ../ctx && mkdir ../ctx && tar -x -C ../ctx < /tmp/a.tar`, // K5 the first review round's form
      `cd "$X" && unzip /tmp/a.zip -d ${sp}/ctx`, // K6 absolute unzip target
    ]
    for (const c of cases) for (const v of both(c)) expect(v, c).toEqual(PASS)
  })

  // One test per form, so a mutant's failure names the command. RED on the base where they pass today.
  it.each([
    ['U13 old dashless tar form', 'cd "$X" && tar xf /tmp/a.tar'],
    ['U14 --directory= relative', 'cd "$X" && tar -x --directory=sub -f /tmp/a.tar'],
    ['U15 popd', 'pushd /tmp && popd && tar -x < /tmp/a.tar'],
    ['U16 patch -d relative', 'cd $X && patch -d sub -p1 < /tmp/p.diff'],
    ['U17 cpio -D relative', 'cd $X && cpio -i -D sub < /tmp/a.cpio'],
    ['U18 7z -o relative', 'cd $X && 7z x /tmp/a.7z -osub'],
    ['U19 unzip -l (stated: a listing is read as an extract after an unknown cd)', 'cd "$X" && unzip -l /tmp/a.zip'],
    ['U20 patch --dry-run (stated, as U19)', 'cd "$X" && patch --dry-run -p1 < /tmp/p.diff'],
  ])('%s is denied for a sub-agent and the main agent', (_n, c) => {
    for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
  })

  // INVARIANTS: a followable cd after the unknown one makes the directory known again.
  it('K10 a literal cd back to a known place after an unknown one: the extract passes', () => {
    for (const v of both(`cd "$X" && cd ${sp}/fc && tar -x < /tmp/a.tar`)) expect(v).toEqual(PASS)
  })

  // INVARIANTS: what was denied stays denied (a known protected cwd, a protected absolute target).
  it('K7-K9 the existing denials hold', () => {
    for (const c of [`cd ${root}/scripts && tar -x < /tmp/a.tar`, `tar -x -C ${root}/scripts/hooks < /tmp/a.tar`,
      `cd "$X"; tar -xf /tmp/a.tar`]) {
      for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
    }
  })
})

// UNKCWDEXTRACT1121, review round 1: the places that set or carry the unknown cwd, and the readings
// that did not run the extract rule. N1 a subshell's ")" brings back whether the cwd was lost, not only the cwd; N2 a
// wrapper's directory change (env -C/--chdir, sudo -D/--chdir) is where its command runs, and a wrapper is taken off
// before the extract rule; N3 a shell's code (-c, piped, heredoc) and the rough readings (an unparsed command, a live
// substitution) run the extract rule with their cd followed; N4 a cd to a directory not there now that reaches a
// protected path is an unknown one. Each `it` names the mutant that turns it red (the plan's mutant table).
const bashAt = (c: string, at: string, subAgent: boolean) => gateDecision('Bash', { command: c }, { root, cwd: at, subAgent, projectDir: subAgent ? cwd() : root, configDir: null })
const bothAt = (c: string, at: string) => [bashAt(c, at, true), bashAt(c, at, false)]

describe('UNKCWDEXTRACT1121 review N1: a subshell keeps whether the cwd was lost', () => {
  // RED on the first change (it passed there). Mutant N1push (the stack keeps false) -> red.
  it.each([
    ['N1a', () => `cd "$X" && (cd ${sp}/fc) && tar -x < /tmp/a.tar`],
    ['N1b', () => 'cd "$X" && (cd /tmp) && tar -xf /tmp/a.tar'],
    ['N1c', () => `cd "$X" && ( cd ${sp}/fc && ls ) && unzip /tmp/a.zip`],
  ])('%s an unknown cd, a subshell that cds to a known place, then an extract: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the first change): the subshell's unknown cd ends with it.
  it('N1-INV1 (cd "$X") && tar -x -C <abs outside> passes', () => {
    for (const v of both(`(cd "$X") && tar -x -C ${sp}/ctx < /tmp/a.tar`)) expect(v).toEqual(PASS)
  })
  // RED on the first change (the reverse, a false denial: the lost mark outlived the subshell). Mutant N1pop -> red.
  it.each([
    ['N1-INV2', () => `cd ${sp}/fc && (cd "$X") && tar -x < /tmp/a.tar`],
    ['N1-INV3', () => `cd ${sp}/fc && (cd "$X"; tar -tf /tmp/a.tar) && tar -x < /tmp/a.tar`],
  ])('%s an unknown cd only inside a subshell: the extract after it, in the known cwd, passes', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
})

describe('UNKCWDEXTRACT1121 review N2: a wrapper and its directory change', () => {
  // RED on the first change. Mutant N2chdir (the wrapper's chdirs ignored) -> red.
  it.each([
    ['N2a env -C "$X"', () => `cd ${sp}/fc && env -C "$X" tar -x < /tmp/a.tar`],
    ['N2b env --chdir="$X"', () => 'cd /tmp && env --chdir="$X" tar -xf /tmp/a.tar'],
    ['N2c sudo -D "$X"', () => `cd ${sp}/fc && sudo -D "$X" tar -xf /tmp/a.tar`],
    ['N2d env -C <root>/scripts (literal, protected)', () => `cd ${sp}/fc && env -C ${root}/scripts tar -x < /tmp/a.tar`],
    ['N2e env -C <root>/scripts/hooks unzip', () => `cd ${sp}/fc && env -C ${root}/scripts/hooks unzip /tmp/a.zip`],
    ['N2f env -C sub after an unknown cd', () => 'cd "$X" && env -C sub tar -x < /tmp/a.tar'],
    // Nested wrappers change directory in order, the second from the first. Mutant N2seq -> red.
    ['N2j env -C <sp> sudo -D ../Install/scripts (only the composed path is protected)', () => `cd ${sp}/fc && env -C ${sp} sudo -D ../Install/scripts tar -x < /tmp/a.tar`],
  ])('%s: the extract runs in that directory and is denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // RED on the first change. Mutant N2unwrap (the wrapper not taken off) -> red.
  it.each([
    ['N2g nice in a protected cwd', () => `cd ${root}/scripts && nice -n 5 tar -x < /tmp/a.tar`],
    ['N2h timeout after an unknown cd', () => 'cd "$X" && timeout 30 unzip /tmp/a.zip'],
    ['N2i env VAR=1 after an unknown cd', () => 'cd "$X" && env LC_ALL=C tar -xf /tmp/a.tar'],
  ])('%s: the wrapped extract is denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the first change): the ways around stay open.
  it.each([
    ['N2-INV1 env -C <abs outside> after an unknown cd', () => `cd "$X" && env -C ${sp}/ctx tar -x < /tmp/a.tar`],
    ['N2-INV2 env -C "$X" ls', () => `cd ${sp}/fc && env -C "$X" ls`],
    ['N2-INV3 sudo tar -t', () => `cd ${sp}/fc && sudo tar -tf /tmp/a.tar`],
    ['N2-INV4 env VAR=1 tar -x in a known safe cwd', () => `cd ${sp}/fc && env LC_ALL=C tar -x < /tmp/a.tar`],
    ['N2-INV5 nice tar -x -C <abs outside>', () => `cd "$X" && nice tar -x -C ${sp}/ctx < /tmp/a.tar`],
  ])('%s passes', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
})

describe('UNKCWDEXTRACT1121 review N3: a shell\'s code and the rough readings run the extract rule', () => {
  // RED on the first change. Mutant N3code (a shell's code not read) -> red.
  it.each([
    ['N3a bash -c after an unknown cd', () => 'cd "$X" && bash -c \'tar -xf /tmp/a.tar\''],
    ['N3b sh -c unzip', () => 'cd "$X" && sh -c "unzip /tmp/a.zip"'],
    ['N3c bash -c with a relative cd', () => 'cd "$X" && bash -c \'cd sub && tar -x < /tmp/a.tar\''],
    ['N3d bash -c in a known protected cwd', () => `cd ${root}/scripts && bash -c 'tar -xf /tmp/a.tar'`],
    ['N3e an unknown cd inside the code', () => `cd ${sp}/fc && bash -c 'cd "$X" && tar -x < /tmp/a.tar'`],
    ['N3f piped into sh', () => 'cd "$X" && echo \'tar -xf /tmp/a.tar\' | sh'],
    ['N3g a heredoc into bash', () => 'cd "$X" && bash <<\'EOF\'\ntar -xf /tmp/a.tar\nEOF'],
    ['N3h a wrapped shell', () => `cd ${sp}/fc && env -C "$X" bash -c 'tar -xf /tmp/a.tar'`],
    // a shell in the code, the second level (mutant N3deep -> red)
    ['N3n a shell in a shell\'s code', () => 'cd "$X" && bash -c "sh -c \'tar -xf /tmp/a.tar\'"'],
  ])('%s: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // RED on the first change, from a known safe cwd (the rough readings judged every command at the caller's cwd). The third
  // column names the mutant that turns the row red: N3rough (an unparsed command), N3subst (a live substitution), N3seg
  // (a segment the word reader cannot split).
  it.each([
    ['N3i an unparsed command', () => 'cd "$X" && tar -x < /tmp/a.tar && echo "$(git log -1 --format=\'%ad\' $c)"', 'N3rough'],
    ['N3j a quoted live substitution', () => 'echo "$(cd $X && tar -x < /tmp/a.tar)"', 'N3rough'],
    ['N3k an unquoted live substitution', () => 'echo $(cd $X && tar -x < /tmp/a.tar)', 'N3subst'],
    ['N3l a backtick substitution', () => 'echo `cd $X && unzip /tmp/a.zip`', 'N3subst'],
    ['N3m a segment the word reader cannot split', () => 'cd "$X" && case y in y) tar -x < /tmp/a.tar ;; esac', 'N3seg'],
  ])('%s: denied from a safe cwd', (_n, c) => {
    for (const v of bothAt(c(), join(sp, 'fc'))) expect(v, c()).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the first change). N3-INV1 / N3-INV2 moved to R5a / R5b (review round 2: the class rule denies them, stated).
  it.each([
    ['N3-INV3 bash -c with a literal cd from a known safe cwd', () => `cd ${sp}/fc && bash -c 'cd ${sp}/ctx && tar -x < /tmp/a.tar'`],
    ['N3-INV4 bash -c without an extract', () => 'cd "$X" && bash -c \'ls -la\''],
  ])('%s passes', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
  // ACCEPTED (stated, RED on the first change where it passed): a shell's code is read at every directory it has passed (as
  // ancestorOnlyHolds), so from a cwd that reaches a protected path an extract after a literal cd in the code is denied.
  // The way around: the cd outside the shell (`cd /tmp/w && tar -x`) or an absolute -C.
  it('N3-V from the agent dir, bash -c with a literal cd then an extract: denied (stated)', () => {
    for (const v of both(`bash -c 'cd ${sp}/ctx && tar -x < /tmp/a.tar'`)) expect(v).toMatchObject({ deny: true })
  })
})

describe('UNKCWDEXTRACT1121 review N4: a cd to a missing directory that reaches a protected path', () => {
  // RED on the first change (the old cwd is safe, the missing one is under scripts/hooks/). Mutant N4 -> red.
  it('N4a cd <safe> && cd <root>/scripts/hooks/new; tar -x: denied', () => {
    for (const v of both(`cd ${sp}/fc && cd ${root}/scripts/hooks/new; tar -x < /tmp/a.tar`)) expect(v).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the first change): a failed cd from a protected cwd leaves the old one, which is
  // judged (altCwd).
  it('N4b cd <root>/scripts && cd <missing outside>; tar -x: denied', () => {
    for (const v of both(`cd ${root}/scripts && cd ${sp}/missing; tar -x < /tmp/a.tar`)) expect(v).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the first change): a missing directory outside the install stays as it was (mkdir then cd is common).
  it.each([
    ['N4-INV1 mkdir; cd <new outside>; tar -x', () => `cd ${sp}/fc && mkdir -p ${sp}/w; cd ${sp}/w; tar -x < /tmp/a.tar`],
    ['N4-INV2 cd <missing outside>; tar -x from a safe cwd', () => `cd ${sp}/fc && cd ${sp}/missing; tar -x < /tmp/a.tar`],
  ])('%s passes', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
})

// UNKCWDEXTRACT1121, review round 2: R1 env -S / --split-string; R2 a program that runs text as commands is denied
// as a CLASS where the cwd is unknown or reaches a protected path, when an extract word is in its text (fail closed: eval, xargs,
// find -exec, every shell, busybox), and its code is read further: the -c code is the first word after -c that is no option, the stdin
// is the code with -s or /dev/stdin too, eval reads its words; R3 an extract word written with quotes or a backslash inside; R4 a ~user
// or brace directory is unknown; R6 a wrapper chain runs its command in its LAST directory. R5: the stated false denials are named below.
describe('UNKCWDEXTRACT1121 round 2 R1: env -S / --split-string', () => {
  // RED on the round-1 code. Mutant R1split (the split strings not read) and R2class -> red as noted per row.
  it.each([
    ['R1a env -S after an unknown cd', () => 'cd "$X" && env -S \'tar -xf /tmp/a.tar\''],
    ['R1b env --split-string= in a protected cwd', () => `cd ${root}/scripts && env --split-string='unzip /tmp/a.zip'`],
    // from a known SAFE cwd the class rule does not hold: only the split reading sees the protected target (mutant R1split)
    ['R1c env -S tar -x -C <protected> from a safe cwd', () => `cd ${sp}/fc && env -S 'tar -x -C ${root}/scripts -f /tmp/a.tar'`],
  ])('%s: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the round-1 code): a split command with an absolute target from a known safe cwd passes
  it('R1-INV env -S tar -x -C <abs outside> from a safe cwd passes', () => {
    for (const v of both(`cd ${sp}/fc && env -S 'tar -x -C ${sp}/ctx -f /tmp/a.tar'`)) expect(v).toEqual(PASS)
  })
})

describe('UNKCWDEXTRACT1121 round 2 R2: a program that runs text as commands (class rule, fail closed)', () => {
  // RED on the round-1 code. Mutant R2class (the class rule off) -> red.
  it.each([
    ['R2a eval', () => 'cd "$X" && eval tar -xf /tmp/a.tar'],
    ['R2b piped into bash -s x', () => 'cd "$X" && echo \'tar -xf /tmp/a.tar\' | bash -s x'],
    ['R2c piped into bash /dev/stdin', () => 'cd "$X" && echo \'tar -xf /tmp/a.tar\' | bash /dev/stdin'],
    ['R2d bash -c -- code', () => 'cd "$X" && bash -c -- \'tar -xf /tmp/a.tar\''],
    ['R2e a pipe into sh inside the -c code', () => 'cd "$X" && bash -c "echo \'tar -xf /tmp/a.tar\' | sh"'],
    ['R2f three levels of shells', () => 'cd "$X" && bash -c "sh -c \\"bash -c \'tar -xf /tmp/a.tar\'\\""'],
    ['R2g fish -c', () => 'cd "$X" && fish -c \'tar -xf /tmp/a.tar\''],
    ['R2h busybox sh -c', () => 'cd "$X" && busybox sh -c \'tar -xf /tmp/a.tar\''],
    ['R2i mksh -c', () => 'cd "$X" && mksh -c \'unzip /tmp/a.zip\''],
    ['R2j xargs tar', () => 'cd "$X" && echo /tmp/a.tar | xargs tar -xf'],
    ['R2k find -exec tar', () => 'cd "$X" && find /tmp -name a.tar -exec tar -xf {} \\;'],
  ])('%s after an unknown cd: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // RED on the round-1 code, from a KNOWN SAFE cwd (the class rule does not hold there: the code reading must follow the inner cd).
  // The third column names the mutant that turns the row red. 'develop' marks a row that no mutant of this change turns red: since
  // #2990 `develop` reads the code a shell runs itself (measured: with the `--` rule, the `eval` and `busybox` reading and the rough
  // reading of code text taken out together, these rows stay green), so they are regression pins for that reading.
  it.each([
    ['R2l bash -c -- with an inner unknown cd', () => `cd ${sp}/fc && bash -c -- 'cd "$X" && tar -x < /tmp/a.tar'`, 'develop'],
    ['R2m stdin code with -s and a positional word', () => `cd ${sp}/fc && echo 'cd "$X" && tar -x < /tmp/a.tar' | bash -s x`, 'R2stdin'],
    ['R2n stdin code through /dev/stdin', () => `cd ${sp}/fc && echo 'cd "$X" && tar -x < /tmp/a.tar' | bash /dev/stdin`, 'R2stdin'],
    ['R2o eval reads its words as code', () => `cd ${sp}/fc && eval 'cd "$X" && tar -x < /tmp/a.tar'`, 'develop'],
    ['R2p a pipe into sh inside the code after an inner unknown cd', () => `cd ${sp}/fc && bash -c 'cd "$X"; echo "tar -xf /tmp/a.tar" | sh'`, 'develop'],
    ['R2q busybox sh -c with an inner unknown cd', () => `cd ${sp}/fc && busybox sh -c 'cd "$X" && tar -x < /tmp/a.tar'`, 'develop'],
    // Four levels of shells from a safe cwd, the unknown cd at the innermost one
    ['R2s four levels, the unknown cd innermost', () => String.raw`cd ${sp}/fc && bash -c "sh -c 'bash -c \"sh -c \\\"cd \\\\\\\$X && tar -x < /tmp/a.tar\\\"\"'"`, 'develop'],
  ])('%s: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // INVARIANTS (green on the round-1 code): a heredoc WRITTEN to a file (cat, no re-shelling program runs it) passes, its text naming bash and tar
  // (the measured false-denial candidates of the class were all of this form); a shell with no extract word passes
  it.each([
    ['R2-INV1 cat > file with a heredoc naming bash and tar', () => `cd "$X" && cat > ${sp}/fc/x.txt <<'EOF'\nbash -c 'tar -xf /tmp/a.tar'\nEOF`],
    ['R2-INV2 bash -c ls', () => 'cd "$X" && bash -c \'ls -la\''],
    ['R2-INV3 bash -c tar -t from a known safe cwd', () => `cd ${sp}/fc && bash -c 'tar -tf /tmp/a.tar'`],
  ])('%s passes', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
})

describe('UNKCWDEXTRACT1121 round 2 R3: an extract word written with quotes or a backslash inside', () => {
  // RED on the round-1 code. Mutant R3quote (the quotes not taken off) -> red.
  it.each([
    ['R3a t"a"r', () => 'cd "$X" && bash -c \'t"a"r -xf /tmp/a.tar\''],
    ['R3b un\'\'zip', () => 'cd "$X" && bash -c "un\'\'zip /tmp/a.zip"'],
    ['R3c ta\\r', () => 'cd "$X" && bash -c \'ta\\r -x < /tmp/a.tar\''],
  ])('%s: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
})

describe('UNKCWDEXTRACT1121 round 2 R4: a ~user or brace directory is unknown', () => {
  // RED on the round-1 code. Mutants R4chdir (wrapper) and R4target (extract target) -> red.
  it.each([
    ['R4a env -C ~user/x', () => `cd ${sp}/fc && env -C ~nobody/x tar -x < /tmp/a.tar`],
    ['R4b env -C {a,b}', () => `cd ${sp}/fc && env -C {a,b} tar -x < /tmp/a.tar`],
    ['R4c tar -x -C ~user/x', () => `cd ${sp}/fc && tar -x -C ~nobody/x < /tmp/a.tar`],
    ['R4d tar -x -C {a,b}', () => `cd ${sp}/fc && tar -x -C {a,b} < /tmp/a.tar`],
  ])('%s: denied', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
})

describe('UNKCWDEXTRACT1121 round 2 R6: a wrapper chain runs its command in its LAST directory', () => {
  // RED on the round-1 code (it judged every intermediate directory: a false denial). Mutant R6each -> red.
  it('R6a env -C <protected> sudo -D <safe abs> tar -x passes', () => {
    for (const v of both(`cd ${sp}/fc && env -C ${root}/scripts sudo -D ${sp}/ctx tar -x < /tmp/a.tar`)) expect(v).toEqual(PASS)
  })
  // INVARIANTS: a wrapper's directory change is its command's only; the next command runs in the segment cwd
  it('R6-INV2 env -C <protected> true && tar -x from a safe cwd passes', () => {
    for (const v of both(`cd ${sp}/fc && env -C ${root}/scripts true && tar -x < /tmp/a.tar`)) expect(v).toEqual(PASS)
  })
  // INVARIANTS: the last directory protected (N2d, N2j) stays denied
  it('R6-INV env -C <safe> sudo -D <protected> tar -x is denied', () => {
    for (const v of both(`cd ${sp}/fc && env -C ${sp}/ctx sudo -D ${root}/scripts tar -x < /tmp/a.tar`)) expect(v).toMatchObject({ deny: true })
  })
})

describe('UNKCWDEXTRACT1121 round 2 R5: the stated false denials of the class rule', () => {
  // ACCEPTED (RED on the round-1 code where they passed): where the cwd is unknown or reaches a protected path (an agent's own directory does),
  // a re-shelling program with an extract word in its text is denied even when it only lists or extracts to an absolute place outside.
  // The way around: run it from a literal cd outside the install, without the re-shelling program, or with an absolute -C / -d.
  it.each([
    ['R5a bash -c tar -t after an unknown cd (was N3-INV1)', () => 'cd "$X" && bash -c \'tar -tf /tmp/a.tar\''],
    ['R5b bash -c tar -x -C <abs outside> after an unknown cd (was N3-INV2)', () => `cd "$X" && bash -c 'tar -x -C ${sp}/ctx < /tmp/a.tar'`],
  ])('%s is denied (stated)', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // Round 3 (the maintainer's request 1): a SUB-agent's own directory no longer counts for the class rule (X1 below); the main agent's cwd
  // here is another agent's directory, which still does.
  it('R5c from an agent dir: find -exec tar -t is denied for the main agent (stated), and passes for a sub-agent in its own dir', () => {
    expect(bash('find /tmp -name a.tar -exec tar -tf {} \\;', false)).toMatchObject({ deny: true })
    expect(bash('find /tmp -name a.tar -exec tar -tf {} \\;', true)).toEqual(PASS)
  })
})

// UNKCWDEXTRACT1121, review round 3 (the maintainer's first review of the PR, four requests). Every request has its shapes as
// must-stay-open rows, and each shape a negative twin that stays denied (the same shape whose extract lands in the install, or in an
// unknown directory). X1 the class rule does not count the caller's OWN agent directory; X2 `D=<abs literal> && cd $D` is a known
// directory; X3 `tar -O` / `--to-stdout` and `unzip -p` write no file, and a listing inside `$(...)` is no extract.
const OWN_HANDOFF_PY = "python3 - <<'EOF'\nopen('HANDOFF.md', 'a').write('apply the patch, then tar the result')\nEOF"
const OWN_HANDOFF_PERL = "perl -0pi -e 's/old note/the patch and tar notes/' HANDOFF.md"
const REPORT_PY = "python3 - <<'EOF'\nprint('report: the tar and patch notes')\nEOF"

describe('UNKCWDEXTRACT1121 round 3 X1: the class rule does not count the caller\'s own agent directory', () => {
  // The maintainer's class A: an interpreter edits the agent's own HANDOFF.md, its text naming `patch` / `tar`. X1a and X1b are RED on the
  // round-2 head (X1c passes there too: sed is no re-shelling program). Mutant X1own (classProtected = cwdReaches) -> red.
  it.each([
    ['X1a python3 heredoc on HANDOFF.md', OWN_HANDOFF_PY],
    ['X1b perl -0pi on HANDOFF.md', OWN_HANDOFF_PERL],
    ['X1c sed -i on HANDOFF.md naming tar', "sed -i 's/a tar archive/the tar result/' HANDOFF.md"],
  ])('%s passes for a sub-agent in its own directory', (_n, c) => {
    expect(bash(c, true)).toEqual(PASS)
  })
  // The maintainer's class D: the same text after a literal cd. A cd to a directory that is not there (`;`: the old directory is kept as
  // the alternative) read the own directory as protected (X1e RED on the round-2 head; X1d passes there too, an invariant).
  // Mutant X1own -> red.
  it.each([
    ['X1d a literal cd outside, then the heredoc', () => `cd ${sp}/fc && ${REPORT_PY}`],
    ['X1e a literal cd to a missing directory with ;, then the heredoc', () => `cd ${sp}/missing; ${REPORT_PY}`],
  ])('%s passes for a sub-agent', (_n, c) => {
    expect(bash(c(), true)).toEqual(PASS)
  })
  // NEGATIVE TWINS: the same text where the extract would land in the install root, in an unknown directory or in ANOTHER agent's directory.
  it.each([
    ['X1-T1 unknown directory (cd "$X")', () => `cd "$X" && ${OWN_HANDOFF_PY}`],
    ['X1-T2 unknown directory, perl', () => `cd "$X" && ${OWN_HANDOFF_PERL}`],
    ['X1-T3 the install root', () => `cd ${root} && ${OWN_HANDOFF_PY}`],
    ['X1-T4 scripts/', () => `cd ${root}/scripts && ${REPORT_PY}`],
    ['X1-T5 a real extract in scripts/ by a script', () => `cd ${root}/scripts && python3 - <<'EOF'\nimport os\nos.system('tar xf /tmp/a.tar')\nEOF`],
    ['X1-T6 unknown directory after a literal one, with ;', () => `cd ${sp}/fc; cd "$X"; ${REPORT_PY}`],
  ])('%s is denied for a sub-agent and the main agent', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
  // ANOTHER agent's directory stays protected for a sub-agent; so does the own directory for the main agent (not measured: stated).
  it('X1-T7 a sub-agent in ANOTHER agent\'s directory is denied; the main agent in an agent directory is denied (stated)', () => {
    mkdirSync(join(root, 'agents', 'other'), { recursive: true })
    const other = join(root, 'agents', 'other')
    expect(bashAt(OWN_HANDOFF_PY, other, true)).toMatchObject({ deny: true })
    expect(bash(OWN_HANDOFF_PY, false)).toMatchObject({ deny: true })
  })
})

describe('UNKCWDEXTRACT1121 round 3 X2: a cd to a variable the command itself sets to an absolute literal', () => {
  // The maintainer's class B: `D=<abs> && cd $D && ... tar xzf x -C bin`. RED on the round-2 head. Mutant X2lit (the literal not used) -> red.
  it.each([
    ['X2a D=<abs> && cd $D && tar xzf -C bin', () => `D=${sp}/fc && cd $D && tar xzf /tmp/x.tar.gz -C bin`],
    ['X2b D=<abs>; cd "$D" && tar -x', () => `D=${sp}/fc; cd "$D" && tar -x < /tmp/a.tar`],
    ['X2c ${D} form with a sub-directory', () => `D=${sp} && cd \${D}/fc && tar -x < /tmp/a.tar`],
    ['X2d pushd $D', () => `D=${sp}/fc && pushd $D && tar -x < /tmp/a.tar`],
    ['X2e a relative extract target after the literal cd', () => `D=${sp}/ctx && cd $D && unzip /tmp/a.zip -d out`],
    ['X2g a literal variable cd, then a python heredoc naming tar (the commonest shape)', () => `S=${sp}; cd $S/fc && python3 - <<'EOF'\nprint('the tar and patch notes')\nEOF`],
    ['X2h the same, the heredoc body assigns the name again (data, no effect)', () => `S=${sp}/fc; cd $S && python3 - <<'EOF'\nS='/x'\nprint('the tar and patch notes')\nEOF`],
    ['X2i a pipe between the assignment and the use (| tail)', () => `S=${sp}; cd ${sp}/ctx && ls | tail -2; cd $S/fc && tar -x < /tmp/a.tar`],
    ['X2f a real-looking download: curl into the literal directory, unpack there', () => `D=${sp}/fc && curl -sSLo $D/x.tar.gz https://example.org/x.tar.gz && cd $D && tar xzf x.tar.gz -C bin`],
  ])('%s passes for a sub-agent and the main agent', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
  // NEGATIVE TWINS: the literal is a protected place (known, so denied as a known cwd), or the variable is not definitely that literal.
  it.each([
    ['X2-T1 D=<root>/scripts (known protected), a target under hooks/', () => `D=${root}/scripts && cd $D && tar xzf /tmp/x.tar.gz -C hooks`],
    ['X2-T2 D=<root>/scripts, no target', () => `D=${root}/scripts; cd $D; tar -x < /tmp/a.tar`],
    ['X2-T3 assigned twice (the second wins)', () => `D=${sp}/fc; D=${root}/scripts; cd $D && tar -x < /tmp/a.tar`],
    ['X2-T4 a relative literal is no absolute directory', () => 'D=fc && cd $D && tar -x < /tmp/a.tar'],
    ['X2-T5 a value from a substitution', () => 'D=$(cat /tmp/w) && cd $D && tar -x < /tmp/a.tar'],
    ['X2-T6 the assignment is in a pipe (a subshell)', () => `D=${sp}/fc | cat; cd $D && tar -x < /tmp/a.tar`],
    ['X2-T7 the assignment is in a subshell', () => `(D=${sp}/fc); cd $D && tar -x < /tmp/a.tar`],
    ['X2-T8 a read after the assignment', () => `D=${sp}/fc; read D; cd $D && tar -x < /tmp/a.tar`],
    ['X2-T9 the use is single-quoted', () => `D=${sp}/fc && cd '$D' && tar -x < /tmp/a.tar`],
    ['X2-T10 an || before the assignment', () => `false || D=${sp}/fc; cd $D && tar -x < /tmp/a.tar`],
    ['X2-T11 a for loop sets it', () => `D=${sp}/fc; for D in ${root}/scripts; do cd $D; tar -x < /tmp/a.tar; done`],
    ['X2-T12 an unset variable', () => 'cd $D && tar -x < /tmp/a.tar'],
    ['X2-T15 a heredoc command, the literal is the scripts directory', () => `S=${root}/scripts; cd $S && python3 - <<'EOF'\nprint('the tar and patch notes')\nEOF`],
    ['X2-T16 a heredoc command, the name is assigned twice', () => `S=${sp}/fc; S=${root}/scripts; cd $S && python3 - <<'EOF'\nprint('the tar and patch notes')\nEOF`],
    ['X2-T17 the assignment is the last element of a pipeline (a subshell)', () => `echo x | S=${sp}/fc; cd $S && tar -x < /tmp/a.tar`],
    ['X2-T18 a pipe after the assignment does not rescue a second assignment', () => `S=${sp}/fc; ls | cat; S=${root}/scripts; cd $S && tar -x < /tmp/a.tar`],
    ['X2-T14 a backslash-escaped use is the literal text $D', () => `D=${sp}/fc && cd \\$D && tar -x < /tmp/a.tar`],
    ['X2-T13 the sub-directory of the literal is protected', () => `D=${root} && cd $D/scripts && tar -x < /tmp/a.tar`],
  ])('%s is denied for a sub-agent and the main agent', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
})

describe('UNKCWDEXTRACT1121 round 3 X3: an extract to stdout writes no file; a listing is no extract', () => {
  // The maintainer's class C. RED on the round-2 head. Mutants X3tar (-O / --to-stdout not read) and X3unzip (-p / -c) -> red.
  it.each([
    ['X3a tar -xzOf with a listing in $(...)', () => `tar -xzOf /tmp/a.tgz $(tar -tzf /tmp/a.tgz | grep 'bin/tool') > ${sp}/out`],
    ['X3b the same after an unknown cd', () => `cd "$X" && tar -xzOf /tmp/a.tgz $(tar -tzf /tmp/a.tgz | grep 'bin/tool') > ${sp}/out`],
    ['X3c tar --to-stdout', () => 'cd "$X" && tar --to-stdout -xf /tmp/a.tar member'],
    ['X3d dashless tar xOf', () => 'cd "$X" && tar xOf /tmp/a.tar member'],
    ['X3e unzip -p', () => 'cd "$X" && unzip -p /tmp/a.zip member | head -3'],
    ['X3f unzip -pq', () => 'cd "$X" && unzip -pq /tmp/a.zip member'],
    ['X3g unzip -c', () => 'cd "$X" && unzip -c /tmp/a.zip member'],
    ['X3h a listing inside $(...) after an unknown cd', () => 'cd "$X" && echo $(tar -tzf /tmp/a.tar | head -3)'],
  ])('%s passes for a sub-agent and the main agent', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toEqual(PASS)
  })
  // NEGATIVE TWINS: the same without the stdout flag, a file name that only holds an O, -O with a protected target.
  it.each([
    ['X3-T1 tar -xzf with the listing', () => "tar -xzf /tmp/a.tgz $(tar -tzf /tmp/a.tgz | grep 'bin/tool')"],
    ['X3-T2 the same after an unknown cd', () => 'cd "$X" && tar -xzf /tmp/a.tgz $(tar -tzf /tmp/a.tgz | grep bin/tool)'],
    ['X3-T3 unzip of a member', () => 'cd "$X" && unzip /tmp/a.zip member'],
    ['X3-T4 an archive name holding an O', () => 'cd "$X" && tar -xf Orders.tar'],
    ['X3-T5 an archive name that is only an O-word after -f', () => 'cd "$X" && tar -x -f OOO'],
    ['X3-T6 the dashless cluster holds no O', () => 'cd "$X" && tar xf /tmp/a.tar'],
    ['X3-T7 -O does not excuse a protected target', () => `tar -xOf /tmp/a.tar -C ${root}/scripts`],
    ['X3-T8 unzip -P is a password, not -p', () => 'cd "$X" && unzip -P secret /tmp/a.zip'],
  ])('%s is denied for a sub-agent and the main agent', (_n, c) => {
    for (const v of both(c())) expect(v, c()).toMatchObject({ deny: true })
  })
})

// A command named like an Object.prototype key (toString, constructor) found an inherited "entry" in the extract table,
// and the gate crashed into a fail-closed deny of a harmless command (measured on a fleet corpus: `cd ... && grep
// "a\|toString" f` read toString as a command). RED on the base: TypeError, EXTRACT_DIR_FLAGS[name] is not iterable.
describe('a command named like an Object.prototype key is no extractor', () => {
  it('P1-P3 decide without a crash, for a sub-agent and the main agent', () => {
    for (const c of ['cd |toString /', 'cd /tmp; toString -f prog.awk', 'cd /tmp && grep -n "raw\\|toString" /tmp/u.js']) {
      for (const v of both(c)) expect(v, c).toEqual(PASS)
    }
  })
})
