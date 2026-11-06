import { describe, it, expect } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// The task store is matched by NAME (any path segment `scheduled-tasks`), on purpose: the runner's store,
// the two linked config dirs and this install's own scheduled-tasks/ and seed-scheduled-tasks/ (copied
// into the store at start). A fleet keeps a DIFFERENT copy of task prompts in its own config repo
// (<repo>/common/scheduled-tasks/...), edited in a git worktree and deployed only through review. Two
// harmless operations on such a copy were denied (measured 2026-11-03 on main 017bc9d6 and develop
// 312627675); this change covers ONE of them, the native Edit/Write of a worktree file (a builder's change).
// The base rule stays: every scheduled-tasks path is denied to the native file tools. The ONE exception is a
// copy inside a git work tree, bound to that tree's root: the CANONICAL
// path (`..` resolved, the longest existing ancestor resolved through symlinks) lies in the nearest ancestor R that
// holds a .git (dir or file), is exactly R/common/scheduled-tasks/... with no store parent segment after R, and no
// spelling of it is the store (~/.claude, ~/.claude-config, ~/.channels-config and their link targets, the store
// parents of every agent of the install and their link targets, this install's own task dirs). A copy path that
// links onto the store, or out of its work tree, or sits anywhere else in the tree, is not a copy.
// Shell commands are unchanged (read-only git on a copy path stays denied: git can run a pager or a helper).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const H = homedir()
const SD = 'scheduled-tasks'
const WT = '/tmp/fleet-wt/fleet-config'
type Opts = { cwd?: string; projectRoot?: string }
const bash = (command: string) => gateDecision('Bash', { command })
const edit = (file_path: string, opts: Opts = {}) => gateDecision('Edit', { file_path, old_string: 'a', new_string: 'b' }, opts)
const write = (file_path: string, opts: Opts = {}) => gateDecision('Write', { file_path, content: 'x' }, opts)

// a fresh, real git work tree (git init) in a temp dir; fn gets its root, the dir is removed after
const inRepo = (prefix: string, fn: (repo: string) => void) => {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  try {
    const r = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`)
    fn(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}
// n fresh work trees at once
const inRepos = (n: number, fn: (repos: string[]) => void) => {
  const go = (acc: string[]): void => (acc.length === n ? fn(acc) : inRepo('sp-cfgrepo-', (r) => go([...acc, r])))
  go([])
}
// a linked git worktree of a fresh repo: its .git is a FILE (gitdir: ...), not a dir
const inWorktree = (fn: (wt: string) => void) => {
  inRepo('sp-main-', (repo) => {
    const wt = `${repo}-wt`
    const g = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
    try {
      if (g('commit', '-q', '--allow-empty', '-m', 'x').status !== 0 || g('worktree', 'add', '-q', wt).status !== 0) {
        throw new Error('git worktree add failed')
      }
      fn(wt)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })
}

describe('self-pace-gate: a fleet config repo copy of the task dir is not the store (native file tools)', () => {
  it('ALLOWS a native Edit/Write of <work tree root>/common/scheduled-tasks/... (a .git dir, and a worktree .git file)', () => {
    inRepo('sp-wt-', (repo) => {
      for (const p of [`${repo}/common/${SD}/reggeli-napindito/SKILL.md`, `${repo}/Common/Scheduled-Tasks/napi/SKILL.md`]) {
        expect(edit(p).deny, p).toBe(false)
        expect(write(p).deny, p).toBe(false)
      }
    })
    inWorktree((wt) => {
      const p = `${wt}/common/${SD}/reggeli-napindito/SKILL.md`
      expect(edit(p).deny, p).toBe(false)
      expect(write(p).deny, p).toBe(false)
    })
  })

  // Regression guard (the base denied every task-dir path): outside a git work tree a task dir
  // is denied whatever its name, and a work-tree path that leaves its tree (symlink, ..) is judged where it lands
  it('DENIES a task dir outside any git work tree, whatever its name (the base rule)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-nogit-'))
    try {
      for (const p of [`${dir}/main-cfg/${SD}/x/SKILL.md`, `${dir}/common/${SD}/x/SKILL.md`, `${WT}/common/${SD}/reggeli-napindito/SKILL.md`]) {
        expect(edit(p).deny, p).toBe(true)
        expect(write(p).deny, p).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DENIES a work-tree path that leaves its tree (symlink, ..) or is not <root>/common/scheduled-tasks (bound to the root)', () => {
    const out = mkdtempSync(join(tmpdir(), 'sp-out-'))
    try {
      inRepo('sp-wt-', (repo) => {
        symlinkSync(out, join(repo, 'common-out'))
        mkdirSync(join(repo, 'common'))
        symlinkSync(out, join(repo, 'common', SD))
        for (const p of [
          `${repo}/common-out/${SD}/x/SKILL.md`,
          `${repo}/common/${SD}/x/SKILL.md`,                     // common/scheduled-tasks itself links out of the tree
          `${repo}/../${basename(out)}/${SD}/x/SKILL.md`,
          `${repo}/main/${SD}/x/SKILL.md`,                       // not at <root>/common/
          `${repo}/scratchpad/wt/common/${SD}/napi/SKILL.md`,     // a common/ deeper in the tree is not the root's
        ]) {
          expect(edit(p).deny, p).toBe(true)
          expect(write(p).deny, p).toBe(true)
        }
      })
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('DENIES a native Edit of the store, its linked config dirs and this install root task dirs', () => {
    for (const p of [
      `${H}/.claude/${SD}/x/SKILL.md`,
      `${H}/.claude-config/${SD}/x/SKILL.md`,
      `${H}/marveen/agents/worker/.claude-config/${SD}/x/SKILL.md`,
      `${H}/.channels-config/${SD}/x/SKILL.md`,
      `${ROOT}/${SD}/x/SKILL.md`,
      `${ROOT}/seed-${SD}/x/SKILL.md`,
    ]) {
      expect(edit(p).deny, p).toBe(true)
    }
  })

  it('DENIES a copy-looking path that resolves onto the store (.. or a symlinked ancestor)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-copy-'))
    try {
      symlinkSync(join(H, '.claude'), join(dir, 'link'))
      for (const p of [
        `${dir}/link/${SD}/x/SKILL.md`,
        `${WT}/common/../../../..${H}/.claude/${SD}/x/SKILL.md`,
      ]) {
        expect(edit(p).deny, p).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The folded and the lexical case are denied by exactly ONE spelling: their kernel view is <root>/common/scheduled-tasks
  // (the exempt shape), so dropping that spelling from the store check lets them through. The kernel-view case stays
  // (an invariant): its kernel view is the store, which the exemption shape never admits. The store parent is a temp
  // dir named .claude inside the work tree: the real ~/.claude is never touched.
  it('DENIES the store seen through only one spelling: the kernel view, the folded view, the lexical name', () => {
    inRepo('sp-forms-', (dir) => {
      const store = join(dir, 'home', '.claude')
      mkdirSync(join(store, 'sub'), { recursive: true })
      mkdirSync(join(dir, 'common'))
      mkdirSync(join(dir, 'far', 'other'), { recursive: true })
      mkdirSync(join(dir, 'w'))
      // kernel view only: link -> <store>/sub, and the kernel's `..` after the link is <store>
      symlinkSync(join(store, 'sub'), join(dir, 'link'))
      // folded view only: `sub/..` folds lexically to <dir>, where onto links to the store; the kernel's `..` after
      // sub (a link to far/other) is far/, where far/onto links to <dir>/common (the exempt shape)
      symlinkSync(join(dir, 'far', 'other'), join(dir, 'sub'))
      symlinkSync(store, join(dir, 'onto'))
      symlinkSync(join(dir, 'common'), join(dir, 'far', 'onto'))
      // lexical name only: w/.claude links to <dir>/common, so the real path is the exempt shape
      symlinkSync(join(dir, 'common'), join(dir, 'w', '.claude'))
      for (const p of [
        `${dir}/link/../${SD}/x/SKILL.md`,
        `${dir}/sub/../onto/${SD}/x/SKILL.md`,
        `${dir}/w/.claude/${SD}/x/SKILL.md`,
      ]) {
        expect(edit(p).deny, p).toBe(true)
        expect(write(p).deny, p).toBe(true)
      }
    })
  })

  // the one allowing branch holds only when EVERY spelling is a repo copy. Here the kernel
  // view IS a copy and no spelling names the store, so only that rule can deny:
  // folded: <a>/common/d links to <b>/common/zz, so the kernel's `..` after d is <b>/common (a copy in work tree b), while
  //   `d/..` folds lexically to <a>/common, whose scheduled-tasks links out of every work tree;
  // lexical: <out>/c links to <b>/common, so the real path is a copy, but no .git sits above the path as written.
  // The kernel view itself, written directly, is a copy (the control).
  it('DENIES a path whose kernel view is a repo copy but whose folded or lexical spelling is not', () => {
    const out = mkdtempSync(join(tmpdir(), 'sp-out-'))
    try {
      inRepos(2, ([a, b]) => {
        mkdirSync(join(out, 'plain'))
        mkdirSync(join(a, 'common'))
        symlinkSync(join(out, 'plain'), join(a, 'common', SD))
        mkdirSync(join(b, 'common', 'zz'), { recursive: true })
        mkdirSync(join(b, 'common', SD))
        symlinkSync(join(b, 'common', 'zz'), join(a, 'common', 'd'))
        symlinkSync(join(b, 'common'), join(out, 'c'))
        const control = `${b}/common/${SD}/x/SKILL.md`
        expect(edit(control).deny, `control: ${control}`).toBe(false)
        for (const [form, p] of [
          ['folded', `${a}/common/d/../${SD}/x/SKILL.md`],
          ['lexical', `${out}/c/${SD}/x/SKILL.md`],
        ]) {
          expect(edit(p).deny, `${form}: ${p}`).toBe(true)
          expect(write(p).deny, `${form}: ${p}`).toBe(true)
        }
      })
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  // a store parent symlinked to a target of ANOTHER name is the store under its target path too, and
  // a ~/ path is expanded from the home of the call. HOME points at a temp home that is a git work tree (the HOME itself
  // may be a work tree root); the real ~/.claude is never touched.
  const withHome = (linkClaude: boolean, fn: (home: string) => void) => {
    inRepo('sp-home-', (home) => {
      const regi = process.env.HOME
      try {
        mkdirSync(join(home, 'common'))
        if (linkClaude) symlinkSync(join(home, 'common'), join(home, '.claude'))
        process.env.HOME = home
        fn(home)
      } finally {
        if (regi === undefined) delete process.env.HOME
        else process.env.HOME = regi
      }
    })
  }

  it('DENIES the store written through the target path of a symlinked ~/.claude', () => {
    withHome(true, (home) => {
      const p = `${home}/common/${SD}/x/SKILL.md`       // the exempt shape, but it IS the store (~/.claude -> common)
      expect(edit(p).deny, p).toBe(true)
      expect(write(p).deny, p).toBe(true)
    })
  })

  it('expands a ~/ path from the home of the call before it is judged', () => {
    withHome(false, () => {
      const p = `~/common/${SD}/x/SKILL.md`             // ~/ -> HOME (a work tree root): the exempt shape
      expect(edit(p).deny, p).toBe(false)
      expect(write(p).deny, p).toBe(false)
      expect(edit(`~/.claude/${SD}/x/SKILL.md`).deny).toBe(true)
    })
  })

  // every store parent of every agent of the install (<install>/agents/<name>/.claude,
  // .claude-config, .channels-config) linked to a target of another name makes that target the store -- here the
  // target is <work tree root>/common, the exempt shape, so only the agent rule can deny. The install root is injected
  // (opts.projectRoot, the option the token check already takes), so nothing is written under the real <ROOT>/agents/.
  // An agents/ entry that cannot be listed for any reason but "missing" denies (fail-closed); a missing agents/ is no agent.
  it('DENIES the target path of any store parent of an agent, and denies when agents/ cannot be listed', () => {
    const roots = [mkdtempSync(join(tmpdir(), 'sp-root-')), mkdtempSync(join(tmpdir(), 'sp-root-')), mkdtempSync(join(tmpdir(), 'sp-root-'))]
    try {
      inRepos(4, (repos) => {
        const [root, bad, none] = roots
        const parents = ['.claude', '.claude-config', '.channels-config']
        parents.forEach((parent, k) => {
          mkdirSync(join(repos[k], 'common'))
          mkdirSync(join(root, 'agents', `a${k}`), { recursive: true })
          symlinkSync(join(repos[k], 'common'), join(root, 'agents', `a${k}`, parent))
        })
        parents.forEach((parent, k) => {
          const p = `${repos[k]}/common/${SD}/x/SKILL.md`
          expect(edit(p, { projectRoot: root }).deny, `${parent}: ${p}`).toBe(true)
          expect(write(p, { projectRoot: root }).deny, `${parent}: ${p}`).toBe(true)
        })
        writeFileSync(join(bad, 'agents'), 'not a dir')        // readdir fails with ENOTDIR (also as root)
        const p = `${repos[3]}/common/${SD}/x/SKILL.md`
        expect(edit(p, { projectRoot: bad }).deny, `agents/ not listable: ${p}`).toBe(true)
        expect(edit(p, { projectRoot: none }).deny, `no agents/: ${p}`).toBe(false)
      })
    } finally {
      for (const r of roots) rmSync(r, { recursive: true, force: true })
    }
  })

  // a store parent segment followed by a task dir counts wherever it sits, not only before the FIRST task-dir segment
  it('DENIES a store-shaped .claude-config/scheduled-tasks pair that follows an earlier task-dir segment', () => {
    inRepo('sp-wt-', (repo) => {
      for (const p of [
        `${repo}/common/${SD}/sub/.claude-config/${SD}/x/SKILL.md`,
        `${repo}/seed-${SD}/a/.claude/${SD}/x/SKILL.md`,
      ]) {
        expect(edit(p).deny, p).toBe(true)
      }
    })
  })

  // the install root's task dirs are matched without regard to letter case (the name rule is case-insensitive)
  it("DENIES the install root's task dirs in another letter case", () => {
    for (const p of [`${ROOT}/Scheduled-Tasks/x/SKILL.md`, `${ROOT}/SEED-scheduled-tasks/x/SKILL.md`]) {
      expect(edit(p).deny, p).toBe(true)
    }
  })

  // a relative path is taken from the hook's cwd (both directions); inside the exempt shape a look-alike name
  // is a copy, a store parent segment is not (no store parent segment after the root)
  it('judges a relative path from the cwd, keeps look-alike names a copy and a store parent segment denied', () => {
    inRepo('sp-wt-', (repo) => {
      const rel = (cwd: string) => gateDecision('Edit', { file_path: `${SD}/x/SKILL.md`, old_string: 'a', new_string: 'b' }, { cwd })
      expect(rel(`${H}/.claude`).deny).toBe(true)
      expect(rel(`${repo}/common`).deny).toBe(false)
      for (const p of [`${repo}/common/${SD}/my.claude/x/SKILL.md`, `${repo}/common/${SD}/.claude-old/x/SKILL.md`]) {
        expect(edit(p).deny, p).toBe(false)
      }
      expect(edit(`${repo}/common/${SD}/.claude/x/SKILL.md`).deny).toBe(true)
    })
  })

  it('keeps a read-only git command on a copy path denied (git can run a pager or a helper)', () => {
    expect(bash(`git -C ${WT} diff --stat origin/develop -- common/${SD}/reggeli-napindito/SKILL.md`).deny).toBe(true)
  })

  it('keeps every write form on the store denied (shell)', () => {
    for (const cmd of [
      `echo x > ${H}/.claude/${SD}/x/SKILL.md`,
      `python3 -c "open('${H}/.claude/${SD}/x/SKILL.md','w').write('x')"`,
      `cp /tmp/a ${H}/.claude/${SD}/x/SKILL.md`,
      `sed -i s/a/b/ ${H}/.claude/${SD}/x/SKILL.md`,
    ]) {
      expect(bash(cmd).deny, cmd).toBe(true)
    }
  })
})
