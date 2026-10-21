// The hook-failure reader: Claude Code writes a `hook_non_blocking_error` record
// into the transcript when a hook exits with anything but 0 or 2 (and a system
// warning when a hook blocks). For a PreToolUse gate a non-blocking error means the
// call went through, so a crashed gate is silently fail-open until someone reads it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
// The main agent is listed among the others too: the roots must not read it twice.
vi.mock('../web/agent-config.js', async (orig) => {
  const { MAIN_AGENT_ID: main } = await import('../config.js')
  return {
    ...(await orig<typeof import('../web/agent-config.js')>()),
    listAllAgentNames: () => ['ana', main, 'dex'],
  }
})
vi.mock('../web/main-transcript-root.js', () => ({
  configDirFor: (name: string) => (name === 'dex' ? '/cfg/dex' : undefined),
}))

import {
  parseHookFailureLine, stderrHeadline, groupHookFailures, scanHookFailures, transcriptRoots,
  type HookFailure,
} from '../web/hook-failure-scan.js'
import { MAIN_AGENT_ID } from '../config.js'
import { parseArgs, renderReport } from '../hook-failure-report.js'

// The shape of a real record: a PreToolUse gate that crashed at module load.
const NON_BLOCKING = JSON.stringify({
  type: 'attachment',
  timestamp: '2030-01-02T06:15:47.594Z',
  sessionId: 'sess-1',
  attachment: {
    type: 'hook_non_blocking_error',
    hookEvent: 'PreToolUse',
    exitCode: 1,
    command: 'node /opt/app/scripts/some-gate.mjs',
    stderr: 'Failed with non-blocking status code: file:///opt/app/scripts/some-gate.mjs:716\n  x ||\n\nReferenceError: join is not defined',
  },
})
const BLOCKING = JSON.stringify({
  type: 'system', level: 'warning', timestamp: '2030-01-02T10:00:00.000Z',
  content: 'UserPromptSubmit operation blocked by hook: something exploded',
})

describe('parseHookFailureLine', () => {
  it('parses a non-blocking record', () => {
    expect(parseHookFailureLine(NON_BLOCKING)).toMatchObject({
      event: 'PreToolUse', exitCode: 1, blocking: false, command: 'node /opt/app/scripts/some-gate.mjs',
      timestamp: '2030-01-02T06:15:47.594Z', sessionId: 'sess-1',
    })
  })

  it('parses a blocking record and recovers the event from the message', () => {
    expect(parseHookFailureLine(BLOCKING)).toMatchObject({ event: 'UserPromptSubmit', blocking: true, exitCode: null })
  })

  it('does not fire on conversation that merely talks about hook failures', () => {
    expect(parseHookFailureLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'it was blocked by hook X, and hook_non_blocking_error too' } }))).toBeNull()
    expect(parseHookFailureLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the operation was blocked by hook X' }] } }))).toBeNull()
    expect(parseHookFailureLine(JSON.stringify({ type: 'system', level: 'info', content: 'x blocked by hook y' }))).toBeNull()
    expect(parseHookFailureLine(JSON.stringify({ type: 'attachment', attachment: { type: 'file', content: 'see hook_non_blocking_error' } }))).toBeNull()
  })

  it('a line without either marker, or not JSON, is null', () => {
    expect(parseHookFailureLine('{"type":"user"}')).toBeNull()
    expect(parseHookFailureLine('hook_non_blocking_error {not json')).toBeNull()
  })
})

describe('stderrHeadline and grouping', () => {
  it('prefers the line that names the fault over the harness wrapper', () => {
    expect(stderrHeadline((parseHookFailureLine(NON_BLOCKING)!).stderr)).toBe('ReferenceError: join is not defined')
    expect(stderrHeadline('only one line')).toBe('only one line')
    expect(stderrHeadline('')).toBe('')
  })

  it('never the harness wrapper when anything else is there, and not a code frame that merely mentions Error', () => {
    const wrap = 'Failed with non-blocking status code: file:///opt/app/HandleError.sh:3'
    expect(stderrHeadline(`${wrap}\njq: command not found`)).toBe('jq: command not found')
    expect(stderrHeadline(`${wrap}\n  throw new Error('bad')\n\nError: bad`)).toBe('Error: bad')
    expect(stderrHeadline(wrap)).toBe(wrap)
  })

  it('collapses repeats with their first and last time, most frequent first', () => {
    const base: HookFailure = {
      agent: 'ana', file: '/x.jsonl', sessionId: 's', event: 'PreToolUse', exitCode: 1,
      command: 'node gate.mjs', stderr: 'ReferenceError: join is not defined', timestamp: '2030-01-02T06:15:47Z', blocking: false,
    }
    const groups = groupHookFailures([
      base,
      { ...base, timestamp: '2030-01-02T06:15:40Z' },
      { ...base, agent: 'dex' },
    ])
    expect(groups[0]).toMatchObject({ agent: 'ana', count: 2, firstTimestamp: '2030-01-02T06:15:40Z', lastTimestamp: '2030-01-02T06:15:47Z', stderrHead: 'ReferenceError: join is not defined' })
    expect(groups[1]).toMatchObject({ agent: 'dex', count: 1 })
  })
})

describe('transcriptRoots', () => {
  it('the main agent first, then the others; each agent\'s config root, else the host default, each directory once', () => {
    const roots = transcriptRoots()
    // ana has no config dir of its own: it shares the host default with the main agent
    expect(roots.map((r) => r.agent)).toEqual([MAIN_AGENT_ID, 'dex'])
    expect(roots.find((r) => r.agent === 'dex')!.dir).toBe(join('/cfg/dex', 'projects'))
    expect(roots[0].dir.endsWith(join('.claude', 'projects'))).toBe(true)
  })
})

describe('scanHookFailures over transcript roots', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hookscan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function transcript(root: string, name: string, lines: string[], ageDays = 0): string {
    const p = join(dir, root, 'projects', '-work-dir', name)
    mkdirSync(join(dir, root, 'projects', '-work-dir'), { recursive: true })
    writeFileSync(p, lines.join('\n') + '\n')
    if (ageDays) { const t = Date.now() / 1000 - ageDays * 86400; utimesSync(p, t, t) }
    return p
  }
  const roots = (...names: string[]) => names.map((agent) => ({ agent, dir: join(dir, agent, 'projects') }))

  it('finds the records, owns them by the root they were found under, oldest first', () => {
    transcript('ana', 'a.jsonl', ['{"type":"user"}', BLOCKING])
    transcript('dex', 'b.jsonl', [NON_BLOCKING])
    const scan = scanHookFailures({ roots: roots('ana', 'dex') })
    expect(scan.failures.map((f) => [f.agent, f.blocking])).toEqual([['dex', false], ['ana', true]])
    expect(scan).toMatchObject({ rootsScanned: 2, filesScanned: 2, filesSkippedByAge: 0 })
  })

  it('skips transcripts older than the window', () => {
    transcript('ana', 'old.jsonl', [NON_BLOCKING], 10)
    transcript('ana', 'new.jsonl', [BLOCKING])
    const scan = scanHookFailures({ roots: roots('ana') })
    expect(scan.failures).toHaveLength(1)
    expect(scan).toMatchObject({ filesScanned: 1, filesSkippedByAge: 1 })
    expect(scanHookFailures({ roots: roots('ana'), sinceMs: 30 * 86400_000 }).failures).toHaveLength(2)
  })

  it('a transcript reachable from two roots (a symlinked projects directory) is read once, owned by the first', () => {
    transcript('ana', 'shared.jsonl', [NON_BLOCKING])
    mkdirSync(join(dir, 'dex'), { recursive: true })
    symlinkSync(join(dir, 'ana', 'projects'), join(dir, 'dex', 'projects'))
    const scan = scanHookFailures({ roots: roots('ana', 'dex') })
    expect(scan.failures.map((f) => f.agent)).toEqual(['ana'])
  })

  it('a symlinked working-dir folder below the root is followed; a dangling link is skipped', () => {
    const real = join(dir, 'elsewhere')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'c.jsonl'), NON_BLOCKING + '\n')
    mkdirSync(join(dir, 'ana', 'projects'), { recursive: true })
    symlinkSync(real, join(dir, 'ana', 'projects', '-linked-dir'))
    symlinkSync(join(dir, 'missing'), join(dir, 'ana', 'projects', 'gone.jsonl'))
    const scan = scanHookFailures({ roots: roots('ana') })
    expect(scan.failures).toHaveLength(1)
    expect(scan).toMatchObject({ filesScanned: 1, filesUnreadable: 0 })
  })

  it('reads a transcript in chunks: a record across chunk boundaries and a split UTF-8 character survive', () => {
    const rec = JSON.parse(NON_BLOCKING)
    rec.attachment.stderr = 'Error: árvíztűrő tükörfúrógép'
    transcript('ana', 'u.jsonl', ['{"type":"user"}', JSON.stringify(rec)])
    for (const chunkBytes of [1, 7, 4096]) {
      const [f] = scanHookFailures({ roots: roots('ana'), chunkBytes }).failures
      expect(f?.stderr, String(chunkBytes)).toBe('Error: árvíztűrő tükörfúrógép')
    }
    // the last line counts without a trailing newline too
    writeFileSync(join(dir, 'ana', 'projects', '-work-dir', 'u.jsonl'), JSON.stringify(rec))
    expect(scanHookFailures({ roots: roots('ana'), chunkBytes: 7 }).failures).toHaveLength(1)
  })

  it.skipIf(process.getuid?.() === 0)('an unreadable transcript in the window is counted, not silently dropped', () => {
    const p = transcript('ana', 'locked.jsonl', [NON_BLOCKING])
    chmodSync(p, 0)
    try {
      expect(scanHookFailures({ roots: roots('ana') })).toMatchObject({ failures: [], filesScanned: 0, filesUnreadable: 1 })
    } finally {
      chmodSync(p, 0o600)
    }
  })

  it('a missing root yields nothing, it does not throw', () => {
    expect(scanHookFailures({ roots: roots('nobody') })).toMatchObject({ failures: [], rootsScanned: 1, filesScanned: 0 })
  })
})

describe('the report (npm run hook-failures)', () => {
  it('parses its arguments; anything else is a usage error', () => {
    expect(parseArgs([])).toEqual({ windowMs: 7 * 86400_000, json: false })
    expect(parseArgs(['--days', '1', '--json'])).toEqual({ windowMs: 86400_000, json: true })
    for (const bad of [['--days'], ['--days', '0'], ['--days', 'x'], ['--days', '1e306'], ['--what']]) expect(parseArgs(bad), bad.join(' ')).toBeNull()
  })

  it('renders one line per group, with the mode, the time and the fault', () => {
    const failure = { ...parseHookFailureLine(NON_BLOCKING)!, agent: 'ana', file: '/x.jsonl' }
    const blocked = { ...parseHookFailureLine(BLOCKING)!, agent: 'dex', file: '/y.jsonl' }
    const text = renderReport({ failures: [failure, failure, blocked], rootsScanned: 3, filesScanned: 5, filesSkippedByAge: 1, filesUnreadable: 2 }, 86400_000)
    expect(text).toContain('modified in the last 1d: 3 record(s) (5 transcripts read, 1 older than the window, 2 unreadable, 3 transcript roots)')
    expect(text).toContain('2x  ana  PreToolUse  exit=1  fail-open (the operation proceeded)')
    expect(text).toContain('1x  dex  UserPromptSubmit  exit=-  BLOCKED the operation')
    expect(text).toContain('stderr:  ReferenceError: join is not defined')
  })

  it('a small window is not printed as zero days', () => {
    const text = renderReport({ failures: [], rootsScanned: 1, filesScanned: 0, filesSkippedByAge: 0, filesUnreadable: 0 }, 86_400)
    expect(text).toContain('last 0.001d')
  })
})
