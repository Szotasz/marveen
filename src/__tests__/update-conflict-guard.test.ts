import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// UPDATECONFLICT1105 (field report, 2026-11-05): an update from an older version popped the auto-stash the old way;
// the pop conflicted and left "<<<<<<< Updated upstream" in a tracked Python script, the SyntaxError kept the
// channel service down. update.sh never re-executes itself, so a fix to its own pop cannot reach the run that pulls
// it; the old update.sh does restart through the NEW scripts/start.sh, which calls this guard first.
//
// These tests run the real scripts/update-conflict-guard.sh against a REAL throwaway git repo, where the conflict is
// a real `git stash pop` conflict made with the old update.sh sequence (stash push -u, pull, stash pop).

const GUARD = join(__dirname, '..', '..', 'scripts', 'update-conflict-guard.sh')
const START = readFileSync(join(__dirname, '..', '..', 'scripts', 'start.sh'), 'utf-8')
const SANDBOX = mkdtempSync(join(tmpdir(), 'upd-conflguard-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
}
function sh(dir: string, script: string) {
  const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf-8', env: GIT_ENV })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const git = (dir: string, args: string) => sh(dir, `git ${args}`).out
function guard(dir: string) {
  const t0 = process.hrtime.bigint()
  const r = spawnSync('bash', [GUARD, dir], { cwd: SANDBOX, encoding: 'utf-8', env: GIT_ENV })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? ''), ms }
}
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf-8')
const state = (dir: string) => JSON.parse(read(dir, 'store/update-conflict-guard.json'))
const backups = (dir: string) => (existsSync(join(dir, 'store'))
  ? readdirSync(join(dir, 'store')).filter((n) => n.startsWith('update-conflict-backup-')) : [])
const sha = (dir: string, f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
const parsesPy = (dir: string, f: string) =>
  sh(dir, `python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' ${f}`).code === 0

const GATE = 'scripts/memoria_heartbeat_gate.py'
const BASE = 'import os\n\nAGENT = "picard"\n\n\ndef main():\n    return AGENT\n'
const LOCAL = BASE.replace('"picard"', '"tibor"')
const UPSTREAM = BASE.replace('AGENT = "picard"', 'AGENT = os.environ.get("MAIN_AGENT_ID", "marveen")')
const BROKEN_UPSTREAM = BASE.replace('AGENT = "picard"', 'AGENT = (')

// The install as the old update.sh leaves it: base commit, local edits (the gate line = conflict, other.py = no
// conflict, an untracked note), `git stash push -u`, the upstream commit, `git stash pop` (conflicts).
function conflicted(opts: { upstream?: string, deleteUpstream?: boolean, stashMsg?: string } = {}): string {
  const dir = mkdtempSync(join(SANDBOX, 'repo-'))
  mkdirSync(join(dir, 'scripts'))
  writeFileSync(join(dir, GATE), BASE)
  writeFileSync(join(dir, 'scripts/other.py'), 'X = 1\n')
  writeFileSync(join(dir, '.gitignore'), '__pycache__/\n*.pyc\nstore/\n')
  expect(sh(dir, 'git init -q && git add -A && git commit -qm base').code).toBe(0)
  writeFileSync(join(dir, GATE), LOCAL)
  writeFileSync(join(dir, 'scripts/other.py'), 'X = 1\n# local note\n')
  writeFileSync(join(dir, 'note.txt'), 'mine\n')
  expect(sh(dir, `git stash push -q -u -m "${opts.stashMsg ?? 'marveen-update-auto-stash 20261103-201500'}"`).code).toBe(0)
  if (opts.deleteUpstream) expect(sh(dir, `git rm -q ${GATE} && git commit -qm upstream`).code).toBe(0)
  else {
    writeFileSync(join(dir, GATE), opts.upstream ?? UPSTREAM)
    expect(sh(dir, 'git commit -qam upstream').code).toBe(0)
  }
  expect(sh(dir, 'git stash pop').code).not.toBe(0)
  return dir
}

describe('the repro is the field state', () => {
  it('a conflicted pop leaves markers, a SyntaxError, the unmerged path and the stash entry', () => {
    const dir = conflicted()
    expect(read(dir, GATE)).toContain('<<<<<<< Updated upstream')
    expect(parsesPy(dir, GATE)).toBe(false)
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe(GATE)
    expect(git(dir, 'stash list')).toContain('marveen-update-auto-stash')
  })
})

describe('update-conflict-guard.sh: the repair (UPDATECONFLICT1105)', () => {
  it('puts the conflicted script back to the updated version: no marker, it parses, nothing unmerged', () => {
    const dir = conflicted()
    const r = guard(dir)
    expect(r.code).toBe(0)
    expect(read(dir, GATE)).toBe(UPSTREAM)
    expect(parsesPy(dir, GATE)).toBe(true)
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe('')
    expect(r.out).toContain('repaired conflicted files back to the updated version: ' + GATE)
  })

  it('keeps the stash entry (the operator\'s copy) and names it; never pops, applies or drops', () => {
    const dir = conflicted()
    const before = git(dir, 'stash list')
    const r = guard(dir)
    expect(git(dir, 'stash list')).toBe(before)
    expect(git(dir, `show 'stash@{0}':${GATE}`)).toBe(LOCAL)
    expect(r.out).toContain("local copies stay in 'stash@{0}'")
    expect(state(dir).stash).toContain('marveen-update-auto-stash 20261103-201500')
  })

  it('leaves the non-conflicting local edit and the untracked file exactly as they were', () => {
    const dir = conflicted()
    const other = sha(dir, 'scripts/other.py')
    const notGate = (l: string) => l.split('\n').filter((x) => x && x !== GATE).join('\n')
    const staged = notGate(git(dir, 'diff --cached --name-only'))
    expect(staged).toBe('scripts/other.py')
    guard(dir)
    expect(sha(dir, 'scripts/other.py')).toBe(other)
    expect(read(dir, 'scripts/other.py')).toContain('# local note')
    expect(read(dir, 'note.txt')).toBe('mine\n')
    // only the unmerged path is touched: what the pop staged stays staged
    expect(notGate(git(dir, 'diff --cached --name-only'))).toBe(staged)
  })

  it('backs up first: the conflicted file with its markers and a git diff HEAD patch, in a timestamped store dir', () => {
    const dir = conflicted()
    guard(dir)
    const b = backups(dir)
    expect(b).toHaveLength(1)
    expect(read(dir, `store/${b[0]}/${GATE}`)).toContain('<<<<<<< Updated upstream')
    expect(read(dir, `store/${b[0]}/${GATE}`)).toContain('AGENT = "tibor"')
    expect(read(dir, `store/${b[0]}/local-changes.patch`)).toContain('AGENT = "tibor"')
    const s = state(dir)
    expect(s).toMatchObject({ state: 'repaired', paths: [GATE], backup: `store/${b[0]}` })
    expect(typeof s.at).toBe('number')
  })

  it('a file the update deleted is removed (the operator\'s copy stays in the stash and the backup)', () => {
    const dir = conflicted({ deleteUpstream: true })
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe(GATE)
    guard(dir)
    expect(existsSync(join(dir, GATE))).toBe(false)
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe('')
    expect(git(dir, `show 'stash@{0}':${GATE}`)).toBe(LOCAL)
    expect(state(dir).state).toBe('repaired')
  })

  it('a repaired script that still does not parse (a broken upstream) is reported loudly as repair_failed', () => {
    const dir = conflicted({ upstream: BROKEN_UPSTREAM })
    const r = guard(dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain('ERROR: after the repair these still do not parse or stay conflicted: ' + GATE)
    expect(state(dir)).toMatchObject({ state: 'repair_failed' })
  })
})

describe('update-conflict-guard.sh: only the update\'s own pop is repaired (Dani #2542 review)', () => {
  it('the operator\'s own merge in progress, with an OLD auto-stash entry: the hand resolution stays, report only', () => {
    const dir = mkdtempSync(join(SANDBOX, 'merge-'))
    writeFileSync(join(dir, 'x.py'), 'x = 5\n')
    expect(sh(dir, 'git init -q && git add -A && git commit -qm base').code).toBe(0)
    // an old auto-stash entry from an earlier update
    writeFileSync(join(dir, 'old.txt'), 'old\n')
    expect(sh(dir, 'git stash push -q -u -m "marveen-update-auto-stash 20261001-120000"').code).toBe(0)
    expect(sh(dir, 'git checkout -q -b other && sed -i.bak "s/5/8/" x.py && rm x.py.bak && git commit -qam other && git checkout -q -').code).toBe(0)
    expect(sh(dir, 'sed -i.bak "s/5/6/" x.py && rm x.py.bak && git commit -qam main').code).toBe(0)
    expect(sh(dir, 'git merge other').code).not.toBe(0)
    writeFileSync(join(dir, 'x.py'), 'x = 7\n') // the hand resolution, not yet added
    const r = guard(dir)
    expect(read(dir, 'x.py')).toBe('x = 7\n')
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(r.out).toContain('a git operation is in progress (MERGE_HEAD)')
    expect(state(dir)).toMatchObject({ state: 'refused_in_progress', paths: ['x.py'] })
    expect(backups(dir)).toHaveLength(0)
  })

  it.each(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge/', 'rebase-apply/'])(
    'any operation in progress (%s) stops the repair', (m) => {
      const dir = conflicted()
      const p = join(dir, '.git', m.replace('/', ''))
      if (m.endsWith('/')) mkdirSync(p)
      else writeFileSync(p, git(dir, 'rev-parse HEAD'))
      const before = read(dir, GATE)
      guard(dir)
      expect(read(dir, GATE)).toBe(before)
      expect(state(dir).state).toBe('refused_in_progress')
    })

  it('stash@{0} is the operator\'s own stash, an old auto-stash below it: not touched', () => {
    const dir = mkdtempSync(join(SANDBOX, 'ownstash-'))
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, GATE), BASE)
    expect(sh(dir, 'git init -q && git add -A && git commit -qm base').code).toBe(0)
    writeFileSync(join(dir, 'old.txt'), 'old\n')
    expect(sh(dir, 'git stash push -q -u -m "marveen-update-auto-stash 20261001-120000"').code).toBe(0)
    writeFileSync(join(dir, GATE), LOCAL)
    expect(sh(dir, 'git stash push -q -m "my own work"').code).toBe(0)
    writeFileSync(join(dir, GATE), UPSTREAM)
    expect(sh(dir, 'git commit -qam upstream').code).toBe(0)
    expect(sh(dir, 'git stash pop').code).not.toBe(0) // pops "my own work": conflict, it stays at stash@{0}
    expect(git(dir, 'stash list -n 1')).toContain('my own work')
    const before = read(dir, GATE)
    const r = guard(dir)
    expect(read(dir, GATE)).toBe(before)
    expect(r.out).toContain('stash@{0} is not a marveen-update-auto-stash entry')
    expect(state(dir).state).toBe('refused_no_stash')
  })

  it('the backup is owner-only with a unique suffix; the repaired file keeps the usual mode', () => {
    const dir = conflicted()
    guard(dir)
    const b = backups(dir)
    expect(b).toHaveLength(1)
    expect(b[0]).toMatch(/^update-conflict-backup-\d{8}-\d{6}-[A-Za-z0-9]{6}$/)
    expect(statSync(join(dir, 'store', b[0])).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'store', b[0], 'local-changes.patch')).mode & 0o077).toBe(0)
    expect(statSync(join(dir, 'store', b[0], GATE)).mode & 0o077).toBe(0)
    expect(statSync(join(dir, GATE)).mode & 0o044).toBe(0o044) // readable as before, not 0600
  })
})

describe('update-conflict-guard.sh: when it must NOT repair', () => {
  it('no marveen-update-auto-stash entry: the file is not touched, a warning is written', () => {
    const dir = conflicted({ stashMsg: 'something else' })
    const before = read(dir, GATE)
    const r = guard(dir)
    expect(read(dir, GATE)).toBe(before)
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe(GATE)
    expect(r.out).toContain('stash@{0} is not a marveen-update-auto-stash entry')
    expect(state(dir)).toMatchObject({ state: 'refused_no_stash', paths: [GATE] })
    expect(backups(dir)).toHaveLength(0)
  })

  it('the backup fails: nothing is repaired', () => {
    const dir = conflicted()
    writeFileSync(join(dir, 'store'), 'not a directory\n') // store/ cannot be created
    const before = read(dir, GATE)
    const r = guard(dir)
    expect(read(dir, GATE)).toBe(before)
    expect(git(dir, 'diff --name-only --diff-filter=U').trim()).toBe(GATE)
    expect(r.out).toContain('the backup to store/update-conflict-backup-')
    expect(r.out).toContain('failed; nothing repaired')
  })

  it('a marker outside a conflict (the file was staged by hand) is only reported', () => {
    const dir = conflicted()
    expect(sh(dir, `git add ${GATE}`).code).toBe(0) // no longer unmerged, markers staged
    const before = read(dir, GATE)
    const r = guard(dir)
    expect(read(dir, GATE)).toBe(before)
    expect(r.out).toContain('conflict markers in files that are not in a conflicted state; not repaired: ' + GATE)
    expect(state(dir)).toMatchObject({ state: 'markers_only', paths: [GATE] })
    expect(backups(dir)).toHaveLength(0)
  })

  it('not a git tree, or a tree that is not the install\'s own: one line, nothing else', () => {
    const plain = mkdtempSync(join(SANDBOX, 'plain-'))
    expect(guard(plain).out.trim()).toBe('[update-conflict-guard] not a git tree; skipped')
    const dir = conflicted()
    const sub = join(dir, 'scripts')
    const r = guard(sub)
    expect(r.out).toContain("the git tree is not the install's own")
    expect(existsSync(join(sub, 'store'))).toBe(false)
    expect(read(dir, GATE)).toContain('<<<<<<<')
  })
})

describe('update-conflict-guard.sh: the cost on a clean tree', () => {
  it('a clean tree: no output, no file written, the git index untouched; time measured', () => {
    const dir = mkdtempSync(join(SANDBOX, 'clean-'))
    writeFileSync(join(dir, 'a.py'), 'A = 1\n')
    expect(sh(dir, 'git init -q && git add -A && git commit -qm base && git status --porcelain').code).toBe(0)
    // stale stat info: the case where a porcelain `git diff` would rewrite the index
    sh(dir, 'sleep 1.1; touch a.py; sleep 1.1')
    const idx = sha(dir, '.git/index')
    const runs = [guard(dir), guard(dir), guard(dir)]
    for (const r of runs) {
      expect(r.code).toBe(0)
      expect(r.out).toBe('')
    }
    expect(sha(dir, '.git/index')).toBe(idx)
    expect(existsSync(join(dir, 'store'))).toBe(false)
    const ms = runs.map((r) => Math.round(r.ms))
    console.log(`[UPDATECONFLICT1105] guard on a clean tree, wall time per run (ms): ${ms.join(', ')}`)
  })
})

describe('start.sh wiring', () => {
  it('runs the guard first, before any Python script, and never lets it stop the start', () => {
    const call = 'bash "${INSTALL_DIR}/scripts/update-conflict-guard.sh" "$INSTALL_DIR" 2>&1 || true'
    expect(START).toContain(call)
    expect(START.indexOf(call)).toBeLessThan(START.indexOf('boot-hook-prune.py'))
    expect(START.indexOf(call)).toBeGreaterThan(START.indexOf('INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"'))
  })
})

describe('the dashboard side: the report and the banner text', () => {
  it('parseConflictGuard keeps a well-formed report and drops anything else', async () => {
    const { parseConflictGuard } = await import('../update-conflict-guard.js')
    const ok = { state: 'repaired', at: 1793866000000, paths: [GATE], backup: 'store/update-conflict-backup-20261105-091500-a1B2c3', stash: 'stash@{0}: On main: marveen-update-auto-stash 20261103-201500' }
    expect(parseConflictGuard(ok)).toEqual(ok)
    expect(parseConflictGuard({ ...ok, state: 'hacked' })).toBeNull()
    expect(parseConflictGuard({ ...ok, at: 'x' })).toBeNull()
    expect(parseConflictGuard({ ...ok, paths: 'x' })).toBeNull()
    expect(parseConflictGuard(null)).toBeNull()
    expect(parseConflictGuard([ok])).toBeNull()
    // a backup outside store/update-conflict-backup-<ts>, or a control character, is not passed on
    expect(parseConflictGuard({ ...ok, backup: '/etc/passwd' })).toEqual({ state: 'repaired', at: ok.at, paths: [GATE], stash: ok.stash })
    expect(parseConflictGuard({ ...ok, paths: [GATE, 'bad\nname'] })?.paths).toEqual([GATE])
  })

  it('the guard\'s own state file is what the dashboard reads', async () => {
    const { readConflictGuard } = await import('../update-conflict-guard.js')
    const dir = conflicted()
    guard(dir)
    const r = readConflictGuard(join(dir, 'store'))
    expect(r).toMatchObject({ state: 'repaired', paths: [GATE] })
    expect(r?.backup).toMatch(/^store\/update-conflict-backup-\d{8}-\d{6}-[A-Za-z0-9]{6}$/)
    expect(readConflictGuard(join(SANDBOX, 'nowhere'))).toBeNull()
  })

  it('every guard state has a one-sentence Hungarian (accented) and English banner text with the paths', () => {
    const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf-8')
    const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf-8')
    for (const st of ['repaired', 'refused_no_stash', 'refused_in_progress', 'backup_failed', 'repair_failed', 'markers_only']) {
      const huLine = hu.split('\n').find((l) => l.includes(`'update_conflict.banner.${st}'`)) ?? ''
      const enLine = en.split('\n').find((l) => l.includes(`'update_conflict.banner.${st}'`)) ?? ''
      expect(huLine, st).toContain('{paths}')
      expect(enLine, st).toContain('{paths}')
      expect(huLine, st).toMatch(/[áéíóöőúüű]/)
      // one sentence: a single full stop, at the end
      const text = huLine.split(': \'')[1] ?? ''
      expect(text.replace(/\.',$/, '').includes('. '), st).toBe(false)
    }
    for (const st of ['repaired', 'repair_failed']) {
      expect(hu.split('\n').find((l) => l.includes(`'update_conflict.banner.${st}'`)), st).toContain('{backup}')
    }
  })

  it('the banner is rendered from /api/updates with textContent, and dismissed per guard run', () => {
    const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
    const fn = app.slice(app.indexOf('function updateConflictGuardUI('), app.indexOf('function wireUpdateConflictBanner('))
    expect(fn).toContain("textEl.textContent = t('update_conflict.banner.' + g.state")
    expect(fn).not.toContain('innerHTML')
    expect(fn).toContain('UPDATE_CONFLICT_DISMISS_PREFIX + g.at')
    expect(app).toContain('    updateBranchDriftUI(data)\n    updateConflictGuardUI(data)')
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'updates.ts'), 'utf-8')
    expect(route).toContain('json(res, { ...getUpdateStatus(), conflictGuard: readConflictGuard(STORE_DIR), deployment: deployment() })')
  })
})
