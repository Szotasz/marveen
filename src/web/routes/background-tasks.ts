import { randomBytes } from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath } from '../../platform.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = 'Europe/Budapest'

function bgSessionName(id: string): string {
  return `bg-${id}`
}

function isBgSessionAlive(session: string): boolean {
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n').some(l => l.trim() === session)
  } catch {
    return false
  }
}

function captureSession(session: string): string | null {
  try {
    return execFileSync(TMUX, ['capture-pane', '-t', session, '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
  } catch {
    return null
  }
}

function killSession(session: string): void {
  try {
    execFileSync(TMUX, ['kill-session', '-t', session], { timeout: 3000 })
  } catch { /* already dead */ }
}

export function spawnBackgroundTask(agentId: string, prompt: string): BackgroundTask | { error: string } {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const session = bgSessionName(id)

  const task = createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  const shellCmd = [
    `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    `${CLAUDE} -p "$BG_PROMPT" --output-format text 2>&1`,
  ].join(' && ')

  try {
    execFileSync(TMUX, [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
      `${shellCmd}; echo '___BG_DONE___'; sleep 5`,
    ], {
      timeout: 5000,
      env: { ...process.env, BG_PROMPT: prompt },
    })
  } catch (err) {
    logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
    finishBackgroundTask(id, 'failed', '(spawn failed)')
    return { error: 'Nem sikerült elindítani a háttérfeladatot' }
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')

  setTimeout(() => checkAndFinalize(id), TIMEOUT_MS)
  pollUntilDone(id)

  return task
}

function pollUntilDone(id: string): void {
  const interval = setInterval(() => {
    const task = getBackgroundTask(id)
    if (!task || task.status !== 'running') {
      clearInterval(interval)
      return
    }

    const session = task.tmux_session
    if (!session) { clearInterval(interval); return }

    if (!isBgSessionAlive(session)) {
      const output = '(session ended)'
      finishBackgroundTask(id, 'done', output)
      logger.info({ id }, 'Background task session ended')
      clearInterval(interval)
      return
    }

    const pane = captureSession(session)
    if (pane && pane.includes('___BG_DONE___')) {
      const output = pane.replace(/___BG_DONE___[\s\S]*$/, '').trim()
      finishBackgroundTask(id, 'done', output)
      killSession(session)
      logger.info({ id }, 'Background task completed')
      clearInterval(interval)
    }
  }, 10_000)
}

function checkAndFinalize(id: string): void {
  const task = getBackgroundTask(id)
  if (!task || task.status !== 'running') return

  const session = task.tmux_session
  const output = session ? captureSession(session) : null
  finishBackgroundTask(id, 'timeout', output?.trim() || '(timeout)')
  if (session) killSession(session)
  logger.warn({ id }, 'Background task timed out after 30 minutes')
}

export function sweepOrphanedBackgroundTasks(): void {
  const running = getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    if (!task.tmux_session || !isBgSessionAlive(task.tmux_session)) {
      const output = task.tmux_session ? captureSession(task.tmux_session) : null
      finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')
      orphaned++
    } else {
      setTimeout(() => checkAndFinalize(task.id), TIMEOUT_MS)
      pollUntilDone(task.id)
    }
  }
  if (orphaned) logger.info({ orphaned }, 'Swept orphaned background tasks on startup')
}

const TASK_ID_RE = /^\/api\/background-tasks\/([A-F0-9]{8})$/

export async function tryHandleBackgroundTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/background-tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
    if (!data.prompt?.trim()) {
      json(res, { error: 'Prompt megadása kötelező' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'Agent ID megadása kötelező' }, 400)
      return true
    }

    const result = spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
    if ('error' in result) {
      json(res, { error: result.error }, 429)
      return true
    }
    json(res, result, 201)
    return true
  }

  if (path === '/api/background-tasks' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || undefined
    const all = url.searchParams.get('all') === 'true'
    const tasks = getBackgroundTasks(agentId, all)
    const formatted = tasks.map(t => ({
      ...t,
      started_label: new Date(t.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: t.finished_at ? new Date(t.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    }))
    json(res, formatted)
    return true
  }

  const taskMatch = path.match(TASK_ID_RE)
  if (taskMatch && method === 'GET') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }

    let liveOutput: string | null = null
    if (task.status === 'running' && task.tmux_session) {
      liveOutput = captureSession(task.tmux_session)
    }

    json(res, {
      ...task,
      liveOutput,
      started_label: new Date(task.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: task.finished_at ? new Date(task.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
    const output = task.tmux_session ? captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      killSession(task.tmux_session)
    }
    finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
    json(res, { ok: true })
    return true
  }

  return false
}
