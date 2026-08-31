import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  listPendingTaskRetries, deletePendingTaskRetryById, listTaskRunHistory,
  getScheduleFromDb, listSchedulesFromDb, deleteSchedule, setScheduleEnabled, countSchedules,
} from '../../db.js'
import { MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { toPendingRetryView } from '../../pending-retries.js'
import { isValidCronShape } from '../cron.js'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { sanitizeScheduleName, safeJoin } from '../sanitize.js'
import { listAgentNames } from '../agent-config.js'
import {
  SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN,
  listScheduledTasks, listScheduledTasksFromFiles, writeScheduledTask,
} from '../scheduled-tasks-io.js'
import { runScheduledTaskNow } from '../schedule-runner.js'
import type { RouteContext } from './types.js'

// Tenant scope helpers (mirrors artifacts/kanban pattern):
// - Admin with no ?tenant= filter sees all tenants (effectiveTenantId = null → all).
// - Admin with ?tenant=<id> sees only that tenant.
// - Non-admin is restricted to their own tenant; fleet tasks (tenant_id IS NULL) hidden.
function effectiveTenant(ctx: RouteContext): string | null | 'fleet' {
  if (ctx.role === 'admin') {
    const param = ctx.url.searchParams.get('tenant')
    if (param === 'fleet') return 'fleet'
    return param ?? null  // null = all
  }
  return ctx.tenantId ?? 'default'
}

function crossTenantBlocked(ctx: RouteContext, scheduleTenantId: string | null): boolean {
  if (ctx.role === 'admin') return false
  const callerTenant = ctx.tenantId ?? 'default'
  // Fleet tasks (tenant_id IS NULL) are not visible to non-admin tenant users
  if (scheduleTenantId === null) return true
  return scheduleTenantId !== callerTenant
}

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
    if (!prompt?.trim()) { json(res, { error: 'required', field: 'prompt', hint: 'Prompt is required' }, 400); return true }

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
      json(res, { error: 'internal_error', hint: 'Failed to generate questions' }, 500)
    }
    return true
  }

  if (path === '/api/schedules/expand-prompt' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, answers } = JSON.parse(body.toString()) as { prompt: string; answers: { question: string; answer: string }[] }
    if (!prompt?.trim()) { json(res, { error: 'required', field: 'prompt', hint: 'Prompt is required' }, 400); return true }

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
      json(res, { error: 'internal_error', hint: 'Failed to expand prompt' }, 500)
    }
    return true
  }

  if (path === '/api/schedules' && method === 'GET') {
    const useDb = countSchedules() > 0
    if (useDb) {
      const scope = effectiveTenant(ctx)
      let rows
      if (scope === null) {
        rows = listSchedulesFromDb({ includeFleet: true })
      } else if (scope === 'fleet') {
        rows = listSchedulesFromDb({ includeFleet: false })
      } else {
        rows = listSchedulesFromDb({ tenantId: scope })
      }
      json(res, rows)
    } else {
      json(res, listScheduledTasksFromFiles())
    }
    return true
  }

  if (path === '/api/schedules' && method === 'POST') {
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: 'limit_exceeded', hint: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      name: string; description: string; prompt: string; schedule: string; agent?: string;
      type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string;
      tenant_id?: string
    }
    const name = sanitizeScheduleName(data.name || '')
    if (!name) { json(res, { error: 'required', field: 'name', hint: 'Name is required' }, 400); return true }
    if (!data.prompt?.trim()) { json(res, { error: 'required', field: 'prompt', hint: 'Prompt is required' }, 400); return true }
    if (data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: 'limit_exceeded', field: 'prompt', hint: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (!data.schedule?.trim()) { json(res, { error: 'required', field: 'schedule', hint: 'Schedule is required' }, 400); return true }
    if (!isValidCronShape(data.schedule)) { json(res, { error: 'invalid_value', field: 'schedule', hint: 'Invalid cron expression' }, 400); return true }

    const useDb = countSchedules() > 0
    const existing = useDb ? getScheduleFromDb(name) : existsSync(join(SCHEDULED_TASKS_DIR, name))
    if (existing) { json(res, { error: 'conflict', hint: 'Schedule already exists' }, 409); return true }

    // Tenant stamp: non-admin callers always get their own tenant_id;
    // admin may pass explicit tenant_id (or omit for fleet/null scope).
    const isAdmin = ctx.role === 'admin'
    const tenantId: string | null = isAdmin
      ? (data.tenant_id?.trim() || null)
      : (ctx.tenantId ?? 'default')

    writeScheduledTask(name, {
      description: data.description || '',
      prompt: data.prompt.trim(),
      schedule: data.schedule.trim(),
      agent: data.agent || MAIN_AGENT_ID,
      enabled: true,
      type: data.type || 'task',
      skipIfBusy: data.skipIfBusy === true,
      forceSend: data.forceSend === true,
      targetSession: data.targetSession || undefined,
      tenantId,
    })
    logger.info({ name, schedule: data.schedule, tenantId }, 'Scheduled task created')
    json(res, { ok: true, name })
    return true
  }

  const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleUpdateMatch && method === 'PUT') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = countSchedules() > 0
    const dbRow = useDb ? getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: 'limit_exceeded', hint: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string
    }
    if (data.prompt !== undefined && data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: 'limit_exceeded', field: 'prompt', hint: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (data.schedule !== undefined && !isValidCronShape(data.schedule)) {
      json(res, { error: 'invalid_value', field: 'schedule', hint: 'Invalid cron expression' }, 400)
      return true
    }
    writeScheduledTask(name, data)
    logger.info({ name }, 'Scheduled task updated')
    json(res, { ok: true })
    return true
  }

  if (scheduleUpdateMatch && method === 'DELETE') {
    const resolved = resolveScheduleDir(scheduleUpdateMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = countSchedules() > 0
    const dbRow = useDb ? getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    if (useDb) deleteSchedule(name)
    // Always remove files too (keeps FS in sync with DB; noop if files missing)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    logger.info({ name }, 'Scheduled task deleted')
    json(res, { ok: true })
    return true
  }

  const scheduleToggleMatch = path.match(/^\/api\/schedules\/([^/]+)\/toggle$/)
  if (scheduleToggleMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleToggleMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = countSchedules() > 0
    const dbRow = useDb ? getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    let newEnabled: boolean
    if (useDb && dbRow) {
      newEnabled = dbRow.enabled === 0
      setScheduleEnabled(name, newEnabled)
      // Mirror to file
      writeScheduledTask(name, { enabled: newEnabled })
    } else {
      const configPath = join(dir, 'task-config.json')
      let config: Record<string, unknown> = {}
      try {
        const { readFileOr: rfo } = await import('../agent-config.js')
        config = JSON.parse(rfo(configPath, '{}'))
      } catch { /* use empty */ }
      newEnabled = !(config.enabled !== false)
      writeScheduledTask(name, { enabled: newEnabled })
    }
    logger.info({ name, enabled: newEnabled }, 'Scheduled task toggled')
    json(res, { ok: true, enabled: newEnabled })
    return true
  }

  const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/)
  if (scheduleRunMatch && method === 'POST') {
    const resolved = resolveScheduleDir(scheduleRunMatch[1])
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = countSchedules() > 0
    const dbRow = useDb ? getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    const result = await runScheduledTaskNow(name)
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : result.error === 'disabled' ? 409 : 400
      json(res, { error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, status)
      return true
    }
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
    if (!resolved) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    const { name, dir } = resolved

    const useDb = countSchedules() > 0
    const dbRow = useDb ? getScheduleFromDb(name) : null
    if (useDb ? !dbRow : !existsSync(dir)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }
    if (useDb && crossTenantBlocked(ctx, dbRow?.tenant_id ?? null)) { json(res, { error: 'not_found', hint: 'Schedule not found' }, 404); return true }

    const runs = listTaskRunHistory(name, 10)
    json(res, runs)
    return true
  }

  const pendingCancelMatch = path.match(/^\/api\/schedules\/pending\/(\d+)$/)
  if (pendingCancelMatch && method === 'DELETE') {
    const id = parseInt(pendingCancelMatch[1], 10)
    if (!Number.isFinite(id)) { json(res, { error: 'invalid_value', field: 'id', hint: 'Invalid id' }, 400); return true }
    const removed = deletePendingTaskRetryById(id)
    if (!removed) { json(res, { error: 'not_found', hint: 'Pending retry not found' }, 404); return true }
    logger.info({ id }, 'Pending scheduled-task retry cancelled via API')
    json(res, { ok: true })
    return true
  }

  return false
}
