import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const binDir = mkdtempSync(join(tmpdir(), 'fake-tmux-bin-'))
const ORIG_PATH = process.env.PATH
writeFileSync(join(binDir, 'tmux'), `#!/bin/sh
printf 'start %s\\n' "$1" >> "$FAKE_TMUX_LOG"
case "$1" in
  has-session)
    if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
    if [ -n "$FAKE_NOISE" ]; then head -c 2000000 /dev/zero; fi
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"
    if [ -n "$FAKE_ALIVE" ]; then exit 0; fi
    exit 1 ;;
  capture-pane)
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"
    if [ -n "$FAKE_ALIVE" ] && [ -z "$FAKE_CAPTURE_FAIL" ]; then printf 'PANE'; exit 0; fi
    echo "can't find session" >&2; exit 1 ;;
  *)
    printf 'end %s\\n' "$1" >> "$FAKE_TMUX_LOG"; exit 0 ;;
esac
`)
chmodSync(join(binDir, 'tmux'), 0o755)
process.env.PATH = `${binDir}:${ORIG_PATH}`

const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
const { MAIN_AGENT_ID } = await import('../config.js')
await import('../web/main-agent.js')

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}
const STALL_MAX_MS = 750

let logPath = ''
let logDir = ''
const open: Array<{ req: EventEmitter }> = []

function log(): string[] {
  return readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
}

async function openStream(name: string) {
  const req = Object.assign(new EventEmitter(), { headers: {}, socket: {} })
  const events: string[] = []
  const out = { status: 0, body: '' as string }
  const res: any = new Writable({
    write(chunk, _enc, cb) { events.push(chunk.toString()); cb() },
  })
  res.writeHead = (status: number) => { out.status = status; return res }
  res.setHeader = () => {}
  const origEnd = res.end.bind(res)
  res.end = (b?: any) => { if (b) out.body = String(b); return origEnd() }
  const url = new URL(`http://localhost/api/agents/${encodeURIComponent(name)}/pane/stream`)
  await tryHandleAgentTerminal({ req, res, path: url.pathname, method: 'GET', url } as any)
  const s = { req, res, events, get status() { return out.status } }
  open.push(s)
  return s
}

function openStreamNoAwait(name: string) {
  const req = Object.assign(new EventEmitter(), { headers: {}, socket: {} })
  const events: string[] = []
  const res: any = new Writable({
    write(chunk, _enc, cb) { events.push(chunk.toString()); cb() },
  })
  const heads: number[] = []
  res.writeHead = (status: number) => { heads.push(status); return res }
  res.setHeader = () => {}
  const url = new URL(`http://localhost/api/agents/${encodeURIComponent(name)}/pane/stream`)
  const done = tryHandleAgentTerminal({ req, res, path: url.pathname, method: 'GET', url } as any)
  const s = { req, res, events, heads, done }
  open.push(s)
  return s
}

function parsed(events: string[]): any[] {
  return events.filter(e => e.startsWith('data: ')).map(e => JSON.parse(e.slice(6).trim()))
}

const firstEvent = (events: string[]) =>
  vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 50 })

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'fake-tmux-log-'))
  logPath = join(logDir, 'log')
  writeFileSync(logPath, '')
  process.env.FAKE_TMUX_LOG = logPath
})

afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_ALIVE
  delete process.env.FAKE_NOISE
  delete process.env.FAKE_CAPTURE_FAIL
  for (const s of open.splice(0)) s.req.emit('close')
  rmSync(logDir, { recursive: true, force: true })
})

afterAll(() => {
  process.env.PATH = ORIG_PATH
  rmSync(binDir, { recursive: true, force: true })
})

describe('agent-terminal async liveness probe', () => {
  it('instrument positive control: sync busy-wait is detected', async () => {
    const ms = await stallDuring(async () => { const t = Date.now(); while (Date.now() - t < 300) { /* spin */ } })
    expect(ms).toBeGreaterThanOrEqual(250)
  })

  it('a dead main session streams running:false without stalling', async () => {
    process.env.FAKE_SLEEP = '1.5'
    let s: Awaited<ReturnType<typeof openStream>> | undefined
    const ms = await stallDuring(async () => {
      s = await openStream(MAIN_AGENT_ID)
      await firstEvent(s.events)
    })
    expect(s!.status).toBe(200)
    expect(parsed(s!.events)[0]).toEqual({ pane: '', running: false })
    expect(ms).toBeLessThan(STALL_MAX_MS)
    s!.req.emit('close')
  })

  it('a has-session probe that outlives its 3 s timeout counts as not running', async () => {
    // The fake would answer "alive" -- but only after 6 s, past the 3 s the probe
    // allows, so the answer must never arrive. FAKE_CAPTURE_FAIL makes the tick's
    // capture-pane fail too, so the stream's `running` comes from a has-session
    // probe rather than from a successful capture (resolveTarget probes once, the
    // tick's fallback then probes again: two probes, each killed near its 3 s).
    process.env.FAKE_ALIVE = '1'
    process.env.FAKE_SLEEP = '6'
    process.env.FAKE_CAPTURE_FAIL = '1'
    const t0 = Date.now()
    const s = await openStream(MAIN_AGENT_ID)
    await firstEvent(s.events)
    const took = Date.now() - t0
    expect(s.status).toBe(200)
    expect(parsed(s.events)[0]).toEqual({ pane: '', running: false })
    // ~6 s for two killed probes, not the ~12 s waiting them out would take
    expect(took).toBeGreaterThanOrEqual(5500)
    expect(took).toBeLessThan(10_000)
    expect(log()).toContain('start has-session')
    expect(log()).not.toContain('end has-session')
    s.req.emit('close')
  }, 15_000)

  it('a live main session streams the pane and the tick does not probe', async () => {
    process.env.FAKE_ALIVE = '1'
    const s = await openStream(MAIN_AGENT_ID)
    await firstEvent(s.events)
    expect(parsed(s.events)[0]).toEqual({ pane: 'PANE', running: true })
    s.req.emit('close')
    await sleep(100)
    const l = log()
    expect(l.filter(x => x === 'start has-session')).toHaveLength(1)
    expect(l.filter(x => x === 'start capture-pane').length).toBeGreaterThanOrEqual(1)
  })

  it('a slow probe in flight blocks the next tick from starting another', async () => {
    process.env.FAKE_SLEEP = '1'
    const s = await openStream(MAIN_AGENT_ID)
    await sleep(2500)
    s.req.emit('close')
    let cur = 0, max = 0
    for (const l of log()) {
      if (l === 'start has-session') max = Math.max(max, ++cur)
      else if (l === 'end has-session') cur--
    }
    expect(max).toBe(1)
    expect(log().filter(x => x === 'start has-session').length).toBeGreaterThanOrEqual(2)
  })

  it('closing the request stops the ticks', async () => {
    process.env.FAKE_ALIVE = '1'
    const s = await openStream(MAIN_AGENT_ID)
    await firstEvent(s.events)
    s.req.emit('close')
    await sleep(150)
    const n = log().length
    await sleep(1500)
    expect(log().length).toBe(n)
  })

  it('a client that leaves while the target is being resolved starts no ticks', async () => {
    process.env.FAKE_SLEEP = '1'
    const s = openStreamNoAwait(MAIN_AGENT_ID)
    await vi.waitFor(() => expect(log()).toContain('start has-session'), { timeout: 5000, interval: 20 })
    s.req.emit('close')
    await s.done
    await sleep(1500)
    expect(log().filter(l => l === 'start capture-pane')).toHaveLength(0)
    expect(s.events).toHaveLength(0)
    expect(s.heads).toEqual([]) // nothing is answered to a client that has gone
  })

  it('a probe whose child writes output still reads a successful exit as running', async () => {
    process.env.FAKE_NOISE = '1'
    process.env.FAKE_ALIVE = '1'
    process.env.FAKE_CAPTURE_FAIL = '1'
    const s = await openStream(MAIN_AGENT_ID)
    await firstEvent(s.events)
    expect(parsed(s.events)[0]).toEqual({ pane: '', running: true })
  })
})
