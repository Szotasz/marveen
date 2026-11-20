// Regression tests for Codex relay hardening.
import { describe, it, expect, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROOT } from '../config.js'
import { codexRelayDir } from '../web/agent-engine.js'
import { stopDashboardRelay } from '../web/agent-process.js'

function stopFixture(): { name: string; dir: string } {
  const name = `relay-stop-${randomBytes(6).toString('hex')}`
  const dir = join(PROJECT_ROOT, 'store', 'codex-relay', name)
  mkdirSync(dir, { recursive: true })
  return { name, dir }
}

const RELAY_MJS = fileURLToPath(new URL('../../scripts/codex-relay/relay.mjs', import.meta.url))
const MCP_SHIM_MJS = fileURLToPath(new URL('../../scripts/codex-relay/mcp-shim.mjs', import.meta.url))

// ---- helpers ----------------------------------------------------------------

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => child.on('exit', code => resolve(code)))
}

// A throwaway dashboard: answers every request with { ok: true, echo: url } and
// records what reached it, so a test can prove what did NOT.
async function mockDashboard(): Promise<{ server: Server; url: string; received: Array<{ method?: string; url?: string; body: string }> }> {
  const received: Array<{ method?: string; url?: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, echo: req.url }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received }
}

interface Daemon {
  child: ChildProcess
  relayDir: string
  requestsDir: string
  responsesDir: string
  // Everything the daemon wrote to stderr so far: a refusal test asserts on
  // the operator-facing reason line instead of the exit code alone.
  stderr: () => string
}

// Spawns the relay daemon against the given dashboard with a token file that
// lives OUTSIDE the relay dir, mirroring the production layout. Stderr stays
// drained (collected, so the pipe never fills) for the same reason.
async function startDaemon(work: string, dashboardUrl: string): Promise<Daemon> {
  const relayDir = join(work, 'relay')
  const tokenFile = join(work, 'agent.token')
  writeFileSync(tokenFile, `tok-${randomBytes(16).toString('hex')}\n`)
  const child = spawn(process.execPath, [RELAY_MJS,
    '--agent', 'relay-agent',
    '--relay-dir', relayDir,
    '--token-file', tokenFile,
    '--dashboard-url', dashboardUrl,
    '--audit-log', join(work, 'audit.log'), // outside the relay dir
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => { /* drained: readiness is asserted below */ })
  let stderrText = ''
  child.stderr.on('data', chunk => { stderrText += chunk })
  return {
    child,
    relayDir,
    requestsDir: join(relayDir, 'requests'),
    responsesDir: join(relayDir, 'responses'),
    stderr: () => stderrText,
  }
}

// ---- relay.mjs: encoded traversal (fix 4d) ------------------------------------

describe('relay.mjs R1 hardening', () => {
  it('refuses a percent-encoded traversal path before any fetch', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-enc-'))
    const dashboard = await mockDashboard()
    const daemon = await startDaemon(work, dashboard.url)
    try {
      await waitFor(() => {
        try { return readFileSync(join(daemon.relayDir, 'relay.ready'), 'utf-8').trim() === String(daemon.child.pid) }
        catch { return null }
      })
      // '%2e' is '.', so this is /api/../admin -- outside the /api/ surface,
      // and the literal '..' check never sees it.
      writeFileSync(join(daemon.requestsDir, 'bad-enc.json'), JSON.stringify({ id: 'bad-enc', method: 'GET', path: '/api/%2e%2e/admin' }))
      const response = await waitFor(() => (existsSync(join(daemon.responsesDir, 'bad-enc.json')) ? readJson(join(daemon.responsesDir, 'bad-enc.json')) : null)) as { id: string; status: number; error: string }
      expect(response).toEqual({ id: 'bad-enc', status: 400, error: 'invalid request' })
      expect(existsSync(join(daemon.requestsDir, 'bad-enc.json'))).toBe(false)
      // Nothing escaped the /api/ surface: the dashboard saw no request at all.
      expect(dashboard.received.filter(entry => !entry.url?.startsWith('/api/'))).toEqual([])
      expect(dashboard.received).toEqual([])
      // Compatibility half of the same fix: a legitimate query string must keep
      // round-tripping (the shim sends path+query in one field, e.g.
      // marveen_memory_search always carries ?agent=...). URL keeps the query
      // out of .pathname, so comparing the RAW path against .pathname alone --
      // the naive form of this check -- would 400 every such request.
      writeFileSync(join(daemon.requestsDir, 'q-1.json'), JSON.stringify({ id: 'q-1', method: 'GET', path: '/api/memories?agent=relay-agent&q=x' }))
      const queried = await waitFor(() => (existsSync(join(daemon.responsesDir, 'q-1.json')) ? readJson(join(daemon.responsesDir, 'q-1.json')) : null)) as { id: string; status: number; body: { ok: boolean; echo: string } }
      expect(queried.id).toBe('q-1')
      expect(queried.status).toBe(200)
      expect(queried.body).toEqual({ ok: true, echo: '/api/memories?agent=relay-agent&q=x' })
      expect(dashboard.received[dashboard.received.length - 1].url).toBe('/api/memories?agent=relay-agent&q=x')
    } finally {
      daemon.child.kill('SIGTERM')
      await exited(daemon.child)
      dashboard.server.close()
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)

  // Qwen mutant guard (card 2436459e, round 3): a clean-but-foreign path (no
  // traversal, no query -- normalizes to itself) must never reach a real
  // fetch. The refusal is layered (raw prefix check on request.path + the
  // /api/ leg of the URL round-trip), so either leg alone masks the other;
  // this pins the composed property and goes red when the layering is broken
  // (measured red with both legs removed; a single-leg mutant survives by
  // design -- redundancy, not a gap).
  it('refuses a clean path outside /api/ before any fetch', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-prefix-'))
    const dashboard = await mockDashboard()
    const daemon = await startDaemon(work, dashboard.url)
    try {
      await waitFor(() => {
        try { return readFileSync(join(daemon.relayDir, 'relay.ready'), 'utf-8').trim() === String(daemon.child.pid) }
        catch { return null }
      })
      writeFileSync(join(daemon.requestsDir, 'p-1.json'), JSON.stringify({ id: 'p-1', method: 'GET', path: '/admin/settings' }))
      const response = await waitFor(() => (existsSync(join(daemon.responsesDir, 'p-1.json')) ? readJson(join(daemon.responsesDir, 'p-1.json')) : null)) as { id: string; status: number; error: string }
      expect(response).toEqual({ id: 'p-1', status: 400, error: 'invalid request' })
      expect(dashboard.received).toEqual([])
    } finally {
      daemon.child.kill('SIGTERM')
      await exited(daemon.child)
      dashboard.server.close()
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)

  // ---- relay.mjs: symlink hardening (fix 4c) -----------------------------------

  it('never writes through a pre-created response symlink, whatever it points at', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-sym-'))
    const dashboard = await mockDashboard()
    const responsesDir = join(work, 'relay', 'responses')
    const requestsDir = join(work, 'relay', 'requests')
    mkdirSync(responsesDir, { recursive: true })
    mkdirSync(requestsDir, { recursive: true })

    // Both paths an old atomicWriteJson would have touched, pre-created as
    // symlinks to one outside "victim" file: the final response path (written
    // by rename) and the guessed `.tmp` path (written directly before the fix).
    const victim = join(work, 'victim.txt')
    const victimContent = 'VICTIM-CONTENT-DO-NOT-TOUCH\n'
    writeFileSync(victim, victimContent)
    symlinkSync(victim, join(responsesDir, 'sym-1.json'))
    symlinkSync(victim, join(responsesDir, 'sym-1.json.tmp'))

    const daemon = await startDaemon(work, dashboard.url)
    try {
      await waitFor(() => {
        try { return readFileSync(join(daemon.relayDir, 'relay.ready'), 'utf-8').trim() === String(daemon.child.pid) }
        catch { return null }
      })
      writeFileSync(join(requestsDir, 'sym-1.json'), JSON.stringify({ id: 'sym-1', method: 'GET', path: '/api/kanban' }))
      const response = await waitFor(() => (existsSync(join(responsesDir, 'sym-1.json')) && !lstatSync(join(responsesDir, 'sym-1.json')).isSymbolicLink()
        ? readJson(join(responsesDir, 'sym-1.json'))
        : null)) as { id: string; status: number; body: { ok: boolean; echo: string } }
      expect(response.id).toBe('sym-1')
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ok: true, echo: '/api/kanban?assignee=relay-agent' })
      // The victim kept its content: rename replaced the symlink ENTRY, and the
      // guessed .tmp path was never opened.
      expect(readFileSync(victim, 'utf-8')).toBe(victimContent)
      expect(lstatSync(join(responsesDir, 'sym-1.json.tmp')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(responsesDir, 'sym-1.json.tmp'))).toBe(victim)
    } finally {
      daemon.child.kill('SIGTERM')
      await exited(daemon.child)
      dashboard.server.close()
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)

  // ---- relay.mjs: ready marker (fix 4b / fix 3) --------------------------------

  it('replaces a stale relay.ready with the daemon pid, and readiness means that pid', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-ready-'))
    const relayDir = join(work, 'relay')
    mkdirSync(relayDir, { recursive: true })
    // A marker a SIGKILLed daemon left behind: before the fix the daemon kept
    // it (and wrote no pid), so readiness proved nothing.
    writeFileSync(join(relayDir, 'relay.ready'), 'stale')
    const daemon = await startDaemon(work, 'http://127.0.0.1:9/')
    try {
      await waitFor(() => {
        try { return readFileSync(join(relayDir, 'relay.ready'), 'utf-8').trim() === String(daemon.child.pid) }
        catch { return null }
      })
      expect(readFileSync(join(relayDir, 'relay.ready'), 'utf-8').trim()).toBe(String(daemon.child.pid))
      expect(existsSync(join(relayDir, 'relay.ready'))).toBe(true)
      daemon.child.kill('SIGTERM')
      const code = await exited(daemon.child)
      expect(code).toBe(0)
      expect(existsSync(join(relayDir, 'relay.ready'))).toBe(false)
    } finally {
      daemon.child.kill('SIGKILL')
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)
})

// ---- relay.mjs: spool dirs must be real directories (R2-1 fix) -----------------

describe('relay spool dirs must be real directories', () => {
  it('refuses to start when responses/ is pre-created as a symlink, and writes nothing through it', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-startdir-'))
    const relayDir = join(work, 'relay')
    mkdirSync(relayDir, { recursive: true })
    // The attack: the sandboxed agent pre-points responses/ at an outside
    // EMPTY dir before the daemon starts. mkdirSync recursive accepts a
    // symlink-to-directory silently, so only the lstat-based startup gate
    // catches it -- before relay.ready exists, so a symlinked spool can never
    // count as "ready".
    const victimDir = join(work, 'victim-responses')
    mkdirSync(victimDir)
    symlinkSync(victimDir, join(relayDir, 'responses'))
    const daemon = await startDaemon(work, 'http://127.0.0.1:9/')
    try {
      const code = await exited(daemon.child)
      expect(code).not.toBe(0)
      await waitFor(() => (daemon.stderr().includes('not a real directory') ? true : null))
      expect(existsSync(join(relayDir, 'relay.ready'))).toBe(false)
      // Fail-closed on the outside dir too: not one file escaped through it.
      expect(readdirSync(victimDir)).toEqual([])
    } finally {
      daemon.child.kill('SIGKILL')
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)

  it('exits mid-run when responses/ is swapped for a symlink between ticks, leaving the victim empty', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-swapdir-'))
    const dashboard = await mockDashboard()
    const daemon = await startDaemon(work, dashboard.url)
    try {
      await waitFor(() => {
        try { return readFileSync(join(daemon.relayDir, 'relay.ready'), 'utf-8').trim() === String(daemon.child.pid) }
        catch { return null }
      })
      // Mid-run swap: the real responses dir goes away, a symlink to a fresh
      // outside EMPTY dir takes its place, and ONE valid request arrives right
      // after. The per-tick re-check must fire before readdirSync of the tick
      // that would answer it -- the daemon dies instead of serving it.
      const victimDir = join(work, 'victim-swap')
      mkdirSync(victimDir)
      rmSync(daemon.responsesDir, { recursive: true })
      symlinkSync(victimDir, daemon.responsesDir)
      writeFileSync(join(daemon.requestsDir, 'swap-1.json'), JSON.stringify({ id: 'swap-1', method: 'GET', path: '/api/kanban' }))
      const code = await exited(daemon.child)
      expect(code).not.toBe(0)
      await waitFor(() => (daemon.stderr().includes('not a real directory') ? true : null))
      // No response json and no .tmp file ever landed outside the sandbox.
      expect(readdirSync(victimDir)).toEqual([])
    } finally {
      daemon.child.kill('SIGKILL')
      dashboard.server.close()
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)
})

// ---- mcp-shim.mjs: the Telegram tool is gone ---------------------------------------
// It used to be validated here (fix 5: integer chat_id). The dashboard has no
// POST /api/telegram/reply route, so the tool was removed; a call must now be an
// unknown tool and must not drop any request file.

describe('mcp-shim.mjs R1 hardening', () => {
  it('marveen_telegram_reply is an unknown tool and drops no request file', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-shim-chatid-'))
    const requestsDir = join(work, 'relay', 'requests')
    const responsesDir = join(work, 'relay', 'responses')
    mkdirSync(requestsDir, { recursive: true })
    mkdirSync(responsesDir, { recursive: true })

    const child = spawn(process.execPath, [MCP_SHIM_MJS], {
      env: { MARVEEN_AGENT_NAME: 'shim-agent', MARVEEN_RELAY_DIR: join(work, 'relay') },
    })
    let stdoutBuffer = ''
    const queue: unknown[] = []
    const waiters: Array<(message: unknown) => void> = []
    const drain = () => {
      while (queue.length && waiters.length) waiters.shift()!(queue.shift())
    }
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) {
          queue.push(JSON.parse(line))
          drain()
        }
      }
    })
    const nextMessage = () => new Promise<Record<string, unknown>>(resolve => {
      waiters.push(resolve as (message: unknown) => void)
      drain()
    })
    const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }

    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      await nextMessage()

      // A well-formed call (integer chat_id, text) is now an unknown tool, and NO request file.
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'marveen_telegram_reply', arguments: { chat_id: 123, text: 'hello' } } })
      const rejected = await nextMessage()
      expect((rejected as { id: number }).id).toBe(2)
      const error = (rejected as { error: { code: number; message: string } }).error
      expect(error.code).toBe(-32601)
      expect(error.message).toContain('Unknown tool')
      expect(existsSync(requestsDir)).toBe(true)
      expect(readdirSync(requestsDir)).toEqual([])
      expect(readdirSync(responsesDir)).toEqual([])
    } finally {
      child.kill()
      await exited(child)
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)
})

// ---- stopDashboardRelay pid guard (fix 2) ---------------------------------------

describe('stopDashboardRelay pid guard', () => {
  it('discards a malformed relay.pid without signalling', async () => {
    const { name, dir } = stopFixture()
    try {
      writeFileSync(join(dir, 'relay.pid'), '123junk')
      await expect(stopDashboardRelay(name)).resolves.toBeUndefined()
      expect(existsSync(join(dir, 'relay.pid'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never signals a live pid the relay.pid names but does not own', async () => {
    const { name, dir } = stopFixture()
    // A live, unrelated process: bare node sleeping for a minute.
    const helper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' })
    try {
      await waitFor(() => {
        try { process.kill(helper.pid!, 0); return true } catch { return null }
      })
      writeFileSync(join(dir, 'relay.pid'), String(helper.pid))
      await expect(stopDashboardRelay(name)).resolves.toBeUndefined()
      // Still alive: no SIGTERM and no SIGKILL reached it, and the forged pid
      // file is gone.
      expect(() => process.kill(helper.pid!, 0)).not.toThrow()
      expect(existsSync(join(dir, 'relay.pid'))).toBe(false)
    } finally {
      helper.kill('SIGKILL')
      await exited(helper)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // R2-1 (fix 8): the identity check above ran BEFORE the SIGTERM, and the
  // daemon may die during the ~2s poll window with the kernel reusing its pid
  // meanwhile -- an unconditional SIGKILL at the deadline could then hit an
  // unrelated process, so the cmdline is re-verified first.
  it('spares a pid the kernel reused between the pre-signal check and the SIGKILL deadline', async () => {
    const { name, dir } = stopFixture()
    // Ignores SIGTERM and keeps running, with argv that REALLY looks like this
    // agent's relay daemon (the script path plus the --relay-dir value). The
    // injected ps output tells the two moments apart. The ready marker lands only AFTER the
    // SIGTERM handler is installed -- waiting for the marker (not merely for
    // the pid to exist, which is true before the -e script even runs) is what
    // keeps the helper alive through the SIGTERM the stopper sends next.
    const readyMarker = join(dir, 'helper-ready')
    const helper = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{});const tick=()=>require("fs").writeFileSync(process.argv[1],String(Date.now()));tick();setInterval(tick,50)',
      readyMarker,
      join(PROJECT_ROOT, 'scripts', 'codex-relay', 'relay.mjs'),
      '--relay-dir', dir, '--token-file', 'token',
    ], { stdio: 'ignore' })
    try {
      await waitFor(() => (existsSync(readyMarker) ? true : null))
      const realCmdline = `${process.execPath} ${join(PROJECT_ROOT, 'scripts', 'codex-relay', 'relay.mjs')} --agent ${name} --relay-dir ${dir} --token-file token\n`
      writeFileSync(join(dir, 'relay.pid'), String(helper.pid))
      let calls = 0
      const readCmdline = (_pid: number) => {
        calls += 1
        // Pre-signal check: the real daemon. Every later call (the deadline
        // re-verification): the kernel already handed the pid to somebody else.
        return calls === 1 ? realCmdline : 'unrelated process\n'
      }
      // The poll window makes this take ~2s.
      await expect(stopDashboardRelay(name, { readCmdline })).resolves.toBeUndefined()
      // The reused pid got no SIGKILL: it is still alive, and relay.pid is gone.
      // kill(pid, 0) alone cannot prove liveness here: a SIGKILLed child that
      // the parent has not reaped yet is a zombie, and signal 0 succeeds on a
      // zombie -- so require a fresh heartbeat from the helper after stopping.
      const heartbeat = readFileSync(readyMarker, 'utf-8')
      await waitFor(() => readFileSync(readyMarker, 'utf-8') !== heartbeat)
      expect(() => process.kill(helper.pid!, 0)).not.toThrow()
      expect(existsSync(join(dir, 'relay.pid'))).toBe(false)
    } finally {
      helper.kill('SIGKILL')
      await exited(helper)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('treats a cmdline gone unreadable by the deadline as a dead daemon: no error, pid file removed', async () => {
    const { name, dir } = stopFixture()
    try {
      // A pid nobody owns: ps cannot read its command, which is
      // exactly what the deadline re-check sees once a daemon exits and its
      // pid is reaped.
      let pid = 999_999
      while (pid < 1_000_100) {
        try { process.kill(pid, 0) } catch { break }
        pid += 1
      }
      writeFileSync(join(dir, 'relay.pid'), String(pid))
      let calls = 0
      const readCmdline = (_pid: number) => {
        calls += 1
        if (calls === 1) return `${process.execPath} ${join(PROJECT_ROOT, 'scripts', 'codex-relay', 'relay.mjs')} --agent ${name} --relay-dir ${dir} --token-file token\n`
        throw new Error(`ps exited non-zero for pid ${pid}`)
      }
      // The unreadable deadline read must be swallowed, never surfaced.
      await expect(stopDashboardRelay(name, { readCmdline })).resolves.toBeUndefined()
      expect(existsSync(join(dir, 'relay.pid'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B5 ps process identity', () => {
  it.each(['node', '/opt/homebrew/bin/node'])('signals a matching daemon using %s', async node => {
    const { name, dir } = stopFixture()
    const pid = 123456
    writeFileSync(join(dir, 'relay.pid'), String(pid))
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw new Error('ESRCH')
      return true
    })
    try {
      await stopDashboardRelay(name, {
        readCmdline: () => `${node} ${join(PROJECT_ROOT, 'scripts', 'codex-relay', 'relay.mjs')} --agent ${name} --relay-dir ${dir} --token-file token\n`,
      })
      expect(kill).toHaveBeenCalledWith(pid, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(pid, 'SIGKILL')
      expect(existsSync(join(dir, 'relay.pid'))).toBe(false)
      expect(codexRelayDir(name)).toBe(dir)
    } finally {
      kill.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['other agent', 'end of line', 'longer path', 'foreign script', 'backup script', 'node -e helper', 'agent missing'])('refuses %s without signalling and removes the pid', async variant => {
    const { name, dir } = stopFixture()
    writeFileSync(join(dir, 'relay.pid'), '123456')
    const script = variant === 'foreign script' ? '/foreign/scripts/codex-relay/relay.mjs' : join(PROJECT_ROOT, 'scripts', 'codex-relay', 'relay.mjs')
    const tail = variant === 'other agent' ? `${dir}-other --token-file token` : variant === 'end of line' ? dir : variant === 'longer path' ? `${dir}x --token-file token` : `${dir} --token-file token`
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const full: Record<string, string> = {
      'backup script': `node ${script}.backup --agent ${name} --relay-dir ${dir} --token-file token`,
      'node -e helper': `${process.execPath} -e "require('fs')" marker ${script} --agent ${name} --relay-dir ${dir} --token-file token`,
      'agent missing': `node ${script} --relay-dir ${dir} --token-file token`,
    }
    try {
      await stopDashboardRelay(name, { readCmdline: () => (full[variant] ?? `node ${script} --agent ${name} --relay-dir ${tail}`) + '\n' })
      expect(kill).not.toHaveBeenCalled()
      expect(existsSync(join(dir, 'relay.pid'))).toBe(false)
    } finally {
      kill.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
