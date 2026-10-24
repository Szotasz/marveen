import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// The background-task routes talk to tmux on every poll tick (every 10 s per
// running task), on every task-detail GET, on DELETE, on spawn and on the
// startup sweep. A synchronous child-process call there freezes the whole
// dashboard event loop for as long as tmux takes to answer (up to the 3-5 s
// timeouts). These tests put a fake `tmux` first on PATH that sleeps before it
// answers, and measure the event-loop stall around each path: a sync call
// stalls the loop for the whole sleep, an async one does not.
//
// The fake tmux also keeps a session list, so capture-pane and kill-session
// fail on a session that does not exist -- the same answer the real tmux
// gives -- and the tests pin the behaviour the routes already had.

const SLEEP_S = 1.5
const STALL_MAX_MS = 750 // half the fake's sleep: a sync call stalls >= 1500 ms
const TIMEOUT_MS = 30 * 60 * 1000 // the route's per-task timeout
const POLL_MS = 10_000 // the route's poll interval

const FAKE_TMUX = `#!/bin/sh
d="$FAKE_TMUX_DIR"
sub="$1"
printf 'start %s\\n' "$*" >> "$d/calls.log"
if [ -f "$d/sleep" ]; then sleep "$(cat "$d/sleep")"; fi
target=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-t" ]; then target="$a"; fi
  prev="$a"
done
name=$(printf '%s' "$target" | sed -e 's/^=//' -e 's/:.*$//')
has() {
  [ -f "$d/sessions" ] || return 1
  while IFS= read -r l; do [ "$l" = "$1" ] && return 0; done < "$d/sessions"
  return 1
}
rc=0
case "$sub" in
  list-sessions) cat "$d/sessions" 2>/dev/null ;;
  capture-pane)
    if has "$name"; then cat "$d/pane" 2>/dev/null; else echo "can't find session: $name" >&2; rc=1; fi ;;
  kill-session)
    if has "$name"; then
      : > "$d/sessions.tmp"
      while IFS= read -r l; do [ "$l" = "$name" ] || printf '%s\\n' "$l" >> "$d/sessions.tmp"; done < "$d/sessions"
      mv "$d/sessions.tmp" "$d/sessions"
    else echo "can't find session: $name" >&2; rc=1; fi ;;
  new-session)
    if [ -f "$d/fail-new" ]; then echo "fake spawn failure" >&2; rc=1
    else
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-s" ]; then printf '%s\\n' "$a" >> "$d/sessions"; fi
        prev="$a"
      done
      printf '%s' "$BG_PROMPT" > "$d/prompt"
    fi ;;
esac
printf 'end %s\\n' "$sub" >> "$d/calls.log"
exit $rc
`

let bin: string
let dir: string
let savedPath: string | undefined
let db: typeof import('../db.js')
let mod: typeof import('../web/routes/background-tasks.js')

const put = (name: string, content: string) => writeFileSync(join(dir, name), content)
const calls = (): string[] => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf-8').split('\n').filter(Boolean) : [])
const sessions = (): string[] => (existsSync(join(dir, 'sessions')) ? readFileSync(join(dir, 'sessions'), 'utf-8').split('\n').filter(Boolean) : [])

// Worst event-loop delay (ms) while fn runs. monitorEventLoopDelay samples on a
// libuv timer, so vitest's fake timers do not touch it (measured). A stall that
// starts right at enable() goes unseen (measured: 11 ms for a 300 ms spin), so
// the meter gets a few samples in before fn runs.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try {
    await sleep(30)
    await fn()
    await sleep(50) // let the timer record a stall that ended with fn
  } finally {
    h.disable()
  }
  return h.max / 1e6
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let status = 200
  let out = ''
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { out = b ?? '' },
  } as any
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} }) as any
  const url = new URL(`http://localhost${path}`)
  const handled = await mod.tryHandleBackgroundTasks({ req, res, path: url.pathname, method, url } as any)
  return { status: handled ? status : -1, json: out ? JSON.parse(out) : null }
}

function seedRunning(id: string, agent: string, alive: boolean): void {
  expect(db.createBackgroundTaskAtomic(id, agent, 'p', `bg-${id}`, 3)).not.toBeNull()
  if (alive) put('sessions', [...sessions(), `bg-${id}`].join('\n') + '\n')
}

beforeAll(async () => {
  bin = mkdtempSync(join(tmpdir(), 'bg-fake-bin-'))
  writeFileSync(join(bin, 'tmux'), FAKE_TMUX)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  chmodSync(join(bin, 'claude'), 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${bin}:${process.env.PATH}`
  // The route resolves tmux/claude from PATH at import time: import it fresh,
  // after PATH points at the fakes, with the db module of the same graph.
  vi.resetModules()
  db = await import('../db.js')
  mod = await import('../web/routes/background-tasks.js')
  db.initDatabase(':memory:')
  // Warm-up: the fake's first exec can be far slower than the later ones (on a
  // loaded macOS host 2-3.3 s against 1.55 s warm, #2186), and the first GET or
  // POST case would spend that inside the route's 5 s tmux timeout. Pay it here,
  // once, on the path the measured cases take (the sleep included, for 0 s).
  const warm = mkdtempSync(join(tmpdir(), 'bg-fake-warm-'))
  try {
    writeFileSync(join(warm, 'sleep'), '0')
    writeFileSync(join(warm, 'sessions'), '')
    await promisify(execFile)(join(bin, 'tmux'), ['list-sessions'], { env: { ...process.env, FAKE_TMUX_DIR: warm } })
  } finally {
    rmSync(warm, { recursive: true, force: true })
  }
}, 30_000) // a loaded host hit the default 10 s here even without the warm-up

afterAll(() => {
  process.env.PATH = savedPath
  delete process.env.FAKE_TMUX_DIR
  rmSync(bin, { recursive: true, force: true })
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bg-fake-tmux-'))
  process.env.FAKE_TMUX_DIR = dir
  put('sessions', '')
  // Fake only the JS timers: the route's poll interval and 30-min timeout run
  // on them, and dropping them in afterEach stops the module's loops.
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  for (const t of db.getRunningBackgroundTasks()) db.finishBackgroundTask(t.id, 'failed', '(test cleanup)')
  rmSync(dir, { recursive: true, force: true })
})

describe('background tasks: tmux calls do not block the event loop', () => {
  it('instrument: a synchronous stall is seen by the stall meter (positive control)', async () => {
    const ms = await stallDuring(async () => {
      const b = Date.now()
      while (Date.now() - b < 300) { /* spin */ }
    })
    expect(ms).toBeGreaterThanOrEqual(250)
  })

  it('GET /api/background-tasks/:id captures the live pane without stalling the loop', async () => {
    seedRunning('AA000001', 'agent-get', true)
    put('pane', 'line one\nline two\n')
    put('sleep', String(SLEEP_S))
    let r: { status: number; json: any } | undefined
    const t0 = Date.now()
    const stall = await stallDuring(async () => { r = await call('GET', '/api/background-tasks/AA000001') })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SLEEP_S * 1000 - 100) // the fake really slept
    expect(r!.status).toBe(200)
    expect(r!.json.liveOutput).toBe('line one\nline two\n')
    expect(calls()).toContain('start capture-pane -t =bg-AA000001: -p -S -500')
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('POST starts the tmux session with the prompt in BG_PROMPT without stalling the loop', async () => {
    put('sleep', String(SLEEP_S))
    let r: { status: number; json: any } | undefined
    const stall = await stallDuring(async () => {
      r = await call('POST', '/api/background-tasks', { agent_id: 'agent-post', prompt: '  do the thing  ' })
    })
    expect(r!.status).toBe(201)
    const id = r!.json.id as string
    expect(id).toMatch(/^[A-F0-9]{8}$/)
    expect(r!.json.status).toBe('running')
    expect(sessions()).toContain(`bg-${id}`)
    expect(readFileSync(join(dir, 'prompt'), 'utf-8')).toBe('do the thing')
    expect(calls().some(l => l.startsWith(`start new-session -d -s bg-${id} -x 200 -y 50 `))).toBe(true)
    expect(db.getBackgroundTask(id)!.status).toBe('running')
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('POST: a failed spawn still answers 429 and marks the task failed (spawn failed)', async () => {
    put('fail-new', '1')
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-fail', prompt: 'x' })
    expect(r.status).toBe(429)
    expect(r.json.error).toBe('Nem sikerült elindítani a háttérfeladatot')
    const rows = db.getBackgroundTasks('agent-fail', true)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].output).toBe('(spawn failed)')
  })

  it('POST: a task cancelled while its session is being created gets that session killed', async () => {
    put('sleep', '1')
    const p = call('POST', '/api/background-tasks', { agent_id: 'agent-race', prompt: 'x' })
    // Cancel (what DELETE does to the row) while new-session is still running.
    await vi.waitFor(() => {
      expect(calls()).toContainEqual(expect.stringMatching(/^start new-session /))
      expect(db.getBackgroundTasks('agent-race')).toHaveLength(1)
    }, { timeout: 5000 })
    const id = db.getBackgroundTasks('agent-race')[0].id
    db.finishBackgroundTask(id, 'failed', '(cancelled)')
    await p
    put('sleep', '0')
    await vi.waitFor(() => expect(calls()).toContain('end kill-session'), { timeout: 5000 })
    const log = calls()
    expect(log.indexOf(`start kill-session -t =bg-${id}:`)).toBeGreaterThan(log.indexOf('end new-session'))
    expect(sessions()).not.toContain(`bg-${id}`)
    expect(db.getBackgroundTask(id)!.status).toBe('failed')
    expect(db.getBackgroundTask(id)!.output).toBe('(cancelled)')
  })

  it('DELETE captures the pane, then kills the session, then marks the task failed -- without stalling', async () => {
    seedRunning('AA000002', 'agent-del', true)
    put('pane', 'partial output\n\n')
    put('sleep', String(SLEEP_S))
    let r: { status: number; json: any } | undefined
    const stall = await stallDuring(async () => { r = await call('DELETE', '/api/background-tasks/AA000002') })
    expect(r!.status).toBe(200)
    expect(r!.json).toEqual({ ok: true })
    const log = calls()
    const capEnd = log.indexOf('end capture-pane')
    const killStart = log.indexOf('start kill-session -t =bg-AA000002:')
    expect(capEnd).toBeGreaterThanOrEqual(0)
    expect(killStart).toBeGreaterThan(capEnd) // the pane is read before it is destroyed
    expect(sessions()).not.toContain('bg-AA000002')
    const t = db.getBackgroundTask('AA000002')!
    expect(t.status).toBe('failed')
    expect(t.output).toBe('partial output')
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('poll: a finished pane completes the task with its output and kills the session, without stalling', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-poll', prompt: 'x' })
    const id = r.json.id as string
    put('pane', '  result text  \n___BG_DONE___\n')
    put('sleep', '1')
    const stall = await stallDuring(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS)
      await vi.waitFor(() => expect(db.getBackgroundTask(id)!.status).toBe('done'), { timeout: 10_000 })
      await vi.waitFor(() => expect(calls()).toContain('end kill-session'), { timeout: 10_000 })
    })
    expect(db.getBackgroundTask(id)!.output).toBe('result text')
    expect(sessions()).not.toContain(`bg-${id}`)
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('poll: a session that is gone completes the task as (session ended)', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-gone', prompt: 'x' })
    const id = r.json.id as string
    put('sessions', '')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(db.getBackgroundTask(id)!.status).toBe('done'), { timeout: 10_000 })
    expect(db.getBackgroundTask(id)!.output).toBe('(session ended)')
  })

  it('poll: ticks of one task never overlap while tmux is slow', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-overlap', prompt: 'x' })
    const id = r.json.id as string
    put('pane', 'still working\n')
    put('sleep', '1')
    const before = calls().length
    await vi.advanceTimersByTimeAsync(3 * POLL_MS)
    await sleep(2500) // real time: let every started tmux call finish
    let open = 0, worst = 0
    for (const l of calls().slice(before)) {
      if (l.startsWith('start ')) worst = Math.max(worst, ++open)
      else if (l.startsWith('end ')) open--
    }
    expect(calls().slice(before).length).toBeGreaterThan(0) // the poll did run
    expect(worst).toBe(1)
    expect(db.getBackgroundTask(id)!.status).toBe('running')
  })

  // A cancel (what DELETE does to the row) can land while a tick awaits tmux.
  // Each await is its own window, so each gets its own case.
  it('poll: a task cancelled while list-sessions is in flight is not closed as (session ended)', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-cancel-a', prompt: 'x' })
    const id = r.json.id as string
    put('sleep', '1')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(calls()).toContainEqual(expect.stringMatching(/^start list-sessions/)), { timeout: 5000 })
    put('sessions', '') // the session dies too: the tick will see it gone
    db.finishBackgroundTask(id, 'failed', '(cancelled)')
    await sleep(2500) // real time: let the in-flight tick finish
    expect(calls()).toContain('end list-sessions')
    const t = db.getBackgroundTask(id)!
    expect(t.status).toBe('failed')
    expect(t.output).toBe('(cancelled)')
  })

  it('poll: a task cancelled while capture-pane is in flight is not closed as done', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-cancel-b', prompt: 'x' })
    const id = r.json.id as string
    put('pane', 'done text\n___BG_DONE___\n')
    put('sleep', '1')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(calls()).toContainEqual(expect.stringMatching(/^start capture-pane/)), { timeout: 5000 })
    db.finishBackgroundTask(id, 'failed', '(cancelled)')
    await sleep(2500)
    expect(calls()).toContain('end capture-pane')
    const t = db.getBackgroundTask(id)!
    expect(t.status).toBe('failed')
    expect(t.output).toBe('(cancelled)')
  })

  it('timeout: a task cancelled while the timeout capture is in flight is not closed as timeout', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-cancel-t', prompt: 'x' })
    const id = r.json.id as string
    put('pane', 'half done\n')
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    await sleep(500) // real time: the poll ticks of the first 30 minutes finish
    put('sleep', '1')
    const before = calls().length
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(calls().slice(before)).toContainEqual(expect.stringMatching(/^start capture-pane/)), { timeout: 5000 })
    db.finishBackgroundTask(id, 'failed', '(cancelled)')
    await sleep(2500)
    const t = db.getBackgroundTask(id)!
    expect(t.status).toBe('failed')
    expect(t.output).toBe('(cancelled)')
    expect(calls().slice(before).some(l => l.startsWith('start kill-session'))).toBe(false)
  })

  it('timeout: after 30 minutes the task is closed as timeout with the pane and the session is killed', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-timeout', prompt: 'x' })
    const id = r.json.id as string
    put('pane', '  half done  \n')
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await vi.waitFor(() => expect(db.getBackgroundTask(id)!.status).toBe('timeout'), { timeout: 10_000 })
    expect(db.getBackgroundTask(id)!.output).toBe('half done')
    await vi.waitFor(() => expect(sessions()).not.toContain(`bg-${id}`), { timeout: 10_000 })
  })

  it('startup sweep is awaitable, fails dead tasks as orphaned, keeps live ones, without stalling', async () => {
    seedRunning('AA000003', 'agent-sweep', false)
    seedRunning('AA000004', 'agent-sweep', true)
    put('pane', 'pane text\n')
    put('sleep', String(SLEEP_S))
    let ret: unknown
    const stall = await stallDuring(async () => {
      ret = mod.sweepOrphanedBackgroundTasks()
      await ret
    })
    expect(typeof (ret as Promise<void> | undefined)?.then).toBe('function')
    expect(db.getBackgroundTask('AA000003')!.status).toBe('failed')
    expect(db.getBackgroundTask('AA000003')!.output).toBe('(orphaned on restart)')
    expect(db.getBackgroundTask('AA000004')!.status).toBe('running')
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('startup sweep: a task cancelled while the sweep awaits tmux keeps its cancellation', async () => {
    seedRunning('AA000005', 'agent-sweep-race', false)
    seedRunning('AA000006', 'agent-sweep-race', false)
    put('sleep', '1')
    const p = mod.sweepOrphanedBackgroundTasks()
    await vi.waitFor(() => expect(calls()).toContainEqual(expect.stringMatching(/^start list-sessions/)), { timeout: 5000 })
    db.finishBackgroundTask('AA000006', 'failed', '(cancelled)')
    await p
    expect(db.getBackgroundTask('AA000005')!.status).toBe('failed')
    expect(db.getBackgroundTask('AA000005')!.output).toBe('(orphaned on restart)')
    expect(db.getBackgroundTask('AA000006')!.status).toBe('failed')
    expect(db.getBackgroundTask('AA000006')!.output).toBe('(cancelled)')
  })

  it('POST: a spawn that fails after the task was cancelled keeps the cancellation and still answers 429', async () => {
    put('fail-new', '1'); put('sleep', '1')
    const p = call('POST', '/api/background-tasks', { agent_id: 'agent-failrace', prompt: 'x' })
    await vi.waitFor(() => { expect(calls()).toContainEqual(expect.stringMatching(/^start new-session /)); expect(db.getBackgroundTasks('agent-failrace')).toHaveLength(1) }, { timeout: 5000 })
    const id = db.getBackgroundTasks('agent-failrace')[0].id
    db.finishBackgroundTask(id, 'failed', '(cancelled)')
    const r = await p
    expect(r.status).toBe(429)
    expect(r.json.error).toBe('Nem sikerült elindítani a háttérfeladatot')
    expect(db.getBackgroundTask(id)!.output).toBe('(cancelled)')
  })

  it('POST: the answer for a task cancelled during spawn shows it as failed', async () => {
    put('sleep', '1')
    const p = call('POST', '/api/background-tasks', { agent_id: 'agent-race2', prompt: 'x' })
    await vi.waitFor(() => { expect(calls()).toContainEqual(expect.stringMatching(/^start new-session /)); expect(db.getBackgroundTasks('agent-race2')).toHaveLength(1) }, { timeout: 5000 })
    const id = db.getBackgroundTasks('agent-race2')[0].id
    db.finishBackgroundTask(id, 'failed', '(cancelled)')
    const r = await p
    expect(r.status).toBe(201)
    expect(r.json.id).toBe(id)
    expect(r.json.status).toBe('failed')
    expect(r.json.output).toBe('(cancelled)')
  })

  it('DELETE during the completing tick ends in a state a DELETE before or after it could reach', async () => {
    const r = await call('POST', '/api/background-tasks', { agent_id: 'agent-delrace', prompt: 'x' })
    const id = r.json.id as string
    put('pane', 'out text\n___BG_DONE___\n')
    put('sleep', '1')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(calls()).toContainEqual(expect.stringMatching(/^start kill-session/)), { timeout: 10_000 })
    const d = await call('DELETE', `/api/background-tasks/${id}`)
    expect(d.status).toBe(200)
    await sleep(2500)
    const t = db.getBackgroundTask(id)!
    expect(t.status).toBe('failed')
    expect(['out text\n___BG_DONE___', '(cancelled)']).toContain(t.output)
  })
})
