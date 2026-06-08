import type http from 'node:http'
import { execFile } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import type { ConsumeResult } from './pty-ticket.js'
import { logger } from '../logger.js'

// Pure command builders (host-aware). A remote agent's tmux session lives on
// its host (e.g. the laptop), reached over ssh; a local agent talks to local
// tmux. Kept pure so the local/remote routing is unit-testable without tmux/ssh.
export function ptyAttachCommand(host: string | null, session: string): { file: string; args: string[] } {
  // -tt forces remote PTY allocation so the remote `tmux attach` gets a terminal.
  return host
    ? { file: 'ssh', args: ['-tt', host, 'tmux', 'attach-session', '-t', session] }
    : { file: 'tmux', args: ['attach-session', '-t', session] }
}

export function tmuxControlCommand(host: string | null, args: string[]): { file: string; args: string[] } {
  return host
    ? { file: 'ssh', args: [host, 'tmux', ...args] }
    : { file: 'tmux', args }
}

// Fire-and-forget tmux control command (window pinning), host-aware. Failures
// are logged but never block the viewer -- a missed pin only degrades to the
// old resize jitter.
function tmuxControl(host: string | null, args: string[]): void {
  const cmd = tmuxControlCommand(host, args)
  execFile(cmd.file, cmd.args, { env: process.env as NodeJS.ProcessEnv }, (err) => {
    if (err) logger.warn({ err, host, args }, 'tmux control command failed')
  })
}

const MAX_VIEWERS = 3
const MAX_WS_PAYLOAD = 64 * 1024
const DEFAULT_PING_INTERVAL_MS = 30_000
const DEFAULT_PONG_TIMEOUT_MS = 10_000

type ConsumeFn = (ticket: string, nowS: number) => ConsumeResult
type SessionNameFn = (agentName: string) => string

interface BridgeOptions {
  allowedOrigins?: Set<string>
  pingIntervalMs?: number
  pongTimeoutMs?: number
  // Resolve an agent's remote ssh host (null = local). Injected so the bridge
  // attaches to a remote agent's tmux session over ssh instead of looking for
  // it on the dashboard host. Defaults to local-only.
  resolveHost?: (agentName: string) => string | null
}

const viewerCount = new Map<string, number>()

export function attachWsUpgradeHandler(
  server: http.Server,
  consumeTicketFn: ConsumeFn,
  sessionNameFn: SessionNameFn,
  options: BridgeOptions = {},
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })
  const allowedOrigins = options.allowedOrigins
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
  const pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS
  const resolveHost = options.resolveHost ?? (() => null)

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'ws://localhost')
    if (url.pathname !== '/ws/agent-pty') {
      socket.destroy()
      return
    }
    // CSRF defense-in-depth: WS upgrade Origin must match dashboard allowlist
    // when one is configured. The ticket is primary auth; this is belt+braces.
    const origin = (req.headers.origin as string | undefined) ?? ''
    if (allowedOrigins && origin && !allowedOrigins.has(origin)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, url, consumeTicketFn, sessionNameFn, resolveHost, pingIntervalMs, pongTimeoutMs)
    })
  })
}

function handleConnection(
  ws: WebSocket,
  url: URL,
  consumeTicketFn: ConsumeFn,
  sessionNameFn: SessionNameFn,
  resolveHost: (agentName: string) => string | null,
  pingIntervalMs: number,
  pongTimeoutMs: number,
): void {
  const ticket = url.searchParams.get('ticket') ?? ''
  const cols = Math.max(1, parseInt(url.searchParams.get('cols') ?? '120', 10))
  const rows = Math.max(1, parseInt(url.searchParams.get('rows') ?? '30', 10))

  const result = consumeTicketFn(ticket, Math.floor(Date.now() / 1000))
  if (!result.ok) {
    ws.close(4401, 'invalid or expired ticket')
    return
  }

  // The agent name comes ONLY from the ticket — never from URL params.
  const agentName = result.agentName
  const session = sessionNameFn(agentName)
  // Remote agents (e.g. on the laptop) run their tmux session on another host;
  // attach over ssh instead of looking for the session on the dashboard host.
  const host = resolveHost(agentName)

  const current = viewerCount.get(session) ?? 0
  if (current >= MAX_VIEWERS) {
    ws.close(4429, 'too many viewers')
    return
  }

  let ptyProc: pty.IPty
  try {
    const cmd = ptyAttachCommand(host, session)
    ptyProc = pty.spawn(cmd.file, cmd.args, {
      cols,
      rows,
      name: 'xterm-256color',
      env: process.env as Record<string, string>,
      cwd: process.env.HOME ?? '/tmp',
    })
  } catch {
    ws.close(4404, 'agent session not running')
    return
  }

  viewerCount.set(session, (viewerCount.get(session) ?? 0) + 1)
  logger.info({ agentName, session }, 'PTY viewer connected')

  // Pin the agent window to this viewer's size. Default 'window-size latest'
  // makes tmux flap the shared window to whichever client most recently changed
  // size, so a browser viewer and the operator's console fight over the size and
  // the agent TUI repaints fully on every flip -- the jitter seen in BOTH the
  // browser and the console. resize-window pins the window (implicitly sets
  // window-size=manual); cleanup() releases it for the last viewer.
  tmuxControl(host, ['resize-window', '-t', session, '-x', String(cols), '-y', String(rows)])

  // Keepalive: send ping every pingIntervalMs; if no pong arrives within
  // pongTimeoutMs the connection is treated as dead and cleaned up.
  // Worst-case dead-detect ≈ pingIntervalMs + pongTimeoutMs (e.g., 40s).
  let pongTimer: NodeJS.Timeout | undefined
  const pingTimer: NodeJS.Timeout = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.ping()
    pongTimer = setTimeout(() => {
      logger.warn({ session }, 'PTY viewer pong timeout, cleaning up')
      // Close with a distinct code so the client sees a deliberate teardown
      // (1011 = server error). cleanup() will be invoked again via the
      // 'close' handler and is idempotent.
      try { ws.close(1011, 'pong timeout') } catch {}
      cleanup()
    }, pongTimeoutMs)
    pongTimer.unref?.()
  }, pingIntervalMs)
  pingTimer.unref?.()
  ws.on('pong', () => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = undefined }
  })

  // pty output → WS
  ptyProc.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  })

  // WS input → pty
  ws.on('message', (msg: Buffer | string) => {
    const str = Buffer.isBuffer(msg) ? msg.toString('utf8') : msg
    try {
      const obj = JSON.parse(str)
      if (obj.type === 'resize' && Number.isFinite(obj.cols) && Number.isFinite(obj.rows)) {
        const c = Math.max(1, obj.cols), r = Math.max(1, obj.rows)
        try {
          ptyProc.resize(c, r)
          // Keep the manual pin in step with deliberate browser resizes so the
          // window follows the viewer's container instead of flapping.
          tmuxControl(host, ['resize-window', '-t', session, '-x', String(c), '-y', String(r)])
        } catch (err) {
          logger.warn({ err, session }, 'pty.resize after exit')
          cleanup()
        }
        return
      }
    } catch { /* not JSON — forward as raw input */ }
    try {
      ptyProc.write(str)
    } catch (err) {
      logger.warn({ err, session }, 'pty.write after exit')
      cleanup()
    }
  })

  let cleaned = false
  let killTimer: NodeJS.Timeout | undefined
  function cleanup() {
    if (cleaned) return
    cleaned = true
    clearInterval(pingTimer)
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = undefined }
    try { ptyProc.kill('SIGTERM') } catch {}
    killTimer = setTimeout(() => { try { ptyProc.kill('SIGKILL') } catch {} }, 2000)
    killTimer.unref?.()
    const n = Math.max(0, (viewerCount.get(session) ?? 1) - 1)
    if (n === 0) {
      viewerCount.delete(session)
      // Last viewer gone -- release the manual pin (unset at both window and
      // session scope) so the window-size reverts to the inherited 'latest' and
      // the operator's console reclaims its own size.
      tmuxControl(host, ['set-window-option', '-t', session, '-u', 'window-size'])
      tmuxControl(host, ['set-option', '-t', session, '-u', 'window-size'])
    } else {
      viewerCount.set(session, n)
    }
    logger.info({ session }, 'PTY viewer disconnected')
  }

  ws.on('close', cleanup)
  ws.on('error', cleanup)
  ptyProc.onExit(() => {
    // Clean exit — cancel pending SIGKILL escalation.
    if (killTimer) { clearTimeout(killTimer); killTimer = undefined }
    cleanup()
    if (ws.readyState === WebSocket.OPEN) ws.close(4404, 'session ended')
  })
}
