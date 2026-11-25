import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The REAL reader (plugins/worksource/server.mjs) over stdio, as in worksource-reader-scheduler.test.ts, with a short
// ack timeout. The rules: a confirmed (work_received) item is not handed over again while the agent works on it, but
// only for the hold (a turn can end without work_complete), and a new confirmation restarts the hold; an unconfirmed
// one is handed over again after the ack timeout (a first delivery can be dropped without a trace); and a restart
// still re-delivers an item in active/, confirmed or not.

type Msg = { id?: number; method?: string; params?: { meta?: Record<string, string> }; result?: { isError?: boolean } }

const serverPath = join(process.cwd(), 'plugins', 'worksource', 'server.mjs')
const ACK_MS = 600
const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterAll(() => {
  for (const c of children) c.kill()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'worksource-redeliver-'))
  mkdirSync(join(root, 'pending'), { recursive: true })
  roots.push(root)
  return root
}

async function start(root: string, holdMs = ACK_MS * 8) {
  const child = spawn('node', [serverPath], {
    env: { ...process.env, WORKSOURCE_AGENT_ID: 'redeliver-test', WORKSOURCE_DIR: root, WORKSOURCE_POLL_MS: '100', WORKSOURCE_ACK_TIMEOUT_MS: String(ACK_MS), WORKSOURCE_RECEIVED_HOLD_MS: String(holdMs) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const inbox: Msg[] = []
  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) { try { inbox.push(JSON.parse(line)) } catch { /* framing noise */ } }
    }
  })
  let nextId = 1
  const send = (msg: unknown): void => { child.stdin.write(JSON.stringify(msg) + '\n') }
  const waitFor = (pred: (m: Msg) => boolean, what: string, ms = 8_000): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = setInterval(() => {
        const hit = inbox.find(pred)
        if (hit) { clearInterval(tick); resolve(hit) } else if (Date.now() - t0 > ms) { clearInterval(tick); reject(new Error(`timeout waiting for ${what}`)) }
      }, 25)
    })
  const call = async (name: string, args: Record<string, unknown>): Promise<Msg> => {
    const id = ++nextId
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    return waitFor((m) => m.id === id, `${name} result`)
  }
  const deliveries = (workId: string): number =>
    inbox.filter((m) => m.method === 'notifications/claude/channel' && m.params?.meta?.work_id === workId).length
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  await waitFor((m) => m.id === 1, 'initialize result')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const delivered = (workId: string) =>
    waitFor((m) => m.method === 'notifications/claude/channel' && m.params?.meta?.work_id === workId, `delivery of ${workId}`)
  const deliveredTimes = (workId: string, n: number, ms: number) =>
    waitFor(() => deliveries(workId) >= n, `${n} deliveries of ${workId}`, ms)
  return { child, call, deliveries, delivered, deliveredTimes }
}

const queue = (root: string, id: string): void =>
  writeFileSync(join(root, 'pending', `${id}.json`), JSON.stringify({ content: 'BODY', meta: { from: 'peer', message_id: 1 } }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// A success has a result and no isError; a JSON-RPC error has no result at all, so check both.
const ok = async (p: Promise<Msg>): Promise<void> => {
  const r = await p
  expect(r.result).toBeDefined()
  expect(r.result?.isError).not.toBe(true)
}

describe('worksource re-delivery', () => {
  it('a confirmed item is NOT handed over again while the agent works on it', { timeout: 20_000 }, async () => {
    const root = newRoot()
    const s = await start(root)
    queue(root, 'msg-long')
    await s.delivered('msg-long')
    await ok(s.call('work_received', { work_id: 'msg-long' }))
    await sleep(ACK_MS * 4)
    expect(s.deliveries('msg-long')).toBe(1)
    expect(existsSync(join(root, 'active', 'msg-long.json'))).toBe(true)
    await ok(s.call('work_complete', { work_id: 'msg-long', result: 'ok' }))
    expect(existsSync(join(root, 'done', 'msg-long.json'))).toBe(true)
  })

  it('an unconfirmed item (a dropped first delivery) is handed over again', { timeout: 20_000 }, async () => {
    const root = newRoot()
    const s = await start(root)
    queue(root, 'msg-dropped')
    await s.delivered('msg-dropped')
    await sleep(ACK_MS * 3)
    expect(s.deliveries('msg-dropped')).toBeGreaterThanOrEqual(2)
  })

  it('a confirmed item comes back after the hold, and a new confirmation restarts the hold', { timeout: 20_000 }, async () => {
    const HOLD = 3000
    const root = newRoot()
    const s = await start(root, HOLD)
    queue(root, 'msg-abandoned')
    await s.delivered('msg-abandoned')
    await ok(s.call('work_received', { work_id: 'msg-abandoned' }))
    await sleep(HOLD * 2 / 3)
    expect(s.deliveries('msg-abandoned')).toBe(1) // past the ack timeout, inside the hold
    await ok(s.call('work_received', { work_id: 'msg-abandoned' }))
    await sleep(HOLD * 2 / 3)
    expect(s.deliveries('msg-abandoned')).toBe(1) // past the first hold, inside the restarted one
    await s.deliveredTimes('msg-abandoned', 2, HOLD * 2)
    await sleep(ACK_MS / 2)
    expect(s.deliveries('msg-abandoned')).toBe(2) // handed over once, not on every sweep
  })

  it('a completed id queued again is not held by its old confirmation', { timeout: 20_000 }, async () => {
    const root = newRoot()
    const s = await start(root)
    queue(root, 'msg-reused')
    await s.delivered('msg-reused')
    await ok(s.call('work_received', { work_id: 'msg-reused' }))
    await ok(s.call('work_complete', { work_id: 'msg-reused', result: 'ok' }))
    queue(root, 'msg-reused')
    await s.deliveredTimes('msg-reused', 3, ACK_MS * 4)
  })

  it('a fresh hand-off of a confirmed id gets the ack timeout, not the old hold', { timeout: 20_000 }, async () => {
    const root = newRoot()
    const s = await start(root)
    queue(root, 'msg-requeued')
    await s.delivered('msg-requeued')
    await ok(s.call('work_received', { work_id: 'msg-requeued' }))
    queue(root, 'msg-requeued')
    await s.deliveredTimes('msg-requeued', 3, ACK_MS * 4)
  })

  it('after a restart a confirmed item in active/ is delivered again', { timeout: 20_000 }, async () => {
    const root = newRoot()
    const first = await start(root)
    queue(root, 'msg-restart')
    await first.delivered('msg-restart')
    await ok(first.call('work_received', { work_id: 'msg-restart' }))
    first.child.kill()
    await new Promise((r) => first.child.once('exit', r))
    expect(existsSync(join(root, 'active', 'msg-restart.json'))).toBe(true)
    const second = await start(root)
    await second.delivered('msg-restart')
    expect(second.deliveries('msg-restart')).toBe(1)
  })

  it('work_received refuses an item that is not in flight, and a malformed id', { timeout: 20_000 }, async () => {
    const s = await start(newRoot())
    expect((await s.call('work_received', { work_id: 'msg-none' })).result?.isError).toBe(true)
    expect((await s.call('work_received', { work_id: '../x' })).result?.isError).toBe(true)
  })
})
