import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEB_PORT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  agentDir,
  readAgentModel,
  readAgentModelEffort,
} from './agent-config.js'
import { codexInboxDir, type CodexInboxEnvelope } from './codex-agent-inbox.js'
import type { EffortLevel } from './model-providers.js'

export const CODEX_MESSAGES_PER_TICK = 5
const CODEX_CALL_TIMEOUT_MS = 30 * 60 * 1000
const CODEX_SESSION_LIMIT = 32

export interface CodexSessionStore {
  sessions: Record<string, { sessionId: string; updatedAt: number }>
}

export interface CodexRunResult {
  reply: string
  sessionId: string
}

export interface CodexDispatchDeps {
  run(envelope: CodexInboxEnvelope, sessionId: string | null): Promise<CodexRunResult>
  reply(payload: CodexReplyPayload): Promise<void>
  complete(envelope: CodexInboxEnvelope): Promise<void> | void
  onSession?(taskKey: string, sessionId: string): Promise<void> | void
}

export interface CodexReplyPayload {
  from: string
  to: string
  content: string
  task_id?: string
}

export function codexTaskKey(envelope: CodexInboxEnvelope): string {
  if (envelope.taskId) return `task:${envelope.taskId}`
  if (envelope.from) return `peer:${envelope.from}`
  return `event:${envelope.id}`
}

export function selectCodexBatch(
  envelopes: CodexInboxEnvelope[],
  cap = CODEX_MESSAGES_PER_TICK,
): CodexInboxEnvelope[] {
  return [...envelopes]
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, cap))
}

export function codexReplyPayload(
  agentName: string,
  envelope: CodexInboxEnvelope,
  reply: string,
): CodexReplyPayload | null {
  if (!envelope.from || envelope.from === 'system') return null
  return {
    from: agentName,
    to: envelope.from,
    content: reply,
    ...(envelope.taskId ? { task_id: envelope.taskId } : {}),
  }
}

/**
 * Deterministic dispatcher boundary used by both the real loop and unit tests:
 * FIFO, hard per-tick cap, per-task resume lookup, reply routing, and
 * per-envelope fault isolation.
 */
export async function dispatchCodexBatch(
  agentName: string,
  envelopes: CodexInboxEnvelope[],
  sessions: CodexSessionStore,
  deps: CodexDispatchDeps,
  cap = CODEX_MESSAGES_PER_TICK,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (const envelope of selectCodexBatch(envelopes, cap)) {
    try {
      const taskKey = codexTaskKey(envelope)
      const priorSession = sessions.sessions[taskKey]?.sessionId ?? null
      const result = await deps.run(envelope, priorSession)
      sessions.sessions[taskKey] = { sessionId: result.sessionId, updatedAt: Date.now() }
      await deps.onSession?.(taskKey, result.sessionId)
      const payload = codexReplyPayload(agentName, envelope, result.reply)
      if (payload) await deps.reply(payload)
      await deps.complete(envelope)
      processed++
    } catch (err) {
      failed++
      logger.warn({ err, agentName, envelopeId: envelope.id }, 'codex dispatcher: envelope failed; retained for retry')
    }
  }
  return { processed, failed }
}

export function buildCodexExecArgs(opts: {
  model: string
  effort: EffortLevel
  outputPath: string
  sessionId?: string | null
}): string[] {
  const common = [
    '-m', opts.model,
    '-c', `model_reasoning_effort=${opts.effort}`,
    '--skip-git-repo-check',
    '--output-last-message', opts.outputPath,
    '--json',
  ]
  if (opts.sessionId) {
    // `codex exec resume` has no --sandbox flag in CLI 0.144.6. The config
    // override is the equivalent enforcement and is repeated on every resume,
    // so a user config change cannot silently widen Sol's sandbox.
    return [
      'exec', 'resume',
      '-c', 'sandbox_mode="read-only"',
      ...common,
      opts.sessionId,
      '-',
    ]
  }
  return ['exec', '--sandbox', 'read-only', ...common, '-']
}

export function parseCodexSessionId(jsonl: string): string | null {
  let found: string | null = null
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (
        (event.type === 'thread.started' && typeof event.thread_id === 'string') ||
        (event.type === 'session.started' && typeof event.session_id === 'string')
      ) {
        found = String(event.thread_id ?? event.session_id)
      }
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return found
}

async function runCodexProcess(
  cwd: string,
  model: string,
  effort: EffortLevel,
  envelope: CodexInboxEnvelope,
  priorSession: string | null,
): Promise<CodexRunResult> {
  const outputPath = join(tmpdir(), `marveen-codex-${process.pid}-${Date.now()}-${envelope.id}.out`)
  const args = buildCodexExecArgs({ model, effort, outputPath, sessionId: priorSession })
  console.log(`\n>>> ${envelope.from ?? 'scheduler'} [${envelope.taskId ?? envelope.id}]\n${envelope.content}\n`)
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`codex exec timed out after ${CODEX_CALL_TIMEOUT_MS}ms`))
      }, CODEX_CALL_TIMEOUT_MS)
      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => {
        stderr += chunk
        process.stdout.write(chunk)
      })
      child.on('error', err => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`codex exec exited ${code}: ${stderr.slice(-1000)}`))
      })
      // Prompt bytes go only through stdin. No shell parses model content.
      child.stdin.end(envelope.content)
    })
    const reply = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8').trim() : ''
    if (!reply) throw new Error('codex exec produced an empty final reply')
    const sessionId = parseCodexSessionId(result.stdout) ?? priorSession
    if (!sessionId) throw new Error('codex exec did not report a session id')
    console.log(`<<< ${reply}\n`)
    return { reply, sessionId }
  } finally {
    try { rmSync(outputPath, { force: true }) } catch { /* best effort */ }
  }
}

function sessionsPath(name: string): string {
  return join(agentDir(name), '.codex-sessions.json')
}

function readSessions(name: string): CodexSessionStore {
  try {
    const parsed = JSON.parse(readFileSync(sessionsPath(name), 'utf-8')) as CodexSessionStore
    if (parsed && parsed.sessions && typeof parsed.sessions === 'object') return parsed
  } catch { /* fresh store */ }
  return { sessions: {} }
}

function writeSessions(name: string, store: CodexSessionStore): void {
  const newest = Object.entries(store.sessions)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, CODEX_SESSION_LIMIT)
  store.sessions = Object.fromEntries(newest)
  atomicWriteFileSync(sessionsPath(name), JSON.stringify(store, null, 2), { mode: 0o600 })
}

interface ReplySidecar extends CodexRunResult {}

function readInbox(name: string): Array<{ envelope: CodexInboxEnvelope; path: string }> {
  const inbox = codexInboxDir(name)
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  const out: Array<{ envelope: CodexInboxEnvelope; path: string }> = []
  for (const file of readdirSync(inbox)) {
    if (!/^(message-\d+|event-[A-Za-z0-9_-]+)\.json$/.test(file)) continue
    const path = join(inbox, file)
    try {
      const envelope = JSON.parse(readFileSync(path, 'utf-8')) as CodexInboxEnvelope
      if (!envelope || typeof envelope.content !== 'string' || typeof envelope.id !== 'string') continue
      out.push({ envelope, path })
    } catch (err) {
      logger.warn({ err, path }, 'codex dispatcher: malformed inbox envelope skipped')
    }
  }
  return out
}

function replySidecarPath(path: string): string {
  return path.replace(/\.json$/, '.reply.json')
}

async function postReply(payload: CodexReplyPayload): Promise<void> {
  const token = readFileSync(join(STORE_DIR, '.dashboard-token'), 'utf-8').trim()
  if (!token) throw new Error('dashboard token is empty')
  const response = await fetch(`http://127.0.0.1:${WEB_PORT}/api/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`reply POST failed: HTTP ${response.status} ${await response.text()}`)
}

export async function runCodexDispatcherTick(name: string): Promise<{ processed: number; failed: number }> {
  const entries = readInbox(name)
  const byId = new Map(entries.map(entry => [entry.envelope.id, entry.path]))
  const sessions = readSessions(name)
  const model = readAgentModel(name)
  const effort = readAgentModelEffort(name) ?? 'high'
  return dispatchCodexBatch(name, entries.map(entry => entry.envelope), sessions, {
    run: async (envelope, priorSession) => {
      const path = byId.get(envelope.id)
      if (!path) throw new Error(`missing inbox path for ${envelope.id}`)
      const sidecar = replySidecarPath(path)
      if (existsSync(sidecar)) return JSON.parse(readFileSync(sidecar, 'utf-8')) as ReplySidecar
      const result = await runCodexProcess(agentDir(name), model, effort, envelope, priorSession)
      atomicWriteFileSync(sidecar, JSON.stringify(result), { mode: 0o600 })
      return result
    },
    reply: postReply,
    complete: envelope => {
      const path = byId.get(envelope.id)
      if (!path) return
      rmSync(replySidecarPath(path), { force: true })
      rmSync(path, { force: true })
    },
    onSession: () => writeSessions(name, sessions),
  })
}

export async function runCodexDispatcherLoop(name: string): Promise<never> {
  mkdirSync(codexInboxDir(name), { recursive: true, mode: 0o700 })
  console.log(`Codex dispatcher ready: ${name} (cwd=${agentDir(name)}, cap=${CODEX_MESSAGES_PER_TICK}, sandbox=read-only)`)
  while (true) {
    try {
      await runCodexDispatcherTick(name)
    } catch (err) {
      logger.error({ err, name }, 'codex dispatcher tick failed')
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}
