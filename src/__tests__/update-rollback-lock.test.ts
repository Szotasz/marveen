import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// c68d90eb, the failure mode measured on 2026-10-02 12:22-12:23Z:
// (A) the auto-stash was popped back, the restarted dashboard did not answer, and the
//     finalizer's rollback (`git reset --hard OLD`) destroyed the popped local changes;
// (B) two update runs overlapped (every update.log line twice): update.sh had no run lock.
//
// The finalizer is generated EXACTLY as update.sh generates it (the generation block and the
// two auto-stash functions are taken verbatim from update.sh) and run against a REAL throwaway
// git repository; only npm, curl, sleep and systemctl are stubbed on PATH. It is started the way
// update.sh starts it: a launcher holds the update lock, starts it in the background and exits.
// The fixture's stop.sh waits for that exit, then stop.sh and start.sh record whether they got
// fd 9 and whether the lock is held (from then on only the finalizer can hold it). The invariant
// is measured on disk, not asked from the tool.

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
const which = (cmd: string) => execFileSync('/bin/bash', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).trim()
const REAL_GIT = which('git')
const HAS_FLOCK = spawnSync('/bin/bash', ['-c', 'command -v flock']).status === 0
const REAL_FLOCK = HAS_FLOCK ? which('flock') : 'flock'
const REAL_SLEEP = which('sleep')

function slice(from: string, to: string, inclusiveTo = false): string {
  const a = UPDATE_SH.indexOf(from)
  expect(a, `not found in update.sh: ${from}`).toBeGreaterThan(-1)
  const b = UPDATE_SH.indexOf(to, a + from.length)
  expect(b, `not found in update.sh after the start: ${to}`).toBeGreaterThan(a)
  return UPDATE_SH.slice(a, inclusiveTo ? b + to.length : b)
}
// the two auto-stash functions (the gate and the net), as defined in update.sh
const FUNCTIONS = () => slice('autostash_undeletable_paths() {', '\nSTASHED_AUTO=0')
// the finalizer generation, from its path to its chmod
const GENERATION = () => slice('FINALIZE_SCRIPT="$INSTALL_DIR/store/update-finalize.sh"', 'chmod +x "$FINALIZE_SCRIPT"', true)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { execFileSync('chmod', ['-R', 'u+rwx', d]) } catch { /* best effort */ }
    rmSync(d, { recursive: true, force: true })
  }
})
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }
const git = (repo: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd: repo, encoding: 'utf-8' }).trim()
const exe = (file: string, body: string) => { writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755) }

// stop.sh first waits until the launcher (update.sh's stand-in) is gone (a zombie has closed its fds too)
const STOP_SH = `R="$(cd "$(dirname "$0")/.." && pwd)"
P="$(cat "$R/store/szulo.pid" 2>/dev/null)"
for _ in $(seq 1 100); do
  { [ -n "$P" ] && [ -d "/proc/$P" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$P/status" 2>/dev/null; } || break
  ${REAL_SLEEP} 0.05
done
{ [ -e "/proc/$$/fd/9" ] && echo "stop fd9=nyitva" || echo "stop fd9=zarva"; } >> "$R/store/fd9.log"`
const START_SH = `R="$(cd "$(dirname "$0")/.." && pwd)"
{ [ -e "/proc/$$/fd/9" ] && echo "start fd9=nyitva" || echo "start fd9=zarva"; } >> "$R/store/fd9.log"
{ ${REAL_FLOCK} -n "$R/store/update.lock" true && echo "start zar=szabad" || echo "start zar=foglalt"; } >> "$R/store/fd9.log"`

/** OLD and NEW commits; the tree is on NEW with the operator's popped local changes on top. */
function makeInstall(local: { file: 'local.txt' | 'tracked.txt'; text: string }, opts: { goneInNew?: boolean } = {}) {
  const repo = tmp('update-rollback-')
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@example.invalid')
  git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'scripts'))
  exe(join(repo, 'scripts', 'stop.sh'), STOP_SH)
  exe(join(repo, 'scripts', 'start.sh'), START_SH)
  writeFileSync(join(repo, '.gitignore'), 'store/\n') // as in the real install: the lock and the logs are not the tree's
  writeFileSync(join(repo, 'local.txt'), 'local: as committed\n')
  writeFileSync(join(repo, 'tracked.txt'), 'old\n')
  if (opts.goneInNew) writeFileSync(join(repo, 'gone.txt'), 'gone: as in OLD\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'OLD')
  const oldSha = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'tracked.txt'), 'new\n')
  writeFileSync(join(repo, 'newfile.txt'), 'only in NEW\n')
  if (opts.goneInNew) git(repo, 'rm', '-q', 'gone.txt')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'NEW')
  const newSha = git(repo, 'rev-parse', 'HEAD')
  mkdirSync(join(repo, 'store'))
  // what the pop put back: a tracked edit and an untracked file of the operator
  writeFileSync(join(repo, local.file), local.text)
  writeFileSync(join(repo, 'sajat.txt'), 'operator file\n')
  return { repo, oldSha, newSha }
}

/** The finalizer generated the way update.sh generates it. */
function generateFinalizer(): string {
  const gen = tmp('update-finalizer-gen-')
  mkdirSync(join(gen, 'store'))
  execFileSync('/bin/bash', ['-c', `set -e\n${FUNCTIONS()}\nINSTALL_DIR=${JSON.stringify(gen)}\n${GENERATION()}`], { encoding: 'utf-8' })
  return join(gen, 'store', 'update-finalize.sh')
}

/** npm and sleep do nothing; curl fails `failFirst` times, then answers (the health check). */
function stubs(failFirst: number): string {
  const bin = tmp('update-finalizer-bin-')
  exe(join(bin, 'npm'), 'exit 0')
  exe(join(bin, 'sleep'), 'exit 0')
  exe(join(bin, 'systemctl'), 'exit 1') // no unit lookup against the host's systemd
  const counter = join(bin, 'curl.count')
  writeFileSync(counter, '0')
  exe(join(bin, 'curl'), `n=$(cat ${JSON.stringify(counter)}); n=$((n + 1)); echo "$n" > ${JSON.stringify(counter)}; [ "$n" -gt ${failFirst} ]`)
  return bin
}

/**
 * The launcher holds the update lock, starts the finalizer in the background and exits, as update.sh does.
 * 'orokolt': the finalizer inherits fd 9 (the setsid launchers); 'nincs': it does not (a launcher that closes it).
 */
function runFinalizer(repo: string, oldSha: string, failFirst: number, mode: 'orokolt' | 'nincs' = 'orokolt') {
  const finalizer = generateFinalizer()
  const out = tmp('update-finalizer-out-')
  const result = join(out, 'update.last-result'), rcFile = join(out, 'rc')
  const args = [finalizer, repo, oldSha, oldSha.slice(0, 7), '1', result, join(repo, '.built-commit'), 'NEWSHRT', '', '0']
  const launcher = `exec 9>>"$1/store/update.lock"; ${REAL_FLOCK} -n 9 || exit 99
echo $$ > "$1/store/szulo.pid"; rc="$2"; shift 2
( ${mode === 'nincs' ? 'exec 9>&-; ' : ''}bash "$@"; echo $? > "$rc" ) &
exit 0`
  const r = spawnSync('/bin/bash', ['-c', launcher, '_', repo, rcFile, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${stubs(failFirst)}:${process.env.PATH}` },
  })
  expect(r.status, `the launcher: ${r.stderr}`).toBe(0)
  const code = existsSync(rcFile) ? Number(readFileSync(rcFile, 'utf-8').trim()) : null
  const res = existsSync(result) ? JSON.parse(readFileSync(result, 'utf-8')) : null
  const log = existsSync(join(repo, 'store', 'fd9.log')) ? readFileSync(join(repo, 'store', 'fd9.log'), 'utf-8').trim().split('\n') : []
  return { code, out: res, log }
}

/** Every restart: stop.sh and start.sh without fd 9, and the lock held while start.sh runs. */
const lockedRestarts = (n: number) => Array.from({ length: n }, () => ['stop fd9=zarva', 'start fd9=zarva', 'start zar=foglalt']).flat()

describe('update.sh finalizer: the rollback after a popped auto-stash keeps the local changes (c68d90eb (A))', () => {
  it('REPRODUCTION (A): the health check fails after the pop -> rollback to OLD, the local edit and the operator file survive', () => {
    const { repo, oldSha } = makeInstall({ file: 'local.txt', text: 'local: the operator edit\n' })
    const { code, out, log } = runFinalizer(repo, oldSha, 20) // 20 failing polls = the first health check fails
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(oldSha)
    expect(readFileSync(join(repo, 'local.txt'), 'utf-8')).toBe('local: the operator edit\n')
    expect(readFileSync(join(repo, 'sajat.txt'), 'utf-8')).toBe('operator file\n')
    expect(existsSync(join(repo, 'newfile.txt'))).toBe(false)
    expect(git(repo, 'stash', 'list')).toBe('')
    expect(code).toBe(6)
    expect(out.status).toBe('rolled-back')
    expect(out.message).toContain('A helyi valtozasok visszakerultek.')
    if (HAS_FLOCK) expect(log, 'two restarts, each under the lock, none of them handed fd 9').toEqual(lockedRestarts(2))
  })

  it('a local edit the update itself changed cannot go back onto OLD: the tree is clean OLD and the edit waits in the stash', () => {
    const { repo, oldSha } = makeInstall({ file: 'tracked.txt', text: 'new + the operator edit\n' })
    const { out } = runFinalizer(repo, oldSha, 20)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(oldSha)
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('old\n') // no conflict markers left
    const list = git(repo, 'stash', 'list')
    expect(list).toContain('marveen-update-rollback-stash')
    expect(git(repo, 'show', 'stash@{0}:tracked.txt')).toBe('new + the operator edit')
    expect(readFileSync(join(repo, 'sajat.txt'), 'utf-8')).toBe('operator file\n')
    expect(out.message).toContain('a stash-ben maradtak')
  })

  it('an untracked file at a path the old version tracks is not overwritten by the reset: it waits in the stash (stash -u)', () => {
    const { repo, oldSha } = makeInstall({ file: 'local.txt', text: 'local: the operator edit\n' }, { goneInNew: true })
    writeFileSync(join(repo, 'gone.txt'), 'gone: the operator file\n') // NEW dropped gone.txt, the operator made one
    const { out } = runFinalizer(repo, oldSha, 20)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(oldSha)
    expect(readFileSync(join(repo, 'gone.txt'), 'utf-8')).toBe('gone: as in OLD\n')
    expect(git(repo, 'stash', 'list')).toContain('marveen-update-rollback-stash')
    expect(git(repo, 'show', 'stash@{0}^3:gone.txt'), 'the operator file is kept in the entry').toBe('gone: the operator file')
    expect(git(repo, 'show', 'stash@{0}:local.txt')).toBe('local: the operator edit')
    expect(out.message).toContain('a stash-ben maradtak')
  })

  it('when the gate refuses (an untracked path that cannot be deleted), the rollback does NOT run and nothing is touched', () => {
    const { repo, oldSha, newSha } = makeInstall({ file: 'local.txt', text: 'local: the operator edit\n' })
    mkdirSync(join(repo, 'zart'))
    writeFileSync(join(repo, 'zart', 'f.txt'), 'kept\n')
    chmodSync(join(repo, 'zart'), 0o555)
    if (process.getuid?.() === 0) return // root may delete anything: the gate has nothing to refuse
    const { code, out } = runFinalizer(repo, oldSha, 20)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(newSha)
    expect(readFileSync(join(repo, 'local.txt'), 'utf-8')).toBe('local: the operator edit\n')
    expect(readFileSync(join(repo, 'zart', 'f.txt'), 'utf-8')).toBe('kept\n')
    expect(git(repo, 'stash', 'list')).toBe('')
    expect(code).toBe(1)
    expect(out.status).toBe('failed')
    expect(out.message).toContain('ELMARADT')
  })

  it('CONTROL: a healthy restart touches nothing (no stash, no reset)', () => {
    const { repo, newSha } = makeInstall({ file: 'local.txt', text: 'local: the operator edit\n' })
    const { code, out, log } = runFinalizer(repo, git(repo, 'rev-parse', 'HEAD~1'), 0)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(newSha)
    expect(readFileSync(join(repo, 'local.txt'), 'utf-8')).toBe('local: the operator edit\n')
    expect(git(repo, 'stash', 'list')).toBe('')
    expect([code, out.status]).toEqual([0, 'success'])
    if (HAS_FLOCK) expect(log).toEqual(lockedRestarts(1))
  })
})

// The run lock, taken verbatim from update.sh.
const LOCK = () => slice('# c68d90eb (B): ONE update at a time', '# --- end of the run lock (c68d90eb (B)) ---', true)
const lockScript = (install: string, after: string, before = '') =>
  `RED=; NC=; DIM=; INSTALL_DIR=${JSON.stringify(install)}\n${before}\n${LOCK()}\n${after}`

describe.skipIf(!HAS_FLOCK)('update.sh run lock: one update at a time (c68d90eb (B))', () => {
  it('TWO PARALLEL STARTS: the second exits at once with 75, touches nothing, and says so in store/update.log', async () => {
    const install = tmp('update-lock-')
    const marker1 = join(install, 'first.in'), marker2 = join(install, 'second.in')
    const log = join(install, 'store', 'update.log'), pidfile = join(install, 'store', 'update.pid')
    const lockLines = () => readFileSync(log, 'utf-8').split('\n').filter((l) => l.includes('egy masik frissites fut')).length
    // Node's stdin is a socket: `read` takes fd 0 as it is (/dev/stdin cannot be opened on a socket)
    const first = spawn('/bin/bash', ['-c', lockScript(install, `touch ${JSON.stringify(marker1)}; read -r _`)], { stdio: ['pipe', 'ignore', 'ignore'] })
    for (let i = 0; i < 100 && !existsSync(marker1); i++) await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(marker1), 'the first run holds the lock').toBe(true)
    expect(first.exitCode, 'the first run is still running (holds the lock)').toBe(null)
    // the dashboard's placeholder: its own pid (the parent of the run it spawns) and a start epoch
    writeFileSync(pidfile, `${process.pid}\n${Date.now()}\n`)
    const second = spawnSync('/bin/bash', ['-c', lockScript(install, `touch ${JSON.stringify(marker2)}`)], { encoding: 'utf-8' })
    expect(second.status).toBe(75)
    expect(existsSync(marker2)).toBe(false)
    expect(lockLines()).toBe(1)
    expect(existsSync(pidfile), "the parent's placeholder is released, or the button stays locked for an hour").toBe(false)
    // CONTROL: a pidfile that is not the parent's (here the running update's own pid) is left alone; and with stderr
    // already on store/update.log (the dashboard's spawn) the line lands there once, not twice
    const theirs = `${first.pid}\n${Date.now()}\n`
    writeFileSync(pidfile, theirs)
    const third = spawnSync('/bin/bash', ['-c', lockScript(install, 'exit 0', `exec 2>>${JSON.stringify(log)}`)], { encoding: 'utf-8' })
    expect(third.status).toBe(75)
    expect(readFileSync(pidfile, 'utf-8')).toBe(theirs)
    expect(lockLines()).toBe(2)
    first.stdin.end('\n')
    await new Promise((r) => first.on('exit', r))
    const fourth = spawnSync('/bin/bash', ['-c', lockScript(install, 'exit 0')], { encoding: 'utf-8' })
    expect(fourth.status, 'after the first run the lock is free again').toBe(0)
  })

  it('a service started with 9>&- does not keep the lock after the update ends; without it, it would (why _restart closes fd 9)', () => {
    const install = tmp('update-lock-child-')
    const kid = (close: boolean) => spawnSync('/bin/bash', ['-c', lockScript(install, `sleep 5 ${close ? '9>&-' : ''} >/dev/null 2>&1 & echo $!`)], { encoding: 'utf-8' })
    const closed = kid(true)
    expect(spawnSync('/bin/bash', ['-c', lockScript(install, 'exit 0')]).status, 'the closed child holds nothing').toBe(0)
    spawnSync('kill', [closed.stdout.trim()])
    const open = kid(false)
    expect(spawnSync('/bin/bash', ['-c', lockScript(install, 'exit 0')]).status, 'CONTROL: the open child keeps the lock').toBe(75)
    spawnSync('kill', [open.stdout.trim()])
  })

  it('a finalizer started WITHOUT fd 9 takes the lock itself once the launcher exits, and holds it through the restart', () => {
    const { repo } = makeInstall({ file: 'local.txt', text: 'local: the operator edit\n' })
    const { code, out, log } = runFinalizer(repo, git(repo, 'rev-parse', 'HEAD~1'), 0, 'nincs')
    expect([code, out.status]).toEqual([0, 'success'])
    expect(log).toEqual(lockedRestarts(1))
    expect(spawnSync(REAL_FLOCK, ['-n', join(repo, 'store', 'update.lock'), 'true']).status, 'free once the finalizer ended').toBe(0)
  })
})
