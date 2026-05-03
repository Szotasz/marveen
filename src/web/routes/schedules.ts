import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  listPendingTaskRetries, deletePendingTaskRetryById,
} from '../../db.js'
import { MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { toPendingRetryView } from '../../pending-retries.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { isValidCronShape } from '../cron.js'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { sanitizeScheduleName } from '../sanitize.js'
import { listAgentNames } from '../agent-config.js'
import { readFileOr } from '../agent-config.js'
import {
  SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN,
  listScheduledTasks, writeScheduledTask,
} from '../scheduled-tasks-io.js'
import type { RouteContext } from './types.js'

export async function tryHandleSchedules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/schedules/agents' && method === 'GET') {
    const agentNames = listAgentNames()
    const agents = [
      { name: MAIN_AGENT_ID, label: BOT_NAME, avatar: '/api/marveen/avatar' },
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

  if (path === '/api/schedules' && method === 'GET') {
    json(res, listScheduledTasks())
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
      name: string; description: string; prompt: string; schedule: string; agent?: string; type?: string; skipIfBusy?: boolean
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

    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (existsSync(dir)) { json(res, { error: 'Schedule already exists' }, 409); return true }

    writeScheduledTask(name, {
      description: data.description || '',
      prompt: data.prompt.trim(),
      schedule: data.schedule.trim(),
      agent: data.agent || MAIN_AGENT_ID,
      enabled: true,
      type: data.type || 'task',
      skipIfBusy: data.skipIfBusy === true,
    })
    logger.info({ name, schedule: data.schedule }, 'Scheduled task created')
    json(res, { ok: true, name })
    return true
  }

  const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleUpdateMatch && method === 'PUT') {
    const name = decodeURIComponent(scheduleUpdateMatch[1])
    const dir = join(SCHEDULED_TASKS_DIR, name)
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
      description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean
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
    writeScheduledTask(name, data)
    logger.info({ name }, 'Scheduled task updated')
    json(res, { ok: true })
    return true
  }

  if (scheduleUpdateMatch && method === 'DELETE') {
    const name = decodeURIComponent(scheduleUpdateMatch[1])
    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    rmSync(dir, { recursive: true, force: true })
    logger.info({ name }, 'Scheduled task deleted')
    json(res, { ok: true })
    return true
  }

  const scheduleToggleMatch = path.match(/^\/api\/schedules\/([^/]+)\/toggle$/)
  if (scheduleToggleMatch && method === 'POST') {
    const name = decodeURIComponent(scheduleToggleMatch[1])
    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    const configPath = join(dir, 'task-config.json')
    let config: Record<string, unknown> = {}
    try { config = JSON.parse(readFileOr(configPath, '{}')) } catch { /* use empty */ }
    const newEnabled = !(config.enabled !== false)
    config.enabled = newEnabled
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
    logger.info({ name, enabled: newEnabled }, 'Scheduled task toggled')
    json(res, { ok: true, enabled: newEnabled })
    return true
  }

  if (path === '/api/schedules/pending' && method === 'GET') {
    const now = Date.now()
    const rows = listPendingTaskRetries().map(r => toPendingRetryView(r, now))
    json(res, rows)
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
