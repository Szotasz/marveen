// CODEXEVID d72ba2bd: behaviour of the Codex transcript-root resolver and
// rollout-mtime walker. Everything runs against fake deps (no real tmux, no
// real /proc) or a temp directory tree; the environ fixtures carry a marker
// value so the test can prove the resolver never leaks environ CONTENTS into
// its logs (CODEX_HOME can sit next to secrets in the same dump).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockDebug = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: (...a: unknown[]) => mockDebug(...a), error: vi.fn() },
}))
vi.mock('../web/agent-process.js', () => ({ agentSessionName: (n: string) => `agent-${n}` }))

import {
  parseCodexHome,
  codexSessionDirsFor,
  codexRolloutMtime,
  resetCodexSessionDirCache,
  type CodexSessionDeps,
} from '../web/codex-transcript-root.js'

// An environ dump as /proc/<pid>/environ renders it: NUL-separated KEY=VALUE.
// The marker value must never reach a log line.
const ENVIRO_MARK = 'ENVIRO-SECRET-MARKER-7f3a'
const environDump = (home: string) => `PATH=/usr/bin\0TERM=xterm-256color\0CODEX_HOME=${home}\0TOKEN=${ENVIRO_MARK}\0`

describe('parseCodexHome (PURE)', () => {
  it('finds CODEX_HOME in a NUL-separated environ dump', () => {
    expect(parseCodexHome(environDump('/codex-homes/dex'))).toBe('/codex-homes/dex')
  })
  it('finds it in a newline-separated dump too (the other render of /proc output)', () => {
    expect(parseCodexHome(`A=1\nCODEX_HOME=/codex-homes/kio\nB=2\n`)).toBe('/codex-homes/kio')
  })
  it('misses when there is no CODEX_HOME entry', () => {
    expect(parseCodexHome('PATH=/usr/bin\0HOME=/codex-homes/dex\0')).toBeNull()
  })
  it('an empty value is no home', () => {
    expect(parseCodexHome('CODEX_HOME=\0')).toBeNull()
  })
  it('a variable whose name merely ends in CODEX_HOME is not a match', () => {
    expect(parseCodexHome('NOT_CODEX_HOME=/codex-homes/dex\0')).toBeNull()
  })
})

describe('codexSessionDirsFor (fake deps, no real tmux or /proc)', () => {
  let root: string
  let nowMs: number

  const fakeDeps = (over: Partial<CodexSessionDeps> = {}): CodexSessionDeps & {
    listPanes: ReturnType<typeof vi.fn>
    readEnviron: ReturnType<typeof vi.fn>
    stat: ReturnType<typeof vi.fn>
  } => ({
    listPanes: vi.fn(async () => 'agent-dex 4242\nagent-kio 5252\nmain 1\n'),
    readEnviron: vi.fn(async () => environDump(join(root, 'cx-home'))),
    stat: vi.fn(async () => ({ isDirectory: () => true })),
    now: () => nowMs,
    ...over,
  }) as CodexSessionDeps & { listPanes: ReturnType<typeof vi.fn>; readEnviron: ReturnType<typeof vi.fn>; stat: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    resetCodexSessionDirCache()
    root = mkdtempSync(join(tmpdir(), 'codex-root-'))
    nowMs = 1_000_000
    mockDebug.mockClear()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('happy path: pane pid -> /proc environ -> the sessions dir under CODEX_HOME', async () => {
    const d = fakeDeps()
    const dirs = await codexSessionDirsFor('dex', d)
    expect(dirs).toEqual([join(join(root, 'cx-home'), 'sessions')])
    // The pane pid came from the agent's own tmux row, not some other pane's.
    expect(d.readEnviron).toHaveBeenCalledWith(4242)
    // The resolved home path may be logged...
    expect(mockDebug.mock.calls.some((c) => JSON.stringify(c).includes(join(root, 'cx-home')))).toBe(true)
    // ...but never the environ contents (CODEX_HOME sits next to secrets there).
    expect(JSON.stringify(mockDebug.mock.calls)).not.toContain(ENVIRO_MARK)
  })

  it('no tmux row for the agent session => [] (a Claude-Code agent or a missing pane)', async () => {
    const d = fakeDeps({ listPanes: vi.fn(async () => 'main 1\nother 2\n') })
    expect(await codexSessionDirsFor('dex', d)).toEqual([])
  })

  it('tmux itself failing (absent binary, dead server, timeout) => [], never a throw', async () => {
    const d = fakeDeps({ listPanes: vi.fn(async () => { throw new Error('tmux exited 1') }) })
    await expect(codexSessionDirsFor('dex', d)).resolves.toEqual([])
  })

  it('/proc/<pid>/environ unreadable (remote host, exited pid, permissions) => []', async () => {
    const d = fakeDeps({ readEnviron: vi.fn(async () => { throw new Error('EACCES') }) })
    await expect(codexSessionDirsFor('dex', d)).resolves.toEqual([])
    expect(JSON.stringify(mockDebug.mock.calls)).not.toContain(ENVIRO_MARK)
  })

  it('no CODEX_HOME in the pane env (a Claude-Code motor) => []', async () => {
    const d = fakeDeps({ readEnviron: vi.fn(async () => 'PATH=/usr/bin\0') })
    expect(await codexSessionDirsFor('dex', d)).toEqual([])
  })

  it('CODEX_HOME without a sessions/ directory => [] (nothing to walk)', async () => {
    const d = fakeDeps({ stat: vi.fn(async () => { throw new Error('ENOENT') }) })
    expect(await codexSessionDirsFor('dex', d)).toEqual([])
  })

  it('caches a positive result per agent for ~30s: the second call does not re-run tmux', async () => {
    const d = fakeDeps()
    await codexSessionDirsFor('dex', d)
    await codexSessionDirsFor('dex', d)
    expect(d.listPanes).toHaveBeenCalledTimes(1)
    nowMs += 31_000 // past the TTL: resolved again (a restarted pane gets a new CODEX_HOME)
    await codexSessionDirsFor('dex', d)
    expect(d.listPanes).toHaveBeenCalledTimes(2)
  })

  it('empty results are NOT cached: every failed lookup asks tmux again', async () => {
    const d = fakeDeps({ listPanes: vi.fn(async () => 'main 1\n') })
    await codexSessionDirsFor('dex', d)
    await codexSessionDirsFor('dex', d)
    expect(d.listPanes).toHaveBeenCalledTimes(2)
  })

  it('the cache is keyed per agent', async () => {
    const d = fakeDeps()
    await codexSessionDirsFor('dex', d)
    await codexSessionDirsFor('kio', d)
    expect(d.listPanes).toHaveBeenCalledTimes(2)
    expect(d.readEnviron).toHaveBeenNthCalledWith(1, 4242)
    expect(d.readEnviron).toHaveBeenNthCalledWith(2, 5252)
  })
})

describe('codexRolloutMtime (real temp tree, sessions/YYYY/MM/DD layout)', () => {
  let root: string

  const writeRollout = (rel: string, mtimeMs: number) => {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '{"timestamp":"2026-11-15T11:07:52.752Z","type":"response_item"}\n')
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
  }

  beforeEach(() => {
    resetCodexSessionDirCache()
    root = mkdtempSync(join(tmpdir(), 'codex-mtime-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns the newest mtimeMs over *.jsonl files three levels under sessions/', async () => {
    writeRollout(join('sessions', '2026', '11', '14', 'a.jsonl'), 1_000)
    writeRollout(join('sessions', '2026', '11', '15', 'b.jsonl'), 5_000)
    writeRollout(join('sessions', '2026', '11', '15', 'c.jsonl'), 3_000)
    writeRollout(join('sessions', '2026', '11', '15', 'ignore.txt'), 9_000)
    expect(await codexRolloutMtime([join(root, 'sessions')])).toBe(5_000)
  })

  it('several dirs (or none readable) => the max across what could be read', async () => {
    writeRollout(join('one', '2026', '11', '15', 'a.jsonl'), 2_000)
    writeRollout(join('two', '2026', '11', '15', 'b.jsonl'), 4_000)
    expect(await codexRolloutMtime([join(root, 'one', 'sessions-missing'), join(root, 'one'), join(root, 'two')])).toBe(4_000)
  })

  it('no *.jsonl anywhere readable => null (no evidence, not 0)', async () => {
    expect(await codexRolloutMtime([join(root, 'sessions')])).toBeNull()
    expect(await codexRolloutMtime([])).toBeNull()
  })
})
