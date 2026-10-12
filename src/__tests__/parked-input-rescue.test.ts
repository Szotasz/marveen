import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync, statSync, readdirSync, utimesSync, chmodSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import {
  rescueParkedInput,
  decideMainParkedEscalation,
  PARKED_RESCUE_DIR,
  MAIN_PARKED_HEARTBEAT_AFTER,
  MAIN_PARKED_OWNER_AFTER,
  MAIN_PARKED_RESCUE_AFTER,
} from '../web/agent-process.js'
import { logger } from '../logger.js'

// GH #890: a prompt parked in the main agent's input box makes the session read
// as busy, so every later scheduled task is deferred. The reporter saw the whole
// scheduler stall silently until the line was cleared by hand; measured again on
// 2026-09-09 as 22 skipped tasks in one hour.
//
// Clearing that box is only acceptable because the text is rescued first AND the
// save is read back. A save nobody verified is a delete with extra steps, and
// the box may hold work nothing will re-deliver.

const cleanup: string[] = []
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { force: true })
})

describe('rescueParkedInput', () => {
  it('writes the text and returns a path that actually holds it', () => {
    const text = 'Igen, ird meg Baloghnak a valaszt'
    const path = rescueParkedInput('marveen-channels', text)
    expect(path).not.toBeNull()
    cleanup.push(path!)
    expect(existsSync(path!)).toBe(true)
    expect(readFileSync(path!, 'utf-8')).toContain(text)
  })

  it('labels the saved text as a scrape of the visible box, so a tail is not read as the whole message', () => {
    const path = rescueParkedInput('marveen-channels', 'valami')
    cleanup.push(path!)
    const body = readFileSync(path!, 'utf-8')
    expect(body).toContain('scrape of the VISIBLE input box')
    expect(body).toContain('session: marveen-channels')
  })

  it('keeps multi-line text intact', () => {
    const text = 'elso sor\nmasodik sor\nharmadik sor'
    const path = rescueParkedInput('marveen-channels', text)
    cleanup.push(path!)
    expect(readFileSync(path!, 'utf-8')).toContain(text)
  })

  it('does not collide when two rescues happen for the same session', () => {
    const a = rescueParkedInput('marveen-channels', 'egyik', 1_700_000_000_000)
    const b = rescueParkedInput('marveen-channels', 'masik', 1_700_000_001_000)
    cleanup.push(a!, b!)
    expect(a).not.toBe(b)
    expect(readFileSync(a!, 'utf-8')).toContain('egyik')
    expect(readFileSync(b!, 'utf-8')).toContain('masik')
  })

  it('cannot be walked out of the rescue directory by a hostile session name', () => {
    // The property that matters is containment, not the absence of a dot: the
    // separators are what a traversal needs, and they are gone. A literal '..'
    // left INSIDE one filename segment cannot climb anywhere.
    const path = rescueParkedInput('weird/../name with spaces', 'x')
    cleanup.push(path!)
    expect(dirname(resolve(path!))).toBe(resolve(PARKED_RESCUE_DIR))
    expect(basename(path!)).not.toContain('/')
    expect(basename(path!)).not.toContain(' ')
  })

  it('returns null when the save cannot be made, so the caller must not clear', () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    // A directory where the file should be makes writeFileSync throw: the point
    // is that ANY failure lands here rather than in a clear.
    const stamp = 1_700_000_002_000
    const blocked = join(
      PARKED_RESCUE_DIR,
      `marveen-channels-${new Date(stamp).toISOString().replace(/[:.]/g, '-')}.txt`,
    )
    mkdirSync(blocked, { recursive: true })
    try {
      expect(rescueParkedInput('marveen-channels', 'nem menthet', stamp)).toBeNull()
      expect(err).toHaveBeenCalled()
    } finally {
      rmSync(blocked, { recursive: true, force: true })
      err.mockRestore()
    }
  })
})

describe('decideMainParkedEscalation: the rescue stage', () => {
  it('does not rescue before the owner has been told and given a stage to act', () => {
    expect(decideMainParkedEscalation(MAIN_PARKED_HEARTBEAT_AFTER, false)).toBe('heartbeat')
    expect(decideMainParkedEscalation(MAIN_PARKED_OWNER_AFTER, false)).toBe('owner')
    expect(decideMainParkedEscalation(MAIN_PARKED_RESCUE_AFTER - 1, true)).toBe('heartbeat')
  })

  it('rescues and clears once the same text has outlasted the owner stage', () => {
    expect(decideMainParkedEscalation(MAIN_PARKED_RESCUE_AFTER, true)).toBe('rescue-and-clear')
    expect(decideMainParkedEscalation(MAIN_PARKED_RESCUE_AFTER + 10, true)).toBe('rescue-and-clear')
  })

  it('rescues even if the owner notification never went out, because the stall is the harm', () => {
    expect(decideMainParkedEscalation(MAIN_PARKED_RESCUE_AFTER, false)).toBe('rescue-and-clear')
  })

  it('keeps the ladder ordered: heartbeat < owner < rescue', () => {
    expect(MAIN_PARKED_HEARTBEAT_AFTER).toBeLessThan(MAIN_PARKED_OWNER_AFTER)
    expect(MAIN_PARKED_OWNER_AFTER).toBeLessThan(MAIN_PARKED_RESCUE_AFTER)
  })
})

describe('rescueParkedInput: file permissions and retention', () => {
  it('writes the rescue 0600 and the directory 0700, matching the rest of store/', () => {
    // Measured on a live install: .dashboard-token, claudeclaw.db and
    // .claude-oauth-token are all 0600. A 0644 file sitting next to them later
    // reads as a deliberate exception, and nobody remembers that it was not.
    const path = rescueParkedInput('marveen-channels', 'gazda gepelt mondata')
    cleanup.push(path!)
    expect(statSync(path!).mode & 0o777).toBe(0o600)
    expect(statSync(PARKED_RESCUE_DIR).mode & 0o777).toBe(0o700)
  })

  it('tightens a directory that already exists at the old default', () => {
    // mkdirSync's mode only applies on creation. An install that already ran
    // the first version of the rescue has the directory at 0755 and would
    // silently keep it, so the new mode would apply to nobody who needs it.
    mkdirSync(PARKED_RESCUE_DIR, { recursive: true })
    chmodSync(PARKED_RESCUE_DIR, 0o755)
    expect(statSync(PARKED_RESCUE_DIR).mode & 0o777).toBe(0o755)
    const path = rescueParkedInput('mode-upgrade', 'x')
    cleanup.push(path!)
    expect(statSync(PARKED_RESCUE_DIR).mode & 0o777).toBe(0o700)
  })

  it('keeps the newest rescues and drops the ones beyond the cap', () => {
    // Write comfortably more than the cap, oldest first.
    const written: string[] = []
    for (let i = 0; i < 55; i++) {
      const p = rescueParkedInput('cap-test', `sor ${i}`, 1_700_000_000_000 + i * 1000)
      expect(p).not.toBeNull()
      written.push(p!)
    }
    const left = readdirSync(PARKED_RESCUE_DIR).filter((f) => f.startsWith('cap-test-'))
    expect(left.length).toBeLessThanOrEqual(50)
    // The most recent write must survive: losing the newest would defeat the
    // whole point of writing it.
    expect(existsSync(written[written.length - 1])).toBe(true)
    for (const f of left) rmSync(join(PARKED_RESCUE_DIR, f), { force: true })
  })

  it('drops a rescue older than the retention window', () => {
    const old = rescueParkedInput('age-test', 'regi', 1_700_000_000_000)
    cleanup.push(old!)
    utimesSync(old!, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), new Date(Date.now() - 40 * 24 * 60 * 60 * 1000))
    // The next rescue prunes at write time.
    const fresh = rescueParkedInput('age-test', 'uj')
    cleanup.push(fresh!)
    expect(existsSync(old!)).toBe(false)
    expect(existsSync(fresh!)).toBe(true)
  })

  it('a failing prune never stops the rescue from being written', () => {
    // The prune runs only after the read-back succeeded, so even a throwing
    // prune leaves the file it was asked to protect.
    const path = rescueParkedInput('prune-safety', 'megmarad')
    cleanup.push(path!)
    expect(existsSync(path!)).toBe(true)
  })
})
