import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, listApprovalEvents } from '../db.js'
import { BOT, PKG, approvedPermission } from './helpers/rag-approval-fixtures.js'

// Card 9a77b3e5: the consume must be single-use ACROSS PROCESSES. Two calls on
// one connection would be falsely green (JS is single-threaded there), so this
// runs two separate child processes, each with its own connection to the same
// temp DB FILE, released from a file barrier at the same moment. Per round,
// exactly one wins. 20 rounds on one approval, 20 rounds on two approvals that
// carry the same run_id (one run, one use).
const ROUNDS = 20
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(ROOT, 'node_modules/.bin/tsx')
const CHILD = join(ROOT, 'src/__tests__/helpers/rag-approval-race-child.ts')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(path: string, kids: ChildProcess[], what: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    if (kids.some((k) => k.exitCode !== null && k.exitCode !== 0)) throw new Error(`a child exited early while waiting for ${what}`)
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await sleep(2)
  }
}

describe('consumeOwnerRunApproval across processes', () => {
  it('exactly one of two concurrent processes wins, 20 times, on one approval and on one run_id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-approval-race-'))
    const dbFile = join(dir, 'race.db')
    const syncDir = join(dir, 'sync')
    const kids: ChildProcess[] = []
    try {
      writeFileSync(join(dir, 'README'), 'temp dir of rag-approval-race.test.ts')
      initDatabase(dbFile)
      const now = Math.floor(Date.now() / 1000)
      const mk = (run: string) => approvedPermission({ start: now - 100, end: now + 3600, timeoutAt: now + 600, run })
      const runId = (n: number, k: number) => `${(n * 2 + k).toString(16).padStart(2, '0')}`.repeat(16)

      // rounds 0..19: both children name the SAME approval
      const same = Array.from({ length: ROUNDS }, (_, i) => { const run = runId(i, 0); return { run, a: mk(run).id } })
      // rounds 20..39: each child names its OWN approval, both with the same run_id
      const twin = Array.from({ length: ROUNDS }, (_, i) => { const run = runId(i, 1); return { run, a: mk(run).id, b: mk(run).id } })
      const plan0 = [
        ...same.map((s) => ({ id: s.a, runId: s.run, packageSha256: PKG })),
        ...twin.map((s) => ({ id: s.a, runId: s.run, packageSha256: PKG })),
      ]
      const plan1 = [
        ...same.map((s) => ({ id: s.a, runId: s.run, packageSha256: PKG })),
        ...twin.map((s) => ({ id: s.b, runId: s.run, packageSha256: PKG })),
      ]
      initDatabase(':memory:') // the parent lets go of the file; the children own it now

      const { mkdirSync } = await import('node:fs')
      mkdirSync(syncDir)
      const names = ['A', 'B']
      for (const [i, plan] of [plan0, plan1].entries()) {
        const k = spawn(TSX, [CHILD, dbFile, syncDir, names[i]!, JSON.stringify(plan), BOT], { stdio: ['ignore', 'pipe', 'pipe'] })
        k.stderr!.on('data', () => { /* drained; a failure surfaces through the barrier timeout and exit code */ })
        k.stdout!.on('data', () => { /* drained */ })
        kids.push(k)
      }

      const reasons: Array<[string | null, string | null]> = []
      for (let r = 0; r < ROUNDS * 2; r++) {
        for (const n of names) await waitFor(join(syncDir, `ready-${r}-${n}`), kids, `ready ${r} ${n}`)
        writeFileSync(join(syncDir, `go-${r}`), '')
        const res: Array<{ ok: boolean; reason: string | null }> = []
        for (const n of names) {
          await waitFor(join(syncDir, `res-${r}-${n}`), kids, `result ${r} ${n}`)
          res.push(JSON.parse(readFileSync(join(syncDir, `res-${r}-${n}`), 'utf8')))
        }
        const winners = res.filter((x) => x.ok)
        expect(winners, `round ${r}: ${JSON.stringify(res)}`).toHaveLength(1)
        const loser = res.find((x) => !x.ok)!
        reasons.push([r < ROUNDS ? 'same' : 'twin', loser.reason])
      }
      for (const [kind, reason] of reasons) {
        expect(reason).toBe(kind === 'same' ? 'already_consumed' : 'run_id_already_used')
      }
      await Promise.all(kids.map((k) => new Promise<void>((resolve) => { if (k.exitCode !== null) resolve(); else k.once('exit', () => resolve()) })))
      expect(kids.map((k) => k.exitCode)).toEqual([0, 0])

      // The DB agrees: one consumed approval per run_id, one consumed event per round.
      initDatabase(dbFile)
      const consumed = getDb().prepare("SELECT consumed_ref, COUNT(*) AS n FROM approvals WHERE consumed_at IS NOT NULL GROUP BY consumed_ref").all() as Array<{ consumed_ref: string; n: number }>
      expect(consumed).toHaveLength(ROUNDS * 2)
      expect(consumed.every((c) => c.n === 1)).toBe(true)
      const evCount = (getDb().prepare("SELECT COUNT(*) AS n FROM approval_events WHERE event = 'consumed'").get() as { n: number }).n
      const refusedCount = (getDb().prepare("SELECT COUNT(*) AS n FROM approval_events WHERE event = 'consume_refused'").get() as { n: number }).n
      expect(evCount).toBe(ROUNDS * 2)
      expect(refusedCount).toBe(ROUNDS * 2)
      expect(listApprovalEvents(same[0]!.a).map((e) => e.event).sort()).toEqual(['consume_refused', 'consumed'])
    } finally {
      for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL')
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
