import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath } from '../../platform.js'
import { APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { fleetVenvPathPrefix } from '../agent-process.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { exactTmuxTarget } from '../../tmux-target.js'

const execFileAsync = promisify(execFile)

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function bgSessionName(id: string): string {
  return `bg-${id}`
}

async function isBgSessionAlive(session: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(TMUX, ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return stdout.split('\n').some(l => l.trim() === session)
  } catch {
    return false
  }
}

async function captureSession(session: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(TMUX, ['capture-pane', '-t', exactTmuxTarget(session), '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
    return stdout
  } catch {
    return null
  }
}

async function killSession(session: string): Promise<void> {
  try {
    await execFileAsync(TMUX, ['kill-session', '-t', exactTmuxTarget(session)], { timeout: 3000 })
  } catch { /* already dead */ }
}

export async function spawnBackgroundTask(agentId: string, prompt: string): Promise<BackgroundTask | { error: string }> {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const session = bgSessionName(id)

  const task = createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  const shellCmd = [
    // FLEETVENV923: the fleet venv's bin/ first, as in every agent launch.
    `export PATH="${fleetVenvPathPrefix()}/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    `${CLAUDE} -p "$BG_PROMPT" --output-format text 2>&1`,
  ].join(' && ')

  try {
    await execFileAsync(TMUX, [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
      `${shellCmd}; echo '___BG_DONE___'; sleep 5`,
    ], {
      timeout: 5000,
      env: { ...process.env, BG_PROMPT: prompt },
    })
  } catch (err) {
    logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
    if (getBackgroundTask(id)?.status === 'running') finishBackgroundTask(id, 'failed', '(spawn failed)')
    return { error: 'Nem sikerült elindítani a háttérfeladatot' }
  }

  const current = getBackgroundTask(id)
  if (!current || current.status !== 'running') {
    await killSession(session)
    logger.info({ id, session }, 'Background task cancelled during spawn; session killed')
    return current ?? task
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')

  setTimeout(() => { void checkAndFinalize(id) }, TIMEOUT_MS)
  pollUntilDone(id)

  return task
}

function pollUntilDone(id: string): void {
  let busy = false

  async function tick(): Promise<void> {
    try {
      const task = getBackgroundTask(id)
      if (!task || task.status !== 'running') { clearInterval(interval); return }

      const session = task.tmux_session
      if (!session) { clearInterval(interval); return }

      const alive = await isBgSessionAlive(session)
      if (getBackgroundTask(id)?.status !== 'running') { clearInterval(interval); return }
      if (!alive) {
        finishBackgroundTask(id, 'done', '(session ended)')
        logger.info({ id }, 'Background task session ended')
        clearInterval(interval)
        return
      }

      const pane = await captureSession(session)
      if (getBackgroundTask(id)?.status !== 'running') { clearInterval(interval); return }
      if (pane && pane.includes('___BG_DONE___')) {
        const output = pane.replace(/___BG_DONE___[\s\S]*$/, '').trim()
        finishBackgroundTask(id, 'done', output)
        clearInterval(interval)
        await killSession(session)
        logger.info({ id }, 'Background task completed')
      }
    } catch (err) {
      logger.warn({ err, id }, 'Background task poll tick failed')
    }
  }

  const interval = setInterval(() => {
    if (busy) return
    busy = true
    void tick().finally(() => { busy = false })
  }, 10_000)
}

async function checkAndFinalize(id: string): Promise<void> {
  try {
    const task = getBackgroundTask(id)
    if (!task || task.status !== 'running') return

    const session = task.tmux_session
    const output = session ? await captureSession(session) : null
    if (getBackgroundTask(id)?.status !== 'running') return
    finishBackgroundTask(id, 'timeout', output?.trim() || '(timeout)')
    if (session) await killSession(session)
    logger.warn({ id }, 'Background task timed out after 30 minutes')
  } catch (err) {
    logger.warn({ err, id }, 'Background task timeout check failed')
  }
}

export async function sweepOrphanedBackgroundTasks(): Promise<void> {
  const running = getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    if (!task.tmux_session || !(await isBgSessionAlive(task.tmux_session))) {
      const output = task.tmux_session ? await captureSession(task.tmux_session) : null
      // A DELETE may have closed the task while the sweep awaited tmux.
      if (getBackgroundTask(task.id)?.status !== 'running') continue
      finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')
      orphaned++
    } else {
      if (getBackgroundTask(task.id)?.status !== 'running') continue
      setTimeout(() => { void checkAndFinalize(task.id) }, TIMEOUT_MS)
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

    const result = await spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
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
    let row = task
    if (task.status === 'running' && task.tmux_session) {
      liveOutput = await captureSession(task.tmux_session)
      // The poller or a DELETE can finish the task while the capture was in
      // flight; answer with the row as it is NOW, not the stale 'running' one.
      row = getBackgroundTask(taskMatch[1]) ?? task
    }

    json(res, {
      ...row,
      liveOutput: row.status === 'running' ? liveOutput : null,
      started_label: new Date(row.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: row.finished_at ? new Date(row.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
    const output = task.tmux_session ? await captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      await killSession(task.tmux_session)
    }
    finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
    json(res, { ok: true })
    return true
  }

  return false
}
