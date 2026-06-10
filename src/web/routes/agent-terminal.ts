import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveFromPath } from '../../platform.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { agentDir } from '../agent-config.js'
import { agentSessionName, isAgentRunning } from '../agent-process.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { literalKeyArgs, specialKeyArgs, loginSequence, type LoginStep } from '../tmux-keys.js'
import type { RouteContext } from './types.js'

const TMUX = resolveFromPath('tmux')

// Per-agent dashboard terminal: live pane stream (SSE), keystroke injection,
// and the scripted /login flow. All gated by the dashboard token (the SSE
// endpoint accepts the token via ?token= because EventSource cannot set
// headers -- see the auth gate in web.ts). Szabi 2026-06-03.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTmuxSessionAlive(session: string): boolean {
  try {
    execFileSync(TMUX, ['has-session', '-t', session], { timeout: 3000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Resolve a terminal target for both sub-agents and the MAIN agent (Marveen).
// The main agent has no agents/<name> dir and runs in `<id>-channels`, not
// `agent-<name>` -- so the sub-agent assumptions (existsSync(agentDir) +
// agentSessionName) 404 it (Zara hit this, 871005b). Branch on the main agent.
interface SessionTarget { exists: boolean; running: boolean; session: string }
function resolveTarget(name: string): SessionTarget {
  if (isMainChannelsAgent(name)) {
    return { exists: true, running: isTmuxSessionAlive(MAIN_CHANNELS_SESSION), session: MAIN_CHANNELS_SESSION }
  }
  return { exists: existsSync(agentDir(name)), running: isAgentRunning(name), session: agentSessionName(name) }
}

// Run a single `tmux <args>` invocation. Rejects on non-zero exit so the
// caller can surface a 500 rather than silently swallowing a tmux failure.
function tmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(TMUX, args, { timeout: 5000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function runLoginSteps(session: string, steps: LoginStep[]): Promise<void> {
  for (const step of steps) {
    const args = step.kind === 'literal'
      ? literalKeyArgs(session, step.text)
      : specialKeyArgs(session, step.key)
    if (args) await tmux(args)
    if (step.delayMs > 0) await sleep(step.delayMs)
  }
}

export async function tryHandleAgentTerminal(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  // --- live pane stream (SSE) ------------------------------------------
  const streamMatch = path.match(/^\/api\/agents\/([^/]+)\/pane\/stream$/)
  if (streamMatch && method === 'GET') {
    const name = decodeURIComponent(streamMatch[1])
    const target = resolveTarget(name)
    if (!target.exists) { json(res, { error: 'Agent not found' }, 404); return true }
    const session = target.session

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let closed = false
    let inFlight = false
    const tick = (): void => {
      if (closed || inFlight) return // skip if a slow capture is still running
      inFlight = true
      // ASYNC execFile (arg array) -- NOT execSync: a setInterval execSync would
      // block the WHOLE dashboard event loop for up to the tmux timeout on every
      // tick, freezing all other HTTP requests. The arg array also avoids shell
      // interpolation of `session`. -e keeps ANSI so xterm renders faithfully;
      // -p prints. `-S -2000` includes 2000 lines of scrollback history (not just
      // the visible pane) so the frontend can offer scroll-back; the frontend
      // repaints the full snapshot (clear-scrollback + clear + home) each changed
      // frame and only when the user is at the bottom, so scrolling up is stable.
      execFile(TMUX, ['capture-pane', '-t', session, '-S', '-2000', '-e', '-p'], { timeout: 3000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        inFlight = false
        if (closed) return
        const pane = err ? '' : (stdout ?? '')
        // A successful capture proves the session is alive; only re-probe on
        // capture failure (cheap, and avoids a has-session call every tick).
        const running = err ? isTmuxSessionAlive(session) : true
        try {
          res.write(`data: ${JSON.stringify({ pane, running })}\n\n`)
        } catch {
          closed = true
        }
      })
    }

    tick()
    const interval = setInterval(tick, 700)
    const stop = (): void => { closed = true; clearInterval(interval) }
    ctx.req.on('close', stop)
    ctx.req.on('error', stop)
    return true
  }

  // --- keystroke injection ---------------------------------------------
  const keysMatch = path.match(/^\/api\/agents\/([^/]+)\/keys$/)
  if (keysMatch && method === 'POST') {
    const name = decodeURIComponent(keysMatch[1])
    const target = resolveTarget(name)
    if (!target.exists) { json(res, { error: 'Agent not found' }, 404); return true }
    if (!target.running) { json(res, { error: 'Agent is not running' }, 400); return true }
    const session = target.session
    const body = await readBody(ctx.req)
    let parsed: { keys?: string; special?: string }
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }

    const args = parsed.special
      ? specialKeyArgs(session, parsed.special)
      : (typeof parsed.keys === 'string' ? literalKeyArgs(session, parsed.keys) : null)
    if (!args) {
      json(res, { error: 'Provide {keys:string} or an allow-listed {special}' }, 400)
      return true
    }
    try {
      await tmux(args)
      json(res, { ok: true })
    } catch (err) {
      logger.warn({ err, name }, 'agent-terminal: send-keys failed')
      json(res, { error: 'send-keys failed' }, 500)
    }
    return true
  }

  // --- scripted /login flow --------------------------------------------
  const loginMatch = path.match(/^\/api\/agents\/([^/]+)\/login$/)
  if (loginMatch && method === 'POST') {
    const name = decodeURIComponent(loginMatch[1])
    const target = resolveTarget(name)
    if (!target.exists) { json(res, { error: 'Agent not found' }, 404); return true }
    if (!target.running) { json(res, { error: 'Agent is not running' }, 400); return true }
    const session = target.session
    const body = await readBody(ctx.req)
    let phase: string | undefined
    try { phase = (JSON.parse(body.toString()) as { phase?: string }).phase } catch { /* default below */ }
    if (phase !== 'start' && phase !== 'confirm') {
      json(res, { error: "phase must be 'start' or 'confirm'" }, 400)
      return true
    }
    try {
      await runLoginSteps(session, loginSequence(phase))
      logger.info({ name, phase }, 'agent-terminal: /login sequence sent')
      json(res, { ok: true, phase })
    } catch (err) {
      logger.warn({ err, name, phase }, 'agent-terminal: /login sequence failed')
      json(res, { error: 'login sequence failed' }, 500)
    }
    return true
  }

  return false
}
