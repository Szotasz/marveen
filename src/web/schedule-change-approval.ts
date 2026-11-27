// SCHEDPROPOSAL1126: a change to an existing scheduled task, owner fields (preCheck, command, ...) included, proposed by
// any agent and applied by the server only after the owner's approval. The agent_create pattern (agent-create-approval.ts):
//   1. fileScheduleChange: validates the change with the PUT's own checks, stores the canonical {task, base_hash,
//      changes} and opens a schedule_change approval bound to its sha256, with the owner's text rendered from it.
//   2. consumeScheduleChange (registerApprovalConsumer): after the decision committed, in ONE transaction it consumes the
//      approval (the stored hash, once), stamps the spec row, re-hashes the stored JSON and refuses a task edited since
//      the filing (base_hash). Then it applies through applyScheduleUpdate, the PUT's write path.
//   3. sweepScheduleChangeOnStart: an approval decided while the consumer could not run is consumed now; one consumed
//      without an outcome is alerted, never re-run.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, createApproval, consumeApproval, registerApprovalConsumer, createAgentMessage, type Approval } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { canonicalJson } from './agent-create-spec.js'
import { sanitizeScheduleName } from './sanitize.js'
import { readScheduledTask, parseChannelProvider, SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { preCheckScriptPath } from './precheck-path.js'
import { scheduleUpdateProblem, applyScheduleUpdate, type ScheduleUpdate } from './routes/schedules.js'

export const SCHEDULE_CHANGE_CATEGORY = 'schedule_change'
/** The owner decides at his own pace: the approvals' default timeout (DEFAULT_TIMEOUT_MINUTES). */
export const SCHEDULE_CHANGE_TIMEOUT_S = 24 * 3600
export const SCHEDULE_CHANGE_CONSUME_WINDOW_S = 7 * 86400
/** As agent_create: a looping agent must not bury the owner in proposals. */
export const SCHEDULE_CHANGE_MAX_OPEN_PER_REQUESTER = 3
export const SCHEDULE_CHANGE_MAX_OPEN = 20

/** Every field writeScheduledTask writes; anything else is refused, so the owner never sees a field that is not applied. */
const FIELDS: ReadonlyArray<keyof ScheduleUpdate> = [
  'description', 'prompt', 'schedule', 'agent', 'enabled', 'type', 'skipIfBusy', 'forceSend', 'targetSession', 'command',
  'timeoutMs', 'failThreshold', 'preCheck', 'preCheckTimeoutSeconds', 'catchUpMaxAgeMinutes', 'stuckAfterMinutes',
  'injectMetrics', 'sendDigestDirect', 'telegramChatId', 'channelProvider', 'once',
]

/** Each field's JSON type as writeScheduledTask stores it; null only where it clears the field. */
const BOOL_FIELDS = new Set(['enabled', 'skipIfBusy', 'forceSend', 'injectMetrics', 'sendDigestDirect', 'once'])
const NUMBER_FIELDS = new Set(['timeoutMs', 'failThreshold', 'preCheckTimeoutSeconds', 'catchUpMaxAgeMinutes', 'stuckAfterMinutes'])
const NULLABLE_FIELDS = new Set(['preCheck', 'channelProvider'])
const NON_EMPTY_FIELDS = new Set(['prompt', 'schedule', 'agent', 'preCheck'])

/** The first field whose value has the wrong type for the task file, as an error text; null when all fit. */
export function changeTypeProblem(changes: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) { if (NULLABLE_FIELDS.has(k)) continue; return `${k} cannot be null` }
    if (BOOL_FIELDS.has(k)) { if (typeof v !== 'boolean') return `${k} must be true or false`; continue }
    if (NUMBER_FIELDS.has(k)) { if (typeof v !== 'number' || !Number.isFinite(v)) return `${k} must be a finite number`; continue }
    if (typeof v !== 'string') return `${k} must be a string`
    if (NON_EMPTY_FIELDS.has(k) && !v.trim()) return `${k} cannot be empty`
    // description goes raw into the SKILL.md frontmatter: a line break would add frontmatter keys.
    if (k === 'description' && /[\r\n]/.test(v)) return 'description must be one line'
    if (k === 'channelProvider' && !parseChannelProvider(v)) return 'channelProvider is not a known channel'
  }
  return null
}

/** preCheckSha256: the bytes of the proposed preCheck script at filing; the owner approves those, not just a path. */
export interface ScheduleChangeSpec { task: string; base_hash: string; changes: Record<string, string | number | boolean | null>; preCheckSha256?: string }

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex')
const sha256Bytes = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
/** The proposed preCheck script's bytes, or null when it cannot be read. */
function preCheckBytes(task: string, preCheck: string): Buffer | null {
  const p = preCheckScriptPath(join(SCHEDULED_TASKS_DIR, task), preCheck)
  try { return p ? readFileSync(p) : null } catch { return null }
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The owner's text: the task, then each proposed field as stored -> proposed, and the check code. */
export function renderScheduleChange(spec: ScheduleChangeSpec, current: Record<string, unknown>, hash: string, lang: 'hu' | 'en'): string {
  const lines = Object.keys(spec.changes).sort().map((k) => `- ${k}: ${JSON.stringify(current[k] ?? null)} -> ${JSON.stringify(spec.changes[k])}`)
  const script = spec.preCheckSha256 && typeof spec.changes.preCheck === 'string' ? preCheckBytes(spec.task, spec.changes.preCheck) : null
  const head = script ? JSON.stringify(script.subarray(0, 300).toString('utf8')) : ''
  const pre = spec.preCheckSha256
    ? [lang === 'hu'
        ? `A preCheck-szkript tartalma kötve (sha256 ${spec.preCheckSha256.slice(0, 16)}), ha eltér, nem fut le. Eleje: ${head}`
        : `The preCheck script's bytes are bound (sha256 ${spec.preCheckSha256.slice(0, 16)}); if they differ, nothing is applied. Start: ${head}`]
    : []
  return lang === 'hu'
    ? [`Ütemezett feladat módosítása: ${spec.task}`, 'A szerver pontosan ezeket a mezőket írja át (jelenlegi -> javasolt):', ...lines, ...pre, `Ellenőrző kód: ${hash.slice(0, 8)}`].join('\n')
    : [`Scheduled task change: ${spec.task}`, 'The server writes exactly these fields (current -> proposed):', ...lines, ...pre, `Check code: ${hash.slice(0, 8)}`].join('\n')
}

export function fileScheduleChange(body: unknown, requestedBy: string, lang: 'hu' | 'en'): { status: number; body: Record<string, unknown> } {
  if (!isObj(body) || typeof body.task !== 'string' || !isObj(body.changes)) return { status: 400, body: { error: 'body must be {"task": "<name>", "changes": {<field>: <value>, ...}}' } }
  const task = body.task
  if (!task || sanitizeScheduleName(task) !== task) return { status: 400, body: { error: 'task must be an existing task name' } }
  const current = readScheduledTask(task)
  if (!current?.contentHash) return { status: 404, body: { error: 'Schedule not found (a proposal changes an existing task only)' } }
  // Own tasks only (Marveen 19025): an injected agent must not put another agent's schedule before the owner.
  if (requestedBy !== MAIN_AGENT_ID && current.agent !== requestedBy) {
    return { status: 403, body: { error: `A sub-agent proposes changes to its own tasks only; ${task} belongs to ${current.agent}` } }
  }
  const keys = Object.keys(body.changes)
  if (keys.length === 0) return { status: 400, body: { error: 'changes is empty' } }
  const unknown = keys.filter((k) => !(FIELDS as readonly string[]).includes(k))
  if (unknown.length) return { status: 400, body: { error: `Not a task field: ${unknown.join(', ')}`, fields: unknown } }
  const changes = body.changes as ScheduleChangeSpec['changes']
  if (Object.values(changes).some((v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) {
    return { status: 400, body: { error: 'every value must be a string, number, boolean or null' } }
  }
  const typeProblem = changeTypeProblem(changes)
  if (typeProblem) return { status: 400, body: { error: typeProblem } }
  const problem = scheduleUpdateProblem(changes as ScheduleUpdate)
  if (problem) return { status: problem.status, body: { error: problem.error } }
  const spec: ScheduleChangeSpec = { task, base_hash: current.contentHash, changes: { ...changes } }
  if (typeof changes.preCheck === 'string') {
    const bytes = preCheckBytes(task, changes.preCheck)
    if (!bytes) return { status: 400, body: { error: 'preCheck script not found or not readable; create it first, then propose' } }
    spec.preCheckSha256 = sha256Bytes(bytes)
  }
  const json = canonicalJson(spec)
  const hash = sha256(json)
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // The count and the insert in one synchronous transaction (the agent_create lesson, Dani 81221).
  const filed = getDb().transaction((): boolean => {
    const open = getDb().prepare(`
      SELECT agent_id FROM approvals WHERE category = ? AND status = 'pending' AND (timeout_at IS NULL OR timeout_at > ?)
    `).all(SCHEDULE_CHANGE_CATEGORY, now) as Array<{ agent_id: string }>
    if (open.length >= SCHEDULE_CHANGE_MAX_OPEN || open.filter((o) => o.agent_id === requestedBy).length >= SCHEDULE_CHANGE_MAX_OPEN_PER_REQUESTER) return false
    createApproval({ id, agent_id: requestedBy, category: SCHEDULE_CHANGE_CATEGORY, action_description: renderScheduleChange(spec, current as unknown as Record<string, unknown>, hash, lang), action_payload: null, timeout_at: now + SCHEDULE_CHANGE_TIMEOUT_S, content_hash: hash })
    getDb().prepare(`
      INSERT INTO schedule_change_specs (approval_id, task_name, spec_json, content_hash, base_hash, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, task, json, hash, spec.base_hash, requestedBy, now)
    return true
  })()
  if (!filed) return { status: 429, body: { error: 'Too many open schedule_change proposals; wait for the owner to decide the open ones.' } }
  logger.info({ approvalId: id, requestedBy, task, fields: keys }, 'schedule_change proposal filed; waiting for the owner')
  return { status: 201, body: { ok: true, approvalId: id, contentHash: hash } }
}

/** The stored outcome of a proposal (applied, refused:..., failed:...), null while none is recorded. */
export function scheduleChangeOutcome(approvalId: string): string | null {
  const row = getDb().prepare('SELECT outcome FROM schedule_change_specs WHERE approval_id = ?').get(approvalId) as { outcome: string | null } | undefined
  return row?.outcome ?? null
}

function setOutcome(approvalId: string, outcome: string): void {
  getDb().prepare('UPDATE schedule_change_specs SET outcome = ?, outcome_at = ? WHERE approval_id = ?').run(outcome, Math.floor(Date.now() / 1000), approvalId)
}

function alertMain(text: string): void {
  try { createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.error({ err }, 'schedule_change alert to the main agent failed') }
}

interface SpecRow { spec_json: string; content_hash: string; base_hash: string }
export type ConsumeStep = { go: true; spec: ScheduleChangeSpec } | { go: false; reason: string }

/** The transaction: consume, stamp, re-check the stored JSON and the task's base. Exported for the tests. */
export function consumeScheduleChangeStep(approvalId: string): ConsumeStep {
  const db = getDb()
  return db.transaction((): ConsumeStep => {
    const row = db.prepare('SELECT spec_json, content_hash, base_hash FROM schedule_change_specs WHERE approval_id = ?').get(approvalId) as SpecRow | undefined
    if (!row) return { go: false, reason: 'no_spec' }
    const c = consumeApproval({ id: approvalId, contentHash: row.content_hash, consumer: SCHEDULE_CHANGE_CATEGORY, messageId: approvalId, windowSeconds: SCHEDULE_CHANGE_CONSUME_WINDOW_S, category: SCHEDULE_CHANGE_CATEGORY })
    if (!c.ok) return { go: false, reason: `consume_refused:${c.reason}` }
    const stamped = db.prepare('UPDATE schedule_change_specs SET consumed_at = ? WHERE approval_id = ? AND consumed_at IS NULL').run(Math.floor(Date.now() / 1000), approvalId).changes
    if (stamped !== 1) throw new Error('schedule_change spec already consumed while its approval was not')
    const refuse = (reason: string): ConsumeStep => { setOutcome(approvalId, `refused:${reason}`); return { go: false, reason } }
    if (sha256(row.spec_json) !== row.content_hash) return refuse('spec_changed')
    const spec = JSON.parse(row.spec_json) as ScheduleChangeSpec
    if (spec.base_hash !== row.base_hash) return refuse('spec_changed')
    // The owner approved a change of the task as it was; an edit since then would be overwritten unseen.
    if (readScheduledTask(spec.task)?.contentHash !== spec.base_hash) return refuse('task_changed_since_proposal')
    if (spec.preCheckSha256) {
      const bytes = typeof spec.changes.preCheck === 'string' ? preCheckBytes(spec.task, spec.changes.preCheck) : null
      if (!bytes || sha256Bytes(bytes) !== spec.preCheckSha256) return refuse('precheck_script_changed')
    }
    return { go: true, spec }
  })()
}

/** The schedule_change consumer: called by the decision core after an approval of this category committed. */
export function consumeScheduleChange(approval: Approval): void {
  const step = consumeScheduleChangeStep(approval.id)
  if (!step.go) {
    if (!step.reason.startsWith('consume_refused:already_consumed')) {
      alertMain(`Az ütemezés-módosítás jóváhagyott kérése (${approval.id}) nem futott le: ${step.reason}. Semmi nem változott.`)
    }
    return
  }
  try {
    const r = applyScheduleUpdate(step.spec.task, step.spec.changes as ScheduleUpdate, 'approval:schedule_change')
    if (r.status === 200) {
      setOutcome(approval.id, 'applied')
      logger.info({ approvalId: approval.id, task: step.spec.task }, 'schedule_change applied from an approved proposal')
      return
    }
    setOutcome(approval.id, `failed:${r.status}:${String(r.body.error ?? '')}`)
    alertMain(`Az ütemezés-módosítás jóváhagyott kérése (${approval.id}, ${step.spec.task}) nem ment át: ${r.status} ${String(r.body.error ?? '')}.`)
  } catch (err) {
    setOutcome(approval.id, `failed:exception:${err instanceof Error ? err.message : String(err)}`)
    alertMain(`Az ütemezés-módosítás jóváhagyott kérése (${approval.id}, ${step.spec.task}) hibával megállt: ${err instanceof Error ? err.message : String(err)}. Nézd meg a feladatot.`)
  }
}

let registered = false
export function registerScheduleChangeConsumer(): void {
  if (registered) return
  registerApprovalConsumer(SCHEDULE_CHANGE_CATEGORY, consumeScheduleChange)
  registered = true
}

export function sweepScheduleChangeOnStart(): { consumed: number; interrupted: number } {
  const db = getDb()
  const pending = db.prepare(`
    SELECT a.* FROM approvals a JOIN schedule_change_specs s ON s.approval_id = a.id
    WHERE a.category = ? AND a.status = 'approved' AND a.consumed_at IS NULL AND s.consumed_at IS NULL
  `).all(SCHEDULE_CHANGE_CATEGORY) as Approval[]
  const interrupted = db.prepare('SELECT approval_id FROM schedule_change_specs WHERE consumed_at IS NOT NULL AND outcome IS NULL').all() as Array<{ approval_id: string }>
  for (const r of interrupted) {
    setOutcome(r.approval_id, 'interrupted')
    alertMain(`Az ütemezés-módosítás jóváhagyott kérése (${r.approval_id}) a fogyasztás után megszakadt (újraindulás). Nem futtatom újra: nézd meg a feladatot, és ha kell, kérd újra.`)
  }
  for (const a of pending) consumeScheduleChange(a)
  return { consumed: pending.length, interrupted: interrupted.length }
}
