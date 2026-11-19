// GATEOPENFORMS1118: a file the command writes, then runs in a form the earlier reading (laterRuns) did not see:
// through a copy under another name, behind a wrapper or an assignment prefix, as a shell's start-up file, as the
// program file of an option, as a command substitution's output used as code, or in the directory a wrapper moves to.
// The written text names a protected install path, so running it is denied as running that text would be. Text that is
// only written, copied, read or sent on still passes. Decisions only (nothing runs); the install root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, unwrapRun, copiedNames } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { shellSegments, shellWords } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'written-runs-')))
  root = join(base, 'Install')
  for (const d of ['.claude', 'scripts/hooks', 'store']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
  writeFileSync(join(root, 'store', 'autonomy-config.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

// @ROOT@: the install root (it.each tables are built before beforeEach). The caller's cwd is outside the install.
const bash = (c: string) => gateDecision('Bash', { command: c.replaceAll('@ROOT@', root) }, { root, cwd: base })
const DENY = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }
const WRITE = 'cp /tmp/x @ROOT@/.claude/settings.json'
const H = (f: string, body = WRITE) => `cat > ${f} <<'EOF'\n${body}\nEOF\n`

describe('a written file run under another name (a copy of it)', () => {
  it.each([
    ['cp, then sh', H('/tmp/f') + 'cp /tmp/f /tmp/g; sh /tmp/g'],
    ['tee from its stdin, then chmod and the command word', H('/tmp/f') + 'tee /tmp/g < /tmp/f; chmod +x /tmp/g; /tmp/g'],
    ['mv, then sh', H('/tmp/f') + 'mv /tmp/f /tmp/g; sh /tmp/g'],
    ['ln -s, then sh', H('/tmp/f') + 'ln -s /tmp/f /tmp/g; sh /tmp/g'],
    ['a reader redirected to the new name', H('/tmp/f') + 'cat /tmp/f > /tmp/g; sh /tmp/g'],
    ['install, then sh', H('/tmp/f') + 'install /tmp/f /tmp/g; sh /tmp/g'],
    ['dd of=, then sh', H('/tmp/f') + 'dd if=/tmp/f of=/tmp/g; sh /tmp/g'],
    ['cp into a directory, then sh of its name there', H('/tmp/f') + 'cp /tmp/f /tmp/d/; sh /tmp/d/f'],
    ['cp -t into a directory', H('/tmp/f') + 'cp -t /tmp/d /tmp/f; bash /tmp/d/f'],
    ['a reader piped into tee', H('/tmp/f') + 'cat /tmp/f | tee /tmp/g >/dev/null; sh /tmp/g'],
    ['a copy of a copy', H('/tmp/f') + 'cp /tmp/f /tmp/g; cp /tmp/g /tmp/h; source /tmp/h'],
    ['sed passing it on through a redirect', H('/tmp/f') + "sed '' /tmp/f > /tmp/g; sh /tmp/g"],
    ['head on its stdin, redirected', H('/tmp/f') + 'head -c 99999 < /tmp/f > /tmp/g; sh /tmp/g'],
    ['a pipe of text tools into a redirect', H('/tmp/f') + 'cat /tmp/f | sed s/a/a/ | sort > /tmp/g; sh /tmp/g'],
    ['a copy made in a loop before its source is copied', H('/tmp/f') + 'for i in 1 2; do cp /tmp/g /tmp/h; cp /tmp/f /tmp/g; done; sh /tmp/h'],
    ['printf text with a glob, copied, then sh', `printf 'echo x > @ROOT@/.claude/settings.js*\\n' > /tmp/f; cp /tmp/f /tmp/g; sh /tmp/g`],
    ['a quoted heredoc with a glob, copied, then sh', H('/tmp/f', 'rm -rf @ROOT@/scripts/hoo*') + 'cp /tmp/f /tmp/g; sh /tmp/g'],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe('a written file run behind a wrapper, an assignment or a start-up variable', () => {
  it.each([
    ['nice before env BASH_ENV', H('/tmp/f') + 'nice env BASH_ENV=/tmp/f bash -c true'],
    ['nohup before env BASH_ENV', H('/tmp/f') + 'nohup env BASH_ENV=/tmp/f bash -c true'],
    ['timeout with a duration before env BASH_ENV', H('/tmp/f') + 'timeout 5 env BASH_ENV=/tmp/f bash -c true'],
    ['nice before env ENV', H('/tmp/f') + 'nice env ENV=/tmp/f sh -i -c true'],
    ['command before env', H('/tmp/f') + 'command env BASH_ENV=/tmp/f bash -c true'],
    ['a BASH_ENV prefix assignment', H('/tmp/f') + 'BASH_ENV=/tmp/f bash -c true'],
    ['an exported BASH_ENV', H('/tmp/f') + 'export BASH_ENV=/tmp/f; bash -c true'],
    ['a ZDOTDIR holding the file', H('/tmp/z/.zshenv') + 'ZDOTDIR=/tmp/z zsh -c true'],
    ['nice -n with sh', H('/tmp/f') + 'nice -n 5 sh /tmp/f'],
    ['nice with sh on its stdin', H('/tmp/f') + 'nice sh < /tmp/f'],
    ['sh in a for loop body', H('/tmp/f') + 'for i in 1; do sh /tmp/f; done'],
    ['sh in an if branch', H('/tmp/f') + 'if true; then bash /tmp/f; fi'],
    ['sh in a brace group (already denied)', H('/tmp/f') + '{ sh /tmp/f; }'],
    ['nice -n5 glued with sh', H('/tmp/f') + 'nice -n5 sh /tmp/f'],
    ['timeout with options and bash', H('/tmp/f') + 'timeout -k 2 10 bash /tmp/f'],
    ['stdbuf with sh', H('/tmp/f') + 'stdbuf -oL sh /tmp/f'],
    ['sudo -u with sh', H('/tmp/f') + 'sudo -u nobody sh /tmp/f'],
    ['env -S with the file in its string (already denied: env runs what it names)', H('/tmp/f') + "env -S 'sh /tmp/f'"],
    ['nice before env -S with the file in its string', H('/tmp/f') + "nice env -S 'sh /tmp/f'"],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe('a written file run in the directory a wrapper moves to', () => {
  const REL = 'echo x > .claude/settings.json'
  it.each([
    ['env --chdir=', H('/tmp/s.sh', REL) + 'env --chdir=@ROOT@ sh /tmp/s.sh'],
    ['env -C', H('/tmp/s.sh', REL) + 'env -C @ROOT@ sh /tmp/s.sh'],
    ['env --chdir with a separate value', H('/tmp/s.sh', REL) + 'env --chdir @ROOT@ sh /tmp/s.sh'],
    ['sudo -D', H('/tmp/s.sh', REL) + 'sudo -D @ROOT@ sh /tmp/s.sh'],
    ['nice before env -C', H('/tmp/s.sh', REL) + 'nice env -C @ROOT@ sh /tmp/s.sh'],
    ['env --chdir to a directory the gate cannot know', H('/tmp/s.sh', REL) + 'env --chdir=$D sh /tmp/s.sh'],
    ['a cd the gate cannot follow (read as a lost directory)', H('/tmp/s.sh', REL) + 'cd "$D" && sh /tmp/s.sh'],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
  it('the same text run where the caller is still passes (the relative name lands outside the install)', () => {
    expect(bash(H('/tmp/s.sh', REL) + 'sh /tmp/s.sh')).toEqual(ALLOW)
  })
})

describe('a written file given to a program as its code file', () => {
  it.each([
    ['awk -f', H('/tmp/f', `BEGIN { system("${WRITE}") }`) + 'awk -f /tmp/f'],
    ['gawk --file=', H('/tmp/f', `BEGIN { system("${WRITE}") }`) + 'gawk --file=/tmp/f'],
    ['awk -f glued to the name', H('/tmp/f', `BEGIN { system("${WRITE}") }`) + 'awk -f/tmp/f'],
    ['sed -f (the e command)', H('/tmp/f', `1e ${WRITE}`) + 'sed -f /tmp/f /dev/null'],
    ['sed -nf', H('/tmp/f', `1e ${WRITE}`) + 'sed -nf /tmp/f /dev/null'],
    ['make -f', H('/tmp/f', `all:\n\t${WRITE}`) + 'make -f /tmp/f'],
    ['make --makefile=', H('/tmp/f', `all:\n\t${WRITE}`) + 'make --makefile=/tmp/f'],
    ['make with the default makefile name', H('/tmp/p/Makefile', `all:\n\t${WRITE}`) + 'make -C /tmp/p'],
    ['vim -S', H('/tmp/f', `:!${WRITE}`) + 'vim -S /tmp/f'],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe("a written file's text used as code through a command substitution", () => {
  it.each([
    ['sh -c "$(cat f)"', H('/tmp/f') + 'sh -c "$(cat /tmp/f)"'],
    ['eval "$(cat f)"', H('/tmp/f') + 'eval "$(cat /tmp/f)"'],
    ['bash -c "$(< f)"', H('/tmp/f') + 'bash -c "$(< /tmp/f)"'],
    ['the substitution as the command word', H('/tmp/f') + '"$(cat /tmp/f)"'],
    ['eval with backquotes (already denied)', H('/tmp/f') + 'eval `cat /tmp/f`'],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

// Dani, PR2883GATEFP1118 (33221): env runs a ./ spelling of the written file's absolute path from /. Denied on develop
// (env is a file runner); pinned here so a narrower env reading cannot open it.
describe('env with a ./ spelling of the written file, run from /', () => {
  it.each([
    ['./ before the path without its slash', H('/tmp/f') + 'chmod +x /tmp/f; cd / && env ./tmp/f'],
    ['./ before the full path', H('/tmp/f') + 'chmod +x /tmp/f; cd / && env .//tmp/f'],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe('text that is only written, copied, read or sent on still passes', () => {
  it.each([
    ['a body file', H('/tmp/m') + 'gh pr comment 1 --body-file /tmp/m'],
    ['a copy kept and sent, not run', H('/tmp/m') + 'cp /tmp/m /tmp/m.bak; gh pr comment 1 --body-file /tmp/m.bak'],
    ['a substitution as a message argument', H('/tmp/m') + 'gh pr comment 1 --body "$(cat /tmp/m)"'],
    ['an edit of it in place', H('/tmp/m') + "sed -i '' 's/a/b/' /tmp/m; cat /tmp/m"],
    ['a wrapped reader', H('/tmp/m') + 'nice -n 5 wc -l /tmp/m'],
    ['a wrapped upload of it', H('/tmp/m') + 'timeout 10 curl -s -d @/tmp/m http://127.0.0.1:3420/api/x'],
    ['an ordinary variable holding its name', H('/tmp/m') + 'F=/tmp/m; wc -c "$F"'],
    ['a tee copy that is only compared', H('/tmp/m') + 'tee /tmp/n < /tmp/m >/dev/null; diff /tmp/m /tmp/n'],
    ['awk reading it as data', H('/tmp/m') + "awk '{print $1}' /tmp/m"],
    ['its text in a variable, then printed', H('/tmp/m') + 'X="$(cat /tmp/m)"; echo "$X" | wc -c'],
    ['make elsewhere, with no makefile written', H('/tmp/m') + 'make -C /tmp/proj test'],
    ['an interpreter that builds new text from it, posted, the reply piped to an interpreter', H('/tmp/m') + `python3 -c "import json, sys; print(json.dumps({'c': open(sys.argv[1]).read()}))" /tmp/m > /tmp/payload.json; curl -s -d @/tmp/payload.json http://127.0.0.1:3420/api/x | python3 -c "import sys; print(sys.stdin.read()[:40])"`],
    ['its name inside a printf format written to another file, which another program reads', H('/tmp/m') + "printf 'spawn bash /tmp/m\\n' > /tmp/t.exp; expect -v"],
    ['a copy onto it from elsewhere, then the copy target read', H('/tmp/m') + 'cp /tmp/other /tmp/m; cp /tmp/m /tmp/n; wc -c /tmp/n'],
    ['an unrelated copy, then that copy run', H('/tmp/m') + 'cp /tmp/tool.sh /tmp/y; sh /tmp/y'],
    ['a cd the gate cannot follow, then a script that names nothing protected', H('/tmp/s.sh', 'npm test') + 'cd "$WT" && sh /tmp/s.sh'],
  ])('%s', (_, c) => { expect(bash(c)).toEqual(ALLOW) })
})

// The stated limit (the gate's own message, docs/db-write-gate.md): a file written in an EARLIER Bash call, or with the
// Write tool, is not read by this gate when a later call runs it.
describe('known limit', () => {
  it('a run of a file the same command did not write passes', () => {
    expect(bash('sh /tmp/f')).toEqual(ALLOW)
    expect(bash('cp /tmp/f /tmp/g; sh /tmp/g')).toEqual(ALLOW)
  })
})

describe('the readers', () => {
  const words = (c: string) => shellWords(c)
  it('unwrapRun strips wrappers, their options and values, and collects assignments and directory changes', () => {
    const u = unwrapRun(words('nice -n 5 timeout -k 2 10 env -i --chdir=/a -u Y X=1 sudo -D /b BASH_ENV=/f bash -c true'))
    expect(u.rest.map((w: { value: string }) => w.value)).toEqual(['bash', '-c', 'true'])
    expect(u.chdirs).toEqual(['/a', '/b'])
    expect(u.assigns).toEqual([{ name: 'X', value: '1' }, { name: 'BASH_ENV', value: '/f' }])
    expect(u.wrapped).toBe(true)
    expect(unwrapRun(words('sh /tmp/f')).wrapped).toBe(false)
  })
  it('copiedNames follows a copy, a redirect and a pipe to a fixpoint, and nothing else', () => {
    const segs = shellSegments('cat > /tmp/f <<EOF\nx\nEOF\ncp /tmp/f /tmp/g; cat /tmp/g | tee /tmp/h; cp /tmp/x /tmp/y', { surface: 'security', projectRoot: '/x' })
    expect(copiedNames(segs, 0, ['/tmp/f'])).toEqual(['/tmp/f', '/tmp/g', '/tmp/g/f', '/tmp/h'])
  })
})
