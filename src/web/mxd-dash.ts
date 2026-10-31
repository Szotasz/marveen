// GROMZOOWNERQR1030: the dashboard's client for marveen-mxd's dash.sock, and the
// owner QR codes built from it (first registration + a new phone's login).
//
// dash.sock (marveen-mxd src/dash.rs, src/main.rs serve_conn) is newline-delimited
// JSON over a Unix socket: one request line -> one reply line. mxd checks the
// peer uid against its configured dashboard user and answers anyone else with
// {"ok":false,"error":"forbidden"}.
//
// THE SECRETS. owner_invite returns `owner_secret` (registers the owner's account)
// and owner_login_code returns `login_secret` (`mol_...`, signs a new app in to the
// existing owner account). Each one is a live credential for the owner's chat
// account, issued by the controller and rate-limited there. Therefore, in this
// module and in its route:
//   - a secret is never logged, never put in an error, never stored, never cached;
//   - it leaves this module only inside the `uri` of an OwnerQr;
//   - every failure is reported as a fixed code, never with reply bytes in it.
// Each call to owner_invite / owner_login_code spends a real, rate-limited issue on
// the live controller: tests must use a fake socket (see the VITEST guard below).

import net from 'node:net'
import { readEnvFile } from '../env.js'

/** mxd's dash.sock where the installers put it (the agent.sock sibling, see
 *  agent-extra-channels.ts MXD_AGENT_SOCK_DEFAULT). mxd's socket_dir has no default
 *  of its own (config.rs): this is the packaged layout. */
export const MXD_DASH_SOCK_DARWIN = '/Library/Application Support/Marveen/mxd-run/dash.sock'
export const MXD_DASH_SOCK_LINUX = '/run/marveen-mxd/dash.sock'
export const MXD_DASH_SOCK_DEFAULT = process.platform === 'darwin' ? MXD_DASH_SOCK_DARWIN : MXD_DASH_SOCK_LINUX

/** One request -> one reply within this many ms, or the call fails with `timeout`. */
export const MXD_DASH_TIMEOUT_MS = 5_000
/** The longest reply line accepted. mxd's replies here are a few hundred bytes. */
export const MXD_DASH_MAX_REPLY = 64 * 1024

/** Where to reach dash.sock: MXD_DASH_SOCK in the install's .env (read per call:
 *  launchd does not pass .env into process.env), else the platform default. */
export function resolveMxdDashSock(): string {
  const v = (readEnvFile(['MXD_DASH_SOCK'])['MXD_DASH_SOCK'] ?? '').trim()
  return v || MXD_DASH_SOCK_DEFAULT
}

export type MxdDashFailure =
  | 'not_running' // no socket, or nobody listening
  | 'no_access' // the socket exists but this user may not open it
  | 'timeout'
  | 'oversized' // the reply line is longer than MXD_DASH_MAX_REPLY
  | 'malformed' // not one JSON object
  | 'closed' // the connection ended before a full line
  | 'io'
  | 'test_guard' // a test reached for the real socket

/** A transport failure. The message is the code only: never reply bytes. */
export class MxdDashError extends Error {
  readonly code: MxdDashFailure
  constructor(code: MxdDashFailure) {
    super(`mxd dash.sock: ${code}`)
    this.name = 'MxdDashError'
    this.code = code
  }
}

export interface MxdDashOptions {
  socketPath?: string
  timeoutMs?: number
  maxReply?: number
}

export type MxdDashReply = Record<string, unknown>
export type MxdDashCall = (request: { verb: string }) => Promise<MxdDashReply>

/**
 * Sends ONE request line to dash.sock and reads ONE reply line.
 * Resolves with the parsed reply object (ok:true or ok:false alike); rejects only
 * with an MxdDashError.
 */
export function mxdDashCall(request: { verb: string }, opts: MxdDashOptions = {}): Promise<MxdDashReply> {
  const socketPath = opts.socketPath ?? resolveMxdDashSock()
  const timeoutMs = opts.timeoutMs ?? MXD_DASH_TIMEOUT_MS
  const maxReply = opts.maxReply ?? MXD_DASH_MAX_REPLY
  // A unit test must never mint a real owner secret on the live controller: the
  // installed paths are refused under vitest whatever the caller passed.
  if (process.env.VITEST && (socketPath === MXD_DASH_SOCK_DARWIN || socketPath === MXD_DASH_SOCK_LINUX)) {
    return Promise.reject(new MxdDashError('test_guard'))
  }
  return new Promise<MxdDashReply>((resolve, reject) => {
    let settled = false
    const chunks: Buffer[] = []
    let total = 0
    const sock = net.createConnection({ path: socketPath })
    const finish = (err: MxdDashError | null, value?: MxdDashReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      // Drop the buffered bytes: a reply may carry a secret.
      chunks.length = 0
      if (err) reject(err)
      else resolve(value as MxdDashReply)
    }
    const timer = setTimeout(() => finish(new MxdDashError('timeout')), timeoutMs)
    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n')
    })
    sock.on('data', (c: Buffer) => {
      if (settled) return
      const nl = c.indexOf(0x0a)
      const take = nl === -1 ? c : c.subarray(0, nl)
      total += take.length
      if (total > maxReply) return finish(new MxdDashError('oversized'))
      chunks.push(take)
      if (nl === -1) return
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return finish(new MxdDashError('malformed'))
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish(new MxdDashError('malformed'))
      }
      finish(null, parsed as MxdDashReply)
    })
    sock.on('end', () => finish(new MxdDashError('closed')))
    sock.on('close', () => finish(new MxdDashError('closed')))
    sock.on('error', (e: NodeJS.ErrnoException) => {
      const code = e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTDIR'
        ? 'not_running'
        : e.code === 'EACCES' || e.code === 'EPERM'
          ? 'no_access'
          : 'io'
      finish(new MxdDashError(code))
    })
  })
}

// ---------------------------------------------------------------------------
// Owner QR codes

export type OwnerQrKind = 'join' | 'login'

export interface OwnerQr {
  kind: OwnerQrKind
  /** The app's QR content. The ONLY place the secret appears. */
  uri: string
  expires_in: number
}

export type OwnerQrResult = { ok: true, qr: OwnerQr } | { ok: false, code: string, retryAfter?: number }

/** The controller's login-secret prefix (marveen-mxd controller.rs OWNER_LOGIN_PREFIX,
 *  the app's JoinLink.loginSecretPrefix). */
export const OWNER_LOGIN_PREFIX = 'mol_'

/**
 * owner_invite refusals that mean "the owner seat is taken, or an invite is
 * already out" (marveen-matrix-server service.ts ownerInvite: once someone owns the
 * seat, AND while an earlier invite is live, the answer is owner_invite_already_issued;
 * owner_invite_used is in mxd's pass-through list too). Then the way in is the
 * owner's login code.
 */
export const OWNER_INVITE_FALLBACK_CODES: readonly string[] = ['owner_invite_already_issued', 'owner_invite_used']

/**
 * The app's QR URI (gromzo-ios-owner RegistrationKit/Sources/RegistrationKit/JoinLink.swift:3-4):
 *   join:  marveen://join?v=1&hs=<https origin>&t=<owner secret>
 *   login: marveen://login?v=1&hs=<https origin>&s=<mol_ login secret>
 * The values are percent-encoded, as in the app's own tests (JoinLinkTests.swift).
 */
export function buildOwnerQrUri(kind: OwnerQrKind, homeserver: string, secret: string): string {
  const hs = encodeURIComponent(homeserver.replace(/\/+$/, ''))
  const s = encodeURIComponent(secret)
  return kind === 'join'
    ? `marveen://join?v=1&hs=${hs}&t=${s}`
    : `marveen://login?v=1&hs=${hs}&s=${s}`
}

/** An https origin with nothing after the host (the app refuses anything else). */
function homeserverOk(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 256) return false
  let u: URL
  try { u = new URL(v) } catch { return false }
  return u.protocol === 'https:' && !u.username && !u.password && (u.pathname === '/' || u.pathname === '')
    && !u.search && !u.hash && v.replace(/\/+$/, '') === u.origin
}

/** mxd's own rule for a secret (controller.rs qr_answer), plus the kind's prefix rule. */
function secretOk(kind: OwnerQrKind, v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 256 || !/^[\x21-\x7e]+$/.test(v)) return false
  const isLogin = v.startsWith(OWNER_LOGIN_PREFIX) && v.length > OWNER_LOGIN_PREFIX.length
  return kind === 'login' ? isLogin : !v.startsWith(OWNER_LOGIN_PREFIX)
}

/** An mxd error code, passed on only when it is a plain code (mxd's code_ok rule). */
function errorCode(reply: MxdDashReply): string {
  const e = reply.error
  return typeof e === 'string' && /^[a-z0-9_]{1,40}$/.test(e) ? e : 'refused'
}

function qrFrom(kind: OwnerQrKind, reply: MxdDashReply): OwnerQrResult {
  const field = kind === 'join' ? 'owner_secret' : 'login_secret'
  const secret = reply[field]
  const exp = reply.expires_in
  if (!homeserverOk(reply.homeserver) || !secretOk(kind, secret)
      || typeof exp !== 'number' || !Number.isInteger(exp) || exp <= 0) {
    return { ok: false, code: 'bad_reply' }
  }
  return { ok: true, qr: { kind, uri: buildOwnerQrUri(kind, reply.homeserver, secret), expires_in: exp } }
}

/**
 * The owner's QR code: the first registration's join code while the owner seat is
 * free; once it is taken (or an invite is already out), the login code for a new
 * phone. A login code refused with no_owner after an "already issued" invite means
 * an unused invite is still live (10 minutes on the controller): `invite_outstanding`.
 */
export async function requestOwnerQr(call: MxdDashCall): Promise<OwnerQrResult> {
  const inv = await call({ verb: 'owner_invite' })
  if (inv.ok === true) return qrFrom('join', inv)
  const invCode = errorCode(inv)
  if (!OWNER_INVITE_FALLBACK_CODES.includes(invCode)) return { ok: false, code: invCode }
  const login = await call({ verb: 'owner_login_code' })
  if (login.ok === true) return qrFrom('login', login)
  const loginCode = errorCode(login)
  // GROMZORESETWAIT1031: the identity reset lock says when it ends (mxd passes the controller's
  // retry_after, seconds); only a whole number in 1..86400 is kept.
  const wait = login.retry_after
  if (loginCode === 'identity_reset_in_progress' && typeof wait === 'number' && Number.isInteger(wait) && wait >= 1 && wait <= 86_400) {
    return { ok: false, code: loginCode, retryAfter: wait }
  }
  return { ok: false, code: loginCode === 'no_owner' ? 'invite_outstanding' : loginCode }
}
