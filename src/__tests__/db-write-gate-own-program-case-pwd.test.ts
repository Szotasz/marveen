// GATEPATHNORM1118 F1/F2 (Dani 81347, his cases6.json): a program this command copied or linked itself is not the
// caller's own code, even under a path or a .sh name (F1); a case variant of the written file's path on a
// case-insensitive file system, and $PWD after a cd, are spellings of the file (F2). The written text names a protected
// install path, so these are denied; the caller's own tool reading data, a program made here running a harmless text,
// a case variant on a case-sensitive file system and another file still pass. Decisions only; the root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'own-program-')))
  root = join(base, 'Install')
  for (const d of ['.claude', 'scripts/hooks', 'store']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const bash = (c: string, caseInsensitiveFs?: boolean) =>
  gateDecision('Bash', { command: c.replaceAll('@ROOT@', root).replaceAll('@S@', join(base, 'w')) }, { root, cwd: base, caseInsensitiveFs })
const DENY = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }
const WRITE = "printf 'echo hi > @ROOT@/.claude/settings.json\\n' > @S@/s.sh; "
const HARMLESS = "printf 'echo hi\\n' > @S@/s.sh; "

describe('F1: a program the command made itself is not the caller\'s own code', () => {
  it.each([
    ['a copied shell run by its path', 'cp /bin/sh @S@/m; @S@/m @S@/s.sh'],
    ['a linked shell run by its path', 'ln -s /bin/sh @S@/m2; @S@/m2 @S@/s.sh'],
    ['a copied shell run as ./name after a cd', 'cp /bin/sh @S@/m3; cd @S@ && ./m3 s.sh'],
    ['a copied shell found through a PATH prefix', 'cp /bin/sh @S@/m4; PATH=@S@:$PATH m4 @S@/s.sh'],
    ['a shell copied to a .sh name', 'cp /bin/sh @S@/run.sh; cd @S@ && PATH=.:$PATH run.sh s.sh'],
    ['a program copied with -t into a directory', 'cp -t @S@/bin /usr/local/bin/xsh; @S@/bin/xsh @S@/s.sh'],
    ['a shell written by tee', 'cat /bin/sh | tee @S@/m5 > /dev/null; @S@/m5 @S@/s.sh'],
    ['a shell written by a redirect', 'cat /bin/sh > @S@/m6; chmod +x @S@/m6; @S@/m6 @S@/s.sh'],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it.each([
    ['the caller\'s own tool reading a data file', "printf 'hello\\n' > @S@/data.txt; @S@/tool @S@/data.txt"],
    ['the caller\'s own script handed the protected text (not made here)', WRITE + '/tmp/tools/q.sh @S@/s.sh'],
    ['a program made here, run on a harmless text', HARMLESS + 'cp /bin/sh @S@/m; @S@/m @S@/s.sh'],
    // the fleet meter's one false denial: a script the command writes itself (its text is read when it runs) handed a
    // data file that mentions a protected path
    ['a script written here by a heredoc, handed a data file', "cat > @S@/q.sh <<'EOF'\necho run \"$1\"\nEOF\nchmod +x @S@/q.sh\nprintf 'see @ROOT@/.claude/settings.json\\n' > @S@/ctrl.sql; @S@/q.sh @S@/ctrl.sql | head -c 300"],
    ['a script written here by printf, handed a data file', "printf 'echo run\\n' > @S@/q2.sh; chmod +x @S@/q2.sh; printf 'see @ROOT@/.claude/settings.json\\n' > @S@/c.sql; @S@/q2.sh @S@/c.sql"],
  ])('%s: passes', (_, c) => { expect(bash(c)).toEqual(ALLOW) })
})

describe('F2: a case variant on a case-insensitive file system, and $PWD after a cd', () => {
  it.each([
    ['written A.sh, run a.sh', "printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > /tmp/pv/A.sh; sh /tmp/pv/a.sh"],
    ['the directory in another case', "printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > /tmp/pv/a.sh; sh /tmp/PV/a.sh"],
  ])('%s: denied on a case-insensitive file system, passes on a case-sensitive one', (_, c) => {
    expect(bash(c, true)).toEqual(DENY)
    expect(bash(c, false)).toEqual(ALLOW)
  })
  it.each([
    ['$PWD/name after a cd', "cd /tmp/pv && printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > a.sh; sh $PWD/a.sh"],
    ['"${PWD}/name" after a cd', "cd /tmp/pv && printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > a.sh; sh \"${PWD}/a.sh\""],
  ])('%s is denied, whatever the file system', (_, c) => {
    expect(bash(c, true)).toEqual(DENY)
    expect(bash(c, false)).toEqual(DENY)
  })
  it('another file, and a harmless text in another case, pass', () => {
    expect(bash("printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > /tmp/pv/a.sh; sh /tmp/pv/b.sh", true)).toEqual(ALLOW)
    expect(bash("printf 'echo hi\\n' > /tmp/pv/A.sh; sh /tmp/pv/a.sh", true)).toEqual(ALLOW)
    expect(bash("cd /tmp/pv && printf 'cp /tmp/x @ROOT@/.claude/settings.json\\n' > a.sh; sh $PWD/b.sh")).toEqual(ALLOW)
  })
})
