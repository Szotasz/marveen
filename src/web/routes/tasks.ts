import { randomUUID } from 'node:crypto'
import {
  listTasks, createTask, deleteTask, pauseTask, resumeTask, updateTask,
} from '../../db.js'
import { ALLOWED_CHAT_ID } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { computeNextRun } from '../cron.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/tasks' && method === 'GET') {
    const tasks = listTasks().map((t) => ({
      ...t,
      next_run_label: new Date(t.next_run * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
      last_run_label: t.last_run
        ? new Date(t.last_run * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
        : null,
    }))
    json(res, tasks)
    return true
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const { prompt, schedule, expand } = data as { prompt: string; schedule: string; expand?: boolean }
    if (!prompt?.trim() || !schedule?.trim()) {
      json(res, { error: 'Prompt es utemterv kotelezo' }, 400)
      return true
    }
    let finalPrompt = prompt.trim()
    if (expand) {
      logger.info({ prompt: finalPrompt }, 'Prompt kibovites...')
      try {
        const { text } = await runAgent(
          `Bovitsd ki ezt a rovid feladat-leirast egy reszletes, egyertelmu promptta amit egy AI asszisztens vegre tud hajtani.
A prompt legyen magyar nyelvu, konkret utasitasokkal.
Az eredmeny CSAK a kibovitett prompt szovege legyen, semmi mas.

Rovid leiras: "${finalPrompt}"`
        )
        if (text) finalPrompt = text.trim()
      } catch (err) {
        logger.warn({ err }, 'Prompt expand failed, using original')
      }
    }
    try {
      const nextRun = computeNextRun(schedule)
      const id = randomUUID().slice(0, 8)
      createTask(id, ALLOWED_CHAT_ID, finalPrompt, schedule, nextRun)
      logger.info({ id, schedule }, 'Uj utemezett feladat letrehozva')
      json(res, { ok: true, id, prompt: finalPrompt })
    } catch {
      json(res, { error: 'Ervenytelen cron kifejezes' }, 400)
    }
    return true
  }

  const taskUpdateMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskUpdateMatch && method === 'PUT') {
    const id = decodeURIComponent(taskUpdateMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const { prompt, schedule } = data as { prompt: string; schedule: string }
    if (!prompt?.trim() || !schedule?.trim()) {
      json(res, { error: 'Prompt es utemterv kotelezo' }, 400)
      return true
    }
    try {
      const nextRun = computeNextRun(schedule)
      if (updateTask(id, prompt.trim(), schedule.trim(), nextRun)) {
        json(res, { ok: true })
      } else {
        json(res, { error: 'Feladat nem talalhato' }, 404)
      }
    } catch {
      json(res, { error: 'Ervenytelen cron kifejezes' }, 400)
    }
    return true
  }

  if (taskUpdateMatch && method === 'DELETE') {
    const id = decodeURIComponent(taskUpdateMatch[1])
    if (deleteTask(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Feladat nem talalhato' }, 404)
    return true
  }

  const taskPauseMatch = path.match(/^\/api\/tasks\/([^/]+)\/pause$/)
  if (taskPauseMatch && method === 'POST') {
    const id = decodeURIComponent(taskPauseMatch[1])
    if (pauseTask(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Feladat nem talalhato' }, 404)
    return true
  }

  const taskResumeMatch = path.match(/^\/api\/tasks\/([^/]+)\/resume$/)
  if (taskResumeMatch && method === 'POST') {
    const id = decodeURIComponent(taskResumeMatch[1])
    if (resumeTask(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Feladat nem talalhato' }, 404)
    return true
  }

  return false
}
