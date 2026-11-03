// #1904: Claude Code honours a project's .claude/settings.json permissions.allow
// only when the GIT ROOT is trusted, not the cwd. stampProjectTrustForDir used to
// stamp only agents/<name> (and its realpath), so on a git-checkout install a
// strict-profile (dontAsk) agent lost its whole allow-list.
//
// What this pins:
// - a git-checkout install: the install root is stamped next to the agent dir
//   (red before the fix);
// - review of #1911: a git root OUTSIDE the install is never stamped -- a tarball
//   install under a home that is a git repo, and an agent dir symlinked into
//   another repository;
// - outside any repo: nothing extra, no throw; an agent dir that is its own repo
//   gets nothing new;
// - the install-root lookup runs once per process and root (no git on the
//   second start);
// - gitToplevelFor falls back to null on any failure, and an inherited GIT_DIR
//   or GIT_WORK_TREE cannot point it at another repo;
// - the launch call site lets the default (install-root) lookup run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { gitToplevelFor, installRootTrustKey, stampProjectTrustForDir } from '../web/agent-process.js'

const AGENT_PROCESS = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

let work: string
let dotClaude: string
const gitInit = (dir: string) => execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
const projects = () => JSON.parse(readFileSync(dotClaude, 'utf-8')).projects as Record<string, Record<string, unknown>>
const trusted = (key: string) => projects()[key]?.hasTrustDialogAccepted === true && projects()[key]?.hasCompletedProjectOnboarding === true

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'trust-1904-')))
  dotClaude = join(work, 'config', '.claude.json')
  mkdirSync(join(work, 'config'), { recursive: true })
})
afterEach(() => {
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  rmSync(work, { recursive: true, force: true })
})

describe('stampProjectTrustForDir: the install root (#1904)', () => {
  it('a git-checkout install: the install root is trusted next to the agent dir', () => {
    const root = join(work, 'marveen')
    const agent = join(root, 'agents', 'webdev')
    mkdirSync(agent, { recursive: true })
    gitInit(root)
    expect(stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))).toBe(true)
    expect(trusted(agent)).toBe(true)
    expect(trusted(root)).toBe(true)
    expect(Object.keys(projects()).sort()).toEqual([agent, root].sort())
  })

  it('a tarball install under a home that is a git repo: the home is NOT stamped', () => {
    const home = join(work, 'home')
    const root = join(home, 'marveen')
    const agent = join(root, 'agents', 'webdev')
    mkdirSync(agent, { recursive: true })
    gitInit(home)
    expect(gitToplevelFor(agent)).toBe(home) // what a per-dir lookup would have stamped
    expect(installRootTrustKey(root)).toBeNull()
    stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))
    expect(Object.keys(projects())).toEqual([agent])
    expect(trusted(home)).toBe(false)
  })

  it('an agent dir symlinked into another repository: that repository is NOT stamped', () => {
    const root = join(work, 'marveen')
    const foreign = join(work, 'foreign')
    mkdirSync(join(root, 'agents'), { recursive: true })
    mkdirSync(join(foreign, 'webdev'), { recursive: true })
    gitInit(foreign)
    const agent = join(root, 'agents', 'webdev')
    symlinkSync(join(foreign, 'webdev'), agent)
    expect(gitToplevelFor(agent)).toBe(foreign) // what a per-dir lookup would have stamped
    stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))
    expect(trusted(foreign)).toBe(false)
    expect(Object.keys(projects()).sort()).toEqual([agent, join(foreign, 'webdev')].sort())
  })

  it('outside any git repo: only the agent dir, no throw', () => {
    const root = join(work, 'plain')
    const agent = join(root, 'agents', 'webdev')
    mkdirSync(agent, { recursive: true })
    expect(installRootTrustKey(root)).toBeNull()
    expect(stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))).toBe(true)
    expect(Object.keys(projects())).toEqual([agent])
  })

  it('an agent dir that is its own repository, in a tarball install: nothing new', () => {
    const root = join(work, 'marveen')
    const agent = join(root, 'agents', 'solo')
    mkdirSync(agent, { recursive: true })
    gitInit(agent)
    stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))
    expect(Object.keys(projects())).toEqual([agent])
  })

  it('already stamped, root included: a second launch writes nothing', () => {
    const root = join(work, 'marveen')
    const agent = join(root, 'agents', 'webdev')
    mkdirSync(agent, { recursive: true })
    gitInit(root)
    expect(stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))).toBe(true)
    expect(stampProjectTrustForDir(dotClaude, agent, installRootTrustKey(root))).toBe(false)
  })
})

describe('installRootTrustKey (#1904, review of #1911)', () => {
  it('looks git up once per process and root: the second start does not run git', () => {
    const root = join(work, 'marveen')
    mkdirSync(root, { recursive: true })
    let calls = 0
    const lookup = (dir: string) => { calls++; return gitToplevelFor(dir) }
    gitInit(root)
    expect(installRootTrustKey(root, lookup)).toBe(root)
    expect(installRootTrustKey(root, lookup)).toBe(root)
    expect(calls).toBe(1)
  })

  it('an install root reached through a symlink: the resolved root is the key (git answers resolved)', () => {
    const real = join(work, 'real-marveen')
    mkdirSync(real, { recursive: true })
    gitInit(real)
    const link = join(work, 'marveen')
    symlinkSync(real, link)
    expect(installRootTrustKey(link)).toBe(real)
  })

  it('an answer that is not the install root itself is null, whatever it is', () => {
    const root = join(work, 'marveen')
    mkdirSync(root, { recursive: true })
    expect(installRootTrustKey(root, () => work)).toBeNull()
    expect(installRootTrustKey(join(work, 'missing'), () => join(work, 'missing'))).toBeNull()
  })
})

describe('gitToplevelFor (#1904)', () => {
  it('a failing, empty or blank git answer is null; the answer is trimmed', () => {
    expect(gitToplevelFor('/x', () => { throw new Error('ENOENT git') })).toBeNull()
    expect(gitToplevelFor('/x', () => '')).toBeNull()
    expect(gitToplevelFor('/x', () => '  \n')).toBeNull()
    expect(gitToplevelFor('/x', () => '/home/u/marveen\n')).toBe('/home/u/marveen')
  })

  it.each(['GIT_DIR', 'GIT_WORK_TREE'])('an inherited %s does not point it at another repo', (v) => {
    const root = join(work, 'marveen')
    const agent = join(root, 'agents', 'webdev')
    const other = join(work, 'other')
    mkdirSync(agent, { recursive: true })
    mkdirSync(other, { recursive: true })
    gitInit(root)
    gitInit(other)
    process.env[v] = v === 'GIT_DIR' ? join(other, '.git') : other
    expect(gitToplevelFor(agent)).toBe(root)
  })
})

describe('the launch call site (#1904)', () => {
  it('startAgentProcess passes no override, so the install-root lookup runs on every start', () => {
    const call = "stampProjectTrustForDir(\n      claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(homedir(), '.claude.json'),\n      dir,\n    )"
    expect(AGENT_PROCESS).toContain(call)
    expect(AGENT_PROCESS).toContain('toplevel: string | null = installRootTrustKey(),')
    expect(AGENT_PROCESS).toContain('root: string = PROJECT_ROOT,')
  })
})
