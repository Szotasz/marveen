import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  listPendingTaskRetries, deletePendingTaskRetryById, listTaskRunHistory,
} from '../../db.js'
import { MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { toPendingRetryView } from '../../pending-retries.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { isValidCronShape } from '../cron.js'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { sanitizeScheduleName, safeJoin } from '../sanitize.js'
import { listAgentNames } from '../agent-config.js'
import { readFileOr, readJsonObjectForWrite } from '../agent-config.js'
import {
  SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN,
  listScheduledTasks, writeScheduledTask, markDefaultTaskRemoved, readScheduledTask,
  type ScheduledTaskWritten, type ScheduledTask,
} from '../scheduled-tasks-io.js'
import {
  registerScheduledTask, unregisterScheduledTask, verifyScheduledTask, describeVerdict,
} from '../schedule-registry.js'
import { runScheduledTaskNow } from '../schedule-runner.js'
import { validateHelperTaskFields } from '../helper/dispatch.js'
import type { RouteContext } from './types.js'

// Resolve a URL-supplied schedule name to an on-disk dir, blocking path
// traversal. sanitizeScheduleName strips everything outside [a-z0-9-] (so no
// "." or "/" survives), the empty check rejects a name that sanitized away
// (which would otherwise resolve to the tasks root and delete/overwrite it),
// and safeJoin is a belt-and-suspenders guard against escaping the base.
function resolveScheduleDir(rawName: string): { name: string; dir: string } | null {
  let decoded: string
  try { decoded = decodeURIComponent(rawName) } catch { return null }
  const name = sanitizeScheduleName(decoded)
  if (!name) return null
  try {
    return { name, dir: safeJoin(SCHEDULED_TASKS_DIR, name) }
  } catch { return null }
}

// HBSCHEDSZAM903: the hourly heartbeat digest's "enabled schedules" figure was
// the ONE number the agent computed itself (counting enabled:true in the raw
// /api/schedules array), and it drifted to a 13x error (376 reported vs 29
// real). Serve the counts pre-computed so the digest copies a number instead
// of deriving one. Pure and exported so the counting rule is unit-testable.
export function summarizeScheduledTasks(tasks: Array<{ enabled?: boolean }>): { total: number; enabled: number; disabled: number } {
  // The same rule the toggle route uses: a task is enabled unless enabled is
  // explicitly false (absent field = enabled).
  const enabled = tasks.filter(t => t.enabled !== false).length
  return { total: tasks.length, enabled, disabled: tasks.length - enabled }
}

// Scheduled-task registry: an in-place edit (PUT / toggle) rewrites the
// task starting from its CURRENT files and then registers the result. If those
// files were changed outside the API, re-registering would launder the foreign
// content (a toggle carries no prompt, a PUT rarely carries every config field),
// so the edit is refused until the operator reviews and re-registers the task
// (schedule-registry-cli) or deletes and re-creates it.
function refuseIfForeign(res: RouteContext['res'], name: string): boolean {
  const current = readScheduledTask(name)
  if (!current) return false
  const v = verifyScheduledTask(current)
  if (v.ok) return false
  json(res, {
    error: `Schedule files changed outside the dashboard API: ${describeVerdict(v)}. ` +
      `Review the files, then re-register (node dist/web/schedule-registry-cli.js register ${name}) or delete and re-create the task.`,
    registry: v.reason,
  }, 409)
  return true
}

// Record the just-written files as trusted: the bytes the route WROTE, not
// whatever is on disk a moment later (a concurrent writer in between makes the
// hashes differ and nothing is registered). A failure leaves a task on disk
// the runner will refuse (fail-closed), so the caller must hear about it.
// A create writes only SKILL.md and task-config.json into a dir that did not
// exist, so it also refuses any other file found there (noUnwrittenDirFiles).
function registerAfterWrite(
  res: RouteContext['res'], name: string, source: string, written: ScheduledTaskWritten | undefined,
  opts: { noUnwrittenDirFiles?: boolean } = {},
): boolean {
  try {
    if (registerScheduledTask(name, source, written, opts)) return true
  } catch (err) {
    logger.error({ err, name }, 'schedule-registry: registration after API write failed')
  }
  json(res, { error: 'Schedule written but NOT registered; the runner will not fire it until it is re-saved or re-registered' }, 500)
  return false
}

// The list form of a task: everything but the prompt, which is replaced by its length and
// sha256 (card 12b0f698).
export function withoutPrompt(task: ScheduledTask): Omit<ScheduledTask, 'prompt'> & { promptLength: number; promptSha256: string } {
  const { prompt, ...rest } = task
  return { ...rest, promptLength: prompt.length, promptSha256: createHash('sha256').update(prompt).digest('hex') }
}

export async function tryHandleSchedules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/schedules/agents' && method === 'GET') {
    const agentNames = listAgentNames()
    const agents = [
      { name: MAIN_AGENT_ID, label: currentBotName(), avatar: '/api/marveen/avatar' },
      ...agentNames.map(n => ({ name: n, label: n, avatar: `/api/agents/${encodeURIComponent(n)}/avatar` }))
    ]
    json(res, agents)
    return true
  }

  if (path === '/api/schedules/expand-questions' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, agent } = JSON.parse(body.toString()) as { prompt: string; agent?: string }
    if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

    const aiPrompt = `A felhasznalo egy utemezett feladatot akar letrehozni egy AI agensnek. A rovid leirasa:
"${prompt.trim()}"
${agent ? `Az agens neve: ${agent}` : ''}

Generalj 3-4 feleletvalasztos kerdest, amivel pontositani lehet a feladatot. Minden kerdeshez adj 2-4 valaszlehetoseget.

Valaszolj KIZAROLAG JSON formatumban, semmi mas:
[
  {"question": "Kerdes szovege?", "options": ["Opcio 1", "Opcio 2", "Opcio 3"]},
  {"question": "Masik kerdes?", "options": ["A", "B"]}
]`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) throw new Error('Invalid response format')
      const questions = JSON.parse(jsonMatch[0])
      json(res, questions)
    } catch (err) {
      logger.error({ err }, 'Failed to generate expand questions')
      json(res, { error: 'Failed to generate questions' }, 500)
    }
    return true
  }

  if (path === '/api/schedules/expand-prompt' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, answers } = JSON.parse(body.toString()) as { prompt: string; answers: { question: string; answer: string }[] }
    if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

    const answersText = answers.map((a: { question: string; answer: string }) => `Kerdes: ${a.question}\nValasz: ${a.answer}`).join('\n\n')

    const aiPrompt = `Bovitsd ki ezt a rovid feladat-leirast egy reszletes, egyertelmu promptta amit egy AI asszisztens vegre tud hajtani.
A prompt legyen magyar nyelvu, konkret utasitasokkal.

Rovid leiras: "${prompt.trim()}"

A felhasznalo valaszai a pontosito kerdesekre:
${answersText}

Az eredmeny CSAK a kibovitett prompt szovege legyen, semmi mas. Ne hasznalj code fence-t.`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      let expanded = text.trim()
      if (expanded.startsWith('```')) expanded = expanded.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      json(res, { prompt: expanded })
    } catch (err) {
      logger.error({ err }, 'Failed to expand prompt')
      json(res, { error: 'Failed to expand prompt' }, 500)
    }
    return true
  }

  // Card 12b0f698: the list leaves the prompts out unless asked (?include=prompt). About
  // 2338 tasks travel on every read, and most readers want a name, a cron or a flag; the
  // prompt's length and sha256 stay, so a changed prompt is still visible. The dashboard's
  // schedule editor asks for the prompts (web/app.js loadSchedules).
  if (path === '/api/schedules' && method === 'GET') {
    const include = ctx.url.searchParams.get('include')
    if (include !== null && include !== 'prompt') {
      json(res, { error: 'unknown include', include, accepted: ['prompt'] }, 400)
      return true
    }
    // `registry`: 'ok' when the runner would fire the task, else the reason it
    // will not ('unregistered', 'hash-mismatch', 'no-hash', 'registry-error'),
    // so an operator sees a skipped task without reading the log. Verified on
    // the full task, before the list form drops the prompt.
    json(res, listScheduledTasks().map(t => {
      const v = verifyScheduledTask(t)
      const registry = v.ok ? 'ok' : v.reason
      return include === 'prompt' ? { ...t, registry } : { ...withoutPrompt(t), registry }
    }))
    return true
  }

  if (path === '/api/schedules/summary' && method === 'GET') {
    json(res, summarizeScheduledTasks(listScheduledTasks()))
    return true
  }

  if (path === '/api/schedules' && method === 'POST') {
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      name: string; description: string; prompt: string; schedule: string; agent?: string; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; once?: boolean; helperType?: unknown; watch?: unknown
    }
    const name = sanitizeScheduleName(data.name || '')
    if (!name) { json(res, { error: 'Name is required' }, 400); return true }
    if (!data.prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }
    if (data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (!data.schedule?.trim()) { json(res, { error: 'Schedule is required' }, 400); return true }
    if (!isValidCronShape(data.schedule)) { json(res, { error: 'Invalid cron expression' }, 400); return true }
    if (data.once !== undefined && typeof data.once !== 'boolean') { json(res, { error: 'once must be true or false' }, 400); return true }

    // Local helper fields (work/local-model-routing/SPEC.md 4.3). Only checked
    // when sent, so every existing caller is untouched. A watch is refused
    // unless the helper would actually take it: written while the helper is
    // off, the task would fire as an ordinary LLM turn on every tick of its
    // (typically one-minute) schedule -- the exact burn the helper removes.
    const helperFields = validateHelperTaskFields(data, (data.agent || MAIN_AGENT_ID))
    if (helperFields.error) { json(res, { error: helperFields.error }, helperFields.status ?? 400); return true }

    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (existsSync(dir)) { json(res, { error: 'Schedule already exists' }, 409); return true }

    const written = writeScheduledTask(name, {
      description: data.description || '',
      prompt: data.prompt.trim(),
      schedule: data.schedule.trim(),
      agent: data.agent || MAIN_AGENT_ID,
      enabled: true,
      type: data.type || 'task',
      skipIfBusy: data.skipIfBusy === true,
      forceSend: data.forceSend === true,
      targetSession: data.targetSession || undefined,
      once: data.once,
      ...(helperFields.helperType ? { helperType: helperFields.helperType } : {}),
      ...(helperFields.watch ? { watch: helperFields.watch } : {}),
    })
    if (!registerAfterWrite(res, name, 'api:create', written, { noUnwrittenDirFiles: true })) return true
    logger.info({ name, schedule: data.schedule, once: data.once === true }, 'Scheduled task created')
    json(res, { ok: true, name })
    return true
  }

  const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleUpdateMatch && method === 'PUT') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string; once?: boolean; preCheck?: string
    }
    if (data.once !== undefined && typeof data.once !== 'boolean') {
      json(res, { error: 'once must be true or false' }, 400)
      return true
    }
    // The body goes to writeScheduledTask whole, so a preCheck of any JSON
    // type used to be stored as is. The runner and the registry hash treat a
    // non-string as no script (#2100), so storing one only leaves a config
    // that says something the runner ignores. null stays allowed: it clears it.
    if (data.preCheck != null && typeof data.preCheck !== 'string') {
      json(res, { error: 'preCheck must be a string (a script path) or null' }, 400)
      return true
    }
    if (data.prompt !== undefined && data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (data.schedule !== undefined && !isValidCronShape(data.schedule)) {
      json(res, { error: 'Invalid cron expression' }, 400)
      return true
    }
    if (refuseIfForeign(res, name)) return true
    const written = writeScheduledTask(name, data)
    if (!registerAfterWrite(res, name, 'api:update', written)) return true
    logger.info({ name }, 'Scheduled task updated')
    json(res, { ok: true })
    return true
  }

  if (scheduleUpdateMatch && method === 'DELETE') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    // Scheduled-task registry: a deleted task leaves no trust behind -- a later plant with
    // the same name and bytes must not inherit the old registration. Unregister
    // FIRST and fail the request if that fails: answering 200 with the files gone
    // would leave a live registry entry behind a "deleted" task, and a re-plant of
    // the same bytes would fire. Nothing is deleted then; the caller can retry.
    try { unregisterScheduledTask(name) } catch (err) {
      logger.error({ err, name }, 'schedule-registry: unregister on delete failed; task NOT deleted')
      json(res, { error: 'Schedule NOT deleted: its registry entry could not be removed (retry, or check the dashboard DB)' }, 500)
      return true
    }
    rmSync(dir, { recursive: true, force: true })
    // #796: remember the removal so a shipped default is not re-seeded on the
    // next restart/update. Harmless for a user-authored task (the seeders only
    // ever revisit shipped names); a later re-create with this name clears it.
    markDefaultTaskRemoved(name)
    logger.info({ name }, 'Scheduled task deleted')
    json(res, { ok: true })
    return true
  }

  const scheduleToggleMatch = path.match(/^\/api\/schedules\/([^/]+)\/toggle$/)
  if (scheduleToggleMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleToggleMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    if (refuseIfForeign(res, name)) return true
    const configPath = join(dir, 'task-config.json')
    let config: Record<string, unknown> = {}
    // JSONCLOBBER926: a corrupt task-config.json is refused, not reset to {enabled}.
    config = readJsonObjectForWrite(configPath)
    const newEnabled = !(config.enabled !== false)
    config.enabled = newEnabled
    // The toggle writes only the config; the SKILL.md it registers along with
    // it is the one read here, right after the trust check above.
    let skillBytes: Buffer | null = null
    try { skillBytes = readFileSync(join(dir, 'SKILL.md')) } catch { /* command task: no SKILL.md */ }
    const configContent = JSON.stringify(config, null, 2)
    atomicWriteFileSync(configPath, configContent)
    if (!registerAfterWrite(res, name, 'api:toggle', { skill: skillBytes, config: configContent })) return true
    logger.info({ name, enabled: newEnabled }, 'Scheduled task toggled')
    json(res, { ok: true, enabled: newEnabled })
    return true
  }

  const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/)
  if (scheduleRunMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleRunMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    const result = await runScheduledTaskNow(name)
    if (!result.ok) { json(res, { error: result.error }, 400); return true }
    logger.info({ name, result: result.result }, 'Scheduled task run-now fired')
    json(res, { ok: true, result: result.result })
    return true
  }

  if (path === '/api/schedules/pending' && method === 'GET') {
    const now = Date.now()
    const rows = listPendingTaskRetries().map(r => toPendingRetryView(r, now))
    json(res, rows)
    return true
  }

  const scheduleRunsMatch = path.match(/^\/api\/schedules\/([^/]+)\/runs$/)
  if (scheduleRunsMatch && method === 'GET') {
    const resolved = resolveScheduleDir(scheduleRunsMatch[1])
    if (!resolved) { json(res, { error: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    const runs = listTaskRunHistory(name, 10)
    json(res, runs)
    return true
  }

  const pendingCancelMatch = path.match(/^\/api\/schedules\/pending\/(\d+)$/)
  if (pendingCancelMatch && method === 'DELETE') {
    const id = parseInt(pendingCancelMatch[1], 10)
    if (!Number.isFinite(id)) { json(res, { error: 'Invalid id' }, 400); return true }
    const removed = deletePendingTaskRetryById(id)
    if (!removed) { json(res, { error: 'Pending retry not found' }, 404); return true }
    logger.info({ id }, 'Pending scheduled-task retry cancelled via API')
    json(res, { ok: true })
    return true
  }

  return false
}
