// Conformance tests for scripts/heartbeat-metrics.sh -- the heartbeat
// round's single callable instrument (HBMEMBLIND819, third contract).
//
// Two properties are load-bearing and each gets both a positive and a
// negative control:
//   1. Fail-closed: a missing/null field NEVER prints as 0 -- it prints an
//      ERROR line and the exit code is non-zero. (The 2026-08-24 22:00
//      failure was exactly a missing field surfacing as a silent 0.)
//   2. Path binding: the scaffold prose references this script by path, so
//      a rename/move must fail HERE, in CI, not at 22:00 on the host.
//      (The prose side is fail-safe too -- sentinel rule -- but that only
//      makes the breakage visible, not impossible.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'

const REPO_ROOT = join(__dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'heartbeat-metrics.sh')
const TOKEN = 'test-token-abc'

// Mutable fixtures the server serves; individual tests reshape them.
let summaryBody: unknown
let schedulesBody: unknown
let server: Server
let origin: string
let storeDir: string

const FULL_SUMMARY = () => ({
  counts: {
    urgent: 2,
    in_progress: 3,
    waiting: 280,
    planned: 5,
    new_hot_memories_1h: 0,
    db_size_mb: 166.6,
  },
  waiting_shown: 8,
  urgent: [{ id: 'CARD1', title: 'first urgent' }],
  waiting: [{ id: 'CARD2', title: 'a waiting card' }],
})

// ASYNC on purpose: the fixture server lives in THIS process, and a
// spawnSync would block the event loop for the child's whole lifetime --
// the server could never answer and every HTTP-dependent case would
// "fail" with a timeout (measured on the first run of this file).
function runScript(env: Record<string, string> = {}): Promise<{ status: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(
      'bash',
      [SCRIPT],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAW_STORE_DIR: storeDir,
          CLAW_DASHBOARD_ORIGIN: origin,
          ...env,
        },
      },
      (err, stdout) => {
        const code = (err as { code?: unknown } | null)?.code
        resolve({ status: err ? (typeof code === 'number' ? code : 1) : 0, stdout })
      }
    )
  })
}

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'hb-metrics-store-'))
  writeFileSync(join(storeDir, '.dashboard-token'), TOKEN + '\n')

  // Fixture task_runs DB, created with the same python3 the script uses.
  // Three rows probe the milliseconds cutoff behaviourally:
  //   - two recent rows with ts in MILLISECONDS -> must be counted
  //   - one old ms row (2h ago)                 -> must not be counted
  //   - one row with ts in SECONDS (now-60)     -> must not be counted;
  //     a seconds-cutoff regression would count it (and the old row too).
  const mk = spawnSync('python3', ['-c', `
import sqlite3, sys, time
con = sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE task_runs (ts INTEGER, status TEXT)')
now_ms = int(time.time() * 1000)
rows = [(now_ms - 60_000, 'fired'), (now_ms - 120_000, 'fired'),
        (now_ms - 7_200_000, 'fired'), (int(time.time()) - 60, 'fired')]
con.executemany('INSERT INTO task_runs VALUES (?, ?)', rows)
con.commit()
`, join(storeDir, 'claudeclaw.db')])
  if (mk.status !== 0) throw new Error('fixture db failed: ' + mk.stderr)

  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + TOKEN) {
      res.writeHead(401).end('{"error":"unauthorized"}')
      return
    }
    const body =
      req.url === '/api/kanban/heartbeat-summary' ? summaryBody
      : req.url === '/api/schedules' ? schedulesBody
      : undefined
    if (body === undefined) {
      res.writeHead(404).end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(storeDir, { recursive: true, force: true })
})

describe('path binding (a rename must fail in CI, not at 22:00 on the host)', () => {
  it('the script exists at the path the scaffold derives and is executable', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    accessSync(SCRIPT, constants.X_OK)
  })

  it('the scaffold source builds exactly this relative path', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf8')
    expect(src).toMatch(/'scripts',\s*'heartbeat-metrics\.sh'/)
  })

  it('script and scaffold agree on the sentinel version', () => {
    // The reporter accepts ONLY the known sentinel; if the script ever
    // bumps to V2, the prose must move in the same commit or every round
    // reads as instrument failure.
    const script = readFileSync(SCRIPT, 'utf8')
    const scaffold = readFileSync(join(REPO_ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf8')
    expect(script).toContain('echo "HB_METRICS_V1 ')
    expect(scaffold).toContain('HB_METRICS_V1')
  })
})

describe('positive control: full fixture', () => {
  it('prints the sentinel first, every field, and exits 0', async () => {
    summaryBody = FULL_SUMMARY()
    schedulesBody = [{ enabled: true }, { enabled: false }, { enabled: true }]
    const r = await runScript()
    expect(r.status).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^HB_METRICS_V1 ts=\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(r.stdout).toContain(
      'COUNTS urgent=2 in_progress=3 waiting=280 planned=5 new_hot_memories_1h=0 db_size_mb=166.6 waiting_shown=8'
    )
    expect(r.stdout).toContain('URGENT CARD1 first urgent')
    expect(r.stdout).toContain('WAITING CARD2 a waiting card')
    expect(r.stdout).toContain('SCHEDULES enabled=2')
    expect(r.stdout).not.toContain('ERROR')
  })

  it('counts only the millisecond rows inside the hour (the *1000 cutoff, behaviourally)', async () => {
    summaryBody = FULL_SUMMARY()
    schedulesBody = []
    const r = await runScript()
    // 2 recent ms rows in; the 2h-old ms row and the seconds-unit row out.
    // A seconds-cutoff regression reports total=4 here.
    expect(r.stdout).toContain('TASK_RUNS_1H total=2 fired=2')
  })
})

describe('fail-closed: a missing value is an ERROR line + non-zero exit, never a 0', () => {
  it('missing new_hot_memories_1h (the 2026-08-24 22:00 shape)', async () => {
    const s = FULL_SUMMARY()
    delete (s.counts as Record<string, unknown>).new_hot_memories_1h
    summaryBody = s
    schedulesBody = [{ enabled: true }]
    const r = await runScript()
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('ERROR summary: missing/null fields: new_hot_memories_1h')
    expect(r.stdout).not.toContain('new_hot_memories_1h=0')
    // Partial output stays usable: the unaffected sections still print.
    expect(r.stdout).toContain('SCHEDULES enabled=1')
    expect(r.stdout).toContain('TASK_RUNS_1H total=2 fired=2')
  })

  it('null db_size_mb (the HBDBMERET822 shape) never becomes 0.0', async () => {
    const s = FULL_SUMMARY()
    ;(s.counts as Record<string, unknown>).db_size_mb = null
    summaryBody = s
    schedulesBody = []
    const r = await runScript()
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('ERROR summary: missing/null fields: db_size_mb')
    expect(r.stdout).not.toMatch(/db_size_mb=/)
  })

  it('unreachable dashboard: sentinel still first, ERROR lines, non-zero exit', async () => {
    const r = await runScript({ CLAW_DASHBOARD_ORIGIN: 'http://127.0.0.1:1' })
    expect(r.status).not.toBe(0)
    expect(r.stdout.split('\n')[0]).toMatch(/^HB_METRICS_V1 /)
    expect(r.stdout).toContain('ERROR summary:')
    expect(r.stdout).toContain('ERROR schedules:')
    expect(r.stdout).not.toContain('COUNTS')
    // task_runs reads the local DB and still works.
    expect(r.stdout).toContain('TASK_RUNS_1H total=2 fired=2')
  })

  it('missing token file: ERROR token, non-zero exit, no fabricated numbers', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'hb-metrics-bare-'))
    try {
      summaryBody = FULL_SUMMARY()
      schedulesBody = []
      const r = await runScript({ CLAW_STORE_DIR: bare })
      expect(r.status).not.toBe(0)
      expect(r.stdout).toContain('ERROR token:')
      expect(r.stdout).toContain('ERROR task_runs: db not found:')
      expect(r.stdout).not.toContain('COUNTS')
      expect(r.stdout).not.toContain('SCHEDULES')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('rejected token (401): ERROR from the summary and schedules sections', async () => {
    summaryBody = FULL_SUMMARY()
    schedulesBody = []
    writeFileSync(join(storeDir, '.dashboard-token'), 'wrong-token\n')
    try {
      const r = await runScript()
      expect(r.status).not.toBe(0)
      expect(r.stdout).toContain('ERROR summary:')
      expect(r.stdout).toContain('ERROR schedules:')
      expect(r.stdout).not.toContain('COUNTS')
    } finally {
      writeFileSync(join(storeDir, '.dashboard-token'), TOKEN + '\n')
    }
  })
})
