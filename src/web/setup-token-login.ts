// Add a Claude subscription from the dashboard by logging in (SETUPTOKENWIZ1022).
//
// The dashboard runs `claude setup-token` on its own machine, shows the owner the
// login link, takes back the code the login page hands out, and catches the
// long-lived token the CLI prints. The token then goes the same way a pasted one
// does (routes/claude-plans-login.ts -> commitNewPlan).
//
// The parser below is a port of the Bridge installer's TOKENWIZ1 relay
// (Szotasz/marveen-bridge-installer src/setup-token.ts), where the facts it
// stands on were measured: the prompt needs a PTY, the auth URL arrives inside an
// OSC 8 hyperlink, Ctrl-C does not end it but closing the terminal does, there is
// no self-timeout, and the token is printed (coloured, possibly wrapped) rather
// than written to a file. Re-measured here on CLI 2.1.308 for the URL leg: URL
// after ~3 s, OSC 8, host claude.com; the CLI calls $BROWSER with the URL, so
// the launch env points BROWSER at a no-op (otherwise a browser tab would open
// on the dashboard machine).
//
// SECRET REGIME: nothing read from the PTY leaves this module as text. The URL
// is extracted and checked against an allowlist; everything else is a status
// code. The token goes only to the sink the caller passes to submitCode, and
// the raw buffer is dropped as soon as it is caught.
//
// ISOLATION: the child claude must not load the channel plugin -- a child with
// the inherited environment stops the main agent's Telegram poller
// (docs/mcp-list-channel-plugin.md). So the env is built from an allowlist, with
// a throwaway CLAUDE_CONFIG_DIR and an empty TELEGRAM_STATE_DIR, and the whole
// temp root is removed on every ending.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryResolveFromPath } from '../platform.js'

// ---------------------------------------------------------------------------
// Parsing (pure).
// ---------------------------------------------------------------------------

/* eslint-disable no-control-regex */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI_RE = /\x1b\[[0-9;?<>=]*[A-Za-z]/g
const MISC_ESC_RE = /\x1b[=>]?/g
// OSC 8 hyperlink opener: ESC ] 8 ; params ; URI (BEL | ST)
const OSC8_TARGET_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g
/* eslint-enable no-control-regex */

export function stripAnsiOsc(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(MISC_ESC_RE, '')
}

// The lookahead keeps a URL still arriving (cut at a chunk boundary) from
// matching half: the visible URL counts only once whitespace follows it.
const OAUTH_URL_RE = /https:\/\/\S*oauth\/authorize\S*(?=\s)/
const AUTH_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)$/

/** The URL is shown to the owner as a link to open, so only an https
 * oauth/authorize URL on an Anthropic host passes. */
export function isAllowedAuthUrl(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && AUTH_HOST_RE.test(u.hostname) && u.pathname.endsWith('/oauth/authorize')
}

/** The first allowed oauth/authorize URL in the RAW stream, or null. The OSC 8
 * target is the whole URL even where the visible text is wrapped (measured on
 * 2.1.308 at the default width), so it is tried first; the stripped text is
 * the fallback. Both need the URL's end to have arrived. */
export function extractOauthUrl(raw: string): string | null {
  for (const m of raw.matchAll(OSC8_TARGET_RE)) {
    if (isAllowedAuthUrl(m[1])) return m[1]
  }
  const m = OAUTH_URL_RE.exec(stripAnsiOsc(raw))
  if (!m) return null
  const url = m[0].replace(/[\]\s"']+$/g, '')
  return isAllowedAuthUrl(url) ? url : null
}

// Token scan. The installer's scanner (TOKENWIZ1) treats a single newline
// inside the token as a terminal wrap and rejoins across it. Here the relay
// owns the geometry (512 columns, scripts/setup-token-pty.py), so a ~108-char
// token cannot wrap, and rejoining would only add a risk measured on CLI
// 2.1.308: lines end in "\r\r\n" and words are spaced with cursor moves, so a
// line after the token that starts with a word would be glued onto it. So here
// any newline ends the token, as does a colour reset, a space or any non-colour
// escape; colour (SGR) codes inside it are skipped. A scan that runs off the
// end of the buffer is incomplete (the rest may be in the next chunk) unless
// the stream has ended. A wrong cut cannot be stored: the shape check below and
// the live probe in the route both stand in the way.
const SGR_RE = /^\x1b\[[0-9;]*m/
const RESET_RE = /^\x1b\[(?:0|39)?m/
const TOKEN_CHAR = /[A-Za-z0-9_-]/
// The same shape claude-credentials-guard.ts accepts (OAUTH_TOKEN_RX).
const SETUP_TOKEN_SHAPE = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/

/** Every `sk-ant-` occurrence is tried in order: prose that names the prefix
 * before the real token must not hide it. */
export function extractSetupToken(raw: string, streamEnded = false): string | null {
  for (let anchor = raw.indexOf('sk-ant-'); anchor >= 0; anchor = raw.indexOf('sk-ant-', anchor + 1)) {
    const tok = scanTokenAt(raw, anchor, streamEnded)
    if (tok) return tok
  }
  return null
}

function scanTokenAt(raw: string, anchor: number, streamEnded: boolean): string | null {
  let i = anchor
  let tok = ''
  let ended = false
  while (i < raw.length) {
    const rest = raw.slice(i)
    if (rest[0] === '\x1b') {
      if (RESET_RE.test(rest)) { ended = true; break }
      const m = SGR_RE.exec(rest)
      if (m) { i += m[0].length; continue }
      // An escape cut off at the end of the buffer may still become a colour code.
      if (/^\x1b(?:\[[0-9;]*)?$/.test(rest)) break
      ended = true
      break
    }
    if (TOKEN_CHAR.test(rest[0])) { tok += rest[0]; i++; continue }
    ended = true
    break
  }
  return (ended || streamEnded) && SETUP_TOKEN_SHAPE.test(tok) ? tok : null
}

/** The code the login page hands out. It goes onto the PTY stdin, so control
 * characters (a stray Enter, an escape sequence) must not get through. */
export function isPlausibleLoginCode(code: string): boolean {
  return /^[A-Za-z0-9_#.~-]{8,1024}$/.test(code)
}

// ---------------------------------------------------------------------------
// The relay process.
// ---------------------------------------------------------------------------

export interface RelayProcess {
  write(data: string): void
  /** Close stdin: the relay closes the PTY, which ends the prompt. */
  end(): void
  kill(): void
  onData(cb: (chunk: string) => void): void
  onExit(cb: () => void): void
}

export type LaunchResult = { ok: true; relay: RelayProcess; cleanup: () => void } | { ok: false; code: 'claude-not-found' | 'spawn-failed' }

export const RELAY_SCRIPT = join(PROJECT_ROOT, 'scripts', 'setup-token-pty.py')

/** The child's whole environment. Nothing is inherited beyond these keys: no
 * token, no API key, no channel state dir. */
export function buildRelayEnv(root: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parent.PATH ?? '/usr/bin:/bin',
    HOME: homedir(),
    LANG: parent.LANG ?? 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    TELEGRAM_STATE_DIR: join(root, 'telegram'),
    BROWSER: join(root, 'no-browser.sh'),
  }
  for (const key of ['USER', 'LOGNAME', 'TMPDIR'] as const) {
    if (parent[key]) env[key] = parent[key] as string
  }
  return env
}

export function launchSetupTokenRelay(claudeBin?: string): LaunchResult {
  const claude = claudeBin ?? tryResolveFromPath('claude')
  if (!claude) return { ok: false, code: 'claude-not-found' }
  let root: string | null = null
  const cleanup = () => {
    if (root) { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } }
    root = null
  }
  try {
    root = mkdtempSync(join(tmpdir(), 'marveen-setup-token-'))
    mkdirSync(join(root, 'config'), { mode: 0o700 })
    mkdirSync(join(root, 'telegram'), { mode: 0o700 })
    writeFileSync(join(root, 'no-browser.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const child = spawn('python3', [RELAY_SCRIPT, claude], {
      env: buildRelayEnv(root),
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let exited = false
    const exitCbs: Array<() => void> = []
    const fireExit = () => {
      if (exited) return
      exited = true
      for (const cb of exitCbs) cb()
    }
    child.on('exit', fireExit)
    child.on('error', fireExit)
    child.stdin.on('error', () => { /* the relay is gone; exit fires */ })
    const relay: RelayProcess = {
      write: (data) => { if (!exited) child.stdin.write(data) },
      end: () => { if (!exited) child.stdin.end() },
      kill: () => { if (!exited) child.kill('SIGKILL') },
      onData: (cb) => { child.stdout.setEncoding('utf-8'); child.stdout.on('data', (s: string) => cb(s)) },
      onExit: (cb) => { if (exited) cb(); else exitCbs.push(cb) },
    }
    return { ok: true, relay, cleanup }
  } catch {
    cleanup()
    return { ok: false, code: 'spawn-failed' }
  }
}

// ---------------------------------------------------------------------------
// The session.
// ---------------------------------------------------------------------------

export type LoginPhase = 'waiting-url' | 'waiting-code' | 'waiting-token' | 'done' | 'failed' | 'cancelled'

export type LoginErrorCode =
  | 'claude-not-found' | 'spawn-failed' | 'url-timeout' | 'code-timeout' | 'token-timeout'
  | 'exited' | 'cancelled' | 'bad-code' | 'wrong-phase' | 'store-failed'

export interface LoginTimeouts {
  urlMs: number
  codeMs: number
  tokenMs: number
  /** After end(), how long the relay gets before SIGKILL. */
  killMs: number
}

export const DEFAULT_LOGIN_TIMEOUTS: LoginTimeouts = { urlMs: 30_000, codeMs: 600_000, tokenMs: 60_000, killMs: 5_000 }

/** Gap between the code and the Enter: the prompt folds a terminator arriving
 * in the same burst into the pasted text (installer measurement, CLI 2.1.220). */
export const SUBMIT_ENTER_DELAY_MS = 500

const BUFFER_CAP = 64 * 1024
const TERMINAL: ReadonlySet<LoginPhase> = new Set(['done', 'failed', 'cancelled'])

export type StartResult = { ok: true; url: string } | { ok: false; code: LoginErrorCode }
export type CodeResult<T> = { ok: true; result: T } | { ok: false; code: LoginErrorCode }

export class SetupTokenLogin {
  private phase: LoginPhase = 'waiting-url'
  private error: LoginErrorCode | null = null
  private url: string | null = null
  private buf = ''
  private relay: RelayProcess | null = null
  private relayExited = false
  private cleanup: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private enterTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private settleStart: ((r: StartResult) => void) | null = null
  private onToken: ((token: string | null) => void) | null = null

  constructor(
    private readonly launch: () => LaunchResult = launchSetupTokenRelay,
    private readonly timeouts: LoginTimeouts = DEFAULT_LOGIN_TIMEOUTS,
  ) {}

  getPhase(): LoginPhase { return this.phase }
  getError(): LoginErrorCode | null { return this.error }
  /** The login link while it is still usable (waiting for the code). */
  getUrl(): string | null { return this.phase === 'waiting-code' ? this.url : null }
  isActive(): boolean { return !TERMINAL.has(this.phase) }

  start(): Promise<StartResult> {
    return new Promise((resolve) => {
      const launched = this.launch()
      if (!launched.ok) {
        this.finish('failed', launched.code)
        resolve({ ok: false, code: launched.code })
        return
      }
      this.relay = launched.relay
      this.cleanup = launched.cleanup
      this.settleStart = resolve
      this.relay.onData((chunk) => this.onChunk(chunk))
      this.relay.onExit(() => {
        this.relayExited = true
        this.clearKillTimer()
        if (this.phase === 'waiting-token') this.catchToken(true)
        this.runCleanup()
        if (this.isActive()) this.finish('failed', 'exited')
      })
      this.timer = setTimeout(() => this.finish('failed', 'url-timeout'), this.timeouts.urlMs)
    })
  }

  /** Type the code and wait for the token. The token goes only to `sink`; its
   * return value is what the caller gets back. */
  submitCode<T>(code: string, sink: (token: string) => Promise<T>): Promise<CodeResult<T>> {
    if (this.phase !== 'waiting-code' || !this.relay) return Promise.resolve({ ok: false, code: 'wrong-phase' })
    if (!isPlausibleLoginCode(code)) return Promise.resolve({ ok: false, code: 'bad-code' })
    this.clearTimer()
    this.buf = ''
    this.phase = 'waiting-token'
    return new Promise((resolve) => {
      this.onToken = (token) => {
        this.onToken = null
        if (token === null) { resolve({ ok: false, code: this.error ?? 'exited' }); return }
        sink(token).then(
          (result) => resolve({ ok: true, result }),
          () => resolve({ ok: false, code: 'store-failed' }),
        )
      }
      this.timer = setTimeout(() => this.finish('failed', 'token-timeout'), this.timeouts.tokenMs)
      this.relay!.write(code)
      this.enterTimer = setTimeout(() => {
        this.enterTimer = null
        if (this.phase === 'waiting-token') this.relay?.write('\r')
      }, SUBMIT_ENTER_DELAY_MS)
    })
  }

  cancel(): void {
    if (this.isActive()) this.finish('cancelled', 'cancelled')
  }

  private onChunk(chunk: string): void {
    if (!this.isActive()) return
    this.buf = (this.buf + chunk).slice(-BUFFER_CAP)
    if (this.phase === 'waiting-url') {
      const url = extractOauthUrl(this.buf)
      if (!url) return
      this.clearTimer()
      this.url = url
      this.phase = 'waiting-code'
      this.timer = setTimeout(() => this.finish('failed', 'code-timeout'), this.timeouts.codeMs)
      const settle = this.settleStart
      this.settleStart = null
      settle?.({ ok: true, url })
    } else if (this.phase === 'waiting-token') {
      this.catchToken(false)
    }
  }

  private catchToken(streamEnded: boolean): void {
    const token = extractSetupToken(this.buf, streamEnded)
    if (!token) return
    const deliver = this.onToken
    this.finish('done', null)
    deliver?.(token)
  }

  private finish(phase: LoginPhase, error: LoginErrorCode | null): void {
    if (!this.isActive()) return
    this.phase = phase
    this.error = error
    this.buf = ''
    this.clearTimer()
    if (this.enterTimer) { clearTimeout(this.enterTimer); this.enterTimer = null }
    const settle = this.settleStart
    this.settleStart = null
    settle?.({ ok: false, code: error ?? 'exited' })
    if (phase !== 'done') {
      const deliver = this.onToken
      deliver?.(null)
    }
    if (this.relay && !this.relayExited) {
      this.relay.end()
      const relay = this.relay
      this.killTimer = setTimeout(() => { this.killTimer = null; relay.kill(); this.runCleanup() }, this.timeouts.killMs)
    } else {
      this.runCleanup()
    }
  }

  private runCleanup(): void {
    const c = this.cleanup
    this.cleanup = null
    c?.()
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  private clearKillTimer(): void {
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null }
  }
}
