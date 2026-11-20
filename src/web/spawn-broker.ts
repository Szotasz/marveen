import { execFile, execFileSync } from 'node:child_process'
import { constants } from 'node:os'
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import { logger } from '../logger.js'
import { BROKER_SOURCE, WORKER_SOURCE } from './spawn-broker-sources.js'

export interface BrokerSyncOptions {
  timeout: number
  encoding?: 'utf-8'
  maxBuffer?: number
  killSignal?: NodeJS.Signals
  stdio?: ['ignore', 'pipe' | 'ignore', 'pipe']
}
export interface BrokerAsyncOptions {
  timeout: number
  encoding?: 'utf-8'
  maxBuffer?: number
  killSignal?: NodeJS.Signals
}
interface Reply {
  id: number
  marker?: 'BROKER_DOWN' | 'BROKER_LOST' | 'BROKER_TIMEOUT'
  pid: number
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string | null
  stderr: string
  error: null | { code: string; errno: number; syscall: string; path: string; spawnargs: string[]; message: string }
  timedOut: boolean
  maxBufferExceeded: false | 'stdout' | 'stderr'
}
interface Pending { resolve: (reply: Reply) => void; timer: ReturnType<typeof setTimeout> }
const GRACE_MS = 1000
let worker: Worker | undefined
let syncPort: MessagePort | undefined
let asyncPort: MessagePort | undefined
let state = new Int32Array(new SharedArrayBuffer(8)) // Sequence counter, live broker PID.
let nextId = 0
let failed = false
let stopping: Promise<void> | undefined
const pending = new Map<number, Pending>()

export function spawnBrokerActive(): boolean {
  return worker !== undefined && !failed && Atomics.load(state, 1) > 0
}

export function startSpawnBroker(): void {
  if (worker || failed || stopping || process.env.MARVEEN_SPAWN_BROKER === 'off') return
  const sync = new MessageChannel()
  const async = new MessageChannel()
  syncPort = sync.port1
  asyncPort = async.port1
  state = new Int32Array(new SharedArrayBuffer(8))
  const fail = (err: unknown) => {
    if (failed) return
    failed = true
    Atomics.store(state, 1, 0)
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ id, marker: 'BROKER_LOST' } as Reply)
    }
    pending.clear()
    asyncPort?.unref()
    logger.warn({ err }, 'Spawn broker worker failed; using direct spawning')
  }
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        syncPort: sync.port2, asyncPort: async.port2, shared: state.buffer,
        source: BROKER_SOURCE, execPath: process.execPath,
        execArgv: process.execArgv.filter(arg => !/^--(?:inspect|debug)/.test(arg)),
      },
      transferList: [sync.port2, async.port2],
    })
    worker.on('message', message => {
      if (message.type === 'up') logger.info({ pid: message.pid }, 'Spawn broker is up')
      else if (message.type === 'down') logger.warn(message, 'Spawn broker died; restart scheduled')
      else if (message.type === 'starting' && message.restart) logger.warn('Starting spawn broker')
      else if (message.type === 'stderr') logger.warn({ stderr: message.line.slice(0, 2048) }, 'Spawn broker stderr')
    })
    worker.on('error', fail)
    worker.on('exit', code => { if (!stopping) fail(new Error(`Spawn broker worker exited (${code})`)) })
    worker.unref()
    asyncPort.on('message', (reply: Reply) => {
      const entry = pending.get(reply.id)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(reply.id)
      if (!pending.size) asyncPort?.unref()
      entry.resolve(reply)
    })
    asyncPort.unref()
    syncPort.unref()
  } catch (err) {
    sync.port1.close(); sync.port2.close(); async.port1.close(); async.port2.close()
    fail(err)
  }
}

export function stopSpawnBroker(): Promise<void> {
  if (stopping) return stopping
  const current = worker
  if (!current) return Promise.resolve()
  const pid = Atomics.exchange(state, 1, 0)
  stopping = (async () => {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); current.off('message', message); resolve() }
      const message = (value: { type: string }) => { if (value.type === 'stopped') done() }
      const timer = setTimeout(() => {
        if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { /* Already reaped. */ } }
        done()
      }, GRACE_MS)
      current.on('message', message)
      current.once('exit', done)
      current.postMessage({ type: 'stop' })
    })
    await current.terminate()
    worker = undefined
    syncPort?.close(); asyncPort?.close()
    syncPort = asyncPort = undefined
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ id, marker: 'BROKER_LOST' } as Reply)
    }
    pending.clear()
  })().finally(() => { stopping = undefined })
  return stopping
}

function request(file: string, args: string[], options: BrokerSyncOptions, sync: boolean) {
  return {
    id: ++nextId, file, args, cwd: process.cwd(), env: { ...process.env },
    timeout: options.timeout, killSignal: options.killSignal,
    maxBuffer: options.maxBuffer, stdout: options.stdio?.[1] ?? 'pipe', sync,
  }
}

function transportError(marker: Reply['marker']): Error {
  return Object.assign(new Error(marker === 'BROKER_TIMEOUT'
    ? 'spawn broker request timed out'
    : 'spawn broker lost the request; it was not retried'), {
    code: marker === 'BROKER_TIMEOUT' ? 'ETIMEDOUT' : 'ESPAWNBROKER',
  })
}

// Rebuild checkExecSyncError's result, including string-vs-Buffer output.
function syncResult(r: Reply, file: string, args: string[], options: BrokerSyncOptions): string | Buffer | null {
  const decode = (data: string | null) => {
    if (data === null) return null
    const buffer = Buffer.from(data, 'base64')
    return options.encoding ? buffer.toString(options.encoding) : buffer
  }
  const stdout = r.error ? undefined : decode(r.stdout)
  const stderr = r.error ? undefined : decode(r.stderr)
  const result = { pid: r.pid, status: r.status, signal: r.signal,
    output: r.error ? null : [null, stdout, stderr], stdout, stderr }
  const code = r.error?.code ?? (r.timedOut ? 'ETIMEDOUT' : r.maxBufferExceeded ? 'ENOBUFS' : undefined)
  if (code) {
    const syscall = `spawnSync ${file}`
    const errno = r.error?.errno ?? -constants.errno[code as keyof typeof constants.errno]
    throw Object.assign(new Error(`${syscall} ${code}`), r.error ?? {}, {
      message: `${syscall} ${code}`, code, errno, syscall, path: file, spawnargs: args,
    }, result)
  }
  if (r.status !== 0 || r.signal) {
    const cmd = args.length ? `${file} ${args.join(' ')}` : file
    throw Object.assign(new Error(`Command failed: ${cmd}${stderr?.length ? `\n${stderr}` : ''}`), result)
  }
  return stdout ?? null
}

export function brokerExecFileSync(file: string, args: string[], options: BrokerSyncOptions & { encoding: 'utf-8' }, meta: { readOnly: boolean }): string
export function brokerExecFileSync(file: string, args: string[], options: BrokerSyncOptions, meta: { readOnly: boolean }): string | Buffer | null
export function brokerExecFileSync(file: string, args: string[], options: BrokerSyncOptions, meta: { readOnly: boolean }): string | Buffer | null {
  const r = request(file, args, options, true)
  let sequence = Atomics.load(state, 0)
  let reply: Reply | undefined
  if (spawnBrokerActive()) {
    const dispatchedPid = Atomics.load(state, 1)
    const deadline = performance.now() + options.timeout + GRACE_MS
    syncPort!.postMessage(r)
    for (;;) {
      let received
      while ((received = receiveMessageOnPort(syncPort!))) {
        if (received.message.id === r.id) reply = received.message
        // Discard stale replies from calls whose deadline already passed.
      }
      if (reply) break
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      Atomics.wait(state, 0, sequence, remaining)
      sequence = Atomics.load(state, 0)
    }
    if (!reply) {
      Atomics.compareExchange(state, 1, dispatchedPid, 0)
      worker?.postMessage({ type: 'expire', id: r.id, pid: dispatchedPid })
      reply = { id: r.id, marker: 'BROKER_TIMEOUT' } as Reply
    }
  } else reply = { id: r.id, marker: 'BROKER_DOWN' } as Reply
  if (reply.marker) {
    if (reply.marker === 'BROKER_DOWN' || meta.readOnly) return execFileSync(file, args, options)
    throw transportError(reply.marker)
  }
  return syncResult(reply, file, args, options)
}

function asyncResult(r: Reply, file: string, args: string[]): { stdout: string; stderr: string } {
  const stdout = Buffer.from(r.stdout ?? '', 'base64').toString('utf-8')
  const stderr = Buffer.from(r.stderr, 'base64').toString('utf-8')
  const cmd = args.length ? `${file} ${args.join(' ')}` : file
  let error: Error | undefined
  if (r.error) error = Object.assign(new Error(r.error.message), r.error)
  else if (r.maxBufferExceeded) {
    error = Object.assign(new RangeError(`${r.maxBufferExceeded} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  } else if (r.status !== 0 || r.signal || r.timedOut) {
    error = Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
      code: r.status, killed: r.timedOut, signal: r.signal,
    })
  }
  if (error) throw Object.assign(error, { cmd, stdout, stderr, ...(r.timedOut ? { timedOut: true } : {}) })
  return { stdout, stderr }
}

export async function brokerExecFile(file: string, args: string[], options: BrokerAsyncOptions, meta: { readOnly: boolean }): Promise<{ stdout: string; stderr: string }> {
  const r = request(file, args, options, false)
  const reply = await new Promise<Reply>(resolve => {
    if (!spawnBrokerActive()) { resolve({ id: r.id, marker: 'BROKER_DOWN' } as Reply); return }
    const dispatchedPid = Atomics.load(state, 1)
    const timer = setTimeout(() => {
      pending.delete(r.id)
      if (!pending.size) asyncPort?.unref()
      Atomics.compareExchange(state, 1, dispatchedPid, 0)
      worker?.postMessage({ type: 'expire', id: r.id, pid: dispatchedPid })
      resolve({ id: r.id, marker: 'BROKER_TIMEOUT' } as Reply)
    }, options.timeout + GRACE_MS)
    pending.set(r.id, { resolve, timer })
    asyncPort!.ref()
    asyncPort!.postMessage(r)
  })
  if (reply.marker) {
    if (reply.marker !== 'BROKER_DOWN' && !meta.readOnly) throw transportError(reply.marker)
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, { ...options, cwd: r.cwd, env: r.env, encoding: 'utf-8' }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }))
        else resolve({ stdout, stderr })
      })
      child?.stdin?.end()
    })
  }
  return asyncResult(reply, file, args)
}

const READ_ONLY_TMUX_VERBS = new Set([
  'capture-pane', 'list-sessions', 'list-panes', 'list-windows', 'list-clients',
  'display-message', 'has-session', 'show-options', 'show-environment', 'show-window-options',
])
export function isReadOnlyTmuxChain(tmuxArgs: string[]): boolean {
  let needsVerb = true
  let needsPrint = false
  let previousToken = ''
  let seenDoubleDash = false
  for (const arg of tmuxArgs) {
    if (arg === ';') {
      if (needsVerb || needsPrint) return false
      needsVerb = true
      previousToken = ''
      seenDoubleDash = false
    }
    else if (needsVerb) {
      if (!READ_ONLY_TMUX_VERBS.has(arg)) return false
      needsVerb = false
      needsPrint = arg === 'capture-pane' || arg === 'display-message'
      previousToken = ''
      seenDoubleDash = false
    } else {
      if (arg === '--') seenDoubleDash = true
      if (arg === '-p' && !seenDoubleDash && !/^-[^-]*[bEStcdF]$/.test(previousToken)) needsPrint = false
      previousToken = arg
    }
  }
  return !needsVerb && !needsPrint
}
