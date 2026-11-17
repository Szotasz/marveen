import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// #2835: the auto-stash ran `git stash push -u`. Every untracked file went into
// the stash as a blob, and after the pop those blobs stayed in .git/objects as
// unreachable objects. An install with a large untracked folder grew by that
// folder's size on every stash update. The stash is now tracked-only.
//
// These tests RUN the real update.sh text (the stash push, the pull and the pop)
// against REAL throwaway git repos: an upstream repo and a clone of it.

const UPDATE = readFileSync(join(__dirname, '..', '..', 'update.sh'), 'utf-8')
const SANDBOX = mkdtempSync(join(tmpdir(), 'upd-stashuntr-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

function slice(from: string, to: string): string {
  const start = UPDATE.indexOf(from)
  const end = UPDATE.indexOf(to, start)
  expect(start, `block start not found: ${from}`).toBeGreaterThan(-1)
  expect(end, `block end not found: ${to}`).toBeGreaterThan(start)
  return UPDATE.slice(start, end)
}

// The dirty check and the auto-stash push.
const pushBlock = () => slice('STASHED_AUTO=0\n', '# ANETTUPDATESTASH1102 (field report')
// pop_auto_stash, restore_stash_before_exit, add_update_warn and the settings gate.
const stashFns = () => slice('STASH_POP_FAILED=0\n', '# UPDOOMNPMCI926: `npm ci` failed after the pull.')
// The pull and its failure branch.
const pullBlock = () => slice('# Pull latest, NON-fatal', 'NEW_VERSION=$(git rev-parse --short HEAD')

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
}

function sh(dir: string, script: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf-8', env: { ...GIT_ENV, ...env } })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const git = (dir: string, args: string) => sh(dir, `git ${args}`)

// An upstream repo and a clone ("the install"). The clone gets a tracked local
// edit (so the dirty check stashes) and an untracked folder with a file.
const BIG = 'x'.repeat(64 * 1024) + '\n'
function setup(): { up: string; wc: string } {
  const root = mkdtempSync(join(SANDBOX, 'case-'))
  const up = join(root, 'up')
  mkdirSync(up)
  writeFileSync(join(up, 'conf.txt'), 'base\n')
  writeFileSync(join(up, 'other.txt'), 'base\n')
  expect(sh(up, 'git init -q -b main && git add -A && git commit -qm base').code).toBe(0)
  const wc = join(root, 'wc')
  expect(sh(root, `git clone -q "${up}" wc`).code).toBe(0)
  writeFileSync(join(wc, 'conf.txt'), 'local\n')
  mkdirSync(join(wc, 'models'))
  writeFileSync(join(wc, 'models', 'weights.bin'), BIG)
  return { up, wc }
}

function upstreamCommit(up: string, file: string, content: string) {
  writeFileSync(join(up, file), content)
  expect(sh(up, `git add -A && git commit -qm "upstream ${file}"`).code).toBe(0)
}

// Runs the push block, then `between` (inside the same shell), then the pull
// block, then pop_auto_stash. An `exit` in the pull block ends the run; the
// EXIT trap still writes the outcome next to the case, outside the work tree.
function runUpdate(wc: string, opts: { between?: string; pushText?: string } = {}) {
  const out = join(wc, '..')
  const script = [
    "RED=''; NC=''; ORANGE=''",
    'RESULT_STATUS=success; RESULT_MSG=""',
    'INSTALL_DIR=/nonexistent-install-dir',
    'CURRENT_BRANCH=main',
    'AUTO_STASH=1',
    'retry() { shift 2; "$@"; }',
    `trap 'printf "%s" "$RESULT_MSG" > "${out}/.msg"; printf "%s" "$UPDATE_WARN" > "${out}/.warn"; printf "%s" "$STASHED_AUTO" > "${out}/.stashed"' EXIT`,
    stashFns(),
    opts.pushText ?? pushBlock(),
    opts.between ?? '',
    pullBlock(),
    'pop_auto_stash; echo "pop_rc=$?"',
  ].join('\n')
  const r = sh(wc, script)
  const read = (f: string) => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf-8') : '')
  return { ...r, msg: read('.msg'), warn: read('.warn'), stashed: read('.stashed') }
}

// Is this exact content stored as an object in the clone's .git?
function blobInStore(wc: string, content: string): boolean {
  const tmp = join(wc, '..', 'probe.bin')
  writeFileSync(tmp, content)
  const hash = sh(wc, `git hash-object "${tmp}"`).out.trim()
  expect(hash).toMatch(/^[0-9a-f]{40,64}$/)
  return git(wc, `cat-file -e ${hash}`).code === 0
}

// While the stash is held: is the untracked file still on disk, and is the
// stash tracked-only (no third parent)?
const DURING = [
  'printf "during_file=%s\\n" "$( [ -f models/weights.bin ] && echo yes || echo no )"',
  'printf "during_third=%s\\n" "$(git rev-parse -q --verify "stash@{0}^3" >/dev/null 2>&1 && echo yes || echo no)"',
  'printf "during_stash=%s\\n" "$(git stash list | grep -c marveen-update-auto-stash)"',
].join('\n')

describe('update.sh auto-stash: tracked changes only (#2835)', () => {
  it('the auto-stash push carries no -u, --include-untracked or --all', () => {
    const line = pushBlock().split('\n').find((l) => l.includes('git stash push'))
    expect(line, 'git stash push line not found').toBeDefined()
    expect(line).not.toMatch(/\s(-u|-a|--include-untracked|--all)(\s|$)/)
    expect(line).toContain('marveen-update-auto-stash')
  })

  it('clean pop: the tracked edit comes back, the untracked folder never leaves the disk, .git/objects gets no blob of it', () => {
    const { up, wc } = setup()
    upstreamCommit(up, 'other.txt', 'upstream\n')
    const r = runUpdate(wc, { between: DURING })
    expect(r.out).toContain('during_stash=1')
    expect(r.out).toContain('during_file=yes')
    expect(r.out).toContain('during_third=no')
    expect(r.out).toContain('pop_rc=0')
    expect(readFileSync(join(wc, 'conf.txt'), 'utf-8')).toBe('local\n')
    expect(readFileSync(join(wc, 'other.txt'), 'utf-8')).toBe('upstream\n')
    expect(readFileSync(join(wc, 'models', 'weights.bin'), 'utf-8')).toBe(BIG)
    expect(git(wc, 'stash list').out.trim()).toBe('')
    expect(blobInStore(wc, BIG)).toBe(false)
  })

  it('conflicting pop: the untracked folder stays on disk the whole time and no blob of it is stored; the stash is kept', () => {
    const { up, wc } = setup()
    upstreamCommit(up, 'conf.txt', 'upstream\n')
    const r = runUpdate(wc, { between: DURING })
    expect(r.out).toContain('during_file=yes')
    expect(r.out).toContain('during_third=no')
    expect(r.out).toContain('pop_rc=1')
    // The existing conflict handling (ANETTUPDATESTASH1102) is unchanged.
    expect(readFileSync(join(wc, 'conf.txt'), 'utf-8')).toBe('upstream\n')
    expect(git(wc, 'stash list').out).toContain('marveen-update-auto-stash')
    expect(git(wc, 'show stash@{0}:conf.txt').out).toBe('local\n')
    expect(r.warn).toContain('conf.txt')
    expect(readFileSync(join(wc, 'models', 'weights.bin'), 'utf-8')).toBe(BIG)
    expect(blobInStore(wc, BIG)).toBe(false)
  })

  it('control: the old `-u` push stores the untracked blob (the check above can fail)', () => {
    const { up, wc } = setup()
    upstreamCommit(up, 'other.txt', 'upstream\n')
    const old = pushBlock().replace('git stash push -m', 'git stash push -u -m')
    expect(old).not.toBe(pushBlock())
    const r = runUpdate(wc, { pushText: old })
    expect(r.out).toContain('pop_rc=0')
    expect(readFileSync(join(wc, 'models', 'weights.bin'), 'utf-8')).toBe(BIG)
    expect(blobInStore(wc, BIG)).toBe(true)
  })

  it('an untracked local file where the update adds a tracked one: the pull stops loudly, names it, overwrites nothing, the tracked edit comes back', () => {
    const { up, wc } = setup()
    writeFileSync(join(wc, 'new.txt'), 'my local notes\n')
    upstreamCommit(up, 'new.txt', 'upstream new\n')
    const r = runUpdate(wc)
    expect(r.code).toBe(5)
    expect(r.out).not.toContain('pop_rc=')
    expect(r.msg).toContain('new.txt')
    expect(r.msg).not.toContain('divergencia')
    expect(r.out).toContain('Nem kovetett fajl all az uj, kovetett fajl helyen: new.txt')
    expect(readFileSync(join(wc, 'new.txt'), 'utf-8')).toBe('my local notes\n')
    // restore_stash_before_exit popped the tracked edit back before the exit.
    expect(readFileSync(join(wc, 'conf.txt'), 'utf-8')).toBe('local\n')
    expect(r.stashed).toBe('0')
    expect(git(wc, 'stash list').out.trim()).toBe('')
    expect(readFileSync(join(wc, 'models', 'weights.bin'), 'utf-8')).toBe(BIG)
    // HEAD did not move.
    expect(git(wc, 'log -1 --format=%s').out.trim()).toBe('base')
  })

  it('a pull failure with no untracked file in the way keeps the old message', () => {
    const { up, wc } = setup()
    upstreamCommit(up, 'other.txt', 'upstream\n')
    // Diverge: a local commit the upstream does not have.
    writeFileSync(join(wc, 'other.txt'), 'local commit\n')
    expect(git(wc, 'commit -qam local').code).toBe(0)
    const r = runUpdate(wc)
    expect(r.code).toBe(5)
    expect(r.msg).toContain('divergencia vagy halozati hiba')
    expect(readFileSync(join(wc, 'conf.txt'), 'utf-8')).toBe('local\n')
  })

  it('the English message names the blocking file too', () => {
    const { up, wc } = setup()
    writeFileSync(join(wc, 'new.txt'), 'my local notes\n')
    upstreamCommit(up, 'new.txt', 'upstream new\n')
    const out = join(wc, '..')
    const r = runUpdate(wc, { between: 'MARVEEN_LANG=en' })
    expect(r.code).toBe(5)
    expect(r.msg).toContain('Nothing was overwritten')
    expect(r.msg).toContain('new.txt')
    expect(existsSync(join(out, '.msg'))).toBe(true)
  })
})
