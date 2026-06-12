import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL } from './config.js'
import { loadOrCreateDashboardToken, checkBearerToken } from './web/dashboard-auth.js'
import { json } from './web/http-helpers.js'
import { detectLanIp } from './web/network-info.js'
import { AGENTS_BASE_DIR, listAgentNames } from './web/agent-config.js'
import { ensureAgentHooks, ensureDefaultScheduledTasks } from './web/agent-scaffold.js'
import { refreshMarveenBotUsername } from './web/telegram.js'
import { startMessageRouter } from './web/message-router.js'
import { startUpdateChecker } from './web/update-checker.js'
import { startScheduleRunner } from './web/schedule-runner.js'
import { startChannelPluginMonitor } from './web/channel-monitor.js'
import { startInboundProber } from './web/inbound-probe.js'
import { startChannelHealthMonitor } from './web/channel-health-monitor.js'
import { startStuckInputWatcher } from './web/stuck-input-watcher.js'
import { startStuckToolCallWatcher } from './web/stuck-tool-call-watcher.js'
import { startReauthHealer } from './web/reauth-healer.js'
import { startAutoRestartRunner } from './web/auto-restart-runner.js'
import { logger } from './logger.js'
import { tryHandleProfiles } from './web/routes/profiles.js'
import { tryHandleMessages } from './web/routes/messages.js'
import { tryHandleAgentTerminal } from './web/routes/agent-terminal.js'
import { tryHandleAgentConversation } from './web/routes/agent-conversation.js'
import { tryHandleAgentTaskState } from './web/routes/agent-taskstate.js'
import { sweepOrphanTaskStates } from './web/agent-taskstate.js'
import { tryHandleDailyLog } from './web/routes/daily-log.js'
import { tryHandleMemories } from './web/routes/memories.js'
import { tryHandleMigrate } from './web/routes/migrate.js'
import { tryHandleKanban } from './web/routes/kanban.js'
import { tryHandleSchedules } from './web/routes/schedules.js'
import { tryHandleConnectors } from './web/routes/connectors.js'
import { tryHandleDocs } from './web/routes/docs.js'
import { tryHandleConnectorsHu } from './web/routes/connectors-hu.js'
import { tryHandleAgentsSkills } from './web/routes/agents-skills.js'
import { tryHandleSkills } from './web/routes/skills.js'
import { tryHandleAgents } from './web/routes/agents.js'
import { tryHandleMarveen } from './web/routes/marveen.js'
import { tryHandleRecall } from './web/routes/recall.js'
import { tryHandleBackgroundTasks, sweepOrphanedBackgroundTasks } from './web/routes/background-tasks.js'
import { tryHandleOverview } from './web/routes/overview.js'
import { tryHandleUpdates } from './web/routes/updates.js'
import { tryHandleStatus } from './web/routes/status.js'
import { tryHandleAutonomy } from './web/routes/autonomy.js'
import { tryHandleTokenUsage } from './web/routes/token-usage.js'
import { tryHandleIdeas } from './web/routes/ideas.js'
import { tryHandleToolLog } from './web/routes/tool-log.js'
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
    ...(DASHBOARD_PUBLIC_URL ? [DASHBOARD_PUBLIC_URL.replace(/\/$/, '')] : []),
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
    // The live pane SSE stream is consumed via EventSource, which cannot set an
    // Authorization header -- accept the token via ?token= for this one GET
    // path, validated with the same constant-time check. Everything else stays
    // header-only.
    const isSseStream = method === 'GET' && /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)
    if (path.startsWith('/api/') && !isPublicApi) {
      const headerOk = checkBearerToken(req.headers.authorization, DASHBOARD_TOKEN)
      const queryOk = isSseStream && checkBearerToken(`Bearer ${url.searchParams.get('token') ?? ''}`, DASHBOARD_TOKEN)
      if (!headerOk && !queryOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }

    // The mobile-login QR needs a URL the phone can actually reach. When the
    // desktop opens the dashboard on localhost, window.location.origin is
    // useless (the phone would hit its OWN localhost), so the client asks the
    // server for its LAN IP and builds the QR from that. Auth is already
    // enforced by the /api/* gate above.
    if (path === '/api/network-info' && method === 'GET') {
      return json(res, { lan_ip: detectLanIp(), port })
    }

    try {
      const routeCtx: RouteContext = { req, res, path, method, url }

      if (await tryHandleProfiles(routeCtx)) return
      if (await tryHandleMessages(routeCtx)) return
      if (await tryHandleDailyLog(routeCtx)) return
      if (await tryHandleMemories(routeCtx)) return
      if (await tryHandleMigrate(routeCtx)) return
      if (await tryHandleKanban(routeCtx)) return
      if (await tryHandleSchedules(routeCtx)) return
      if (await tryHandleConnectorsHu(routeCtx)) return
      if (await tryHandleConnectors(routeCtx)) return
      if (await tryHandleDocs(routeCtx)) return
      if (await tryHandleAgentsSkills(routeCtx)) return
      if (await tryHandleSkills(routeCtx)) return
      if (await tryHandleAgentTerminal(routeCtx)) return
      if (await tryHandleAgentConversation(routeCtx)) return
      if (await tryHandleAgentTaskState(routeCtx)) return
      if (await tryHandleAgents(routeCtx, WEB_DIR)) return
      if (await tryHandleMarveen(routeCtx, WEB_DIR)) return
      if (await tryHandleBackgroundTasks(routeCtx)) return
      if (await tryHandleRecall(routeCtx)) return
      if (await tryHandleOverview(routeCtx)) return
      if (await tryHandleUpdates(routeCtx)) return
      if (await tryHandleStatus(routeCtx)) return
      if (await tryHandleAutonomy(routeCtx)) return
      if (await tryHandleTokenUsage(routeCtx)) return
      if (await tryHandleIdeas(routeCtx)) return
      if (await tryHandleToolLog(routeCtx)) return
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

  // Pre-start the interactive agent worker (subscription backend) so the first
  // heartbeat / scheduled generation after boot does not pay the cold-boot
  // latency. runViaWorker still lazy-starts + restarts it on demand, so this is
  // a warm-up, not a hard dependency. Skipped on the SDK rollback backend.
  if ((process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
    import('./web/agent-worker.js')
      .then(m => { m.startWorkerSession(); logger.info('Interactive agent worker pre-started') })
      .catch(err => logger.warn({ err }, 'Failed to pre-start agent worker (will lazy-start on first use)'))
  }

  const pluginMonitorInterval = startChannelPluginMonitor()
  logger.info('Channel plugin health monitor started (60s poll)')

  // Userbot inbound-probe (gold-standard deafness detector). Safe no-op until
  // the prober session file + allowlist are configured. Wrapped so a failure
  // never crashes server startup.
  try {
    startInboundProber()
  } catch (err) {
    logger.warn({ err }, 'Inbound prober failed to start')
  }

  const channelHealthInterval = startChannelHealthMonitor()
  logger.info('Channel MCP health monitor started (60s poll, 45s offset)')

  const stuckInputInterval = startStuckInputWatcher()
  logger.info('Stuck-input watcher started (15s poll, 20s offset)')

  const stuckToolCallInterval = startStuckToolCallWatcher()
  logger.info('Stuck-tool-call watcher started (30s poll, 35s offset)')

  const reauthHealerInterval = startReauthHealer()
  if (reauthHealerInterval) logger.info('Reauth healer started (3min poll, 90s offset)')

  const autoRestartInterval = startAutoRestartRunner()
  logger.info('Auto-restart runner started (60s poll, 40s offset)')

  const updateCheckerInterval = startUpdateChecker()
  logger.info('Update checker started (15min poll)')

  // NOTE: startMcpListChecker() is intentionally NOT called here.
  //
  // Root cause: calling `claude mcp list` at boot time (30s delay) spawns the
  // Telegram plugin for a health check. The plugin claims the bot-token poller
  // slot, which 409-kills the live session-bridge process that already holds
  // the same token. On every deploy this caused the Telegram channel to go
  // offline within 33s of startup (3/3 observed deploys, 2026-06-04).
  //
  // The Connectors page already has a manual "Refresh" button that calls
  // refreshMcpListCache() on demand. The cache starts empty; users see their
  // connectors after the first manual refresh.
  //
  // Related: PR #269 fixed a DIFFERENT 409 source (runtime poller-flapping /
  // channel-coordinator 409 cooldown hysteresis). That fix and this one are
  // complementary -- both 409 vectors must be addressed.

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

  try {
    ensureDefaultScheduledTasks()
    logger.info('Default scheduled tasks seeded')
  } catch (err) {
    logger.warn({ err }, 'Scheduled tasks seed skipped')
  }

  try {
    sweepOrphanedBackgroundTasks()
  } catch (err) {
    logger.warn({ err }, 'Background task sweep skipped')
  }

  try {
    const swept = sweepOrphanTaskStates(Date.now())
    if (swept > 0) logger.info({ swept }, 'Orphan agent task-state records swept')
  } catch (err) {
    logger.warn({ err }, 'Task-state orphan sweep skipped')
  }

  const origClose = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    clearInterval(routerInterval)
    clearInterval(scheduleInterval)
    if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)
    clearInterval(channelHealthInterval)
    clearInterval(stuckInputInterval)
    clearInterval(stuckToolCallInterval)
    if (reauthHealerInterval) clearInterval(reauthHealerInterval)
    clearInterval(autoRestartInterval)
    clearInterval(updateCheckerInterval)
    return origClose(cb)
  }

  return server
}
