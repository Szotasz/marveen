import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID } from './config.js'
import { loadOrCreateDashboardToken, checkBearerToken } from './web/dashboard-auth.js'
import { isBlockedCrossOriginWrite, originMatchesServedHost } from './web/csrf-origin.js'
import { json } from './web/http-helpers.js'
import { detectLanIp } from './web/network-info.js'
import { AGENTS_BASE_DIR, listAgentNames } from './web/agent-config.js'
import { ensureAgentHooks, ensureAgentStalenessHook, ensureEgressGate, ensureQuarantineReader, ensureDefaultScheduledTasks, agentSettingsPath, ensureAutonomySection } from './web/agent-scaffold.js'
import { shouldRegisterHooks, pruneStaleHooksFromSettingsFile } from './web/hook-registration-guard.js'
import { refreshMarveenBotUsername } from './web/telegram.js'
import { startMessageRouter } from './web/message-router.js'
import { startUpdateChecker } from './web/update-checker.js'
import { startScheduleRunner } from './web/schedule-runner.js'
import { startChannelPluginMonitor } from './web/channel-monitor.js'
import { startInboundProber } from './web/inbound-probe.js'
import { startChannelHealthMonitor } from './web/channel-health-monitor.js'
import { startStuckInputWatcher } from './web/stuck-input-watcher.js'
import { startInboxNudgeWatcher } from './web/inbox-nudge-watcher.js'
import { startStuckToolCallWatcher } from './web/stuck-tool-call-watcher.js'
import { startReauthHealer } from './web/reauth-healer.js'
import { startAutoRestartRunner } from './web/auto-restart-runner.js'
import { startModelFallbackRunner } from './web/model-fallback-runner.js'
import { startContextGuardRunner } from './web/context-guard-runner.js'
import { collectTokenUsage } from './web/token-usage.js'
import { logger } from './logger.js'
import { tryHandleProfiles } from './web/routes/profiles.js'
import { tryHandleMessages } from './web/routes/messages.js'
import { tryHandleFederation } from './web/routes/federation.js'
import { identifyFederationCaller } from './web/federation/config.js'
import { startFederationPoller } from './web/federation/poller.js'
import { startCapabilitySummaryRunner } from './web/federation/capability-runner.js'
import { ensureFederationClaudeMdSection } from './web/federation/onboarding.js'
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
import { tryHandleOnboarding } from './web/routes/onboarding.js'
import { tryHandleStatus } from './web/routes/status.js'
import { tryHandleAutonomy } from './web/routes/autonomy.js'
import { tryHandleApprovals, startApprovalTimeoutSweeper } from './web/routes/approvals.js'
import { tryHandleTokenUsage } from './web/routes/token-usage.js'
import { tryHandleCosts, startCostsSyncTask } from './web/routes/costs.js'
import { tryHandleIdeas } from './web/routes/ideas.js'
import { tryHandleToolLog } from './web/routes/tool-log.js'
import { tryHandleSkillUsage } from './web/routes/skill-usage.js'
import { tryHandleSettings } from './web/routes/settings.js'
import { tryHandleAuditLog } from './web/routes/audit-log.js'
import { tryHandleFleetQ } from './web/routes/fleet-q.js'
import { tryHandleStatic } from './web/routes/static.js'
import { tryHandleVoice } from './web/routes/voice.js'
import { tryHandleVaultSsh } from './web/routes/vault-ssh.js'
import { tryHandleFleet } from './web/routes/fleet.js'
import { tryHandleVaultSshKeys } from './web/routes/vault-ssh-keys.js'
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
    ...DASHBOARD_ALLOWED_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean),
  ])

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const path = url.pathname
    const method = req.method || 'GET'

    const origin = req.headers.origin
    // Emit CORS headers for allowlisted origins AND for genuinely same-origin
    // requests reached via a reverse proxy (e.g. Tailscale Serve's ts.net host,
    // where the Origin host matches Host / X-Forwarded-Host). Without this, an
    // iOS Safari preflight for an Authorization-bearing /api/ fetch over the
    // proxy gets a 204 with no Access-Control-* headers and the browser blocks
    // the request -- the page shell loads but no data does. Authorization must be
    // in Allow-Headers or the preflight rejects the Bearer header.
    if (origin && (allowedOrigins.has(origin) ||
        originMatchesServedHost(origin, req.headers.host, req.headers['x-forwarded-host'] as string | undefined))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Block state-changing requests from browsers running on foreign origins.
    // Same-origin fetches (Origin absent, allowlisted, or matching the host the
    // server was actually reached on -- e.g. a Tailscale Serve / reverse-proxy
    // hostname) are accepted; a foreign Origin is rejected (the CSRF defence).
    if (isBlockedCrossOriginWrite(method, origin, req.headers.host, req.headers['x-forwarded-host'] as string | undefined, allowedOrigins)) {
      logger.warn({ method, path, origin, host: req.headers.host, xForwardedHost: req.headers['x-forwarded-host'] }, 'CSRF: blocked write from foreign origin')
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
    // /.well-known/fleetq exposes the agent roster; protect it with the same
    // Bearer token as /api/* so LAN-exposed instances don't leak fleet topology.
    const isFleetManifest = path === '/.well-known/fleetq' && method === 'GET'
    let fedPeerForCtx: string | null = null
    if ((path.startsWith('/api/') && !isPublicApi) || isFleetManifest) {
      const headerOk = checkBearerToken(req.headers.authorization, DASHBOARD_TOKEN)
      const queryOk = isSseStream && checkBearerToken(`Bearer ${url.searchParams.get('token') ?? ''}`, DASHBOARD_TOKEN)
      // Scoped per-peer federation tokens (round 2): valid EXCLUSIVELY for
      // the two federation wire endpoints (exact path+method), and only
      // while federation is enabled. identifyFederationCaller tries each
      // configured peer's inboundToken with the same timing-safe comparator
      // (N is small single digits) and returns the matching peer id -- the
      // caller IDENTITY, which the inbox uses to bind the claimed sender
      // prefix. Everything is fail-closed: the helper never throws (this
      // gate runs outside the dispatcher try{}), a disabled/invalid config
      // identifies nobody, and short/empty stored tokens are skipped before
      // comparison (an empty expected token would make checkBearerToken
      // accept "Bearer " + whitespace). A disabled peer presents to its
      // partner as a plain 401 -- deliberately indistinguishable from a
      // token mismatch (revoked-token holders learn nothing). The peers
      // config endpoints are NOT in this whitelist: dashboard-token-only.
      const isFedPath =
        (path === '/api/federation/manifest' && method === 'GET') ||
        (path === '/api/federation/inbox' && method === 'POST')
      let fedCaller: string | null = null
      if (isFedPath && !headerOk && !queryOk) {
        fedCaller = identifyFederationCaller(req.headers.authorization, checkBearerToken)
        if (fedCaller === null) {
          // 401s are otherwise silent; federation-endpoint auth failures are
          // the brute-force surface, make them visible.
          logger.warn({ path, method }, 'federation: rejected wire-endpoint auth')
        }
      }
      if (!headerOk && !queryOk && fedCaller === null) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      if (fedCaller !== null) fedPeerForCtx = fedCaller
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
      const routeCtx: RouteContext = { req, res, path, method, url, fedPeer: fedPeerForCtx }

      if (await tryHandleProfiles(routeCtx)) return
      if (await tryHandleMessages(routeCtx)) return
      if (await tryHandleFederation(routeCtx)) return
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
      if (await tryHandleOnboarding(routeCtx)) return
      if (await tryHandleStatus(routeCtx)) return
      if (await tryHandleAutonomy(routeCtx)) return
      if (await tryHandleApprovals(routeCtx)) return
      if (await tryHandleTokenUsage(routeCtx)) return
      if (await tryHandleCosts(routeCtx)) return
      if (await tryHandleIdeas(routeCtx)) return
      if (await tryHandleToolLog(routeCtx)) return
      if (await tryHandleSkillUsage(routeCtx)) return
      if (await tryHandleSettings(routeCtx)) return
      if (await tryHandleVoice(routeCtx)) return
      if (await tryHandleVaultSshKeys(routeCtx)) return
      if (await tryHandleVaultSsh(routeCtx)) return
      if (await tryHandleAuditLog(routeCtx)) return
      if (await tryHandleFleetQ(routeCtx)) return
      if (await tryHandleFleet(routeCtx)) return
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
            server.listen(port, WEB_HOST, () => {
              logger.info({ port }, `Web dashboard: re-listen bound after port reclaim`)
            })
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

  // Self-heal a SILENT listener failure. Under launchd, a `kickstart -k` can
  // race the dying predecessor's lingering socket: the EADDRINUSE reclaim +
  // re-listen path can leave this process ALIVE but not actually listening, with
  // no error (observed 2026-06-27 -- the success log above fired yet nothing was
  // bound, and the background loops started below kept running, so the dashboard
  // was deaf until a manual restart, which bound cleanly). A clean restart binds
  // reliably, so if the listener is not up we exit(1) and let launchd restart us
  // fresh rather than linger un-servable. Runs regardless of WEB_ONLY -- it is
  // about the HTTP listener, not the background services.
  //
  // The grace must comfortably exceed a SLOW-but-valid bind: restarting OVER a
  // wedged predecessor, the EADDRINUSE reclaim retries every ~1500ms until the
  // old socket finally releases -- observed up to ~5 MINUTES (2026-06-27). An
  // 8s grace would exit MID-bind and loop, so wait STARTUP_GRACE first. After
  // that, poll periodically so a mid-life listener drop is caught too, not just
  // a startup failure.
  const STARTUP_GRACE_MS = 7 * 60 * 1000
  const RELISTEN_POLL_MS = 60 * 1000
  setTimeout(() => {
    setInterval(() => {
      if (!server.listening) {
        logger.error({ port }, 'Web server not listening -- exiting(1) for a clean launchd restart')
        process.exit(1)
      }
    }, RELISTEN_POLL_MS).unref()
  }, STARTUP_GRACE_MS).unref()

  // WEB_ONLY=true disables all background services (scheduler, pollers, monitors).
  // Used for staging preview instances that must not conflict with the live fleet
  // (duplicate schedule execution, Telegram 409, tmux manipulation, etc.).
  const webOnly = process.env['WEB_ONLY'] === 'true'
  if (webOnly) {
    logger.info('[staging] WEB_ONLY mode: background services disabled')
  }

  const routerInterval = webOnly ? undefined : startMessageRouter()
  if (!webOnly) logger.info('Agent message router started (5s poll)')

  const scheduleInterval = webOnly ? undefined : startScheduleRunner()
  if (!webOnly) logger.info('Schedule runner started (60s poll)')

  // Pre-start the interactive agent worker (subscription backend) so the first
  // heartbeat / scheduled generation after boot does not pay the cold-boot
  // latency. runViaWorker still lazy-starts + restarts it on demand, so this is
  // a warm-up, not a hard dependency. Skipped on the SDK rollback backend.
  if (!webOnly && (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
    import('./web/agent-worker.js')
      .then(m => { m.startWorkerSession(); logger.info('Interactive agent worker pre-started') })
      .catch(err => logger.warn({ err }, 'Failed to pre-start agent worker (will lazy-start on first use)'))
  }

  const pluginMonitorInterval = webOnly ? undefined : startChannelPluginMonitor()
  if (!webOnly) logger.info('Channel plugin health monitor started (60s poll)')

  // Userbot inbound-probe (gold-standard deafness detector). Safe no-op until
  // the prober session file + allowlist are configured. Wrapped so a failure
  // never crashes server startup.
  if (!webOnly) {
    try {
      startInboundProber()
    } catch (err) {
      logger.warn({ err }, 'Inbound prober failed to start')
    }
  }

  const channelHealthInterval = webOnly ? undefined : startChannelHealthMonitor()
  if (!webOnly) logger.info('Channel MCP health monitor started (60s poll, 45s offset)')

  // CostOps: reflect the local config's fixed costs into the ledger once at boot + every
  // 10 minutes. Deliberately NOT done inside the GET /api/costs/summary handler -- a read
  // endpoint must not write (was flagged in review); this is the one place that does.
  const costsSyncInterval = webOnly ? undefined : startCostsSyncTask()
  if (!webOnly) logger.info('CostOps fixed-cost sync started (10min poll + startup)')

  const stuckInputInterval = webOnly ? undefined : startStuckInputWatcher()
  if (!webOnly) logger.info('Stuck-input watcher started (15s poll, 20s offset)')

  const stuckToolCallInterval = webOnly ? undefined : startStuckToolCallWatcher()
  if (!webOnly) logger.info('Stuck-tool-call watcher started (30s poll, 35s offset)')

  const inboxNudgeInterval = webOnly ? undefined : startInboxNudgeWatcher()
  if (!webOnly) logger.info('Inbox nudge watcher started (20s poll, 55s offset)')

  const reauthHealerInterval = webOnly ? undefined : startReauthHealer()
  if (!webOnly && reauthHealerInterval) logger.info('Reauth healer started (3min poll, 90s offset)')

  const autoRestartInterval = webOnly ? undefined : startAutoRestartRunner()
  if (!webOnly) logger.info('Auto-restart runner started (60s poll, 40s offset)')

  const modelFallbackInterval = webOnly ? undefined : startModelFallbackRunner()
  if (!webOnly) logger.info('Model-fallback runner started (60s poll, 50s offset)')

  const contextGuardInterval = webOnly ? undefined : startContextGuardRunner()
  if (!webOnly) logger.info('Context-guard runner started (5min poll, 4.5min initial delay)')

  const updateCheckerInterval = webOnly ? undefined : startUpdateChecker()
  if (!webOnly) logger.info('Update checker started (15min poll)')

  const federationPollerInterval = webOnly ? undefined : startFederationPoller()
  if (!webOnly) logger.info('Federation manifest poller started (10min poll, 25s offset)')

  const capabilityRunnerInterval = webOnly ? undefined : startCapabilitySummaryRunner()
  if (!webOnly) logger.info('Capability summary runner started (5min poll, 65s offset; idle while federation is off)')

  // Collect token usage from JSONL transcripts every hour so the run-history
  // token estimates stay fresh without requiring a manual dashboard visit.
  // Sweep timed-out pending approvals every minute
  const approvalTimeoutInterval = startApprovalTimeoutSweeper()

  const tokenCollectInterval = webOnly ? undefined : setInterval(() => {
    collectTokenUsage().catch(err => logger.warn({ err }, 'Periodic token usage collection failed'))
  }, 60 * 60 * 1000)
  if (!webOnly) {
    collectTokenUsage().catch(err => logger.warn({ err }, 'Startup token usage collection failed'))
    logger.info('Token usage auto-collect started (1h poll + startup)')
  }

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

  // Reconcile the federation onboarding block in the main agent's CLAUDE.md
  // EARLY (before the channels session may read the file) and only on live
  // instances: a WEB_ONLY staging copy must never rewrite the persona file
  // (do NOT copy the hook backfill's ungated placement). The ensure heals
  // the two known loss vectors: update.sh --regen-claudemd and a stale
  // dashboard-editor buffer PUT.
  if (!webOnly) {
    ensureFederationClaudeMdSection()
    ensureAutonomySection(MAIN_AGENT_ID)
  }

  // Backfill the PreCompact hook into existing agents' settings.json so the
  // auto-skill / auto-memory flow runs on context compaction. No-op if the
  // agent already has its own hooks block.
  //
  // Guarded: a worktree checkout or a WEB_ONLY staging instance must NEVER
  // register hooks -- its PROJECT_ROOT is temporary, and baking it into the
  // user-global ~/.claude/settings.json leaves stale absolute paths behind
  // once the worktree is deleted. A failing (exit 2) UserPromptSubmit hook
  // then BLOCKS every prompt and deafens the main agent (2026-07-11 incident).
  const hookDecision = shouldRegisterHooks({ projectRoot: PROJECT_ROOT, webOnly, tmpDir: tmpdir() })
  if (!hookDecision.register) {
    logger.info({ reason: hookDecision.reason, projectRoot: PROJECT_ROOT }, 'Hook registration skipped')
  } else {
    try {
      const patched: string[] = []
      const stalePatched: string[] = []
      const egressPatched: string[] = []
      const pruned: string[] = []
      // Include the main agent (MAIN_AGENT_ID) so the voice hook is also seeded
      // into ~/.claude/settings.json alongside existing hooks (e.g. telegram_progress.py).
      for (const agentName of [MAIN_AGENT_ID, ...listAgentNames()]) {
        // Self-heal FIRST: drop entries this app previously wrote whose script
        // file no longer exists (e.g. a deleted worktree instance's paths), so
        // the re-registration below lands on a clean, unblocked settings file.
        pruned.push(...pruneStaleHooksFromSettingsFile(agentSettingsPath(agentName)))
        if (ensureAgentHooks(agentName)) patched.push(agentName)
        if (ensureAgentStalenessHook(agentName)) stalePatched.push(agentName)
        if (ensureEgressGate(agentName)) egressPatched.push(agentName)
        ensureQuarantineReader(agentName)
      }
      if (pruned.length) logger.info({ pruned }, 'Stale hook entries pruned from agent settings.json')
      if (patched.length) logger.info({ patched }, 'PreCompact hook backfilled into agent settings.json')
      if (stalePatched.length) logger.info({ patched: stalePatched }, 'staleness-guard UserPromptSubmit hook backfilled into agent settings.json')
      if (egressPatched.length) logger.info({ patched: egressPatched }, 'egress-gate WebFetch hook backfilled into agent settings.json')
    } catch (err) {
      logger.warn({ err }, 'Agent hook backfill skipped')
    }
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
    if (costsSyncInterval) clearInterval(costsSyncInterval)
    clearInterval(stuckInputInterval)
    clearInterval(stuckToolCallInterval)
    if (inboxNudgeInterval) clearInterval(inboxNudgeInterval)
    if (reauthHealerInterval) clearInterval(reauthHealerInterval)
    clearInterval(autoRestartInterval)
    clearInterval(modelFallbackInterval)
    clearInterval(contextGuardInterval)
    clearInterval(approvalTimeoutInterval)
    clearInterval(updateCheckerInterval)
    if (federationPollerInterval) clearInterval(federationPollerInterval)
    if (capabilityRunnerInterval) clearInterval(capabilityRunnerInterval)
    clearInterval(tokenCollectInterval)
    return origClose(cb)
  }

  return server
}
