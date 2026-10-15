// Kanban claim lock, dependency unblock, done-evidence warning.
//
// The goal under test: two fleet agents must never both pick up the same card.
// The claim is a compare-and-set (one conditional UPDATE, KANBAN_CLAIM_SQL), so
// the load-bearing test is the concurrency one: several connections racing the
// same statement at the same instant, exactly one winner. It also runs a broken
// (unguarded) variant of the statement through the same harness and requires
// MORE than one winner there, so a harness that could never observe a race
// cannot pass for a working lock.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  initDatabase, createKanbanCard, getKanbanCard, moveKanbanCard, archiveKanbanCard, updateKanbanCard,
  ensureKanbanClaimSchema,
  addKanbanComment, getKanbanComments, addCardBlocker, getDb,
  claimKanbanCard, releaseKanbanCardClaim, isKanbanClaimActive, unblockDependentsOf, getDoneEvidence,
  KANBAN_CLAIM_SQL, KANBAN_CLAIM_DEFAULT_TTL_SEC,
} from '../db.js'
import { tryHandleKanban, parseClaimTtl } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function call(method: string, path: string, payload?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk) out.body = JSON.parse(chunk.toString()) },
  }
  const req: any = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

async function route(method: string, path: string, payload?: unknown) {
  const { ctx, out } = call(method, path, payload)
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

const NOW = 1_800_000_000

describe('claimKanbanCard / releaseKanbanCardClaim (db layer)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('claims a free card and reports the holder and expiry', () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    const r = claimKanbanCard('c1', 'cody', 7200, NOW)
    expect(r).toMatchObject({ ok: true, claimed_by: 'cody', claimed_at: NOW, claim_expires_at: NOW + 7200, renewed: false, took_over_from: null })
    expect(getKanbanCard('c1')).toMatchObject({ claimed_by: 'cody', claimed_at: NOW, claim_expires_at: NOW + 7200 })
  })

  it('refuses a second agent while the claim is live, naming the holder', () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    claimKanbanCard('c1', 'cody', 7200, NOW)
    const r = claimKanbanCard('c1', 'samu', 7200, NOW + 10)
    expect(r).toMatchObject({ ok: false, reason: 'held', claimed_by: 'cody', claim_expires_at: NOW + 7200 })
    expect(getKanbanCard('c1')!.claimed_by).toBe('cody')
  })

  it('same agent re-claiming is a renewal: expiry moves, claimed_at stays (case-insensitive name)', () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    claimKanbanCard('c1', 'cody', 7200, NOW)
    const r = claimKanbanCard('c1', 'Cody', 7200, NOW + 3600)
    expect(r).toMatchObject({ ok: true, renewed: true, claimed_at: NOW, claim_expires_at: NOW + 3600 + 7200, took_over_from: null })
  })

  it('an expired claim can be taken over, and the previous holder is reported', () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    claimKanbanCard('c1', 'cody', 60, NOW)
    expect(isKanbanClaimActive(getKanbanCard('c1'), NOW + 59)).toBe(true)
    expect(isKanbanClaimActive(getKanbanCard('c1'), NOW + 60)).toBe(false)
    const r = claimKanbanCard('c1', 'samu', 7200, NOW + 60)
    expect(r).toMatchObject({ ok: true, claimed_by: 'samu', claimed_at: NOW + 60, renewed: false, took_over_from: 'cody' })
  })

  it('refuses done, archived and unknown cards', () => {
    createKanbanCard({ id: 'd', title: 'Done' })
    moveKanbanCard('d', 'done', 0)
    createKanbanCard({ id: 'a', title: 'Archived' })
    archiveKanbanCard('a')
    expect(claimKanbanCard('d', 'cody', 7200, NOW)).toMatchObject({ ok: false, reason: 'done' })
    expect(claimKanbanCard('a', 'cody', 7200, NOW)).toMatchObject({ ok: false, reason: 'archived' })
    expect(claimKanbanCard('nope', 'cody', 7200, NOW)).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('release: holder yes, stranger no, stranger after expiry yes, force yes', () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    claimKanbanCard('c1', 'cody', 7200, NOW)
    expect(releaseKanbanCardClaim('c1', 'samu', {}, NOW + 1)).toMatchObject({ ok: false, reason: 'held', claimed_by: 'cody' })
    expect(releaseKanbanCardClaim('c1', 'cody', {}, NOW + 1)).toEqual({ ok: true, released: true, previous: 'cody' })
    expect(getKanbanCard('c1')).toMatchObject({ claimed_by: null, claimed_at: null, claim_expires_at: null })
    // releasing an unclaimed card is a harmless no-op, not an error
    expect(releaseKanbanCardClaim('c1', 'cody', {}, NOW + 2)).toEqual({ ok: true, released: false, previous: null })

    claimKanbanCard('c1', 'cody', 60, NOW)
    expect(releaseKanbanCardClaim('c1', 'samu', {}, NOW + 61)).toMatchObject({ ok: true, released: true, previous: 'cody' })

    claimKanbanCard('c1', 'cody', 7200, NOW)
    expect(releaseKanbanCardClaim('c1', 'samu', { force: true }, NOW + 1)).toMatchObject({ ok: true, released: true })
    expect(releaseKanbanCardClaim('nope', 'cody', {}, NOW)).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('closing the card releases the claim for EVERY writer, raw SQL included', () => {
    createKanbanCard({ id: 'm', title: 'Moved' })
    createKanbanCard({ id: 'r', title: 'Raw' })
    createKanbanCard({ id: 'x', title: 'Archived' })
    createKanbanCard({ id: 'w', title: 'Waiting' })
    for (const id of ['m', 'r', 'x', 'w']) claimKanbanCard(id, 'cody')
    moveKanbanCard('m', 'done', 0)
    getDb().prepare("UPDATE kanban_cards SET status='done' WHERE id='r'").run()
    archiveKanbanCard('x')
    moveKanbanCard('w', 'waiting', 0)
    expect(getKanbanCard('m')!.claimed_by).toBeNull()
    expect(getKanbanCard('r')!.claimed_by).toBeNull()
    expect(getKanbanCard('x')!.claimed_by).toBeNull()
    // entering waiting is the documented handoff state: the claim goes with it
    expect(getKanbanCard('w')!.claimed_by).toBeNull()
  })

  it('entering testing releases; in_progress re-saves, planned -> in_progress and renewals keep the lock', () => {
    createKanbanCard({ id: 't', title: 'To review' })
    createKanbanCard({ id: 'k', title: 'Kept' })
    claimKanbanCard('t', 'cody')
    claimKanbanCard('k', 'cody')
    moveKanbanCard('t', 'in_progress', 0)
    moveKanbanCard('t', 'testing', 0)
    expect(getKanbanCard('t')!.claimed_by).toBeNull()

    moveKanbanCard('k', 'in_progress', 0)
    moveKanbanCard('k', 'in_progress', 5)            // reorder within in_progress
    updateKanbanCard('k', { status: 'in_progress', title: 'Kept (renamed)' })
    claimKanbanCard('k', 'cody')                      // renewal
    expect(getKanbanCard('k')!.claimed_by).toBe('cody')
  })

  it('reassigning to someone other than the holder releases; to the holder, or an echo, keeps', () => {
    createKanbanCard({ id: 'a', title: 'A', assignee: 'cody' })
    createKanbanCard({ id: 'b', title: 'B', assignee: 'samu' })
    createKanbanCard({ id: 'c', title: 'C', assignee: 'cody' })
    for (const id of ['a', 'b', 'c']) claimKanbanCard(id, 'cody')
    updateKanbanCard('a', { assignee: 'marveen' })
    updateKanbanCard('b', { assignee: 'Cody' })       // to the holder (case-insensitive)
    updateKanbanCard('c', { assignee: 'cody', title: 'C2' }) // echo, no real change
    expect(getKanbanCard('a')!.claimed_by).toBeNull()
    expect(getKanbanCard('b')!.claimed_by).toBe('cody')
    expect(getKanbanCard('c')!.claimed_by).toBe('cody')
    // raw SQL reassignment is covered too
    claimKanbanCard('c', 'cody')
    getDb().prepare("UPDATE kanban_cards SET assignee='samu' WHERE id='c'").run()
    expect(getKanbanCard('c')!.claimed_by).toBeNull()
  })
})

describe('the documented handoff: the new assignee can claim', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('blocked agent reassigns + sets waiting (instruction steps b, c): the delegator claims with 200', async () => {
    createKanbanCard({ id: 'h', title: 'Handoff', assignee: 'cody' })
    expect((await route('POST', '/api/kanban/h/claim', { agent: 'cody' })).status).toBe(200)
    await route('POST', '/api/kanban/h/move', { status: 'in_progress', actor: 'cody' })
    await route('POST', '/api/kanban/h/comments', { author: 'cody', content: 'marveen: dontes kell X-rol' })
    expect((await route('PUT', '/api/kanban/h', { assignee: 'marveen' })).status).toBe(200)
    await route('POST', '/api/kanban/h/move', { status: 'waiting', actor: 'cody' })
    const r = await route('POST', '/api/kanban/h/claim', { agent: 'marveen' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ claimed_by: 'marveen', took_over_from: null })
  })

  it('reassignment alone (card stays in_progress) already frees the card for the new assignee', async () => {
    createKanbanCard({ id: 'h', title: 'Handoff', assignee: 'cody' })
    await route('POST', '/api/kanban/h/claim', { agent: 'cody' })
    await route('PUT', '/api/kanban/h', { assignee: 'samu' })
    expect((await route('POST', '/api/kanban/h/claim', { agent: 'samu' })).status).toBe(200)
  })

  it('a review close to testing frees the card for the reviewer', async () => {
    createKanbanCard({ id: 'h', title: 'Review me', assignee: 'cody' })
    await route('POST', '/api/kanban/h/claim', { agent: 'cody' })
    await route('POST', '/api/kanban/h/move', { status: 'testing', actor: 'cody' })
    expect((await route('POST', '/api/kanban/h/claim', { agent: 'marveen' })).status).toBe(200)
  })
})

describe('claim is race-free across connections (the double-pickup guarantee)', () => {
  let dir: string
  let dbFile: string
  const betterSqlitePath = createRequire(import.meta.url).resolve('better-sqlite3')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-claim-race-'))
    dbFile = join(dir, 'race.db')
    initDatabase(dbFile)
    createKanbanCard({ id: 'hot', title: 'Contended card' })
  })
  afterEach(() => {
    try { getDb().close() } catch { /* already closed */ }
    initDatabase(':memory:')
    rmSync(dir, { recursive: true, force: true })
  })

  // N workers, each with its OWN better-sqlite3 connection to the same file,
  // all parked on a shared barrier and released at the same instant to run the
  // given statement once as a different agent. Returns the per-worker `changes`.
  //
  // checkThenWrite: the worker first READS claimed_by on its own connection,
  // then waits on a second barrier until every worker has read, and only then
  // writes (if it read the card as free). That is the check-then-write shape a
  // claim without the compare-and-set would have, with the interleaving that
  // breaks it forced rather than hoped for.
  async function race(
    sql: string, workers: number, checkThenWrite = false,
  ): Promise<Array<{ agent: string; changes: number }>> {
    const flag = new Int32Array(new SharedArrayBuffer(4))
    const readFlag = new Int32Array(new SharedArrayBuffer(4))
    const code = `
      const { parentPort, workerData } = require('node:worker_threads')
      const Database = require(workerData.lib)
      const db = new Database(workerData.file)
      db.pragma('busy_timeout = 10000')
      const stmt = db.prepare(workerData.sql)
      parentPort.postMessage({ ready: true })
      Atomics.wait(workerData.flag, 0, 0)
      let changes = 0
      const params = { id: 'hot', agent: workerData.agent, now: workerData.now, expires: workerData.now + 7200 }
      if (workerData.checkThenWrite) {
        const row = db.prepare("SELECT claimed_by FROM kanban_cards WHERE id = 'hot'").get()
        parentPort.postMessage({ read: true })
        Atomics.wait(workerData.readFlag, 0, 0)
        if (row.claimed_by === null) changes = stmt.run(params).changes
      } else {
        changes = stmt.run(params).changes
      }
      db.close()
      parentPort.postMessage({ agent: workerData.agent, changes })
    `
    const ready: Promise<void>[] = []
    const read: Promise<void>[] = []
    const done: Promise<{ agent: string; changes: number }>[] = []
    const ws: Worker[] = []
    for (let i = 0; i < workers; i++) {
      const w = new Worker(code, {
        eval: true,
        workerData: { lib: betterSqlitePath, file: dbFile, sql, agent: `agent-${i}`, now: NOW, flag, readFlag, checkThenWrite },
      })
      ws.push(w)
      let onReady!: () => void
      let onRead!: () => void
      ready.push(new Promise<void>((r) => { onReady = r }))
      read.push(new Promise<void>((r) => { onRead = r }))
      done.push(new Promise((resolve, reject) => {
        w.on('error', reject)
        w.on('message', (m) => {
          if (m.ready) onReady()
          else if (m.read) onRead()
          else resolve(m)
        })
      }))
    }
    await Promise.all(ready)
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
    if (checkThenWrite) {
      await Promise.all(read)
      Atomics.store(readFlag, 0, 1)
      Atomics.notify(readFlag, 0)
    }
    const results = await Promise.all(done)
    await Promise.all(ws.map((w) => w.terminate()))
    return results
  }

  const freeHot = () =>
    getDb().prepare("UPDATE kanban_cards SET claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL WHERE id='hot'").run()

  it('8 simultaneous claimers on separate connections: exactly one wins, and the row names it', async () => {
    for (let round = 0; round < 3; round++) {
      freeHot()
      const results = await race(KANBAN_CLAIM_SQL, 8)
      const winners = results.filter((r) => r.changes === 1)
      expect(winners).toHaveLength(1)
      expect(getKanbanCard('hot')!.claimed_by).toBe(winners[0].agent)
    }
  })

  it('control: a check-then-write over the same connections double-claims; the compare-and-set does not', async () => {
    // A plain UPDATE guarded only by an earlier SELECT: every worker read the
    // card as free before any of them wrote, so several "win". This shows the
    // harness really runs the workers on separate connections whose reads and
    // writes interleave, and that what saves the claim is the WHERE in the one
    // statement, not the harness serialising the workers.
    const unguarded = 'UPDATE kanban_cards SET claimed_by = @agent, claimed_at = @now, claim_expires_at = @expires WHERE id = @id'
    freeHot()
    const naive = await race(unguarded, 8, true)
    expect(naive.filter((r) => r.changes === 1).length).toBeGreaterThan(1)

    // Same forced interleaving, the real statement: still exactly one winner.
    freeHot()
    const guarded = await race(KANBAN_CLAIM_SQL, 8, true)
    const winners = guarded.filter((r) => r.changes === 1)
    expect(winners).toHaveLength(1)
    expect(getKanbanCard('hot')!.claimed_by).toBe(winners[0].agent)
  })
})

describe('claim/release HTTP routes', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('POST /claim: 200 for the first agent, 409 with the holder for the second', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    const a = await route('POST', '/api/kanban/c1/claim', { agent: 'cody' })
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ ok: true, id: 'c1', claimed_by: 'cody', renewed: false })
    expect(a.body.claim_expires_at - a.body.claimed_at).toBe(KANBAN_CLAIM_DEFAULT_TTL_SEC)

    const b = await route('POST', '/api/kanban/c1/claim', { agent: 'samu' })
    expect(b.status).toBe(409)
    expect(b.body).toMatchObject({ ok: false, reason: 'held', claimed_by: 'cody' })
    expect(b.body.error).toContain('cody')
  })

  it('two claims fired in parallel through the route: exactly one 200', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    const [x, y] = await Promise.all([
      route('POST', '/api/kanban/c1/claim', { agent: 'cody' }),
      route('POST', '/api/kanban/c1/claim', { agent: 'samu' }),
    ])
    expect([x.status, y.status].sort()).toEqual([200, 409])
  })

  it('accepts `actor` as an alias, and ttl_seconds within bounds', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    const r = await route('POST', '/api/kanban/c1/claim', { actor: 'cody', ttl_seconds: 600 })
    expect(r.status).toBe(200)
    expect(r.body.claim_expires_at - r.body.claimed_at).toBe(600)
  })

  it('400 without an agent, 400 on a bad ttl, 404 on an unknown card, 409 on a done card', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    expect((await route('POST', '/api/kanban/c1/claim', {})).status).toBe(400)
    expect((await route('POST', '/api/kanban/c1/claim')).status).toBe(400)
    // a JSON body that is not an object is a 400 on both doors, never a 500
    for (const bad of [null, ['cody'], 'cody', 7]) {
      expect((await route('POST', '/api/kanban/c1/claim', bad)).status).toBe(400)
      expect((await route('POST', '/api/kanban/c1/release', bad)).status).toBe(400)
    }
    expect((await route('POST', '/api/kanban/c1/claim', { agent: 'cody', ttl_seconds: 5 })).status).toBe(400)
    expect((await route('POST', '/api/kanban/c1/claim', { agent: 'cody', ttl_seconds: 'soon' })).status).toBe(400)
    expect((await route('POST', '/api/kanban/nope/claim', { agent: 'cody' })).status).toBe(404)
    moveKanbanCard('c1', 'done', 0)
    const done = await route('POST', '/api/kanban/c1/claim', { agent: 'cody' })
    expect(done.status).toBe(409)
    expect(done.body.reason).toBe('done')
  })

  it('an expired claim taken over leaves a system comment on the card', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    claimKanbanCard('c1', 'cody', 60, Math.floor(Date.now() / 1000) - 120)
    const r = await route('POST', '/api/kanban/c1/claim', { agent: 'samu' })
    expect(r.status).toBe(200)
    expect(r.body.took_over_from).toBe('cody')
    const comments = getKanbanComments('c1')
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ author: 'system' })
    expect(comments[0].content).toContain('cody')
    expect(comments[0].content).toContain('samu')
  })

  it('POST /release: holder 200, stranger 409, force 200', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    await route('POST', '/api/kanban/c1/claim', { agent: 'cody' })
    const stranger = await route('POST', '/api/kanban/c1/release', { agent: 'samu' })
    expect(stranger.status).toBe(409)
    expect(stranger.body.claimed_by).toBe('cody')
    const holder = await route('POST', '/api/kanban/c1/release', { agent: 'cody' })
    expect(holder.status).toBe(200)
    expect(holder.body).toMatchObject({ ok: true, released: true, previous: 'cody' })
    await route('POST', '/api/kanban/c1/claim', { agent: 'cody' })
    const forced = await route('POST', '/api/kanban/c1/release', { agent: 'operator', force: true })
    expect(forced.status).toBe(200)
    expect(getKanbanCard('c1')!.claimed_by).toBeNull()
  })

  it('the dashboard whole-card PUT carrying claim fields still succeeds and cannot write the claim', async () => {
    createKanbanCard({ id: 'c1', title: 'One', assignee: 'cody' })
    claimKanbanCard('c1', 'cody')
    const card = getKanbanCard('c1')!
    // A title edit through the whole-card send: the claim fields ride along
    // (and are tampered with) but are never written.
    const r = await route('PUT', '/api/kanban/c1', { ...card, title: 'One (edited)', claimed_by: 'samu', claim_expires_at: 1, labels: [], blockers: [] })
    expect(r.status).toBe(200)
    const after = getKanbanCard('c1')!
    expect(after.title).toBe('One (edited)')
    expect(after.claimed_by).toBe('cody')
    expect(after.claim_expires_at).toBe(card.claim_expires_at)
  })

  it('moving a card another agent holds to in_progress succeeds but carries claim_warning', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    claimKanbanCard('c1', 'cody')
    const other = await route('POST', '/api/kanban/c1/move', { status: 'in_progress', actor: 'samu' })
    expect(other.status).toBe(200)
    expect(other.body.ok).toBe(true)
    expect(other.body.claim_warning).toContain('cody')
    moveKanbanCard('c1', 'planned', 0)
    const own = await route('POST', '/api/kanban/c1/move', { status: 'in_progress', actor: 'cody' })
    expect(own.body.claim_warning).toBeUndefined()
  })

  it('parseClaimTtl: default, bounds, integers only', () => {
    expect(parseClaimTtl(undefined)).toBe(KANBAN_CLAIM_DEFAULT_TTL_SEC)
    expect(parseClaimTtl(60)).toBe(60)
    expect(parseClaimTtl('3600')).toBe(3600)
    expect(parseClaimTtl(59)).toBeNull()
    expect(parseClaimTtl(86401)).toBeNull()
    expect(parseClaimTtl(90.5)).toBeNull()
    expect(parseClaimTtl('')).toBeNull()
  })
})

describe('dependency unblock on done', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a waiting card goes back to planned only when its LAST open blocker closes', async () => {
    createKanbanCard({ id: 'a', title: 'Blocked' })
    createKanbanCard({ id: 'b', title: 'First blocker' })
    createKanbanCard({ id: 'c', title: 'Second blocker' })
    moveKanbanCard('a', 'waiting', 0)
    addCardBlocker('a', 'b')
    addCardBlocker('a', 'c')

    const first = await route('POST', '/api/kanban/b/move', { status: 'done', actor: 'cody' })
    expect(first.body.unblocked).toBeUndefined()
    expect(getKanbanCard('a')!.status).toBe('waiting')

    const second = await route('PUT', '/api/kanban/c', { status: 'done', actor: 'samu' })
    expect(second.status).toBe(200)
    expect(second.body.unblocked.map((u: { id: string }) => u.id)).toEqual(['a'])
    expect(getKanbanCard('a')!.status).toBe('planned')
    const comments = getKanbanComments('a')
    expect(comments).toHaveLength(1)
    expect(comments[0].author).toBe('system')
    expect(comments[0].content).toContain('Second blocker')
    expect(comments[0].content).toContain('waiting -> planned')
  })

  it('leaves planned and in_progress dependents alone, and an unfinished archived blocker still blocks', () => {
    createKanbanCard({ id: 'p', title: 'Planned dep' })
    createKanbanCard({ id: 'i', title: 'Running dep' })
    createKanbanCard({ id: 'w', title: 'Waiting dep' })
    createKanbanCard({ id: 'b', title: 'Blocker' })
    createKanbanCard({ id: 'z', title: 'Archived unfinished blocker' })
    moveKanbanCard('i', 'in_progress', 0)
    moveKanbanCard('w', 'waiting', 0)
    for (const dep of ['p', 'i', 'w']) addCardBlocker(dep, 'b')
    addCardBlocker('w', 'z')
    archiveKanbanCard('z')
    moveKanbanCard('b', 'done', 0)
    expect(unblockDependentsOf('b')).toEqual([])
    expect(getKanbanCard('p')!.status).toBe('planned')
    expect(getKanbanCard('i')!.status).toBe('in_progress')
    expect(getKanbanCard('w')!.status).toBe('waiting')
    expect(getKanbanComments('p')).toHaveLength(0)
  })

  it('the unblock comment does not call the card free when a live claim remains', () => {
    createKanbanCard({ id: 'a', title: 'Blocked' })
    createKanbanCard({ id: 'f', title: 'Free one' })
    createKanbanCard({ id: 'b', title: 'Blocker' })
    moveKanbanCard('a', 'waiting', 0)
    moveKanbanCard('f', 'waiting', 0)
    addCardBlocker('a', 'b')
    addCardBlocker('f', 'b')
    claimKanbanCard('a', 'samu')     // reserved while waiting: kept on purpose
    moveKanbanCard('b', 'done', 0)
    expect(unblockDependentsOf('b').map((u) => u.id).sort()).toEqual(['a', 'f'])
    const held = getKanbanComments('a')[0].content
    expect(held).toContain('samu foglalja')
    expect(held).not.toContain('felvehető')
    expect(getKanbanComments('f')[0].content).toContain('felvehető')
  })

  it('does nothing for a card that is not done', () => {
    createKanbanCard({ id: 'a', title: 'Blocked' })
    createKanbanCard({ id: 'b', title: 'Blocker' })
    moveKanbanCard('a', 'waiting', 0)
    addCardBlocker('a', 'b')
    expect(unblockDependentsOf('b')).toEqual([])
    expect(getKanbanCard('a')!.status).toBe('waiting')
  })

  it('re-saving an already-done card does not re-run the unblock', async () => {
    createKanbanCard({ id: 'a', title: 'Blocked' })
    createKanbanCard({ id: 'b', title: 'Blocker' })
    moveKanbanCard('b', 'done', 0)
    moveKanbanCard('a', 'waiting', 0)
    addCardBlocker('a', 'b')
    const r = await route('POST', '/api/kanban/b/move', { status: 'done', sort_order: 5 })
    expect(r.body.unblocked).toBeUndefined()
    expect(getKanbanCard('a')!.status).toBe('waiting')
  })
})

describe('done evidence (soft)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('warns when a card closes without a comment since it went in_progress, never refuses', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    moveKanbanCard('c1', 'in_progress', 0, 'cody')
    const r = await route('POST', '/api/kanban/c1/move', { status: 'done', actor: 'cody' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.evidence_warning).toContain('/api/kanban/c1/comments')
    expect(getKanbanCard('c1')!.status).toBe('done')
  })

  it('no warning when an agent comment exists since in_progress; system comments do not count', async () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    createKanbanCard({ id: 'c2', title: 'Two' })
    moveKanbanCard('c1', 'in_progress', 0, 'cody')
    moveKanbanCard('c2', 'in_progress', 0, 'cody')
    addKanbanComment('c1', 'cody', 'Kész: teszt zöld, commit abc123')
    addKanbanComment('c2', 'system', 'dispatch note')
    expect(getDoneEvidence('c1')!.comments).toBe(1)
    expect(getDoneEvidence('c2')!.comments).toBe(0)
    const ok = await route('POST', '/api/kanban/c1/move', { status: 'done', actor: 'cody' })
    expect(ok.body.evidence_warning).toBeUndefined()
    const warn = await route('PUT', '/api/kanban/c2', { status: 'done' })
    expect(warn.body.evidence_warning).toBeDefined()
  })

  it('a comment from BEFORE the latest in_progress spell is not evidence for this one', () => {
    createKanbanCard({ id: 'c1', title: 'One' })
    const db = getDb()
    db.prepare('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)').run('c1', 'cody', 'old note', NOW - 100)
    db.prepare("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES ('c1', 'planned', 'in_progress', 'cody', ?)").run(NOW)
    expect(getDoneEvidence('c1')).toEqual({ since: NOW, comments: 0 })
  })
})

describe('schema migration on an existing database', () => {
  it('adds the claim columns to a pre-claim kanban_cards table and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-claim-mig-'))
    const file = join(dir, 'old.db')
    try {
      const old = new Database(file)
      old.exec(`
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
          assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
          project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
          parent_id TEXT REFERENCES kanban_cards(id), dispatched_at INTEGER
        );
        INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES ('legacy', 'Old card', 'in_progress', 1, 1);
      `)
      old.close()
      initDatabase(file)
      const cols = (getDb().prepare('PRAGMA table_info(kanban_cards)').all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toEqual(expect.arrayContaining(['claimed_by', 'claimed_at', 'claim_expires_at']))
      expect(getKanbanCard('legacy')).toMatchObject({ title: 'Old card', status: 'in_progress', claimed_by: null })
      expect(claimKanbanCard('legacy', 'cody').ok).toBe(true)
      // idempotent: a second boot on the migrated file is a no-op
      initDatabase(file)
      expect(getKanbanCard('legacy')!.claimed_by).toBe('cody')
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ensureKanbanClaimSchema: a failed ALTER never leaves a trigger over a missing column', () => {
  const LEGACY = `
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
      assignee TEXT, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES ('k', 'Card', 'in_progress', 1, 1);
  `
  const claimTriggers = (d: Database.Database) =>
    (d.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'kanban_cards_claim_%'").all() as Array<{ name: string }>)
      .map((r) => r.name).sort()

  // A real connection whose ALTER TABLE fails the way a disk/lock/corruption
  // error would; every other statement goes through untouched.
  function withFailingAlter(d: Database.Database): Database.Database {
    return new Proxy(d, {
      get(target, prop, receiver) {
        if (prop === 'exec') {
          return (sql: string) => {
            if (/^\s*ALTER TABLE/i.test(sql)) throw new Error('SQLITE_IOERR: disk I/O error')
            return target.exec(sql)
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  }

  it('ALTER failure: returns false, creates no claim trigger, and status updates keep working', () => {
    const d = new Database(':memory:')
    try {
      d.exec(LEGACY)
      expect(ensureKanbanClaimSchema(withFailingAlter(d))).toBe(false)
      expect(claimTriggers(d)).toEqual([])
      // the whole point: the board's status writes are not broken by a trigger
      // that references a column which never arrived
      expect(() => d.prepare("UPDATE kanban_cards SET status='done' WHERE id='k'").run()).not.toThrow()
      expect(() => d.prepare("UPDATE kanban_cards SET assignee='x' WHERE id='k'").run()).not.toThrow()
    } finally {
      d.close()
    }
  })

  it('missing columns are added and the triggers created; a second run does not ALTER again', () => {
    const d = new Database(':memory:')
    try {
      d.exec(LEGACY)
      expect(ensureKanbanClaimSchema(d)).toBe(true)
      expect(claimTriggers(d)).toEqual(['kanban_cards_claim_clears_on_reassign', 'kanban_cards_claim_clears_on_status'])
      // columns present now: an ALTER on the second run would throw through the proxy
      expect(ensureKanbanClaimSchema(withFailingAlter(d))).toBe(true)
      expect(claimTriggers(d)).toHaveLength(2)
    } finally {
      d.close()
    }
  })

  it('an older trigger definition is replaced on the next boot, not kept or stacked', () => {
    const d = new Database(':memory:')
    try {
      d.exec(LEGACY)
      ensureKanbanClaimSchema(d)
      d.exec('DROP TRIGGER kanban_cards_claim_clears_on_status')
      d.exec(`CREATE TRIGGER kanban_cards_claim_clears_on_status AFTER UPDATE OF status ON kanban_cards
              BEGIN SELECT 1; END`)
      ensureKanbanClaimSchema(d)
      expect(claimTriggers(d)).toEqual(['kanban_cards_claim_clears_on_reassign', 'kanban_cards_claim_clears_on_status'])
      const sql = (d.prepare("SELECT sql FROM sqlite_master WHERE name = 'kanban_cards_claim_clears_on_status'").get() as { sql: string }).sql
      expect(sql).toContain("'testing'")
    } finally {
      d.close()
    }
  })
})
