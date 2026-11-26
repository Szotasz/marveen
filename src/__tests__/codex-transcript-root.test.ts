// CODEXEVID d72ba2bd: config-based Codex transcript-root resolution uses
// fake deps only; the rollout-mtime walker uses a real temp directory tree.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/agent-config.js', () => ({ readAgentEngineConfigSafe: vi.fn() }))

import {
  codexSessionDirsFor,
  codexRolloutMtime,
  codexAgentRolloutMtime,
  type CodexSessionDeps,
} from '../web/codex-transcript-root.js'

describe('codexSessionDirsFor (fake deps only)', () => {
  const fakeDeps = () => ({
    readConfig: vi.fn(() => ({ engine: 'codex', codexConfigDir: '/x/dex' as string | null })),
    stat: vi.fn(async (): Promise<{ isDirectory(): boolean }> => ({ isDirectory: () => true })),
    homeDir: vi.fn(() => '/home/u'),
  }) satisfies CodexSessionDeps

  it('returns [] for a claude-motor agent without filesystem access', async () => {
    const deps = fakeDeps()
    deps.readConfig.mockReturnValue({ engine: 'claude', codexConfigDir: null })
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual([])
    expect(deps.stat).not.toHaveBeenCalled()
    expect(deps.homeDir).not.toHaveBeenCalled()
  })

  it('resolves the sessions directory under the configured Codex home', async () => {
    const deps = fakeDeps()
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual(['/x/dex/sessions'])
    expect(deps.readConfig).toHaveBeenCalledWith('dex')
    expect(deps.stat).toHaveBeenCalledWith('/x/dex/sessions')
    expect(deps.homeDir).not.toHaveBeenCalled()
  })

  it('returns [] when stat rejects', async () => {
    const deps = fakeDeps()
    deps.stat.mockRejectedValue(new Error('ENOENT'))
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual([])
  })

  it('returns [] when the sessions path is not a directory', async () => {
    const deps = fakeDeps()
    deps.stat.mockResolvedValue({ isDirectory: () => false })
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual([])
  })

  it.each([null, ''])('returns [] without filesystem access when codexConfigDir is %s', async (codexConfigDir) => {
    const deps = fakeDeps()
    deps.readConfig.mockReturnValue({ engine: 'codex', codexConfigDir })
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual([])
    expect(deps.stat).not.toHaveBeenCalled()
    expect(deps.homeDir).not.toHaveBeenCalled()
  })

  it('returns [] without throwing when readConfig throws', async () => {
    const deps = fakeDeps()
    deps.readConfig.mockImplementation(() => { throw new Error('unreadable config') })
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual([])
    expect(deps.stat).not.toHaveBeenCalled()
  })
})

describe('codexAgentRolloutMtime (real temp tree, first-line ownership)', () => {
  let root: string
  const workspace = '/agents/dex'
  const meta = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { cwd } })
  const writeRollout = (rel: string, firstLine: string, mtimeMs: number) => {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, firstLine + '\n' + meta('/elsewhere') + '\n')
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
    return path
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-agent-mtime-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('ignores another agent\'s newer rollout on a shared seat', async () => {
    const own = writeRollout('2026/11/26/a.jsonl', meta(workspace), 4_000)
    const other = writeRollout('2026/11/26/b.jsonl', meta('/elsewhere'), 9_000)
    const readFirstLine = vi.fn(async (path: string) => path === own ? meta(workspace) : meta('/elsewhere'))
    expect(await codexAgentRolloutMtime([root], workspace, undefined, { readFirstLine })).toBe(4_000)
    expect(readFirstLine).toHaveBeenCalledWith(own)
    expect(readFirstLine).toHaveBeenCalledWith(other)
  })

  it('accepts a session cwd nested under the workspace', async () => {
    writeRollout('2026/11/26/a.jsonl', meta(workspace + '/nested'), 5_000)
    expect(await codexAgentRolloutMtime([root], workspace)).toBe(5_000)
  })

  it('rejects a sibling cwd that shares only the workspace prefix', async () => {
    writeRollout('2026/11/26/a.jsonl', meta(workspace + '-other'), 9_000)
    expect(await codexAgentRolloutMtime([root], workspace)).toBeNull()
  })

  it.each([
    'unparseable',
    JSON.stringify({ type: 'response_item', payload: { cwd: workspace } }),
    JSON.stringify({ type: 'session_meta', payload: {} }),
    JSON.stringify({ type: 'session_meta', payload: { cwd: 123 } }),
    'null',
  ])('skips a rollout with invalid first-line ownership: %s', async (firstLine) => {
    const path = writeRollout('2026/11/26/a.jsonl', firstLine, 9_000)
    // Later metadata must not repair invalid ownership on the first line.
    writeFileSync(path, firstLine + '\n' + meta(workspace) + '\n')
    expect(await codexAgentRolloutMtime([root], workspace)).toBeNull()
  })

  it('skips a failed or empty injected first-line read', async () => {
    writeRollout('2026/11/26/a.jsonl', meta(workspace), 4_000)
    expect(await codexAgentRolloutMtime([root], workspace, undefined, {
      readFirstLine: async () => { throw new Error('unreadable') },
    })).toBeNull()
    expect(await codexAgentRolloutMtime([root], workspace, undefined, {
      readFirstLine: async () => null,
    })).toBeNull()
  })

  it('caps the default first-line read at 64 KiB', async () => {
    const longMeta = JSON.stringify({ type: 'session_meta', padding: 'x'.repeat(64 * 1024), payload: { cwd: workspace } })
    writeRollout('2026/11/26/a.jsonl', longMeta, 4_000)
    expect(await codexAgentRolloutMtime([root], workspace)).toBeNull()
  })

  it('counts a long-running session whose rollout sits in an old start-day directory', async () => {
    const sinceMs = new Date(2026, 10, 26, 0, 30).getTime()
    writeRollout('2026/11/23/long.jsonl', meta(workspace), sinceMs + 9_000)
    expect(await codexAgentRolloutMtime([root], workspace, sinceMs)).toBe(sinceMs + 9_000)
  })

  it('skips files not written after sinceMs without reading their first line', async () => {
    const sinceMs = new Date(2026, 10, 26, 0, 30).getTime()
    writeRollout('2026/11/26/old.jsonl', meta(workspace), sinceMs - 1_000)
    writeRollout('2026/11/26/equal.jsonl', meta(workspace), sinceMs)
    const readFirstLine = vi.fn(async (_path: string) => meta(workspace))
    expect(await codexAgentRolloutMtime([root], workspace, sinceMs, { readFirstLine })).toBeNull()
    expect(readFirstLine).not.toHaveBeenCalled()

    const fresh = writeRollout('2026/11/26/fresh.jsonl', meta(workspace), sinceMs + 2_000)
    expect(await codexAgentRolloutMtime([root], workspace, sinceMs, { readFirstLine })).toBe(sinceMs + 2_000)
    expect(readFirstLine).toHaveBeenCalledTimes(1)
    expect(readFirstLine).toHaveBeenCalledWith(fresh)
  })

  it('without sinceMs every own rollout is read', async () => {
    const sinceMs = new Date(2026, 10, 26, 0, 30).getTime()
    const old = writeRollout('2026/11/26/old.jsonl', meta(workspace), sinceMs - 1_000)
    const equal = writeRollout('2026/11/26/equal.jsonl', meta(workspace), sinceMs)
    const fresh = writeRollout('2026/11/26/fresh.jsonl', meta(workspace), sinceMs + 2_000)
    const readFirstLine = vi.fn(async (_path: string) => meta(workspace))
    expect(await codexAgentRolloutMtime([root], workspace, undefined, { readFirstLine })).toBe(sinceMs + 2_000)
    expect(readFirstLine).toHaveBeenCalledTimes(3)
    expect(readFirstLine).toHaveBeenCalledWith(old)
    expect(readFirstLine).toHaveBeenCalledWith(equal)
    expect(readFirstLine).toHaveBeenCalledWith(fresh)
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
