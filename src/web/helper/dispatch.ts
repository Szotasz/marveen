// Schedule-runner glue for the local helper (docs/superpowers/specs/2026-10-26-local-helper-task-routing-design.md
// 4.4). helperDispatch() is called for every due task, next to the `command`
// branch. It returns false -- and the task runs exactly as it always did --
// unless ALL of these hold:
//   1. HELPER_ENABLED=1 (the first thing read: with it off nothing else is
//      touched, no provider file, no state file);
//   2. the task has a helper type (helperType, a watch spec, or it is the
//      seeded rotation heartbeat);
//   3. HELPER_PROVIDER_ID names an existing custom provider that ticks that
//      type;
//   4. this PR implements the type (watch, wake, rotationDecision; the other
//      three are data model + UI only and keep the old path).
// When it returns true the work runs asynchronously (no tmux, no session) and
// the runner records the tick like a command task.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, WEB_HOST, WEB_PORT } from '../../config.js'
import { logger } from '../../logger.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { appendTaskRun, createAgentMessage, getKanbanComments, listAgentMessagesForWatch, markTaskRunCompleted } from '../../db.js'
import { sendOwnerMessage } from '../../notify.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { listAgentNames } from '../agent-config.js'
import { loadCustomProvider, effectiveTaskTypes, effectiveFallback, type CustomProviderDef } from '../custom-providers.js'
import { getSecret } from '../vault.js'
import { loadOrCreateDashboardToken } from '../dashboard-auth.js'
import { trackDetachedGroup } from '../detached-groups.js'
import { writeScheduledTask, type ScheduledTask } from '../scheduled-tasks-io.js'
import { rewriteRegisteredTask } from '../schedule-registry-rewrite.js'
import { ROTATION_HEARTBEAT_TASK } from '../claude-rotation-heartbeat.js'
import { helperTypeForWatch, parseHelperType, validateWatchSpec, type HelperTaskType, type WatchSpec } from './types.js'
import { callHelperDecision } from './decision.js'
import { evaluateHelperCall, shouldAttemptCall, countSkipped, outageText, type HelperHealth } from './health.js'
import { evaluateWatch, buildEscalationMessage, type WatchItem, type WatchState, type JudgeOutcome } from './watch-engine.js'
import { runRotationDecision } from './rotation.js'

export const HELPER_SENDER_ID = 'helper'
const RUNS_LOG = join(STORE_DIR, 'helper-runs.jsonl')
const WATCH_STATE_PATH = join(STORE_DIR, 'helper-watch-state.json')
const HEALTH_PATH = join(STORE_DIR, 'helper-health.json')
const ROTATE_CHECK_TIMEOUT_MS = 120_000

function setting(key: string): string {
  try { return String(getEffectiveSettingValue(key) ?? '').trim() } catch { return '' }
}

export function isHelperEnabled(): boolean {
  return setting('HELPER_ENABLED') === '1'
}

/** The helper type a task asks for, or undefined (an ordinary task). */
export function taskHelperType(task: Pick<ScheduledTask, 'name' | 'helperType' | 'watch' | 'type'>): HelperTaskType | undefined {
  if (task.watch) return helperTypeForWatch(task.watch)
  if (task.helperType) return task.helperType
  // The seeded rotation heartbeat predates the field: recognised by name, and
  // only while it is still the LLM heartbeat it was seeded as.
  if (task.name === ROTATION_HEARTBEAT_TASK && task.type === 'heartbeat') return 'rotationDecision'
  return undefined
}

const IMPLEMENTED: ReadonlySet<HelperTaskType> = new Set(['watch', 'wake', 'rotationDecision'])

export type HelperRoute =
  | { handled: false; reason: 'disabled' | 'not-helper-task' | 'no-provider' | 'not-ticked' | 'not-implemented' | 'no-watch-spec' }
  | { handled: true; type: HelperTaskType; provider: CustomProviderDef }

export interface RouteDeps {
  enabled: () => boolean
  providerId: () => string
  loadProvider: (id: string) => CustomProviderDef | null
}

export const defaultRouteDeps: RouteDeps = {
  enabled: isHelperEnabled,
  providerId: () => setting('HELPER_PROVIDER_ID'),
  loadProvider: loadCustomProvider,
}

/** Pure routing decision (the dispatch matrix the tests pin). */
export function resolveHelperRoute(task: ScheduledTask, deps: RouteDeps = defaultRouteDeps): HelperRoute {
  if (!deps.enabled()) return { handled: false, reason: 'disabled' }
  const type = taskHelperType(task)
  if (!type) return { handled: false, reason: 'not-helper-task' }
  const id = deps.providerId()
  const provider = id ? deps.loadProvider(id) : null
  if (!provider) return { handled: false, reason: 'no-provider' }
  if (!effectiveTaskTypes(provider)[type]) return { handled: false, reason: 'not-ticked' }
  if (!IMPLEMENTED.has(type)) return { handled: false, reason: 'not-implemented' }
  if ((type === 'watch' || type === 'wake') && !task.watch) return { handled: false, reason: 'no-watch-spec' }
  return { handled: true, type, provider }
}

/**
 * POST /api/schedules: validates the optional helperType / watch fields.
 * Absent fields -> {} (the route behaves exactly as before). A watch is only
 * accepted while the helper would take the task (see the route comment).
 */
export function validateHelperTaskFields(
  data: { helperType?: unknown; watch?: unknown },
  agent: string,
  deps: RouteDeps = defaultRouteDeps,
): { error?: string; status?: number; helperType?: HelperTaskType; watch?: WatchSpec } {
  if (data.helperType === undefined && data.watch === undefined) return {}
  let helperType: HelperTaskType | undefined
  if (data.helperType !== undefined) {
    helperType = parseHelperType(data.helperType)
    if (!helperType) return { error: 'helperType must be one of watch, wake, quietHeartbeat, rotationDecision, triage, summary' }
  }
  let watch: WatchSpec | undefined
  if (data.watch !== undefined) {
    const v = validateWatchSpec(data.watch)
    if (typeof v === 'string') return { error: v }
    watch = v
    const implied = helperTypeForWatch(v)
    if (helperType && helperType !== implied) return { error: `helperType ${helperType} does not match watch.kind ${v.kind} (expected ${implied})` }
    helperType = implied
  } else if (helperType === 'watch' || helperType === 'wake') {
    return { error: `helperType ${helperType} needs a watch spec` }
  }
  if (watch) {
    const route = resolveHelperRoute({ name: '', description: '', prompt: '', schedule: '', agent, enabled: true, createdAt: 0, watch, helperType }, deps)
    if (!route.handled) return { error: `helper_not_active: the helper would not take this watch (${route.reason}); with HELPER_ENABLED=1 and a HELPER_PROVIDER_ID that ticks ${helperType}`, status: 409 }
  }
  return { helperType, watch }
}

// ---- persisted state -------------------------------------------------------

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T } catch { return fallback }
}
function writeJson(path: string, value: unknown): void {
  try { atomicWriteFileSync(path, JSON.stringify(value, null, 2)) } catch (err) { logger.warn({ err, path }, 'helper: state write failed') }
}

function logRun(entry: Record<string, unknown>): void {
  try { appendFileSync(RUNS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n') } catch { /* audit is best effort */ }
}

function recordTaskRun(task: ScheduledTask, outcome: 'done' | 'skipped'): void {
  try {
    if (outcome === 'skipped') { appendTaskRun(task.name, task.agent || MAIN_AGENT_ID, 'skipped'); return }
    const runId = appendTaskRun(task.name, task.agent || MAIN_AGENT_ID)
    markTaskRunCompleted(runId, 'done')
  } catch { /* non-fatal, same as command tasks */ }
}

// ---- provider health (one owner note per outage) ---------------------------

/**
 * Feeds one call result into the provider's health and sends the owner note
 * on a transition. Exported with injectable I/O for the outage test.
 */
export async function noteProviderCall(
  provider: CustomProviderDef,
  ok: boolean,
  nowMs: number,
  io: { read: () => Record<string, HelperHealth>; write: (m: Record<string, HelperHealth>) => void; notify: (text: string) => Promise<unknown> },
): Promise<void> {
  const map = io.read()
  const prev = map[provider.id]
  const { next, action } = evaluateHelperCall(prev, ok, nowMs)
  map[provider.id] = next
  io.write(map)
  if (action === 'down') await io.notify(outageText(provider.label, 'down', next))
  else if (action === 'recover' && prev) await io.notify(outageText(provider.label, 'recover', prev))
}

const healthIo = {
  read: () => readJson<Record<string, HelperHealth>>(HEALTH_PATH, {}),
  write: (m: Record<string, HelperHealth>) => writeJson(HEALTH_PATH, m),
  notify: (text: string) => sendOwnerMessage(text).catch((err) => { logger.warn({ err }, 'helper: owner note failed') }),
}

function bumpSkipped(providerId: string): void {
  const m = healthIo.read()
  m[providerId] = countSkipped(m[providerId])
  healthIo.write(m)
}

async function judgeWithProvider(provider: CustomProviderDef, question: string, item: WatchItem, nowMs: number): Promise<JudgeOutcome> {
  // While down, one real call per retry window doubles as the recovery probe;
  // every other item fails fast instead of waiting out a 30 s timeout.
  if (!shouldAttemptCall(healthIo.read()[provider.id], nowMs)) {
    bumpSkipped(provider.id)
    return { kind: 'unavailable' }
  }
  const res = await callHelperDecision(provider, question, `${item.author}: ${item.content}`, { fetch, getSecret })
  await noteProviderCall(provider, res.ok, Date.now(), healthIo)
  if (!res.ok) {
    logger.warn({ provider: provider.id, error: res.error, detail: res.detail }, 'helper: decision call failed')
    if (healthIo.read()[provider.id]?.downSince != null) bumpSkipped(provider.id)
    return { kind: 'unavailable' }
  }
  return res.decision.action === 'escalate'
    ? { kind: 'escalate', reason: res.decision.reason }
    : { kind: 'skip', reason: res.decision.reason }
}

// ---- watch ------------------------------------------------------------------

function knownAgent(id: string): boolean {
  if (!id || id === 'system' || id === HELPER_SENDER_ID) return false
  if (id === MAIN_AGENT_ID) return true
  try { return listAgentNames().includes(id) } catch { return false }
}

/** Escalation target allowlist (SPEC.md 7): a known agent, never system. */
export function resolveEscalationTarget(wanted: string | undefined, taskAgent: string, fallbackAgent: string | undefined, isKnown: (id: string) => boolean = knownAgent): string {
  for (const c of [wanted, taskAgent, fallbackAgent]) if (c && isKnown(c)) return c
  return MAIN_AGENT_ID
}

function listWatchItems(spec: WatchSpec, afterId: number | null, sinceSec: number): WatchItem[] {
  if (spec.kind === 'kanban-comment') {
    return getKanbanComments(spec.target)
      .map((c) => ({ id: c.id, author: c.author, content: c.content, createdAt: c.created_at }))
      .sort((a, b) => a.id - b.id)
  }
  if (spec.kind === 'message') {
    return listAgentMessagesForWatch({ afterId, sinceSec, from: spec.target === '*' ? null : spec.target, to: spec.to ?? null })
      .map((m) => ({ id: m.id, author: m.from_agent, content: m.content, createdAt: m.created_at }))
  }
  return []
}

function disableWatchTask(name: string): void {
  try {
    rewriteRegisteredTask(name, 'server:helper-watch-done', () => { writeScheduledTask(name, { enabled: false }); return true })
  } catch (err) {
    logger.warn({ err, task: name }, 'helper: finished watch could not be switched off')
  }
}

async function runWatchTask(task: ScheduledTask, type: HelperTaskType, provider: CustomProviderDef, nowMs: number): Promise<void> {
  const spec = task.watch!
  const states = readJson<Record<string, WatchState>>(WATCH_STATE_PATH, {})
  const result = await evaluateWatch(task.prompt, task.createdAt, spec, states[task.name], {
    nowMs,
    listItems: listWatchItems,
    judge: (q, item) => judgeWithProvider(provider, q, item, nowMs),
    fallback: effectiveFallback(provider)[type],
  })
  const fresh = readJson<Record<string, WatchState>>(WATCH_STATE_PATH, {})
  fresh[task.name] = result.nextState
  writeJson(WATCH_STATE_PATH, fresh)

  if (result.event) {
    const to = resolveEscalationTarget(spec.escalateTo, task.agent, provider.fallbackAgent)
    const content = buildEscalationMessage({ taskName: task.name, helperType: type, spec, event: result.event, escalated: result.escalated })
    try {
      const msg = createAgentMessage(HELPER_SENDER_ID, to, content, `helper:${task.name}`)
      logRun({ task: task.name, type, outcome: 'escalate', event: result.event, to, msgId: msg.id, items: result.escalated.map((e) => ({ id: e.item.id, via: e.via })), modelCalls: result.modelCalls })
    } catch (err) {
      // Not sent = not done: leave the watch on, the state already moved past
      // these items, so put them back as pending for the next tick.
      logger.warn({ err, task: task.name }, 'helper: escalation message could not be queued')
      const back = readJson<Record<string, WatchState>>(WATCH_STATE_PATH, {})
      const ids = result.escalated.map((e) => e.item.id)
      back[task.name] = { ...result.nextState, pending: [...new Set([...result.nextState.pending, ...ids])] }
      writeJson(WATCH_STATE_PATH, back)
      return
    }
    if (result.done) disableWatchTask(task.name)
    recordTaskRun(task, 'done')
    return
  }
  logRun({ task: task.name, type, outcome: 'skip', modelCalls: result.modelCalls, skippedByModel: result.skippedByModel, pending: result.nextState.pending.length })
}

// ---- rotation ---------------------------------------------------------------

function runRotateCheckProcess(): Promise<{ ok: boolean; stdout: string; detail: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('npx', ['tsx', join(PROJECT_ROOT, 'scripts', 'claude-plan-rotate-check.ts')], { cwd: PROJECT_ROOT, detached: true })
    } catch (err) {
      resolve({ ok: false, stdout: '', detail: (err as Error).message }); return
    }
    const untrack = trackDetachedGroup(child.pid, 'helper:rotate-check')
    let stdout = ''
    let settled = false
    const done = (r: { ok: boolean; stdout: string; detail: string }) => {
      if (settled) return
      settled = true; clearTimeout(timer); untrack(); resolve(r)
    }
    const timer = setTimeout(() => {
      try { if (child.pid != null) process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
      done({ ok: false, stdout, detail: `timeout ${ROTATE_CHECK_TIMEOUT_MS}ms` })
    }, ROTATE_CHECK_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 16_000) stdout += d.toString() })
    child.stderr?.resume()
    child.on('error', (err) => done({ ok: false, stdout, detail: err.message }))
    child.on('close', (code) => done(code === 0 ? { ok: true, stdout, detail: 'exit 0' } : { ok: false, stdout, detail: `exit ${code}` }))
  })
}

async function postRotateLoopback(targetPlanId: string): Promise<{ status: number; body: unknown }> {
  const host = WEB_HOST === '0.0.0.0' || WEB_HOST === '::' ? '127.0.0.1' : WEB_HOST
  try {
    const res = await fetch(`http://${host}:${WEB_PORT}/api/claude-plans/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${loadOrCreateDashboardToken()}` },
      body: JSON.stringify({ targetPlanId }),
    })
    let body: unknown = null
    try { body = await res.json() } catch { body = null }
    return { status: res.status, body }
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : 'request failed' } }
  }
}

async function runRotationTask(task: ScheduledTask, provider: CustomProviderDef, fallbackRun: (name: string) => Promise<unknown>): Promise<void> {
  const fallback = effectiveFallback(provider).rotationDecision
  const outcome = await runRotationDecision({
    runCheck: runRotateCheckProcess,
    notifyOwner: (text) => sendOwnerMessage(text).catch(() => ({ sent: false })),
    postRotate: postRotateLoopback,
    fallback,
    fallbackRun: () => fallbackRun(task.name),
  })
  logRun({ task: task.name, type: 'rotationDecision', outcome: outcome.kind, ...(outcome.kind === 'acted' ? { lines: outcome.lines, rotateStatus: outcome.rotateStatus } : {}), ...(outcome.kind === 'check-failed' ? { fallback: outcome.fallback, detail: outcome.detail } : {}) })
  if (outcome.kind === 'check-failed') {
    logger.warn({ task: task.name, detail: outcome.detail, fallback }, 'helper: rotation check could not run')
    if (fallback === 'skip') recordTaskRun(task, 'skipped')
    return
  }
  recordTaskRun(task, 'done')
}

// ---- the runner entry point ------------------------------------------------

export interface HelperDispatchDeps {
  /** Fires the task the old way (an LLM turn in its agent); used by fallback 'opus'. */
  fallbackRun: (taskName: string) => Promise<unknown>
  route?: RouteDeps
}

const inFlight = new Set<string>()

/**
 * True when the helper took the task this tick (the runner then records the
 * tick and moves on). False = run it exactly as before.
 */
export function helperDispatch(task: ScheduledTask, nowMs: number, deps: HelperDispatchDeps): boolean {
  const route = resolveHelperRoute(task, deps.route)
  if (!route.handled) return false
  if (inFlight.has(task.name)) {
    logger.info({ task: task.name }, 'helper: previous run still in flight, skipping this tick')
    return true
  }
  inFlight.add(task.name)
  const work = route.type === 'rotationDecision'
    ? runRotationTask(task, route.provider, deps.fallbackRun)
    : runWatchTask(task, route.type, route.provider, nowMs)
  void work
    .catch((err) => logger.warn({ err, task: task.name }, 'helper: run failed'))
    .finally(() => inFlight.delete(task.name))
  return true
}
