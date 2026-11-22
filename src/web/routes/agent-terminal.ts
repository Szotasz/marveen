import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { agentDir } from '../agent-config.js'
import { agentSessionName, isAgentRunning, tmuxInvocationFor } from '../agent-process.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { literalKeyArgs, specialKeyArgs, loginSequence, type LoginStep } from '../tmux-keys.js'
import { readTerminalInputEnabled, writeTerminalInputEnabled } from '../terminal-input-store.js'
import type { RouteContext } from './types.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import { exactTmuxTarget } from '../../tmux-target.js'

// Per-agent dashboard terminal: live pane stream (SSE), keystroke injection,
// and the scripted /login flow. All gated by the dashboard token (the SSE
// endpoint accepts the token via ?token= because EventSource cannot set
// headers -- see the auth gate in web.ts). Szabi 2026-06-03.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// has-session off the event loop, with the child's stdio ignored as the
// synchronous call had it (no buffering, so no output size can turn a
// successful exit into "not running"); alive means exit status 0.
function isTmuxSessionAlive(session: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const inv = tmuxInvocationFor(['has-session', '-t', exactTmuxTarget(session)])
      const child = spawn(inv.file, inv.args, { stdio: 'ignore', timeout: 3000 })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

// Resolve a terminal target for both sub-agents and the MAIN agent (Marveen).
// The main agent has no agents/<name> dir and runs in `<id>-channels`, not
// `agent-<name>` -- so the sub-agent assumptions (existsSync(agentDir) +
// agentSessionName) 404 it (Zara hit this, 871005b). Branch on the main agent.
interface SessionTarget { exists: boolean; running: boolean; session: string }
async function resolveTarget(name: string): Promise<SessionTarget> {
  if (isMainChannelsAgent(name)) {
    return { exists: true, running: await isTmuxSessionAlive(MAIN_CHANNELS_SESSION), session: MAIN_CHANNELS_SESSION }
  }
  return { exists: existsSync(agentDir(name)), running: isAgentRunning(name), session: agentSessionName(name) }
}

// Run a single `tmux <args>` invocation. Rejects on non-zero exit so the
// caller can surface a 500 rather than silently swallowing a tmux failure.
//
// Goes through tmuxInvocationFor (agent-process.ts) rather than the raw binary:
// an agent that owns its OS user lives on its OWN tmux server, and a cross-user
// connection is refused even when the socket permissions allow it. Calling the
// bare binary here made every /keys and /login write answer 500 for exactly the
// agents most likely to need one -- measured twice on this install, 2026-08-26
// and 2026-08-27, while the operator was trying to clear a permission prompt.
function tmux(args: string[]): Promise<void> {
  const inv = tmuxInvocationFor(args)
  return new Promise((resolve, reject) => {
    execFile(inv.file, inv.args, { timeout: 5000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// Same as tmux(), but resolves with the command's stdout (display-message -p).
function tmuxOutput(args: string[]): Promise<string> {
  const inv = tmuxInvocationFor(args)
  return new Promise((resolve, reject) => {
    execFile(inv.file, inv.args, { timeout: 5000, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout ?? ''))
    })
  })
}

/** Parse a `#{window_width}x#{window_height}` read-back; null when it does not match. */
export function parseWindowSize(out: string): { cols: number; rows: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(out.trim())
  if (!m) return null
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

// Sanitize a literal keys payload before it hits send-keys. Motivation
// (v1.19.0, Szabi UX): on a VPS the operator pastes a token-login link / auth
// code into the terminal input, and copy-paste often drags along leading/trailing
// whitespace or a trailing newline -- the newline would prematurely SUBMIT the
// half-pasted line, and stray spaces corrupt the code/URL. So for a PASTE
// (multi-char payload) we strip bracketed-paste markers, drop all CR/LF (a login
// URL/code is single-line; an embedded newline can only hurt), and trim the
// outer whitespace. A single keystroke (length <= 1) is passed through untouched
// so deliberately typing a space still works. The intentional Enter is a
// SEPARATE {special:'Enter'} action, never part of the text payload, so trimming
// the text is safe.
export function sanitizeLiteralKeys(keys: string): string {
  if (keys.length <= 1) return keys // single keystroke -- literal passthrough
  const noPasteMarkers = keys.replace(/\x1b\[20[01]~/g, '')
  const singleLine = noPasteMarkers.replace(/[\r\n]+/g, '')
  return singleLine.replace(/^\s+|\s+$/g, '')
}

/**
 * Az audit-naplóba kerülő leírás egy beírt szövegről -- a szöveg TARTALMA NÉLKÜL.
 *
 * MIÉRT (kanban dashboard-key-logging, jelezve 2026-08-02, javítva 2026-08-11): ez a sor
 * korábban a nyers payloadot írta a naplóba (`keys:"..."`), és 806 ilyen sor gyűlt össze a
 * store/dashboard.log-ban. A súlyt kimértük: a 11 hosszú érték MIND különböző volt, és egyik
 * SEM a hosszú életű titkaink közül való -- a vault egyszer használatos, 15 percig élő
 * beviteli-link tokenjeire illettek. Tehát tartós titok nem szivárgott ki, és rotálni sem
 * kellett. A kockázat viszont ELŐRE mutat: aki valaha egy valódi jelszót másol a
 * webterminálba, azt eddig szó szerint naplóztuk volna.
 *
 * Amit az auditnak tudnia kell, az NEM a tartalom, hanem hogy TÖRTÉNT-E injektálás, mekkora
 * volt, és -- egy hamisított prompt visszakereséséhez -- hogyan kezdődött. Négy karakter ehhez
 * elég, és önmagában nem használható titokként.
 */
export function maskKeysPreview(keys: string): string {
  const head = keys.slice(0, 4).replace(/\s/g, ' ')
  return `keys:len=${keys.length} head=${JSON.stringify(head)}${keys.length > 4 ? '…(maszkolva)' : ''}`
}

// Bounds for the viewer-driven window size. Below 20x5 Claude Code's UI is unusable,
// and above 500x200 a single capture-pane frame (with -S -2000 scrollback) grows
// for no visible gain.
export const TERMINAL_COLS_MIN = 20
export const TERMINAL_COLS_MAX = 500
export const TERMINAL_ROWS_MIN = 5
export const TERMINAL_ROWS_MAX = 200

/**
 * Validate a `{cols, rows}` body for the pane-size route. Only real integers inside
 * the bounds pass (no numeric strings, no fractions, no NaN/Infinity), so what
 * reaches the tmux argv is always a plain decimal number.
 */
export function parseTerminalSize(body: unknown): { cols: number; rows: number } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { cols, rows } = body as { cols?: unknown; rows?: unknown }
  const ok = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
  if (!ok(cols, TERMINAL_COLS_MIN, TERMINAL_COLS_MAX) || !ok(rows, TERMINAL_ROWS_MIN, TERMINAL_ROWS_MAX)) return null
  return { cols, rows }
}

// The window is never made smaller than the tmux default 80x24, whatever the
// viewer asks for. The size outlives the modal, and other readers of the pane
// (the pane-state classifier, the stuck-tool watcher, the inbox wake) judge
// idle/busy from capture-pane text: a phone-sized 45x20 window would wrap and cut
// what they read. A small modal therefore gets the old 80x24 view, as before.
export const TERMINAL_COLS_FLOOR = 80
export const TERMINAL_ROWS_FLOOR = 24

/** The size actually applied to the window: the request, raised to the 80x24 floor. */
export function appliedTerminalSize(size: { cols: number; rows: number }): { cols: number; rows: number } {
  return { cols: Math.max(size.cols, TERMINAL_COLS_FLOOR), rows: Math.max(size.rows, TERMINAL_ROWS_FLOOR) }
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

  // --- terminal-input master toggle (owner-gated opt-in) ---------------
  // GET returns the current state; POST {enabled:boolean} flips it. GET sits
  // behind the global dashboard-token gate (web.ts); POST also needs the owner
  // (OWNERGATE3-1104), since the shared token is readable by every sub-agent. This is the deliberate first step of the two-step opt-in:
  // /keys stays 403 until this is ON. Every flip is audit-logged.
  if (path === '/api/terminal-input') {
    if (method === 'GET') {
      json(res, { enabled: readTerminalInputEnabled() })
      return true
    }
    if (method === 'POST') {
      // OWNERGATE3-1104: flips store/terminal-input.json, the master switch that lets /keys type into ANY agent's
      // pane; owner-only, before the body is read. Turning it OFF is gated too: no machine caller turns it off
      // (none in scripts/, src/, the skills or the UI beyond the owner's own toggle), and an open OFF would let the
      // shared token silently cut the owner's terminal mid-session.
      if (!mayActAsOwner(ctx.auth, ctx.req)) {
        refuseOwner(res, 'Turning terminal input on or off needs the dashboard login (an owner session).')
        return true
      }
      const body = await readBody(ctx.req)
      let enabled: unknown
      try { enabled = (JSON.parse(body.toString()) as { enabled?: unknown }).enabled } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
      if (typeof enabled !== 'boolean') {
        json(res, { error: 'Provide {enabled:boolean}' }, 400)
        return true
      }
      const next = writeTerminalInputEnabled(enabled)
      logger.warn({
        enabled: next,
        remote: ctx.req.socket?.remoteAddress ?? 'unknown',
        xff: ctx.req.headers['x-forwarded-for'] ?? '',
        ua: ctx.req.headers['user-agent'] ?? '',
      }, `agent-terminal: TERMINAL-INPUT TOGGLE ${next ? 'ENABLED' : 'DISABLED'}`)
      json(res, { enabled: next })
      return true
    }
  }

  // --- live pane stream (SSE) ------------------------------------------
  const streamMatch = path.match(/^\/api\/agents\/([^/]+)\/pane\/stream$/)
  if (streamMatch && method === 'GET') {
    const name = decodeURIComponent(streamMatch[1])
    // The client can go away while resolveTarget awaits tmux; listen first, so a
    // close during that await is not missed (it would leave the ticks running).
    let closed = false
    let interval: ReturnType<typeof setInterval> | undefined
    const stop = (): void => { closed = true; if (interval) clearInterval(interval) }
    ctx.req.on('close', stop)
    ctx.req.on('error', stop)
    const target = await resolveTarget(name)
    if (closed) return true
    if (!target.exists) { json(res, { error: 'Agent not found' }, 404); return true }
    const session = target.session

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

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
      // Same resolution as the write path: for a per-user agent the pane lives on
      // that user's tmux server, and a raw binary call returns nothing -- which
      // the stream renders as a blank terminal rather than an error. That blank
      // pane is what the operator reported as "nem jelenit meg semmit".
      const capture = tmuxInvocationFor(['capture-pane', '-t', exactTmuxTarget(session), '-S', '-2000', '-e', '-p'])
      execFile(capture.file, capture.args, { timeout: 3000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (closed) { inFlight = false; return }
        const pane = err ? '' : (stdout ?? '')
        // The tick stays in flight until the probe answers, so a slow probe
        // never overlaps the next tick.
        const send = (running: boolean): void => {
          inFlight = false
          if (closed) return
          try {
            res.write(`data: ${JSON.stringify({ pane, running })}\n\n`)
          } catch {
            closed = true
          }
        }
        // A successful capture proves the session is alive; only re-probe on
        // capture failure (cheap, and avoids a has-session call every tick).
        if (err) void isTmuxSessionAlive(session).then(send)
        else send(true)
      })
    }

    tick()
    interval = setInterval(tick, 700)
    return true
  }

  // --- window size follows the viewer ----------------------------------
  // The stream above mirrors capture-pane, so the modal can never show more than
  // the pane holds. A detached agent session runs at the tmux default size
  // (80x24), which the modal showed as a small block in its top-left corner.
  // The modal posts its fitted xterm size here (on open and on every resize),
  // and the agent's window is resized to it, so Claude Code re-renders at the
  // viewer's size. Two viewers with different sizes: the last post wins.
  //
  // resize-window pins the window's `window-size` option to manual. It is unset
  // right after, back to the inherited value: with no client attached the window
  // keeps the size just set (measured on tmux 3.6a and 3.7b), and an operator who
  // later runs `tmux attach` still gets the window sized to their own terminal.
  //
  // The main agent's channel session is left out: the route answers
  // {ok:false, skipped:'main-channels'} without any tmux call, and the modal keeps
  // the old view. Nothing restores the size when the modal closes, the channel
  // pane's classifiers have not been measured at a larger size, and a silenced
  // main session is the most expensive failure.
  //
  // Owner-gated like /keys and /login: it changes the agent's tmux window. It is
  // NOT behind the terminal-input toggle, since it types nothing into the pane.
  const sizeMatch = path.match(/^\/api\/agents\/([^/]+)\/pane\/size$/)
  if (sizeMatch && method === 'POST') {
    const name = decodeURIComponent(sizeMatch[1])
    if (!mayActAsOwner(ctx.auth, ctx.req)) {
      refuseOwner(res, 'Resizing an agent\'s terminal needs the dashboard login (an owner session).')
      return true
    }
    const body = await readBody(ctx.req)
    let parsedBody: unknown
    try { parsedBody = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const size = parseTerminalSize(parsedBody)
    if (!size) {
      json(res, {
        error: `Provide integer {cols, rows}: cols ${TERMINAL_COLS_MIN}..${TERMINAL_COLS_MAX}, rows ${TERMINAL_ROWS_MIN}..${TERMINAL_ROWS_MAX}`,
      }, 400)
      return true
    }
    // The main agent's channel session is never resized (see the comment above):
    // no tmux call at all, not even the liveness probe of resolveTarget.
    if (isMainChannelsAgent(name)) {
      json(res, { ok: false, skipped: 'main-channels' })
      return true
    }
    const target = await resolveTarget(name)
    if (!target.exists) { json(res, { error: 'Agent not found' }, 404); return true }
    if (!target.running) { json(res, { error: 'Agent is not running' }, 400); return true }
    // Never below 80x24 (see TERMINAL_COLS_FLOOR): the pane readers need it.
    const applied = appliedTerminalSize(size)

    // The unset of window-size names NO scope flag: tmux takes the scope from the
    // option's own table entry. window-size is a window option from tmux 3.1 and a
    // session option in 2.9/3.0, where a `-w` unset would fail right after the
    // resize was applied and leave the window pinned to manual. Measured on 3.7b
    // only: without the flag the window option is unset. The 2.9/3.0 behaviour
    // comes from tmux's option table, not from a run.
    const unsetWindowSize = ['set-option', '-u', '-t', exactTmuxTarget(target.session), 'window-size']
    try {
      // ONE tmux invocation (`;` is tmux's own command separator, a separate argv
      // element, not a shell token): there is no second process launch that could
      // fail between the resize and the unset.
      await tmux([
        'resize-window', '-t', exactTmuxTarget(target.session), '-x', String(applied.cols), '-y', String(applied.rows),
        ';', ...unsetWindowSize,
      ])
    } catch (err) {
      // tmux stops a chain at the first failing command, so the resize may have
      // been applied while the unset was not: retry the unset on its own, best
      // effort, so the window is not left pinned to manual.
      await tmux(unsetWindowSize).catch(() => {})
      logger.warn({ err, name, ...applied }, 'agent-terminal: resize-window failed')
      json(res, { error: 'resize failed' }, 500)
      return true
    }

    // Report the size the window really has. A client attached to it (an
    // operator's `tmux attach`, a control-mode client, a session that links the
    // window) keeps its own size once window-size is back to `latest`, so the
    // requested size may not be what tmux shows. The read-back is a SEPARATE
    // invocation: on tmux 3.7b a display-message chained after the unset still
    // printed the requested size, and the next invocation the attached client's.
    // If the read-back fails, the applied size is reported and a warning logged.
    let actual = applied
    try {
      const out = await tmuxOutput(['display-message', '-p', '-t', exactTmuxTarget(target.session), '#{window_width}x#{window_height}'])
      const read = parseWindowSize(out)
      if (read) actual = read
      else logger.warn({ name }, 'agent-terminal: window size read-back unreadable')
    } catch (err) {
      logger.warn({ err, name }, 'agent-terminal: window size read-back failed')
    }
    const snappedBack = actual.cols !== applied.cols || actual.rows !== applied.rows
    // Audit the accepted resize like the sibling routes: the validated numbers
    // only, never the raw body.
    logger.info({ name, cols: actual.cols, rows: actual.rows, ...(snappedBack ? { requested: applied, snappedBack } : {}) }, 'agent-terminal: pane resized')
    json(res, { ok: true, cols: actual.cols, rows: actual.rows, ...(snappedBack ? { snappedBack: true } : {}) })
    return true
  }

  // --- keystroke injection ---------------------------------------------
  const keysMatch = path.match(/^\/api\/agents\/([^/]+)\/keys$/)
  if (keysMatch && method === 'POST') {
    const name = decodeURIComponent(keysMatch[1])
    // SECURITY (2026-06-26 / 2026-07-05): this raw keystroke-injection endpoint --
    // the dashboard live-terminal write path (#275) -- lets a dashboard-token
    // holder type arbitrary input into an agent's tmux pane, and originally never
    // logged successful calls, so an injection left no trace. That made it the
    // (unlogged) vector for the forged-"Szabi" prompt injections in the
    // 2026-06-26 incident, and it was disabled outright.
    //
    // It comes back (ddc0cd9b, Szabi option B) as a DELIBERATE two-step opt-in:
    // the operator must explicitly flip the terminal-input toggle ON in the
    // dashboard (behind the dashboard-token gate) before any /keys call is
    // accepted; default OFF, fail-closed (readTerminalInputEnabled). AND every
    // ACCEPTED call is now audit-logged with remote-addr + UA + agent + a preview
    // of the injected keys/special -- the #1 missing fix from the incident.
    // Legit inter-agent delivery is unaffected: it uses the message-router's own
    // send-keys path, not this HTTP endpoint.
    const remote = ctx.req.socket?.remoteAddress ?? 'unknown'
    const xff = ctx.req.headers['x-forwarded-for'] ?? ''
    const ua = ctx.req.headers['user-agent'] ?? ''
    // OWNERGATE3-1104: types arbitrary input into an agent's tmux pane, i.e. full control of that agent; the
    // toggle below is a second switch, not an identity check (while it is ON, the shared token every sub-agent can
    // read would pass it). Owner-only, before the toggle, the target lookup, the body and any tmux call.
    if (!mayActAsOwner(ctx.auth, ctx.req)) {
      logger.warn({ name, remote, xff, ua, auth: ctx.auth?.kind ?? 'none' }, 'agent-terminal: KEYS INJECTION REFUSED (no owner session)')
      refuseOwner(res, 'Typing into an agent\'s terminal needs the dashboard login (an owner session).')
      return true
    }
    if (!readTerminalInputEnabled()) {
      logger.warn({ name, remote, xff, ua }, 'agent-terminal: KEYS INJECTION BLOCKED (toggle OFF)')
      json(res, { error: 'Terminal input is disabled. Enable it in the dashboard first.' }, 403)
      return true
    }
    const target = await resolveTarget(name)
    if (!target.exists) { json(res, { error: 'Agent not found' }, 404); return true }
    if (!target.running) { json(res, { error: 'Agent is not running' }, 400); return true }
    const session = target.session
    const body = await readBody(ctx.req)
    let parsed: { keys?: string; special?: string }
    try { parsed = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }

    // Sanitize a pasted literal payload (strip surrounding whitespace + stray
    // newlines) so a pasted login link/code doesn't pre-submit or get corrupted.
    const literalKeys = typeof parsed.keys === 'string' ? sanitizeLiteralKeys(parsed.keys) : null
    const args = parsed.special
      ? specialKeyArgs(session, parsed.special)
      : (literalKeys ? literalKeyArgs(session, literalKeys) : null)
    if (!args) {
      json(res, { error: 'Provide {keys:string} or an allow-listed {special}' }, 400)
      return true
    }
    // AUDIT every accepted injection. Preview describes the SANITIZED payload actually sent,
    // but it MUST NOT contain the payload itself.
    //
    // MIÉRT MASZKOLVA (kanban dashboard-key-logging, 2026-08-02 jelzés, 2026-08-11 javítás):
    // ez a sor korábban a nyers szöveget írta a naplóba (`keys:"..."`), és 806 ilyen sor gyűlt
    // össze. A súlyt kimértük: a 11 hosszú érték MIND különböző volt, és egyik SEM a hosszú
    // életű titkaink közül való — a vault egyszer használatos, 15 percig élő beviteli-link
    // tokenjeire illettek, tehát nem szivárgott ki tartós titok. A kockázat viszont ELŐRE
    // mutat: aki valaha egy valódi jelszót másol a webterminálba, azt szó szerint naplózzuk.
    //
    // Amit a naplónak tudnia kell, az NEM a tartalom, hanem hogy TÖRTÉNT-E injektálás, mikor,
    // kitől és mekkora. A hossz és az első néhány karakter elég ahhoz, hogy egy hamisított
    // prompt nyomon követhető legyen; a teljes szöveg csak kárt tud okozni.
    const preview = parsed.special
      ? `special:${parsed.special}`
      : maskKeysPreview(literalKeys ?? '')
    logger.info({ name, remote, xff, ua, preview }, 'agent-terminal: KEYS INJECTION ACCEPTED')
    // ENVATLEAK1114: typed AS IS, deliberately WITHOUT the pane mapping (pane-text.ts paneTyped). This is
    // the owner's own keyboard into the pane: an at-sign file reference typed here is what the owner meant,
    // and escaping it would change their keystrokes. Every other path that types outside text is mapped.
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
    // OWNERGATE3-1104: types the scripted /login sequence into the agent's pane and confirms it, i.e. starts a new
    // Claude login for that agent (whose account it then runs on); owner-only, before the target lookup and any tmux.
    if (!mayActAsOwner(ctx.auth, ctx.req)) {
      refuseOwner(res, 'Starting an agent\'s Claude login needs the dashboard login (an owner session).')
      return true
    }
    const target = await resolveTarget(name)
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
