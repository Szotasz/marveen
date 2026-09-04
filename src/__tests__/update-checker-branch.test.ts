// Regression test for the update checker's branch selection.
//
// The checker used to hardcode `main` while update.sh pulls
// `origin/<current branch>`. On any checkout that follows another branch
// (e.g. `develop`) the two disagreed: the dashboard advertised a "new version"
// the update button could never deliver, and stayed silent about the commits
// that actually were on the way. trackedBranch() is what keeps the two in sync,
// so it is pinned here.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trackedBranch, currentVersion, getUpdateStatus } from '../web/update-checker.js'
import { PROJECT_ROOT } from '../config.js'

function gitBranch(): string {
  return execFileSync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8',
  }).trim()
}

describe('update checker branch selection', () => {
  it('follows the branch the checkout is actually on', () => {
    const actual = gitBranch()
    // Detached HEAD reports the literal "HEAD"; the helper substitutes main
    // there, matching what update.sh tells the operator to check out.
    const expected = actual && actual !== 'HEAD' ? actual : 'main'
    expect(trackedBranch()).toBe(expected)
  })

  it('never returns an empty ref', () => {
    // An empty branch would produce `origin/` / `commits/` requests that fail
    // in confusing ways; the fallback must always yield a usable ref.
    expect(trackedBranch()).toBeTruthy()
  })

  it('does not silently assume main on a non-main checkout', () => {
    const actual = gitBranch()
    if (!actual || actual === 'HEAD' || actual === 'main') return // nothing to prove here
    expect(trackedBranch()).not.toBe('main')
  })
})

// The Updates panel shows the running instance's semver; it must come from
// package.json and never be fabricated. currentVersion() is the single source.
describe('update checker current version', () => {
  it('returns the semver from package.json at PROJECT_ROOT', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'))
    expect(currentVersion()).toBe(pkg.version)
    // sanity: it is a real semver, not an empty/garbage value
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is exposed on the /api/updates status object', () => {
    expect(getUpdateStatus().version).toBe(currentVersion())
  })

  it('returns empty (never fabricates) when package.json is missing/unreadable', () => {
    expect(currentVersion('/nonexistent-root-xyz')).toBe('')
    expect(currentVersion('/etc')).toBe('') // dir exists, no package.json -> ''
  })
})

// Regression test for the fork case.
//
// "Update" means new commits from the ORIGINAL author, so a checkout that has
// an `upstream` remote must ask THAT repo, not `origin` -- after a fork origin
// is the user's own copy and never carries the author's new work. Two things
// then have to follow the chosen remote, and both used to follow `origin`:
//   - the BRANCH (a local feature branch does not exist in someone else's repo:
//     GitHub answers 422 on /commits/<branch>), and
//   - the compare BASE (a base the remote does not know turns the reported
//     backlog into a fork-distance -- measured 375 against a real 5).
import { remoteIsOwnOrigin, parseGitHubRemote, branchOnRemote, branchExistsOnOrigin, originHasTrackingRefs, upstreamMergeBase } from '../web/update-checker.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// A throwaway git repo with the given remotes. Everything below measures against
// one of these instead of the live checkout: on CI the checkout has no
// `upstream` remote, so a test that reads PROJECT_ROOT exits before it asserts
// anything, and stays green even with the fix deleted.
function repoWithRemotes(remotes: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'update-checker-'))
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', args, { cwd: dir, timeout: 5000, encoding: 'utf-8' })
  git('init', '-q', '-b', 'a-local-feature-branch')
  // One commit, otherwise `rev-parse --abbrev-ref HEAD` reports the literal
  // "HEAD" on an unborn branch and the helper's detached-HEAD fallback hides
  // what we are trying to measure.
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-q', '--allow-empty', '-m', 'base')
  for (const [name, url] of Object.entries(remotes)) git('remote', 'add', name, url)
  return dir
}

describe('update checker remote selection (fork case)', () => {
  const dirs: string[] = []
  const mk = (remotes: Record<string, string>) => {
    const d = repoWithRemotes(remotes)
    dirs.push(d)
    return d
  }
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  it('keeps a plain, un-forked checkout on origin', () => {
    // The non-regression half: no `upstream` remote, so nothing changes.
    const root = mk({ origin: 'https://github.com/Someone/theirrepo.git' })
    expect(parseGitHubRemote(root)).toBe('Someone/theirrepo')
    expect(remoteIsOwnOrigin('Someone/theirrepo', root)).toBe(true)
  })

  it('prefers upstream over origin once a fork configures it', () => {
    // The actual fix. Deleting the `upstream` entry from the preference list
    // turns this red -- which the previous version of this test did not.
    const root = mk({
      origin: 'git@github.com:TheFork/marveen.git',
      upstream: 'https://github.com/TheAuthor/marveen.git',
    })
    expect(parseGitHubRemote(root)).toBe('TheAuthor/marveen')
    // ...and the author's repo is NOT our own origin, which is what sends the
    // branch and the compare base down the foreign path.
    expect(remoteIsOwnOrigin('TheAuthor/marveen', root)).toBe(false)
    expect(remoteIsOwnOrigin('TheFork/marveen', root)).toBe(true)
  })

  it('asks a foreign repo about ITS default branch, never our local one', async () => {
    const root = mk({
      origin: 'git@github.com:TheFork/marveen.git',
      upstream: 'https://github.com/TheAuthor/marveen.git',
    })
    // The remote's answer is injected: the assertion is about which branch we
    // ask for, not about GitHub being reachable.
    const branch = await branchOnRemote('TheAuthor/marveen', root, async () => 'their-default')
    expect(branch).toBe('their-default')
    expect(branch).not.toBe('a-local-feature-branch')
  })

  it('asks our OWN fork about the branch this checkout follows', async () => {
    const root = mk({ origin: 'git@github.com:TheFork/marveen.git' })
    const branch = await branchOnRemote('TheFork/marveen', root, async () => 'never-used')
    expect(branch).toBe('a-local-feature-branch')
  })
})

// UPDATEBRANCH904: "origin is our own repo" is a naming CONVENTION, and this
// fork inverts it -- `origin` points at the original author (Szotasz/marveen)
// and the fork pushes to a second remote. branchOnRemote then asked the
// AUTHOR's repo for OUR local feature branch, GitHub answered 422, the throw
// was swallowed into `behind: 0`, and the dashboard reported "up to date" for
// nine days while 66 upstream commits piled up. A silent zero is the worst
// possible answer here: it looks exactly like being current.
describe('branchOnRemote does not trust a branch the remote has never seen', () => {
  const OURS = 'Owner/Repo'
  const ownOrigin = (r: string) => r === OURS

  it('uses the local branch when the remote actually has it', async () => {
    const branch = await branchOnRemote(
      OURS, PROJECT_ROOT,
      async () => 'develop',
      () => true,
      ownOrigin,
      () => true,
    )
    expect(branch).toBe(trackedBranch())
  })

  it('falls back to the default branch when the remote has no such branch', async () => {
    const branch = await branchOnRemote(
      OURS, PROJECT_ROOT,
      async () => 'develop',
      () => false,
      ownOrigin,
      () => true,
    )
    expect(branch).toBe('develop')
    expect(branch).not.toBe(trackedBranch())
  })

  it('asks a foreign remote for its own default branch, never ours', async () => {
    const branch = await branchOnRemote(
      'SomeoneElse/repo', PROJECT_ROOT,
      async () => 'main',
      () => true, // even if a same-named local ref existed, it is not theirs
      ownOrigin,
      () => true,
    )
    expect(branch).toBe('main')
  })

  // Control: the existence probe answers about THIS checkout, so a branch that
  // cannot exist must come back false. Without this, a probe stubbed to always
  // return true would make the first test pass for the wrong reason.
  it('the real existence probe rejects a branch that cannot exist', () => {
    expect(branchExistsOnOrigin('no-such-branch-9f3a1c', PROJECT_ROOT)).toBe(false)
  })
})

// The end-to-end shape of UPDATEBRANCH904, asserted against a checkout whose
// remote-tracking refs we build ourselves.
//
// The first version of this asserted against PROJECT_ROOT and passed on the
// workstation, then failed on CI: `actions/checkout` fetches the PR ref alone,
// so `refs/remotes/origin/develop` is not there and every claim about "this
// checkout has origin refs" is a claim about the checkout, not about the code.
// The fixture below carries real refs -- a real bare origin, a real clone, real
// `refs/remotes/origin/*` -- so the assertions measure git behaviour and stay
// true wherever they run.
function clonedRepoWithTrackingRefs(): { root: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'update-checker-clone-'))
  const origin = join(dir, 'origin.git')
  const root = join(dir, 'work')
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', args, { cwd, timeout: 5000, encoding: 'utf-8' })

  // A real remote with a real `develop`, published the way a remote is.
  const seed = join(dir, 'seed')
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'develop', seed], { timeout: 5000 })
  git(seed, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-q', '--allow-empty', '-m', 'upstream base')
  execFileSync('/usr/bin/git', ['init', '-q', '--bare', origin], { timeout: 5000 })
  // The bare repo's HEAD defaults to the git build's init.defaultBranch, which
  // is not necessarily `develop`; a clone then checks nothing out and the
  // branch made below has no ancestry with origin/develop -- an empty
  // merge-base produced by the FIXTURE would look exactly like the bug.
  execFileSync('/usr/bin/git', ['symbolic-ref', 'HEAD', 'refs/heads/develop'], { cwd: origin, timeout: 5000 })
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'develop')

  // ...and a clone of it, which is what a real install looks like: HEAD on its
  // own branch, `refs/remotes/origin/develop` present because it was fetched.
  execFileSync('/usr/bin/git', ['clone', '-q', origin, root], { timeout: 15000 })
  git(root, 'remote', 'set-url', 'origin', 'https://github.com/TheAuthor/marveen.git')
  git(root, 'checkout', '-q', '-b', 'a-local-feature-branch')
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-q', '--allow-empty', '-m', 'local work never pushed')

  return { root, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('the branch we ask upstream about is answerable', () => {
  const fixture = clonedRepoWithTrackingRefs()
  afterAll(() => fixture.cleanup())

  it('a fetched clone carries origin tracking refs, so the probe carries evidence', () => {
    expect(originHasTrackingRefs(fixture.root)).toBe(true)
    expect(branchExistsOnOrigin('develop', fixture.root)).toBe(true)
  })

  // Control: the probe answers about THIS checkout, so a branch that was never
  // fetched must come back false. Without it, a probe that always said true
  // would make the claim above pass for the wrong reason.
  it('a branch the clone never fetched is reported absent', () => {
    expect(branchExistsOnOrigin('a-local-feature-branch', fixture.root)).toBe(false)
    expect(branchExistsOnOrigin('no-such-branch-9f3a1c', fixture.root)).toBe(false)
  })

  it('never asks upstream about a branch that is not on origin', async () => {
    const remote = parseGitHubRemote(fixture.root)
    const asked = await branchOnRemote(remote, fixture.root, async () => 'develop')
    // Either it is a branch origin really has, or it is the injected default.
    expect(branchExistsOnOrigin(asked, fixture.root) || asked === 'develop').toBe(true)
    // The local-only branch is exactly the 422 this fix removed.
    expect(asked).not.toBe('a-local-feature-branch')
  })
})

// The twin half of UPDATEBRANCH904. branchOnRemote decides WHICH branch we ask
// about; upstreamMergeBase decides which commit we measure the distance FROM.
// Both used the same `origin` naming convention, so both resolved to a ref
// that has never existed here -- and an empty base does not fail loudly, it
// produces a nonsense distance (161 reported against a real backlog of 4,
// measured 2026-09-04). A number nobody can act on is worse than an error.
describe('upstreamMergeBase resolves a base the remote actually knows', () => {
  const fixture = clonedRepoWithTrackingRefs()
  afterAll(() => fixture.cleanup())

  it('returns a real commit for the branch we ask the remote about', () => {
    const base = upstreamMergeBase(parseGitHubRemote(fixture.root), 'develop', fixture.root)
    expect(base).toMatch(/^[0-9a-f]{40}$/)
  })

  it('the base is an ancestor of the ref it claims to compare against', () => {
    const base = upstreamMergeBase(parseGitHubRemote(fixture.root), 'develop', fixture.root)
    // If the base were picked from a ref the remote does not carry, this fails:
    // merge-base --is-ancestor exits non-zero.
    const ok = (() => {
      try {
        execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', base, 'origin/develop'],
          { cwd: fixture.root, timeout: 3000 })
        return true
      } catch { return false }
    })()
    expect(ok).toBe(true)
  })

  it('never returns an empty base while origin/develop exists', () => {
    // The empty string is the failure that produced the nonsense count; it must
    // not come back silently on a checkout that plainly has the ref.
    expect(branchExistsOnOrigin('develop', fixture.root)).toBe(true)
    expect(upstreamMergeBase(parseGitHubRemote(fixture.root), 'develop', fixture.root)).not.toBe('')
  })

  // The failure itself: no ref for the queried branch anywhere, so there is
  // nothing to measure from and the honest answer is the empty string -- the
  // caller turns that into "unknown", never into a distance.
  it('returns empty rather than inventing a base when no ref matches', () => {
    const bare = repoWithRemotes({ origin: 'https://github.com/TheAuthor/marveen.git' })
    try {
      expect(upstreamMergeBase('TheAuthor/marveen', 'develop', bare)).toBe('')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
