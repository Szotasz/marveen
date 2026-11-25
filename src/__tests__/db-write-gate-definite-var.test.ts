// VARDEFDB1121: a variable that is DEFINITELY a literal when the segment runs (definiteAssignments, the
// self-pace gate's EGRESSFP1106 (b) rule) is read as that literal by the write gate too: `W=/abs/wt; git -C $W fetch`
// and `S=/abs; cd $S/fc && tar -x -C ../ctx` name a known place. Everything the rule does not prove stays unresolved
// (strict). Decisions on a temp install root.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, GIT_GATE_MSG } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import * as spg from '../../scripts/self-pace-gate.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let sp: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'var-def-')))
  root = join(base, 'Install')
  sp = join(base, 'scratch')
  mkdirSync(join(root, 'agents', 'samu'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(sp, 'wt', '.git'), { recursive: true })
  mkdirSync(join(sp, 'fc'), { recursive: true })
  mkdirSync(join(sp, 'ctx'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const cwd = () => join(root, 'agents', 'samu')
const bash = (c: string, subAgent = false) => gateDecision('Bash', { command: c }, { root, cwd: cwd(), subAgent, projectDir: subAgent ? cwd() : root, configDir: null })
const PASS = { deny: false }
const both = (c: string) => [bash(c, true), bash(c, false)]

describe('VARDEFDB1121: a definite literal variable is read as its value', () => {
  // The write gate reads a definite literal variable as its value.
  it('D1-D6 a definite variable naming a place outside the install passes', () => {
    const cases = [
      `W=${sp}/wt; git -C $W fetch -q origin develop`,
      `W=${sp}/wt && git -C $W reset -q --hard origin/develop`,
      `W=${sp}/wt; cd $W && git commit -q -m x`,
      `S=${sp}; cd $S/fc && rm -rf ../ctx && mkdir ../ctx`,
    ]
    for (const c of cases) for (const v of both(c)) expect(v, c).toEqual(PASS)
  })

  // With `< /tmp/a.tar` the replacement is off and an unknown cwd lets a target-less extract through (the strict
  // direction of the redirection rule below), so these inputs carry no redirection.
  it('N1-N2 a definite variable naming the install hooks: the extract is denied', () => {
    for (const c of [`S=${root}/scripts/hooks; cd $S && tar -xf /tmp/a.tar`, `S=${root}/scripts; cd $S/hooks && tar -xf /tmp/b.tar`]) {
      for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
    }
  })

  // What the rule does not prove stays strict, and a definite install target is denied.
  it('N3-N17 not definite, unsafe or the install itself: still denied', () => {
    const cases: [string, string][] = [
      ['N3 definite install root', `W=${root}; git -C $W reset --hard`],
      ['N4 conditional across ;', `false && W=${sp}/wt; git -C $W reset --hard`],
      ['N5 assigned twice', `W=${sp}/wt; W=${root}; git -C $W reset --hard`],
      ['N6 assigned in a subshell', `(W=${sp}/wt); git -C $W reset --hard`],
      ['N7 export', `export W=${sp}/wt; git -C $W reset --hard`],
      ['N8 prefix assignment (not set for the expansion)', `W=${sp}/wt git -C $W reset --hard`],
      ['N9 zsh modifier', `W=${sp}/wt; git -C $W:h reset --hard`],
      ['N10 zsh subscript', `W=${sp}/wt; git -C $W[1] reset --hard`],
      ['N11 value with a space', `W='${sp}/a b'; git -C $W reset --hard`],
      ['N12 value with a glob', `W=${sp}/w*; git -C $W reset --hard`],
      ['N13 || before the assignment', `true || W=${sp}/wt; git -C $W reset --hard`],
      ['N14 use before the assignment', `git -C $W reset --hard; W=${sp}/wt`],
      ['N15 shell-managed name', `PWD=${sp}/wt; git -C $PWD reset --hard`],
      ['N16 a substitution in the command (rule gives up)', `W=${sp}/wt; x=$(date); git -C $W reset --hard`],
      ['N17 assignment piped (subshell)', `echo | W=${sp}/wt; git -C $W reset --hard`],
    ]
    for (const [n, c] of cases) for (const v of both(c)) expect(v, n).toMatchObject({ deny: true })
  })

  // The git refusal names the exception.
  it('M1 the git refusal keeps the literal-path sentence; its docs section names the definite-literal exception', () => {
    const docs = readFileSync(join(__dirname, '..', '..', 'docs', 'db-write-gate.md'), 'utf-8')
    const gitSection = docs.slice(docs.indexOf('### Git-iras'))
    expect(GIT_GATE_MSG).toContain('("Git-iras")')
    expect(gitSection).toMatch(/VARDEFDB1121/)
    expect(gitSection).toMatch(/egyszer, feltetel nelkul, literalis uttal/)
    expect(GIT_GATE_MSG).toContain('de a celt LITERALIS abszolut uttal add meg: "git -C /Users/marvin/<worktree> ..." vagy "cd /Users/marvin/<worktree> && git ..."')
  })

  // The helper itself: what it leaves alone, and that it expands as the shell does.
  it('H1-H4 the helper replaces only an absolute safe value, never under IFS or a heredoc, and every live use', () => {
    // a namespace import: on the base the export is missing, and only this test fails (not the whole file)
    const sub = (c: string) => spg.substituteDefiniteCommand(c)
    const same = (c: string) => expect(sub(c), c).toBe(c)
    same('W=wt; cd $W && tar -xf /tmp/a.tar') // H1 relative: a cd goes through CDPATH
    same('IFS=/; W=/tmp/a/b; cd $W && ls') // H2 IFS named: the value may split
    same("W=/tmp/wt; cat > x <<'EOF'\n$W\nEOF") // H3 a heredoc: the quoting is not followed
    same('W=/tmp/wt; WX=/tmp/x; cd "$W\\\nX" && tar -xf /tmp/a.tar') // H5 a line continuation joins W and X
    same("W=/tmp/wt; printf '%s' $'a\\'$W' $W") // H6 $'...' with an escaped quote: no replacement at all
    // H4 every live use, as the shell expands it (the commit message too); a single-quoted one stays
    expect(sub(`W=/tmp/wt; git -C "$W" commit -m "$W" -m '$W'`)).toBe(`W=/tmp/wt; git -C "/tmp/wt" commit -m "/tmp/wt" -m '$W'`)
  })

  // The line-continuation counterexample, at the gate: the real git runs in $WX = the install. (The same with
  // `cd ... && tar -xf` passes already without this change: an unknown cwd lets a target-less extract through.)
  it('N19 a line continuation that makes $WX of "$W\\<newline>X" is denied', () => {
    for (const v of both(`W=${sp}/wt; WX=${root}; git -C "$W\\\nX" reset --hard`)) expect(v).toMatchObject({ deny: true })
  })

  // A single-quoted `$W` is text, not the variable (never substituted).
  it('N18 a single-quoted use is not replaced', () => {
    for (const v of both(`W=${sp}/wt; cd ${root} && git -C '$W' reset --hard`)) expect(v).toMatchObject({ deny: true })
  })
  // definiteAssignments proves ONE `NAME=`, not that nothing else sets the name.
  // Every command below changes W (or may) without a second `W=`; at the gate the git runs in the install -> denied.
  // a function: `sp` and `root` are set in beforeEach, a describe-level array would hold `undefined/wt` (a relative value
  // the helper never replaces, so every case would pass without the rule)
  const INDIRECT = (): [string, string][] => [
    ['N20 subscript assignment', `W=${sp}/wt; W[0]=${root}; git -C $W reset --hard`],
    ['N21 printf -vW glued', `W=${sp}/wt; printf -vW %s ${root}; git -C $W reset --hard`],
    ['N22 builtin read', `W=${sp}/wt; builtin read W < /tmp/p; git -C $W reset --hard`],
    ['N23 builtin unset, then "$W" is cwd', `W=${sp}/wt; builtin unset W; git -C "$W" reset --hard`],
    ['N24 trap body', `W=${sp}/wt; trap 'W=${root}' ERR; false; git -C $W reset --hard`],
    ['N25 zsh print -v', `W=${sp}/wt; print -v W ${root}; git -C $W reset --hard`],
    ['N26 zsh set -A', `W=${sp}/wt; set -A W ${root}; git -C $W reset --hard`],
    ['N27 the name through another variable', `W=${sp}/wt; n=W; printf -v $n %s ${root}; git -C $W reset --hard`],
    ['N28 printf -v with a quoted name', `W=${sp}/wt; printf -v "W" %s ${root}; git -C $W reset --hard`],
    ['N29 backslash-hidden builtin source', `W=${sp}/wt; \\builtin source /tmp/f; git -C $W reset --hard`],
    ['N30 quoted builtin, eval', `W=${sp}/wt; 'builtin' eval $Y; git -C $W reset --hard`],
    ['N31 time source (reserved word, same shell)', `W=${sp}/wt; time source /tmp/f; git -C $W reset --hard`],
    ['N32 negated source', `W=${sp}/wt; ! source /tmp/f; git -C $W reset --hard`],
    ['N33 command name from a variable', `W=${sp}/wt; B=builtin; $B source /tmp/f; git -C $W reset --hard`],
    ['N34 zsh repeat source', `W=${sp}/wt; repeat 1 source /tmp/f; git -C $W reset --hard`],
    ['N35 trap running a file', `W=${sp}/wt; trap 'source /tmp/f' ERR; false; git -C $W reset --hard`],
    ['N36 redirection before the command', `W=${sp}/wt; </tmp/p read W; git -C $W reset --hard`],
    ['N37 command eval', `W=${sp}/wt; command eval $Y; git -C $W reset --hard`],
    ['N38 zsh glued strftime -sW', `W=${sp}/wt; strftime -sW %s 0; git -C $W reset --hard`],
    // a prefix value with a blank is ONE word for the shell, a split on blanks loses the command word
    ['N39 quoted blank prefix value, then source', `W=${sp}/wt; X='a b' source /tmp/f; git -C $W reset --hard`],
    ['N40 double-quoted blank prefix value, then builtin read', `W=${sp}/wt; X="a b" builtin read W; git -C $W reset --hard`],
    ['N41 escaped blank prefix value, then source', `W=${sp}/wt; X=a\\ b source /tmp/f; git -C $W reset --hard`],
    // zsh `${W::=x}` / `${W:=x}` assign; only `$NAME` and `${NAME}` are plain uses
    ['N42 zsh ${W::=x} in double quotes', `W=${sp}/wt; echo "\${W::=${root}}" >/dev/null; git -C $W reset --hard`],
    ['N43 zsh ${W::=x} unquoted', `W=${sp}/wt; : \${W::=${root}}; git -C $W reset --hard`],
    ['N44 ${W:=x} default-assign', `W=${sp}/wt; : "\${W:=${root}}"; git -C $W reset --hard`],
    // a MULTI-character name built from pieces the raw-text rule (B) cannot see
    ['N45 bash printf -vW\'\'T', `WT=${sp}/wt; printf -vW''T %s ${root}; git -C $WT reset --hard`],
    ['N46 zsh print -v W\'\'T', `WT=${sp}/wt; print -v W''T ${root}; git -C $WT reset --hard`],
    ['N47 the name through another variable and a glued T', `WT=${sp}/wt; n=W; print -v \${n}T ${root}; git -C $WT reset --hard`],
    ['N48 zsh set -A W\'\'T', `WT=${sp}/wt; set -A W''T ${root}; git -C $WT reset --hard`],
    ['N49 double-quoted piece then T', `WT=${sp}/wt; printf -v "W"T %s ${root}; git -C $WT reset --hard`],
    ['N50 backslash piece', `WT=${sp}/wt; printf -v W\\T %s ${root}; git -C $WT reset --hard`],
    ['N51 two expansions glued', `WT=${sp}/wt; a=W; b=T; printf -v $a$b %s ${root}; git -C $WT reset --hard`],
  ]
  it('N20-N38 a name that can be set without a second NAME= is not read as its literal: denied', () => {
    for (const [n, c] of INDIRECT()) for (const v of both(c)) expect(v, n).toMatchObject({ deny: true })
  })

  // The helper: none of them is rewritten.
  it('H7 the helper leaves every indirect-setter command unchanged', () => {
    for (const [n, c] of INDIRECT()) expect(spg.substituteDefiniteCommand(c), n).toBe(c)
  })

  // Rule (B) is per name: the other definite name is still replaced.
  it('H8 an indirectly set name blocks only itself', () => {
    expect(spg.substituteDefiniteCommand('W=/tmp/wt; M=/tmp/m; printf -vM %s x; git -C $W log'))
      .toBe('W=/tmp/wt; M=/tmp/m; printf -vM %s x; git -C /tmp/wt log')
    // a plain use of the blocked name is an expansion the replacement does not follow: the whole command stays
    const c = 'W=/tmp/wt; M=/tmp/m; printf -vM %s x; git -C $W log; ls $M'
    expect(spg.substituteDefiniteCommand(c)).toBe(c)
  })

  // The strict direction (an accepted false positive): the bare name anywhere else, even in a path, keeps the
  // unresolved reading.
  it('H9 the name as plain text elsewhere (a path part) blocks the replacement', () => {
    const c = 'W=/tmp/wt; git -C $W log -- src/W'
    expect(spg.substituteDefiniteCommand(c)).toBe(c)
  })

  // Rule (A), every listed word on its own (a word dropped from the list -> red): a precommand / indirect-execution word,
  // a hidden VAR_SETTERS word (backslash or quotes) or a non-plain first word switches the replacement off.
  it('H10 each rule-A first word leaves the command unchanged', () => {
    for (const w of ['builtin x', 'command x', 'exec x', 'noglob x', 'nocorrect x', '- x', 'repeat 1 x', 'time x', '! x',
      "trap 'x' ERR", 'alias x=y', 'enable x', 'autoload x', 'fc -s', 'emulate sh', 'zmodload x', '\\source /tmp/f',
      "'eval' x", 'ma\\pfile x', '"$B" x', '2>/dev/null x',
      // quoted / escaped blank in a prefix value; a segment the reader cannot follow fails closed
      "X='a b' source /tmp/f", 'X=a\\ b source /tmp/f', 'X="a b" eval x', '{ source /tmp/f',
      "X='a b' 2>/dev/null x", 'foo a(b', 'foo x}y',
      // inputs that reach the quoting reader's failure branch of firstWordBlocks; since no redirection is allowed there,
      // that branch is redundant and stays as a fail-closed guard
      '\\source /tmp/f>/dev/null', "X='a b' source /tmp/f>x"]) {
      const c = `W=/tmp/wt; ${w}; git -C $W log`
      expect(spg.substituteDefiniteCommand(c), w).toBe(c)
    }
  })

  // A clean command is still replaced (the glue rule is not a blanket refusal), and a name built from
  // pieces is not.
  it('H11 clean quoting and expansions still replace; H12 a glued name does not', () => {
    const sub = (c: string) => spg.substituteDefiniteCommand(c)
    expect(sub(`W=/tmp/wt; git -C "$W" log --format='%H %s' -n 1`)).toBe(`W=/tmp/wt; git -C "/tmp/wt" log --format='%H %s' -n 1`)
    expect(sub('W=/tmp/wt; git -C ${W}/x log')).toBe('W=/tmp/wt; git -C /tmp/wt/x log')
    for (const g of ["printf -vW''T %s /r", 'printf -v "W"T %s /r', 'a=W; print -v ${a}T /r', 'echo $a$b']) {
      const c = `WT=/tmp/wt; ${g}; git -C $WT log`
      expect(sub(c), g).toBe(c)
    }
  })

  // A name BUILT by an expansion or a glob, which no text rule sees, must
  // keep the unresolved (develop, denying) reading. The replacement is only for the simple form: every `$` outside
  // single quotes is a plain `$NAME` / `${NAME}` use of a replaced name.
  const BUILT = [
    "printf -vW''T %s /r", 'printf -v "W"T %s /r', 'printf -v W\\T %s /r', 'a=W; print -v ${a}T /r', 'a=W; b=T; print -v $a$b /r', // shapes with a glued name
    'n=wt; print -v $n:u /r', 'n=wt; set -A $n:u /r', 'n=Wx; print -v $n:s/x/T/ /r', // zsh modifiers without braces
    'n=wt; print -v ${n:u} /r', 'n=$(echo wt); print -v $n /r', // modifier with braces, a substitution
    'print -v W? /r', 'print -v [W]T /r', // globs (a file named WT in the cwd)
    'echo $1 $?; print -v $RANDOM /r', // any other expansion in the command
    // zsh extendedglob and every other character outside the allowlist
    'setopt extendedglob; print -v W#T /r', 'setopt extendedglob; print -v ^X /r', 'print -v ~WT /r', 'print -v W{T,X} /r',
    'print -v W!T /r', 'echo "`date`"', 'echo (a)', 'echo <(date)', 'echo a\\ b',
  ]
  it('H14 a name built by an expansion, a modifier or a glob: the helper leaves the command unchanged', () => {
    const sub = (c: string) => spg.substituteDefiniteCommand(c)
    for (const g of BUILT) {
      const c = `WT=/tmp/wt; ${g}; git -C $WT reset --hard`
      expect(sub(c), g).toBe(c)
    }
    // an unquoted glob character next to a name keeps the reading; a standalone `[ ... ]` test does not
    for (const c of ['WT=/tmp/wt; ls *.txt; git -C $WT log', 'WT=/tmp/wt; ls [a]b; git -C $WT log']) expect(sub(c), c).toBe(c)
    expect(sub('WT=/tmp/wt; [ -d $WT ] && git -C $WT log')).toBe('WT=/tmp/wt; [ -d /tmp/wt ] && git -C /tmp/wt log')
    expect(sub("WT=/tmp/wt; git -C $WT log '*' \"?\"")).toBe("WT=/tmp/wt; git -C /tmp/wt log '*' \"?\"")
    // the simple form is unchanged: only plain uses of replaced names
    expect(sub('WT=/tmp/wt; git -C $WT reset --hard')).toBe('WT=/tmp/wt; git -C /tmp/wt reset --hard')
    expect(sub("WT=/tmp/wt; git -C $WT log --format='%H $x'")).toBe("WT=/tmp/wt; git -C /tmp/wt log --format='%H $x'")
  })

  // A redirection anywhere keeps the unresolved reading. zsh runs `W=/x &>/dev/null </dev/null`
  // (an assignment with only redirections) as a prefix of NULLCMD, so W is NOT set there while the helper read it as set.
  // D4/D6 (`... < /tmp/a.tar`, `... > ../ctx/PR.diff`) are the accepted false positives of this.
  const REDIRS = [
    'W=@/wt &>/dev/null </dev/null', 'W=@/wt &>>/tmp/x </dev/null', 'W=@/wt >/dev/null', 'W=@/wt </dev/null', 'W=@/wt 2>/dev/null',
    'W=@/wt >/dev/null 2>&1', 'S=@; cd $S/fc && tar -x -C ../ctx < /tmp/a.tar', 'S=@; cd $S/fc && git diff a b > ../ctx/PR.diff',
  ]
  it('N52 a redirection in the command: the helper leaves it unchanged (assignment segments, the tar and diff forms)', () => {
    const sub = (c: string) => spg.substituteDefiniteCommand(c)
    for (const r of REDIRS) {
      const c = `${r.replace(/@/g, '/tmp/sp')}; git -C "$${r.startsWith('S=') ? 'S' : 'W'}" reset --hard`
      expect(sub(c), c).toBe(c)
    }
  })
  it('N53 at the gate the redirection forms are denied, sub-agent or not', () => {
    for (const r of REDIRS.slice(0, 6)) {
      const c = `${r.replace(/@/g, sp)}; git -C "$W" reset --hard`
      for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
    }
  })

  it('H15 at the gate the same commands are denied (the git target stays unknown), sub-agent or not', () => {
    for (const g of BUILT) {
      const c = `WT=${sp}/wt; ${g.replace('/r', `${root}/store`)}; git -C $WT reset --hard`
      for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
    }
  })

  // A long `a=a=a=...` prefix must not backtrack exponentially (the worker kills a slow decision).
  it('H13 a long a=a=a=... prefix is decided at once', () => {
    const t = Date.now()
    spg.substituteDefiniteCommand(`W=/tmp/wt; X=${'a='.repeat(26)}a cmd; git -C $W log`)
    expect(Date.now() - t).toBeLessThan(1000)
  })

  // A glued `-vW` falls through to the final `return true` of the same loop in nameSetIndirectly (not a use, not an
  // assignment), so its `if (m[1]) return true` line is redundant on every input of this suite.

  // Positive control: an ordinary leading word (set -e, cd, [ ) does not switch the rule off.
  it('D7 set -e, a [ test and cd in front still pass', () => {
    for (const c of [`set -e; W=${sp}/wt; git -C $W fetch -q origin develop`,
      `W=${sp}/wt; [ -d $W ] && git -C $W fetch -q origin develop`]) {
      for (const v of both(c)) expect(v, c).toEqual(PASS)
    }
  })
})

// B1 (review of GitHub #3063): a name either shell treats as SPECIAL is never read as its assigned literal. zsh 5.9 has 112
// special parameters, and several accept the assignment, keep running and hold ANOTHER value: KEYBOARD_HACK keeps one
// character, HISTCHARS/histchars three, USERNAME its old value. The denylist is not grown name by name: every special name
// of zsh (the embedded list) and of bash (its documented dynamic and special variables) stays unresolved.
describe('VARDEFDB1121 B1: special parameters of zsh and bash are not definite literals', () => {
  // the reviewer's three rows: the gate must read `$NAME<install>` as unknown, not as <scratch>/x<install>
  it('B1a KEYBOARD_HACK and USERNAME: the writes into the install are denied, sub-agent or not', () => {
    const cases = [
      `KEYBOARD_HACK=${sp}/x; cp /tmp/e.mjs $KEYBOARD_HACK${root}/scripts/hooks/e.mjs`,
      `KEYBOARD_HACK=${sp}/x; git -C $KEYBOARD_HACK${root} reset --hard origin/develop`,
      `USERNAME=${sp}/x; git -C $USERNAME reset --hard origin/develop`,
    ]
    for (const c of cases) for (const v of both(c)) expect(v, c).toMatchObject({ deny: true })
  })

  it('B1b the helper leaves each of the three commands unchanged', () => {
    for (const n of ['KEYBOARD_HACK', 'HISTCHARS', 'histchars', 'USERNAME']) {
      const c = `${n}=${sp}/x; git -C $${n} reset --hard`
      expect(spg.substituteDefiniteCommand(c), c).toBe(c)
    }
  })

  // every identifier-shaped name of the embedded zsh list, and the bash list, plus one name of each excluded prefix
  // (`?? []`: before the change the exports do not exist, and the assertion below must be the red reason, not a TypeError)
  const identifiers = (): string[] => [...(spg.ZSH_SPECIAL_NAMES ?? []), ...(spg.BASH_SPECIAL_NAMES ?? []), 'BASH_FOO', 'ZSH_FOO',
    'COMP_FOO', 'READLINE_FOO', 'LC_FOO'].filter((n: string) => /^[A-Za-z_]\w*$/.test(n))

  it('B1c no special name is replaced by the helper, and the use is denied at the gate (a git target)', () => {
    const names = identifiers()
    expect(names.length).toBeGreaterThan(150)
    for (const n of names) {
      const c = `${n}=${sp}/wt; git -C $${n} reset --hard`
      expect(spg.substituteDefiniteCommand(c), n).toBe(c)
      expect(bash(c, true), n).toMatchObject({ deny: true })
    }
  })

  // positive control: the list is exact names, not prefixes of ordinary names
  it('B1d a near-miss name that no shell treats as special is still replaced', () => {
    for (const n of ['KEYBOARD_HACKS', 'USERNAMES', 'WORDCHARSX', 'PATHX', 'HOMEDIR', 'TERMINAL', 'WORKTREE']) {
      const c = `${n}=${sp}/wt; git -C $${n} fetch -q origin develop`
      const out = spg.substituteDefiniteCommand(c)
      expect(out, n).not.toBe(c)
      expect(out, n).toContain(`git -C ${sp}/wt`)
    }
  })

  // The embedded zsh list is compared with the running zsh's own list (the reviewer's recipe). Where there is no zsh the
  // test is SKIPPED; a newer zsh that adds a special parameter makes it red on a machine that has one.
  const ZSH_RECIPE = 'for k in ${(ko)parameters}; do [[ ${parameters[$k]} == *special* ]] && print -r -- $k; done'
  const hasZsh = (() => { const r = spawnSync('zsh', ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0 })()
  it.skipIf(!hasZsh)('B1e the embedded zsh special-parameter list equals the running zsh list', () => {
    const r = spawnSync('zsh', ['-f', '-c', ZSH_RECIPE], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const live = r.stdout.split('\n').filter(Boolean).sort()
    expect([...(spg.ZSH_SPECIAL_NAMES ?? [])].sort()).toEqual(live)
  })
})
