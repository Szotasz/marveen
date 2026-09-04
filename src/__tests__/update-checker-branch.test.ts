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
import { remoteIsOwnOrigin, parseGitHubRemote, branchOnRemote, branchExistsOnOrigin, originHasTrackingRefs } from '../web/update-checker.js'
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

// The end-to-end shape of UPDATEBRANCH904, asserted against THIS checkout:
// whatever branch we end up asking the upstream remote about, it must be one
// that remote could actually answer for. A branch only this machine has ever
// seen is the 422 that produced the silent `behind: 0`.
describe('the branch we ask upstream about is answerable', () => {
  it('this checkout has origin tracking refs, so the probe carries evidence', () => {
    expect(originHasTrackingRefs(PROJECT_ROOT)).toBe(true)
  })

  it('never asks upstream about a branch that is not on origin', async () => {
    const remote = parseGitHubRemote(PROJECT_ROOT)
    const asked = await branchOnRemote(remote, PROJECT_ROOT, async () => 'develop')
    // Either it is a branch origin really has, or it is the injected default.
    expect(branchExistsOnOrigin(asked, PROJECT_ROOT) || asked === 'develop').toBe(true)
  })
})
