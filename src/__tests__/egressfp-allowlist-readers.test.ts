// EGRESSFP1106: false "store/egress-allowlist.json" denials of plain reads from the project root
// (Bence 71296/71414, Abel 71309), and the three fixes (Samu 71412/71460):
//   (a) the protected-store and allowlist rules judge the segments the shell runs: a separator inside a
//       quoted string is no separator; unresolved quoting or a heredoc falls back to the naive split;
//   (b) a variable that is DEFINITELY a literal at its use has no "any text" reading there;
//   (c) `git grep` is a read, except -O / --open-files-in-pager, git -c / any other global option, and an
//       environment prefix.
// Every relaxation sits next to the real writes that must stay denied.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, protectedSegments, splitSegments, gitGrepReadOnly } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root: string
let allowlist: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'egressfp-')))
  mkdirSync(join(root, 'store'))
  allowlist = join(root, 'store', 'egress-allowlist.json')
  writeFileSync(allowlist, JSON.stringify({ domains: ['a.example'] }))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const bash = (command: string, cwd = root) => gateDecision('Bash', { command }, { allowlistPath: allowlist, cwd })
const allowed = (command: string, cwd?: string) => expect(bash(command, cwd), command).toEqual({ deny: false })
const deniedAllowlist = (command: string, cwd?: string) =>
  expect(bash(command, cwd), command).toEqual({ deny: true, reason: 'egress-allowlist' })
const denied = (command: string, cwd?: string) => expect(bash(command, cwd).deny, command).toBe(true)

describe('(a) a separator inside quotes does not make a command', () => {
  it('B1: grep with a BRE alternation, from the root (with and without a cd)', () => {
    allowed(`cd ${root} && grep -n "key: '[A-Z_]*\\(CHAT\\|OWNER\\)[A-Z_]*'" src/config-registry.ts`, '/tmp')
    allowed(`grep -n "key: '[A-Z_]*\\(CHAT\\|OWNER\\)[A-Z_]*'" src/config-registry.ts`)
    allowed(`grep -nE 'a;b|c' src/x.ts`)
  })
  it('the real writes next to it stay denied', () => {
    deniedAllowlist(`grep -n "a\\|b" f; cp /tmp/x store/egress-allowlist.json`)
    deniedAllowlist(`grep -n "a|b" f && sed -i '' 's/a/b/' store/egress-allowlist.json`)
    deniedAllowlist(`echo "x|y" > store/egress-allowlist.json`)
    deniedAllowlist(`sed -i '' 's/a/b/' store/egress-allowlist.json`)
    deniedAllowlist(`cp /tmp/x store/egress-allow*`)
    deniedAllowlist(`python3 -c "open('local-hooks/a.py','w')"`)
    deniedAllowlist(`bash -c "echo hi; cp /tmp/x store/egress-allowlist.json"`)
  })
  it('a quoted glob is NOT made harmless: find -delete on a quoted pattern stays denied', () => {
    deniedAllowlist(`find . -name 'local-ho*' -delete`)
    deniedAllowlist(`find store -name 'egress-allow*' -delete`)
  })
  it('unresolved quoting falls back to the naive split (fail-closed)', () => {
    const unterminated = `grep "a|b f; cp /tmp/x store/egress-allowlist.json`
    expect(protectedSegments(unterminated)).toEqual(splitSegments(unterminated))
    deniedAllowlist(unterminated)
    const subst = `grep "a|b $(cp /tmp/x store/egress-allowlist.json)" f`
    expect(protectedSegments(subst)).toEqual(splitSegments(subst))
    denied(subst)
  })
  it('a heredoc falls back to the naive split: a body line after an echo is still its own command', () => {
    const cmd = `bash <<EOF\necho hi\ncp /tmp/x store/egress-allowlist.json\nEOF`
    expect(protectedSegments(cmd)).toEqual(splitSegments(cmd))
    denied(cmd)
  })
  it('quote-aware split keeps the original text, so a quoted name is still a mention', () => {
    expect(protectedSegments(`grep "a|b" f; cat 'x;y'`)).toEqual([`grep "a|b" f`, `cat 'x;y'`])
    deniedAllowlist(`tee "store/egress-allowlist.json" < /tmp/x`)
  })
})

describe('(c) git grep is a read, in its narrow form', () => {
  it('B2: git grep with an ERE alternation, from the root', () => {
    allowed(`git grep -nE "key: '[A-Z_]*(CHAT|OWNER)[A-Z_]*'"`)
    allowed(`git -C ${root} --no-pager grep -n "[A-Z_]*" -- src`)
  })
  it('a pager, a config or an environment prefix stays denied', () => {
    for (const c of [
      `git grep -O "[A-Z_]*"`,
      `git grep -nO "[A-Z_]*"`,
      `git grep -Ovi "[A-Z_]*"`,
      `git grep --open-files-in-pager=vi "[A-Z_]*"`,
      `git grep --open "[A-Z_]*"`,
      `git -c core.pager=sh grep "[A-Z_]*"`,
      `git -c alias.grep='!sh' grep "[A-Z_]*"`,
      `git --config-env=core.pager=X grep "[A-Z_]*"`,
      `git --paginate grep "[A-Z_]*"`,
      `git -p grep "[A-Z_]*"`,
      `GIT_PAGER=sh git grep "[A-Z_]*"`,
      `git log "[A-Z_]*"`,
    ]) deniedAllowlist(c)
  })
  it('a redirect onto the allowlist stays denied', () => {
    deniedAllowlist(`git grep x > store/egress-allowlist.json`)
  })
  it('gitGrepReadOnly: the accepted and refused shapes', () => {
    expect(gitGrepReadOnly(['grep', '-n', 'x'])).toBe(true)
    expect(gitGrepReadOnly(['-C', '/r', '-P', 'grep', 'x'])).toBe(true)
    expect(gitGrepReadOnly(['--git-dir=/r/.git', '--work-tree=/r', 'grep', '--only-matching', 'x'])).toBe(true)
    for (const w of [['-c', 'a=b', 'grep'], ['grep', '-O'], ['grep', '-iO', 'x'], ['grep', '--o'], ['grep', '--open-files-in-pager'],
      ['-Cdir', 'grep'], ['--exec-path=/x', 'grep'], ['show'], []]) expect(gitGrepReadOnly(w), JSON.stringify(w)).toBe(false)
  })
})

describe('(b) a definitely literal variable has no unresolved reading', () => {
  const use = 'docker run -v $F/out:/out img'
  const B3 = `cd ROOT && F=/private/tmp/x/scratchpad/bfl-comment.txt && sed -i '' 's/^\\[Bence 11-06 10:5x\\] //' $F && head -c 80 $F`
  it('B3 (Bence 71414): the uses inside the && chain of the conditional assignment resolve', () => {
    allowed(B3.replace('ROOT', root), '/tmp')
  })
  it('B3 in full: its last use is past a ; after a CONDITIONAL assignment, so it stays unresolved (Samu 71530)', () => {
    deniedAllowlist(`${B3.replace('ROOT', root)}; echo; python3 scripts/kartya-es-ertesites.py --id X --comment-file $F --author Bence 2>&1 | tail -3`, '/tmp')
  })
  it('DENY (Samu 71530): a conditional assignment does not hold past a ;, where F is empty at run time', () => {
    deniedAllowlist(`false && F=/tmp/x; cp /tmp/y \${F}local-hooks/a.py`)
    deniedAllowlist(`cd ${root} && F=/tmp/x; cp /tmp/y \${F}local-hooks/a.py`, '/tmp')
    deniedAllowlist(`false && F=/tmp/x; ${use}`)
    // a pair without the name: conditional past a ; stays "any text" (from the root, * can be local-hooks) ...
    deniedAllowlist(`false && F=/tmp/x; cp /tmp/y \${F}/a.py`)
    // ... the same assignment unconditional (first in its list) resolves to the literal
    allowed(`F=/tmp/x; cp /tmp/y \${F}/a.py`)
  })
  it('positive: an unconditional or chained literal assignment before the use', () => {
    allowed(`cd ${root} && F=/tmp/x && ${use}`, '/tmp')
    allowed(`F=/tmp/x; cd ${root} && ${use}`, '/tmp')
    allowed(`F=/tmp/x; ${use}`)
    allowed(`F=/tmp/x && ${use.replace('$F', '${F}')}`)
  })
  it('the literal itself is still judged: a variable holding a protected path stays denied', () => {
    deniedAllowlist(`F=${root}/store/egress-allowlist.json; cp /tmp/x $F`)
    deniedAllowlist(`cd ${root} && F=store/egress-allowlist.json && cp /tmp/x $F`, '/tmp')
    deniedAllowlist(`F=local-hooks; cp /tmp/x $F/a.py`)
  })
  it('DENY rows (Samu 71460): ||, a subshell, a reassignment', () => {
    deniedAllowlist(`cd ${root} && false || F=/tmp/x && ${use}`, '/tmp')
    deniedAllowlist(`false || F=/tmp/x && ${use}`)
    // a || earlier in the same list, not right before the assignment: `(false || true) && F=x && use` vs `true || ...`
    deniedAllowlist(`true || false && F=/tmp/x && ${use}`)
    deniedAllowlist(`cd ${root} || true && F=/tmp/x && ${use}`, '/tmp')
    deniedAllowlist(`( F=/tmp/x ); ${use}`)
    deniedAllowlist(`F=/tmp/x; F=$HOME/y; ${use}`)
    deniedAllowlist(`F=/tmp/x; F=/tmp/y; ${use}`)
    deniedAllowlist(`F=/tmp/x; F+=/y; ${use}`)
  })
  it('DENY rows: a pipe, a background job, an env prefix, compound commands and other setters', () => {
    deniedAllowlist(`echo | F=/tmp/x && ${use}`)
    deniedAllowlist(`F=/tmp/x | cat; ${use}`)
    deniedAllowlist(`F=/tmp/x & ${use}`)
    deniedAllowlist(`F=/tmp/x || ${use}`)
    deniedAllowlist(`F=/tmp/x ${use}`)
    deniedAllowlist(`{ F=/tmp/x; }; ${use}`)
    deniedAllowlist(`if true; then F=/tmp/x; fi; ${use}`)
    deniedAllowlist(`F=/tmp/x; export F=$HOME; ${use}`)
    deniedAllowlist(`F=/tmp/x; read F; ${use}`)
    deniedAllowlist(`F=/tmp/x; source ./env.sh; ${use}`)
    deniedAllowlist(`F=/tmp/x; printf -v F %s y; ${use}`)
    deniedAllowlist(`F=/tmp/x; echo $(true); ${use}`)
    deniedAllowlist(`${use}; F=/tmp/x`)
  })
})
