// GATEPATHNORM1118 (a-e): a file the command writes, then runs or uses as code in a form the earlier rules did not list.
// The rule is turned around, class by class: a later program that names the written file (any spelling of it, as an
// operand, an option value or an assignment) runs it, unless it is a known reader, a copier, a sender, or a file
// handler (chmod, touch, mkdir, rm); a copy is followed through any program that reads the file and writes a redirect;
// a variable that holds the file's text is code wherever a shell takes it as code. The written text names a protected
// install path, so all of these are denied; a harmless text run the same ways, and the protected text only read, sent
// or handled, still pass. Decisions only (nothing runs); the install root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'open-forms-ae-')))
  root = join(base, 'Install')
  for (const d of ['.claude', 'scripts/hooks', 'store']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const bash = (c: string) => gateDecision('Bash', { command: c.replaceAll('@ROOT@', root) }, { root, cwd: base })
const DENY = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }
const WRITE = 'cp /tmp/x @ROOT@/.claude/settings.json'
const H = (f: string, body = WRITE) => `cat > ${f} <<'EOF'\n${body}\nEOF\n`
const F = '/tmp/f'

describe('(a) a copy through any program that reads the file and writes a redirect', () => {
  it.each([
    ['grep into a redirect', `grep '' ${F} > /tmp/g; sh /tmp/g`],
    ['base64 there and back', `base64 < ${F} | base64 -d > /tmp/g; sh /tmp/g`],
    ['rev there and back', `rev ${F} | rev > /tmp/g; sh /tmp/g`],
    ['xxd there and back', `xxd -p ${F} | xxd -r -p > /tmp/g; sh /tmp/g`],
    ['strings', `strings ${F} > /tmp/g; sh /tmp/g`],
    ['gzip and gunzip', `gzip -c ${F} | gunzip > /tmp/g; sh /tmp/g`],
    ['column', `column -t ${F} > /tmp/g; sh /tmp/g`],
    ['fmt', `fmt ${F} > /tmp/g; sh /tmp/g`],
    ['less into a redirect', `less ${F} > /tmp/g; sh /tmp/g`],
    ['printf of its text', `printf '%s\\n' "$(cat ${F})" > /tmp/g; sh /tmp/g`],
    ['echo of its text', `echo "$(cat ${F})" > /tmp/g; sh /tmp/g`],
    ['tar through a pipe into a directory', `tar cf - -C /tmp f | tar xf - -C /tmp/d; sh /tmp/d/f`],
    ['split into pieces', `split -l 100 ${F} /tmp/d/x; sh /tmp/d/xaa`],
    ['cp with a brace source', `cp /tmp/{f,g}; sh /tmp/g`],
  ])('%s is denied', (_, tail) => { expect(bash(H(F) + tail)).toEqual(DENY) })
  it('cp with a glob source that matches the file', () => {
    expect(bash(H('/tmp/pn/a.sh') + 'cp /tmp/pn/a.s? /tmp/g; sh /tmp/g')).toEqual(DENY)
  })
  it('a symlink to its directory, then the path through the link', () => {
    expect(bash(H('/tmp/pn/s.sh') + 'ln -s /tmp/pn /tmp/L; sh /tmp/L/s.sh')).toEqual(DENY)
  })
})

describe('(b) a wrapper outside the earlier list', () => {
  it.each([
    ['flock', `flock /tmp/lk sh ${F}`],
    ['script', `script -q /dev/null sh ${F}`],
    ['arch', `arch -arm64 sh ${F}`],
    ['find -exec on its name', `find /tmp -name f -exec sh {} \\;`],
    ['screen', `screen -dm sh ${F}`],
    ['tmux', `tmux new -d sh ${F}`],
    ['strace', `strace -o /dev/null sh ${F}`],
    ['doas', `doas sh ${F}`],
    ['unbuffer', `unbuffer sh ${F}`],
    ['watch', `watch -n1 sh ${F}`],
    ['parallel', `parallel sh ::: ${F}`],
    ['ssh to localhost', `ssh localhost sh ${F}`],
    ['sandbox-exec', `sandbox-exec -n no-network sh ${F}`],
  ])('%s is denied', (_, tail) => { expect(bash(H(F) + tail)).toEqual(DENY) })
})

describe('(c) a start-up or runner variable, or a git config value, naming it', () => {
  it.each([
    ['GIT_PAGER', `GIT_PAGER=${F} git log`],
    ['GIT_EXTERNAL_DIFF', `GIT_EXTERNAL_DIFF=${F} git diff`],
    ['EDITOR for crontab', `EDITOR=${F} crontab -e`],
    ['MANPAGER', `MANPAGER=${F} man ls`],
    ['LESSOPEN', `LESSOPEN="|${F} %s" less /tmp/x`],
    ['SHELL for script', `SHELL=${F} script -q /dev/null`],
    ['git -c core.pager', `git -c core.pager=${F} log`],
    ['git -c alias with !', `git -c alias.x=!${F} x`],
  ])('%s is denied', (_, tail) => { expect(bash(H(F) + tail)).toEqual(DENY) })
})

describe('(d) a program that takes it as its program file', () => {
  it.each([
    ['gdb -x', `gdb -batch -x ${F}`],
    ['lldb -s', `lldb -s ${F}`],
    ['m4', `m4 ${F}`],
    ['dc', `dc ${F}`],
    ['ed on its stdin', `ed -s /dev/null < ${F}`],
    ['emacs -l', `emacs --batch -l ${F}`],
    ['tclsh', `tclsh ${F}`],
    ['expect', `expect ${F}`],
    ['lua', `lua ${F}`],
    ['Rscript', `Rscript ${F}`],
    ['crontab', `crontab ${F}`],
    ['at -f', `at -f ${F} now`],
    ['ssh -F', `ssh -F ${F} x`],
    ['awk running it from its program text', `awk 'BEGIN{system("sh ${F}")}'`],
    ['just -f', `just -f ${F}`],
    ['launchctl submit', `launchctl submit -l x -- sh ${F}`],
    ['curl reading it as its config', `curl -K ${F} https://example.invalid`],
  ])('%s is denied', (_, tail) => { expect(bash(H(F) + tail)).toEqual(DENY) })
  it('python3 -m on its module name', () => {
    expect(bash(H('/tmp/pn/a.py', `import os; os.system("${WRITE}")`) + 'cd /tmp/pn && python3 -m a')).toEqual(DENY)
  })
})

describe('(e) its text as code beyond a substitution in place', () => {
  it.each([
    ['a here-string to a shell', `bash <<< "$(cat ${F})"`],
    ['a variable, then eval', `X=$(cat ${F}); eval "$X"`],
    ['a variable, then sh -c', `X=$(cat ${F}); sh -c "$X"`],
    ['an exported variable, then bash -c', `export X=$(<${F}); bash -c "$X"`],
    ['eval of a quoted backtick', `eval "\`cat ${F}\`"`],
    ['read a line, then eval', `read -r L < ${F}; eval "$L"`],
    ['mapfile, then eval of the array', `mapfile -t L < ${F}; eval "\${L[@]}"`],
  ])('%s is denied', (_, tail) => { expect(bash(H(F) + tail)).toEqual(DENY) })
})

describe('the same, with the path in a variable the command assigns itself', () => {
  const PW = `S=/tmp/pv; printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > $S/a.sh; `
  it.each([
    ['a here-string of a quoted substitution (the segmenter cannot read it)', 'bash <<< "$(cat $S/a.sh)"'],
    ['eval of a quoted backtick (the same)', 'eval "`cat $S/a.sh`"'],
    ['a symlink to its directory', 'ln -s $S $S/L; sh $S/L/a.sh'],
    ['cd to it, then ./name', 'cd $S && sh ./a.sh'],
  ])('%s is denied', (_, tail) => { expect(bash(PW + tail)).toEqual(DENY) })
  // the spelling only in a stdin redirect (no other word names the file)
  it.each([
    ['a shell reading it on stdin through a variable', 'X=/tmp/f; sh < "$X"'],
    ['a shell reading it on stdin through a directory variable', 'D=/tmp; sh < "$D/f"'],
    ['bash -s reading it on stdin, unquoted', 'D=/tmp; bash -s < $D/f'],
  ])('%s is denied', (_, tail) => { expect(bash(H(F) + tail)).toEqual(DENY) })
  it('a reader on stdin through a variable, and a harmless text on a shell\'s stdin: passes', () => {
    expect(bash(H(F) + 'D=/tmp; wc -l < "$D/f"; grep -c cp < $D/f')).toEqual(ALLOW)
    expect(bash(H(F, 'echo hi') + 'D=/tmp; sh < "$D/f"')).toEqual(ALLOW)
  })
  it('an unreadable command whose written text is harmless, or whose written file is not named again: passes', () => {
    expect(bash(`S=/tmp/pv; printf 'echo hi\\n' > $S/a.sh; bash <<< "$(cat $S/a.sh)"`)).toEqual(ALLOW)
    expect(bash(`printf 'see @ROOT@/.claude/settings.json\\n' > /tmp/note.txt; echo "$(git log -1 --format='%ad' $c)"`)).toEqual(ALLOW)
  })
})

describe('what does not run the file still passes', () => {
  it.each([
    ['read by a reader', `cat ${F}; wc -l ${F}; grep x ${F}; jq . ${F}; diff ${F} /tmp/g; sha256sum ${F}`],
    ['listed and inspected', `ls -l ${F}; stat ${F}; file ${F}; test -f ${F}`],
    ['handled', `touch ${F}; mkdir -p /tmp/d; rm ${F}`],
    ['sent as a comment file', `python3 scripts/kartya-es-ertesites.py --id X --comment-file ${F} --author A`],
    ['sent as a PR body', `gh pr comment 1 --body-file ${F}`],
    ['a commit message', `git commit -F ${F}`],
    ['copied and only read', `cp ${F} /tmp/g; cat /tmp/g`],
    ['its text in a variable, only printed', `X=$(cat ${F}); echo "$X"`],
    ['read into a variable, only printed', `read -r L < ${F}; echo "$L"`],
    ['handed as data to the caller\'s own script', `/tmp/tools/q.sh ${F} | head -c 300`],
    ['its text as an argument of the caller\'s own script, the output read back', `/tmp/tools/query.sh "$(cat ${F})" > /tmp/out.json; python3 -c 'import json; print(json.load(open("/tmp/out.json")))'`],
    ['handed to a shell function the command defines', `k(){ python3 scripts/kartya-es-ertesites.py "$@"; }; k --id X --comment-file ${F} --author A`],
    ['sent to another host on ssh\'s stdin', `ssh -F /tmp/ssh_config remote-host 'psql -A' < ${F}`],
    ['run in a container', `docker run --rm --network none -v /tmp:/w alpine sh /w/f`],
    ['fed to a container on stdin', `docker exec -i qa-c psql -A < ${F}`],
    ['run by its path in a container that mounts its directory', `podman run --rm -v /tmp:/tmp alpine sh ${F}`],
    ['handed to the caller\'s own script as an operand, the output read back', `/tmp/tools/query.sh ${F} > /tmp/out.json; python3 -c 'import json; print(json.load(open("/tmp/out.json")))'`],
    ['fed to the caller\'s own script on stdin, the output read back', `/tmp/tools/q.sh 'bash -s' < ${F} > /tmp/out.txt; python3 -c 'print(open("/tmp/out.txt").read()[:300])'`],
    ['its text in a non-printing program\'s argument, the output read back', `psql -At -c "$(cat ${F})" > /tmp/out.txt; python3 -c 'print(open("/tmp/out.txt").read())'`],
    ['diffed and shown by git', `git diff ${F}; git log -1 -- ${F}`],
    ['found without an action', `find /tmp -name f -print`],
  ])('the protected text %s: passes', (_, tail) => { expect(bash(H(F) + tail)).toEqual(ALLOW) })
  it.each([
    ['gdb -x', `gdb -batch -x ${F}`],
    ['a git pager', `git -c core.pager=${F} log`],
    ['a variable, then eval', `X=$(cat ${F}); eval "$X"`],
    ['a copy through base64', `base64 < ${F} | base64 -d > /tmp/g; sh /tmp/g`],
    ['flock', `flock /tmp/lk sh ${F}`],
  ])('a harmless text run through %s: passes', (_, tail) => { expect(bash(H(F, 'echo hi') + tail)).toEqual(ALLOW) })
})
