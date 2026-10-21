// readPendingResumes used to swallow EVERY read error silently. A missing file
// is the normal empty state; an unreadable or corrupt one silently dropped
// every owed resume prompt, and nothing in the log said so.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() } }))

import { readPendingResumes } from '../web/context-guard-resume-store.js'

const dir = mkdtempSync(join(tmpdir(), 'resume-read-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => warn.mockClear())

describe('readPendingResumes read errors', () => {
  it('a missing file is {} and silent', () => {
    expect(readPendingResumes(join(dir, 'nope.json'))).toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it('a valid file still parses, silently', () => {
    const p = join(dir, 'ok.json')
    writeFileSync(p, JSON.stringify({ cody: { restartedAtMs: 5, reason: 'r' } }))
    expect(readPendingResumes(p)).toEqual({ cody: { restartedAtMs: 5, handoffStaleMinutes: null, reason: 'r' } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('corrupt JSON is {} AND a warning', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{"cody": {"restartedAtMs": 5')
    expect(readPendingResumes(p)).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][1])).toContain('not valid JSON')
  })

  it('an unreadable path (a directory) is {} AND a warning naming the code', () => {
    const p = join(dir, 'is-a-dir')
    mkdirSync(p)
    expect(readPendingResumes(p)).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ code: 'EISDIR' })
  })
})
