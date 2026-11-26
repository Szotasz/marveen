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

  it('defaults to ~/.codex when codexConfigDir is null', async () => {
    const deps = fakeDeps()
    deps.readConfig.mockReturnValue({ engine: 'codex', codexConfigDir: null })
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual(['/home/u/.codex/sessions'])
    expect(deps.stat).toHaveBeenCalledWith('/home/u/.codex/sessions')
  })

  it('returns [] without throwing when readConfig throws', async () => {
    const deps = fakeDeps()
    deps.readConfig.mockImplementation(() => { throw new Error('unreadable config') })
    await expect(codexSessionDirsFor('dex', deps)).resolves.toEqual([])
    expect(deps.stat).not.toHaveBeenCalled()
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
