// GAVEUPGRACE917 v2 (#1741 review): the gave_up branch may release the shared
// respawn stamp only when it is still THIS monitor's hard-restart stamp, and
// only after the settle time.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseOwnRespawnStamp, decideRespawnStampRelease } from '../web/respawn-stamp-release.js'

const SETTLE = 240_000
const AT = 1_790_000_000_000
const OWN = { value: String(Math.floor(AT / 1000)), at: AT }

describe('releaseOwnRespawnStamp', () => {
  let dir: string
  let stamp: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stamp-release-'))
    stamp = join(dir, '.channel-last-respawn')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('(a) removes our own stamp once the settle time has passed', () => {
    writeFileSync(stamp, OWN.value)
    expect(releaseOwnRespawnStamp(stamp, OWN, AT + SETTLE, SETTLE)).toBe('release')
    expect(existsSync(stamp)).toBe(false)
    expect(readdirSync(dir)).toEqual([]) // no aside file left behind
  })

  it('(b) keeps our own stamp while the hard restart is still settling', () => {
    writeFileSync(stamp, OWN.value)
    expect(releaseOwnRespawnStamp(stamp, OWN, AT + SETTLE - 1, SETTLE)).toBe('settling')
    expect(readFileSync(stamp, 'utf-8')).toBe(OWN.value)
  })

  it('(c) keeps a stamp written by another actor', () => {
    const theirs = String(Number(OWN.value) + 90) // channel-watchdog.sh respawned later
    writeFileSync(stamp, theirs + '\n')
    expect(releaseOwnRespawnStamp(stamp, OWN, AT + 10 * SETTLE, SETTLE)).toBe('not-ours')
    expect(readFileSync(stamp, 'utf-8')).toBe(theirs + '\n')
  })

  it('(d) does not throw when there is no stamp file', () => {
    expect(() => releaseOwnRespawnStamp(stamp, OWN, AT + SETTLE, SETTLE)).not.toThrow()
    expect(releaseOwnRespawnStamp(stamp, OWN, AT + SETTLE, SETTLE)).toBe('no-stamp')
  })

  it('keeps any stamp when this monitor never recorded one', () => {
    writeFileSync(stamp, OWN.value)
    expect(releaseOwnRespawnStamp(stamp, null, AT + SETTLE, SETTLE)).toBe('not-ours')
    expect(existsSync(stamp)).toBe(true)
  })
})

describe('decideRespawnStampRelease', () => {
  it('ownership is checked before the settle time', () => {
    expect(decideRespawnStampRelease({ fileContent: '1', own: OWN, now: AT, settleMs: SETTLE })).toBe('not-ours')
  })
})

describe('channel-monitor wiring', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'channel-monitor.ts'), 'utf-8')

  it('the gave_up branch calls the guarded release, not a bare rmSync', () => {
    const start = src.indexOf("marveenDownState.stage = 'gave_up'")
    expect(start).toBeGreaterThan(0)
    const branch = src.slice(start, src.indexOf('return', start))
    expect(branch).toContain('tryReleaseOwnRespawnStamp(now)')
    expect(src).not.toMatch(/rmSync\(RESPAWN_STAMP_FILE/)
  })

  it('both hard-restart success paths record our own stamp', () => {
    const fn = src.slice(src.indexOf('export function hardRestartMarveenChannels'), src.indexOf('\n}\n', src.indexOf('export function hardRestartMarveenChannels')))
    expect(fn.match(/noteOwnHardRestartStamp\(marveenLastHardRestart\)/g)?.length).toBe(2)
  })
})
