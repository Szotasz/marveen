import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, WEB_HOST } from './config.js'
import { loadOrCreateDashboardToken, checkBearerToken } from './web/dashboard-auth.js'
import { json } from './web/http-helpers.js'
import { AGENTS_BASE_DIR, listAgentNames } from './web/agent-config.js'
import { ensureAgentHooks } from './web/agent-scaffold.js'
import { refreshMarveenBotUsername } from './web/telegram.js'
import { startMessageRouter } from './web/message-router.js'
import { startUpdateChecker } from './web/update-checker.js'
import { startMcpListChecker } from './web/mcp-list.js'
import { startScheduleRunner } from './web/schedule-runner.js'
import { startTelegramPluginMonitor } from './web/telegram-monitor.js'
import { logger } from './logger.js'
import { tryHandleProfiles } from './web/routes/profiles.js'
import { tryHandleMessages } from './web/routes/messages.js'
import { tryHandleDailyLog } from './web/routes/daily-log.js'
import { tryHandleMemories } from './web/routes/memories.js'
import { tryHandleMigrate } from './web/routes/migrate.js'
import { tryHandleKanban } from './web/routes/kanban.js'
import { tryHandleTasks } from './web/routes/tasks.js'
import { tryHandleSchedules } from './web/routes/schedules.js'
import { tryHandleConnectors } from './web/routes/connectors.js'
import { tryHandleAgentsSkills } from './web/routes/agents-skills.js'
import { tryHandleSkills } from './web/routes/skills.js'
import { tryHandleAgents } from './web/routes/agents.js'
import { tryHandleMarveen } from './web/routes/marveen.js'
import { tryHandleOverview } from './web/routes/overview.js'
import { tryHandleUpdates } from './web/routes/updates.js'
import { tryHandleStatus } from './web/routes/status.js'
import { tryHandleStatic } from './web/routes/static.js'
import type { RouteContext } from './web/routes/types.js'

const WEB_DIR = join(PROJECT_ROOT, 'web')

function ensureDirs() {
  mkdirSync(AGENTS_BASE_DIR, { recursive: true })
}

export function startWebServer(port = 3420): http.Server {
  // SECURITY: Server binds to 127.0.0.1 (see server.listen below). The allowed
  // browser origins mirror that -- anything else is rejected to prevent CSRF
  // from malicious websites the user may visit while the dashboard is running.
  ensureDirs()

  const DASHBOARD_TOKEN = loadOrCreateDashboardToken()
  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...( WEB_HOST !== 'localhost' && WEB_HOST !== '127.0.0.1' ? [`http://${WEB_HOST}:${port}`] : []),
  ])
  const isSafeMethod = (m: string) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS'

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const path = url.pathname
    const method = req.method || 'GET'

    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Block state-changing requests from browsers running on foreign origins.
    // Same-origin fetches from the dashboard don't set Origin on some browsers, so we
    // accept requests where Origin is absent OR whitelisted. Requests carrying a foreign
    // Origin are rejected outright (this is the primary CSRF defence).
    if (!isSafeMethod(method) && origin && !allowedOrigins.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Origin not allowed' }))
      return
    }

    // Auth gate: every /api/* route requires a bearer token in the Authorization
    // header. Exceptions: the auth-status probe (so the client can tell whether
    // it needs to prompt the user), and GET requests for avatar images (loaded
    // via <img src> which can't carry headers -- these are non-sensitive assets).
    const isPublicApi =
      (path === '/api/auth/status' && method === 'GET') ||
      (method === 'GET' && (
        path === '/api/marveen/avatar' ||
        /^\/api\/agents\/[^/]+\/avatar$/.test(path)
      ))
    if (path === '/api/auth/status' && method === 'GET') {
      const ok = checkBearerToken(req.headers.authorization, DASHBOARD_TOKEN)
      return json(res, { authenticated: ok })
    }
    if (path.startsWith('/api/') && !isPublicApi) {
      if (!checkBearerToken(req.headers.authorization, DASHBOARD_TOKEN)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    try {
      const routeCtx: RouteContext = { req, res, path, method, url }

      if (await tryHandleProfiles(routeCtx)) return
      if (await tryHandleMessages(routeCtx)) return
      if (await tryHandleDailyLog(routeCtx)) return
      if (await tryHandleMemories(routeCtx)) return
      if (await tryHandleMigrate(routeCtx)) return
      if (await tryHandleKanban(routeCtx)) return
      if (await tryHandleTasks(routeCtx)) return
      if (await tryHandleSchedules(routeCtx)) return
      if (await tryHandleConnectors(routeCtx)) return
      if (await tryHandleAgentsSkills(routeCtx)) return
      if (await tryHandleSkills(routeCtx)) return
      if (await tryHandleAgents(routeCtx, WEB_DIR)) return
      if (await tryHandleMarveen(routeCtx, WEB_DIR)) return
      if (await tryHandleOverview(routeCtx)) return
      if (await tryHandleUpdates(routeCtx)) return
      if (await tryHandleStatus(routeCtx)) return
      if (await tryHandleStatic(routeCtx, WEB_DIR)) return

      res.writeHead(404)
      res.end('Not found')
    } catch (err) {
      logger.error({ err }, 'Web szerver hiba')
      json(res, { error: 'Szerver hiba' }, 500)
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Try to reclaim the port only if the listener is another node/dashboard
      // process owned by us. Blind `lsof -ti | xargs kill -9` would take down
      // whatever happens to be on the port (e.g. an unrelated dev server),
      // and under launchd it also race-kills the not-yet-dead predecessor.
      logger.warn({ port }, 'Web port foglalt, probalok felszabaditani...')
      try {
        const pidsRaw = execSync(`lsof -ti :${port} 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' }).trim()
        const pids = pidsRaw.split('\n').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0)
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const victims: number[] = []
        for (const pid of pids) {
          if (pid === process.pid) continue
          let cmd = ''
          try {
            cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000, encoding: 'utf-8' }).trim()
          } catch { continue }
          if (uid !== null) {
            try {
              const ownerUid = parseInt(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid='], { timeout: 2000, encoding: 'utf-8' }).trim(), 10)
              if (Number.isFinite(ownerUid) && ownerUid !== uid) continue
            } catch { continue }
          }
          if (!/node|tsx/i.test(cmd)) {
            logger.warn({ port, pid, cmd }, 'Port held by non-node process -- refusing to kill')
            continue
          }
          victims.push(pid)
        }
        for (const pid of victims) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
        if (victims.length) {
          setTimeout(() => {
            for (const pid of victims) {
              try {
                process.kill(pid, 0)
                try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
              } catch { /* gone */ }
            }
            server.listen(port)
          }, 1500)
        } else {
          logger.error({ port }, 'Port foglalt de nem talaltunk felszabadithato node processt -- kilepes')
          process.exit(1)
        }
      } catch (e) {
        logger.error({ err: e }, 'Port-reclaim failed')
      }
    } else {
      logger.error({ err }, 'Web szerver hiba')
    }
  })

  server.listen(port, WEB_HOST, () => {
    logger.info({ port }, `Web dashboard: http://localhost:${port}`)
    // Do NOT log the bearer token: launchd/journal/pipe captures of the
    // structured log would otherwise carry a root-equivalent credential.
    // Print the bootstrap URL directly to stderr instead so it shows in the
    // interactive terminal but does not land in the pino log stream.
    const bootstrapUrl = `http://127.0.0.1:${port}/?token=${DASHBOARD_TOKEN}`
    process.stderr.write(
      `\nDashboard access URL (paste into browser, token is stored afterward):\n  ${bootstrapUrl}\n\n`
    )
  })

  const routerInterval = startMessageRouter()
  logger.info('Agent message router started (5s poll)')

  const scheduleInterval = startScheduleRunner()
  logger.info('Schedule runner started (60s poll)')

  const pluginMonitorInterval = startTelegramPluginMonitor()
  logger.info('Telegram plugin health monitor started (60s poll)')

  const updateCheckerInterval = startUpdateChecker()
  logger.info('Update checker started (15min poll)')

  // Warm the MCP list cache so the Connectors page reflects claude.ai OAuth
  // connectors on first load. 30s delay lets the main-channels session settle
  // first so the telegram plugin's single-poller token is claimed before
  // `claude mcp list` spawns it for a health check.
  startMcpListChecker()
  logger.info('MCP list cache warmup scheduled (30s delay, manual refresh only)')

  // Warm the Marveen bot username cache so /api/marveen returns @username on
  // the first dashboard load. Re-fetched lazily otherwise.
  refreshMarveenBotUsername().catch(() => {})

  // Backfill the PreCompact hook into existing agents' settings.json so the
  // auto-skill / auto-memory flow runs on context compaction. No-op if the
  // agent already has its own hooks block.
  try {
    const patched: string[] = []
    for (const agentName of listAgentNames()) {
      if (ensureAgentHooks(agentName)) patched.push(agentName)
    }
    if (patched.length) logger.info({ patched }, 'PreCompact hook backfilled into agent settings.json')
  } catch (err) {
    logger.warn({ err }, 'Agent hook backfill skipped')
  }

  const origClose = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    clearInterval(routerInterval)
    clearInterval(scheduleInterval)
    clearInterval(pluginMonitorInterval)
    clearInterval(updateCheckerInterval)
    return origClose(cb)
  }

  return server
}
