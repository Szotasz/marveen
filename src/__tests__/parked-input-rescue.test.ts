import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
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
