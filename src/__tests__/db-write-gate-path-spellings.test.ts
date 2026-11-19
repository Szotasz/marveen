// GATEPATHNORM1118: a file the command writes, then runs under another spelling of the same path: a relative name after
// a directory change (cd, pushd, a subshell's cd, a wrapper's chdir), ./ and ../, a doubled slash, /./, an absolute
// path for a file written by a relative name, and the same for a copy of it. The run checks compare names as written,
// so the gate now adds every spelling that resolves, at the directory the later segment runs in, to the written file.
// Where that directory cannot be followed, the last path part decides. The written text names a protected install
// path, so running it is denied. Another file, the same name in another directory, a file only read, and a harmless
// file run still pass. Decisions only (nothing runs); the install root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, writtenFileSpellings } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { shellSegments } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'path-spellings-')))
  root = join(base, 'Install')
  for (const d of ['.claude', 'scripts/hooks', 'store']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

// @ROOT@: the install root (it.each tables are built before beforeEach). The caller's cwd is outside the install.
const bash = (c: string) => gateDecision('Bash', { command: c.replaceAll('@ROOT@', root) }, { root, cwd: base })
const DENY = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }
const WRITE = 'cp /tmp/x @ROOT@/.claude/settings.json'
const H = (f: string, body = WRITE) => `cat > ${f} <<'EOF'\n${body}\nEOF\n`
const S = '/tmp/pn'

describe('the written file run under another spelling of its path', () => {
  it.each([
    ['a relative name after cd', H(`${S}/s.sh`) + `cd ${S} && sh s.sh`],
    ['./name after cd', H(`${S}/s.sh`) + `cd ${S} && sh ./s.sh`],
    ['../name after cd into a subdirectory', H(`${S}/s.sh`) + `cd ${S}/d && sh ../s.sh`],
    ['dir/../name', H(`${S}/s.sh`) + `sh ${S}/d/../s.sh`],
    ['a doubled slash', H(`${S}/s.sh`) + `sh ${S}//s.sh`],
    ['a /./ in the path', H(`${S}/s.sh`) + `sh ${S}/./s.sh`],
    ['./name as the command word', H(`${S}/s.sh`) + `cd ${S} && ./s.sh`],
    ['. ./name', H(`${S}/s.sh`) + `cd ${S} && . ./s.sh`],
    ['source with a relative name', H(`${S}/s.sh`) + `cd ${S}; source s.sh`],
    ['pushd, then the relative name', H(`${S}/s.sh`) + `pushd ${S} && sh s.sh`],
    ['a subshell cd, then the relative name', H(`${S}/s.sh`) + `(cd ${S} && sh s.sh)`],
    ['env --chdir=, then the relative name', H(`${S}/s.sh`) + `env --chdir=${S} sh s.sh`],
    ['env -C, then ./name', H(`${S}/s.sh`) + `env -C ${S} sh ./s.sh`],
    ['written by a relative name, run by its absolute path', `cd ${S} && ` + H('s.sh') + `sh ${S}/s.sh`],
    ['written by a relative name, run as ./name', `cd ${S} && ` + H('s.sh') + 'bash ./s.sh'],
    ['an interpreter after the cd', H(`${S}/s.py`, `import os; os.system("${WRITE}")`) + `cd ${S} && python3 ./s.py`],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe('a copy of the written file run under another spelling', () => {
  it.each([
    ['the copy by a relative name after cd', H(`${S}/a.sh`) + `cd ${S} && cp a.sh g && sh g`],
    ['an absolute copy, run as ./name after cd', H(`${S}/a.sh`) + `cp ${S}/a.sh ${S}/g && cd ${S} && sh ./g`],
    ['a relative copy, run by its absolute path', H(`${S}/a.sh`) + `cd ${S} && cp ./a.sh g && sh ${S}/g`],
    ['a copy into a subdirectory, run with ../', H(`${S}/a.sh`) + `cd ${S}/d && cp ../a.sh ./g && sh ${S}/d/../d/g`],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe('a directory that cannot be followed: the last path part decides', () => {
  it.each([
    ['cd to a variable, then ./name', H(`${S}/s.sh`) + 'cd "$D" && sh ./s.sh'],
    ['a relative write at an unknown directory, run as ./name', 'cd "$D" && ' + H('s.sh') + 'sh ./s.sh'],
    ['env -C to a variable, then the name', H(`${S}/s.sh`) + 'env -C "$D" sh s.sh'],
  ])('%s is denied', (_, c) => { expect(bash(c)).toEqual(DENY) })
})

describe('what is not the written file still passes', () => {
  it.each([
    ['another file in the same directory', H(`${S}/s.sh`) + `cd ${S} && sh other.sh`],
    ['the same name in another directory', H(`${S}/s.sh`) + `cd ${S}/d && sh s.sh`],
    ['the same name under another absolute path', H(`${S}/s.sh`) + 'sh /tmp/other/s.sh'],
    ['the written file only read after cd', H(`${S}/s.sh`) + `cd ${S} && cat ./s.sh`],
    ['a harmless written file run as ./name', H(`${S}/h.sh`, 'echo hi') + `cd ${S} && sh ./h.sh`],
    ['a harmless copy run under another spelling', H(`${S}/h.sh`, 'echo hi') + `cd ${S} && cp h.sh g && sh ./g`],
  ])('%s passes', (_, c) => { expect(bash(c)).toEqual(ALLOW) })
})

describe('another spelling is decided as the written one', () => {
  it.each([
    ['a script that only reads under the install root', `cd @ROOT@ && ls store`],
    ['a script that reads the install root itself', 'ls @ROOT@'],
    ['a script that names a protected file', WRITE],
    ['a harmless script', 'echo hi'],
  ])('%s: ./name after cd, and the absolute name, get the same decision', (_, body) => {
    const literal = bash(H(`${S}/s.sh`, body) + `cd ${S} && sh ${S}/s.sh`)
    expect(bash(H(`${S}/s.sh`, body) + `cd ${S} && sh ./s.sh`)).toEqual(literal)
    expect(bash(H(`${S}/s.sh`, body) + `cd ${S}/d && sh ../s.sh`)).toEqual(literal)
  })
})

describe('directories after an unknown one, assignments, and the later-directory reading', () => {
  it('an absolute cd after an unknown one is known again: the exact file is denied, another file in that directory passes', () => {
    expect(bash(H(`${S}/s.sh`) + `cd "$D"; cd ${S} && sh ./s.sh`)).toEqual(DENY)
    expect(bash(H(`${S}/s.sh`) + `cd "$D"; cd ${S}/d && sh ./s.sh`)).toEqual(ALLOW)
  })
  it('an assignment before the other spelling', () => {
    expect(bash(H(`${S}/s.sh`) + `cd ${S} && X=1 ./s.sh`)).toEqual(DENY)
    expect(bash(H(`${S}/s.sh`) + `cd ${S} && X=1 sh s.sh`)).toEqual(DENY)
  })
  it.each([['rm -rf .'], ['mv store /tmp/x'], ['find . -delete']])(
    'a script that reaches the install only from the directory it runs in (%s): denied under another spelling too',
    (body) => {
      const rel = relative(root, `${S}/s.sh`)
      expect(bash(H(`${S}/s.sh`, body) + `sh ${S}/s.sh`)).toEqual(ALLOW)
      expect(bash(H(`${S}/s.sh`, body) + `cd ${root} && sh ${S}/s.sh`)).toEqual(DENY)
      expect(bash(H(`${S}/s.sh`, body) + `cd ${root} && sh ${rel}`)).toEqual(DENY)
    })
})

describe('another spelling never lifts a denial the written name already gets', () => {
  it('a file fed to eval by its written name stays denied when a shell also runs it under another spelling', () => {
    const body = `cd @ROOT@ && ls store`
    const literalOnly = bash(H(`${S}/s.sh`, body) + `eval "$(cat ${S}/s.sh)"`)
    expect(literalOnly).toEqual(DENY)
    expect(bash(H(`${S}/s.sh`, body) + `eval "$(cat ${S}/s.sh)"; cd ${S} && sh ./s.sh`)).toEqual(DENY)
  })
})

describe('writtenFileSpellings', () => {
  const spell = (cmd: string, cwd: string | null = '/w', cwdLost = false) => {
    const segs = shellSegments(cmd)
    return writtenFileSpellings(segs, 0, ['/tmp/pn/s.sh'], { cwd, cwdLost, root: '/r' }).sort()
  }
  it('adds the later words that resolve to the written path, at the directory each segment runs in', () => {
    expect(spell('true; cd /tmp/pn && sh ./s.sh && cat ../pn/s.sh && cat s2.sh')).toEqual(['../pn/s.sh', './s.sh', '/tmp/pn/s.sh'])
  })
  it('keeps the written names, and adds nothing for a word that resolves elsewhere', () => {
    expect(spell('true; cd /tmp && sh s.sh && sh pn/x.sh')).toEqual(['/tmp/pn/s.sh'])
  })
  it('after a directory it cannot follow, a relative word with the same last part counts', () => {
    expect(spell('true; cd "$D" && sh ./s.sh && sh ./t.sh')).toEqual(['./s.sh', '/tmp/pn/s.sh'])
  })
  it('an absolute word elsewhere does not match by its last part alone', () => {
    expect(spell('true; cd "$D" && sh /tmp/other/s.sh')).toEqual(['/tmp/pn/s.sh'])
  })
  it('words with an expansion or a glob are never resolved', () => {
    expect(spell('true; cd /tmp/pn && sh ./s.s? && sh "$X"/s.sh')).toEqual(['/tmp/pn/s.sh'])
  })
})
