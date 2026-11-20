import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertNoProjectCodexConfig, preflightCodexHome, scaffoldCodexHome } from '../web/agent-engine.js'

const opts = { profile: 'relay', agentName: 'x' } as const
let tmp: string
let outer: string
let root: string
let ws: string
let home: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-projcfg-'))
  outer = join(tmp, 'outer')
  root = join(outer, 'root')
  ws = join(root, 'agents', 'x')
  home = join(tmp, 'home')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(home)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function hasGitAncestor(start: string): boolean {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (lstatSync(join(dir, '.git'), { throwIfNoEntry: false })) return true
    if (dirname(dir) === dir) return false
  }
}
// The no-git case needs a base with no .git above it; a host may have a stray /tmp/.git.
const plainBase = [tmpdir(), '/dev/shm'].find(d => existsSync(d) && !hasGitAncestor(d))

function createSymlinkedWorkspace(): string {
  const launch = join(tmp, 'launch')
  const repo = join(tmp, 'real', 'repo')
  const target = join(repo, 'agents', 'x')
  mkdirSync(join(launch, '.git'), { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(target, { recursive: true })
  const workspace = join(launch, 'agent')
  symlinkSync(target, workspace)
  return workspace
}

describe('assertNoProjectCodexConfig', () => {
  it('accepts a clean project', () => {
    expect(() => assertNoProjectCodexConfig(ws, opts)).not.toThrow()
  })

  it('refuses .codex at the physical git root of a symlinked workspace', () => {
    const workspace = createSymlinkedWorkspace()
    const candidate = join(realpathSync(tmp), 'real', 'repo', '.codex')
    mkdirSync(candidate)
    expect(() => assertNoProjectCodexConfig(workspace, opts)).toThrow(candidate)
  })

  it('refuses an intermediate physical .codex of a symlinked workspace', () => {
    const workspace = createSymlinkedWorkspace()
    const candidate = join(realpathSync(tmp), 'real', 'repo', 'agents', '.codex')
    mkdirSync(candidate)
    expect(() => assertNoProjectCodexConfig(workspace, opts)).toThrow(candidate)
  })

  it('accepts a clean symlinked workspace', () => {
    const workspace = createSymlinkedWorkspace()
    expect(() => assertNoProjectCodexConfig(workspace, opts)).not.toThrow()
  })

  it('refuses .codex in a lexical-only ancestor of a symlinked workspace', () => {
    const workspace = createSymlinkedWorkspace()
    const lexicalOnly = join(tmp, 'launch', '.codex')
    mkdirSync(lexicalOnly)
    expect(() => assertNoProjectCodexConfig(workspace, opts)).toThrow(lexicalOnly)
  })

  it('fails closed when the workspace cannot be resolved', () => {
    const loop = join(tmp, 'loop')
    mkdirSync(join(loop, '.git'), { recursive: true })
    symlinkSync(join(loop, 'b'), join(loop, 'a'))
    symlinkSync(join(loop, 'a'), join(loop, 'b'))
    expect(() => assertNoProjectCodexConfig(join(loop, 'a'), opts)).toThrow(/fail closed/)
  })

  it('accepts a workspace that does not exist yet', () => {
    expect(() => assertNoProjectCodexConfig(join(ws, 'not-yet'), opts)).not.toThrow()
  })

  it('refuses a workspace .codex/config.toml', () => {
    const candidate = join(ws, '.codex')
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'config.toml'), '[mcp_servers]\n')
    expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(candidate)
  })

  it('refuses an intermediate .codex directory', () => {
    const candidate = join(root, 'agents', '.codex')
    mkdirSync(candidate)
    expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(candidate)
  })

  it('refuses .codex at the git root', () => {
    const candidate = join(root, '.codex')
    mkdirSync(candidate)
    expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(candidate)
  })

  it('ignores .codex above the git root', () => {
    mkdirSync(join(outer, '.codex'))
    expect(() => assertNoProjectCodexConfig(ws, opts)).not.toThrow()
  })

  it('refuses a dangling .codex symlink', () => {
    const candidate = join(ws, '.codex')
    symlinkSync(join(tmp, 'missing-target'), candidate)
    expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(candidate)
  })

  it('refuses a regular .codex file', () => {
    const candidate = join(ws, '.codex')
    writeFileSync(candidate, '')
    expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(candidate)
  })

  it('recognizes a worktree .git file as the project root', () => {
    rmSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git'), 'gitdir: /nowhere')
    mkdirSync(join(outer, '.codex'))
    expect(() => assertNoProjectCodexConfig(ws, opts)).not.toThrow()
    const candidate = join(root, '.codex')
    mkdirSync(candidate)
    expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(candidate)
  })

  it.skipIf(!plainBase)('checks only the workspace without a git ancestor', () => {
    const plain = mkdtempSync(join(plainBase!, 'codex-projcfg-plain-'))
    try {
      const plainWs = join(plain, 'a', 'ws')
      mkdirSync(plainWs, { recursive: true })
      mkdirSync(join(plain, 'a', '.codex'))
      expect(() => assertNoProjectCodexConfig(plainWs, opts)).not.toThrow()
      const candidate = join(plainWs, '.codex')
      mkdirSync(candidate)
      expect(() => assertNoProjectCodexConfig(plainWs, opts)).toThrow(candidate)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('leaves omitted and full-access profiles unchanged', () => {
    mkdirSync(join(ws, '.codex'))
    expect(() => assertNoProjectCodexConfig(ws)).not.toThrow()
    expect(() => assertNoProjectCodexConfig(ws, { profile: 'full-access' })).not.toThrow()
  })

  it.skipIf(process.geteuid?.() === 0)('fails closed when a directory cannot be checked', () => {
    const agents = join(root, 'agents')
    chmodSync(agents, 0o000)
    try {
      expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow('fail closed')
    } finally {
      chmodSync(agents, 0o755)
    }
  })

  it.skipIf(process.geteuid?.() === 0)('fails closed when the workspace itself cannot be listed', () => {
    chmodSync(ws, 0o000)
    try {
      expect(() => assertNoProjectCodexConfig(ws, opts)).toThrow(/cannot check/)
    } finally {
      chmodSync(ws, 0o755)
    }
  })
})

describe('project config preflight and scaffold wiring', () => {
  it('preflight and scaffold refuse a physical .codex for a symlinked workspace', () => {
    const workspace = createSymlinkedWorkspace()
    const candidate = join(realpathSync(tmp), 'real', 'repo', '.codex')
    mkdirSync(candidate)
    expect(() => preflightCodexHome(home, workspace, {}, 'overrides', opts)).toThrow(candidate)
    expect(() => scaffoldCodexHome(home, workspace, {}, 'overrides', opts)).toThrow(candidate)
    expect(existsSync(join(workspace, '.codex-overrides'))).toBe(false)
  })

  it.each(['seat', 'overrides'] as const)('preflight refuses .codex for %s identity', identity => {
    const candidate = join(ws, '.codex')
    mkdirSync(candidate)
    expect(() => preflightCodexHome(home, ws, {}, identity, opts)).toThrow(candidate)
  })

  it('scaffold refuses .codex before writing overrides', () => {
    const candidate = join(ws, '.codex')
    mkdirSync(candidate)
    expect(() => scaffoldCodexHome(home, ws, {}, 'overrides', opts)).toThrow(candidate)
    expect(existsSync(join(ws, '.codex-overrides'))).toBe(false)
  })

  it('scaffold refuses .codex before writing seat config', () => {
    const candidate = join(ws, '.codex')
    mkdirSync(candidate)
    expect(() => scaffoldCodexHome(home, ws, {}, 'seat', opts)).toThrow(candidate)
    expect(existsSync(join(home, 'config.toml'))).toBe(false)
  })

  it('preflights a clean relay seat', () => {
    expect(() => preflightCodexHome(home, ws, {}, 'seat', opts)).not.toThrow()
  })
})
