// A write refused for a busy session is queued and run at the end of the turn
// (ELSOKOR922 Phase 7 A-smoke: `/model sonnet keep` answered "pane-busy" and
// was simply lost). The Stop hook is the trigger; these tests cover the store
// and the runner's four outcomes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  queuePendingWrite,
  readPendingWrite,
  clearPendingWrite,
  runPendingWrite,
  PENDING_WRITE_TTL_MS,
  type PendingDeps,
} from '../web/pending-write.js'

const T0 = Date.parse('2026-09-22T20:00:00Z')
let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-'))
  file = join(dir, 'main-command-pending.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function deps(over: Partial<PendingDeps> = {}) {
  const notes: string[] = []
  const ran: string[] = []
  const d: PendingDeps & { notes: string[]; ran: string[] } = {
    notes, ran, file,
    notify: async (t: string) => { notes.push(t) },
    dispatch: (async (text: string, ctx: { reply: (t: string) => Promise<void> }) => {
      ran.push(text)
      await ctx.reply('Átváltva: sonnet')
      return 'ran'
    }) as PendingDeps['dispatch'],
    ...over,
  }
  return d
}

describe('pending write', () => {
  it('queues one command with a deadline; a newer one replaces it', () => {
    expect(queuePendingWrite('/model sonnet keep', 42, T0, file)).toBe(T0 + PENDING_WRITE_TTL_MS)
    expect(readPendingWrite(file)).toEqual({ text: '/model sonnet keep', ownerId: 42, queuedAt: T0, deadline: T0 + PENDING_WRITE_TTL_MS })
    queuePendingWrite('/model opus 30m', 42, T0 + 1000, file)
    expect(readPendingWrite(file)?.text).toBe('/model opus 30m')
    clearPendingWrite(file)
    expect(readPendingWrite(file)).toBeNull()
  })

  it('a re-queue of the SAME command keeps the original deadline (no forever-retry)', () => {
    queuePendingWrite('/model sonnet keep', 42, T0, file)
    expect(queuePendingWrite('/model sonnet keep', 42, T0 + 5 * 60_000, file)).toBe(T0 + PENDING_WRITE_TTL_MS)
  })

  it('nothing queued: the runner does nothing', async () => {
    const d = deps()
    expect(await runPendingWrite(T0, d)).toBe('none')
    expect(d.notes).toEqual([])
  })

  it('runs the queued command once and reports the reply on the main bot', async () => {
    queuePendingWrite('/model sonnet keep', 42, T0, file)
    const d = deps()
    expect(await runPendingWrite(T0 + 30_000, d)).toBe('ran')
    expect(d.ran).toEqual(['/model sonnet keep'])
    expect(d.notes[0]).toMatch(/^\/model sonnet keep \(a foglalt session után, 30 mp várakozás\): Átváltva: sonnet$/)
    expect(existsSync(file)).toBe(false)
  })

  it('still busy: the command re-queues itself and the runner stays silent', async () => {
    queuePendingWrite('/model sonnet keep', 42, T0, file)
    const d = deps({
      dispatch: (async (text: string, ctx: { now: number; reply: (t: string) => Promise<void> }) => {
        queuePendingWrite(text, 42, ctx.now, file)   // what the busy write does
        await ctx.reply('Nem váltottam: a session foglalt (pane-busy).')
        return 'ran'
      }) as PendingDeps['dispatch'],
    })
    expect(await runPendingWrite(T0 + 30_000, d)).toBe('still-busy')
    expect(d.notes).toEqual([])
    expect(readPendingWrite(file)?.deadline).toBe(T0 + PENDING_WRITE_TTL_MS)
  })

  it('past the deadline: dropped, never run, and the owner is told', async () => {
    queuePendingWrite('/model sonnet keep', 42, T0, file)
    const d = deps()
    expect(await runPendingWrite(T0 + PENDING_WRITE_TTL_MS + 1000, d)).toBe('expired')
    expect(d.ran).toEqual([])
    expect(d.notes[0]).toMatch(/Nem futott le: \/model sonnet keep .*10 percig foglalt maradt/)
    expect(existsSync(file)).toBe(false)
  })

  it('an unreadable queue file is treated as empty, never as a command', async () => {
    writeFileSync(file, '{broken')
    expect(readPendingWrite(file)).toBeNull()
    expect(await runPendingWrite(T0, deps())).toBe('none')
  })
})
