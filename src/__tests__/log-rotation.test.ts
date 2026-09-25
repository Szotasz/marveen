import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotateLogFile, runLogRotationSweep, ROTATED_LOG_NAMES } from '../web/log-rotation.js'

// Copytruncate rotation (LOGROTATE910). The load-bearing property is the last
// test: a writer holding the file open in APPEND mode keeps landing lines in
// the truncated live file -- the exact shape mv-based rotation breaks.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'logrot-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const fill = (path: string, bytes: number, ch = 'x') => writeFileSync(path, ch.repeat(bytes))

describe('rotateLogFile', () => {
  it('leaves a file at or under the cap untouched', () => {
    const p = join(dir, 'a.log')
    fill(p, 100)
    const res = rotateLogFile(p, { maxBytes: 100 })
    expect(res.rotated).toBe(false)
    expect(statSync(p).size).toBe(100)
    expect(existsSync(`${p}.1.gz`)).toBe(false)
  })

  it('is a no-op on a missing file (never throws at boot on a fresh install)', () => {
    expect(rotateLogFile(join(dir, 'missing.log')).rotated).toBe(false)
  })

  it('rotates an over-cap file: content lands gzipped in .1.gz, live file truncates to 0', () => {
    const p = join(dir, 'a.log')
    writeFileSync(p, 'line-one\nline-two\n' + 'x'.repeat(200))
    const res = rotateLogFile(p, { maxBytes: 50 })
    expect(res.rotated).toBe(true)
    expect(statSync(p).size).toBe(0)
    const archived = gunzipSync(readFileSync(`${p}.1.gz`)).toString()
    expect(archived).toContain('line-one')
    expect(archived).toContain('line-two')
    expect(existsSync(`${p}.1.gz.tmp`)).toBe(false)
  })

  it('shifts generations and drops the oldest at the keep cap', () => {
    const p = join(dir, 'a.log')
    for (const n of [1, 2, 3]) writeFileSync(`${p}.${n}.gz`, `gen-${n}`)
    fill(p, 60)
    rotateLogFile(p, { maxBytes: 50, keep: 3 })
    // old gen-3 dropped, gen-2 -> 3, gen-1 -> 2, fresh archive at 1
    expect(readFileSync(`${p}.3.gz`).toString()).toBe('gen-2')
    expect(readFileSync(`${p}.2.gz`).toString()).toBe('gen-1')
    expect(gunzipSync(readFileSync(`${p}.1.gz`)).toString()).toBe('x'.repeat(60))
    expect(existsSync(`${p}.4.gz`)).toBe(false)
  })

  // The reason this whole module exists: the writer's fd survives the
  // rotation. An APPEND-mode writer (launchd StandardOutPath, systemd
  // append:, start.sh >>) writes its next line at the NEW EOF of the
  // truncated file. With mv-rotation the same write would vanish into the
  // moved inode.
  it('an O_APPEND writer keeps landing lines in the truncated live file', () => {
    const p = join(dir, 'a.log')
    const fd = openSync(p, 'a')
    writeSync(fd, 'before-rotation\n'.repeat(10))
    const res = rotateLogFile(p, { maxBytes: 10 })
    expect(res.rotated).toBe(true)
    writeSync(fd, 'after-rotation\n')
    closeSync(fd)
    const live = readFileSync(p).toString()
    expect(live).toBe('after-rotation\n')
    expect(gunzipSync(readFileSync(`${p}.1.gz`)).toString()).toContain('before-rotation')
  })
})

describe('runLogRotationSweep', () => {
  it('rotates only the covered, over-cap files and reports them by name', () => {
    fill(join(dir, 'dashboard.log'), 100)
    fill(join(dir, 'channels.log'), 10)
    fill(join(dir, 'provenance-flagged.log'), 100) // ledger: NOT covered
    const rotated = runLogRotationSweep(dir, { maxBytes: 50 })
    expect(rotated).toEqual(['dashboard.log'])
    expect(statSync(join(dir, 'provenance-flagged.log')).size).toBe(100)
    expect(statSync(join(dir, 'channels.log')).size).toBe(10)
  })

  it('covers exactly the launcher-redirected stdout/stderr family', () => {
    // Pin the list: adding a log here is a deliberate decision (ledgers must
    // never slip in), and removing one must break a test, not go quietly.
    expect([...ROTATED_LOG_NAMES].sort()).toEqual([
      'channel-coordinator.error.log',
      'channel-coordinator.log',
      'channels.error.log',
      'channels.log',
      'dashboard.error.log',
      'dashboard.log',
    ])
  })
})
