import net from 'node:net'
import http from 'node:http'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// How long each connection attempt (TCP handshake, HTTP response) may take.
const PROBE_TIMEOUT_MS = 2500
// Minimum spacing between two probes. The endpoint opens raw sockets to a
// LAN host, so we throttle to stop it being turned into a network scanner.
const RATE_LIMIT_MS = 1000
// Hard cap on the request body -- the only field is a short IP string.
const MAX_BODY_BYTES = 4096

// Strict, full-string IPv4 shape. Anchored at both ends so hostnames, ports,
// URLs, CIDR suffixes, decimal/hex integer notations and IPv4-mapped IPv6 all
// fail here rather than sneaking past octet parsing.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export type ValidateResult =
  | { ok: true; ip: string }
  | { ok: false; reason: 'invalid-ip' | 'not-private' }

/**
 * Validate that `input` is a syntactically strict private-LAN IPv4 address.
 *
 * Pure and socket-free so the full edge-case matrix is unit-testable.
 *
 * Rejected as 'invalid-ip': anything not matching the anchored 4-octet regex
 * after trim (hostnames, ports, URLs, CIDR, decimal/hex notations, mapped
 * IPv6), any octet > 255, and octets with a leading zero (e.g. '010') so an
 * octal-looking value can never be silently reinterpreted downstream. A bare
 * '0' octet is allowed by the regex but such addresses fail the private check.
 *
 * Rejected as 'not-private': a well-formed IPv4 that is outside the RFC 1918
 * private ranges -- 10/8, 172.16/12 (second octet 16-31), 192.168/16. This
 * deliberately excludes loopback (127/8), link-local (169.254/16), 0/8 and all
 * public addresses, so the probe can never be pointed at an external host.
 */
export function validatePrivateIPv4(input: string): ValidateResult {
  const ip = (input ?? '').trim()
  const m = IPV4_RE.exec(ip)
  if (!m) return { ok: false, reason: 'invalid-ip' }

  const octets: number[] = []
  for (let i = 1; i <= 4; i++) {
    const part = m[i]
    // Leading zero (e.g. '010', '00') -- reject to avoid octal ambiguity.
    // A single '0' is fine.
    if (part.length > 1 && part[0] === '0') return { ok: false, reason: 'invalid-ip' }
    const n = Number(part)
    if (n > 255) return { ok: false, reason: 'invalid-ip' }
    octets.push(n)
  }

  const [a, b] = octets
  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  if (!isPrivate) return { ok: false, reason: 'not-private' }
  return { ok: true, ip }
}

export type ProbeReason = 'isapi' | 'http' | 'tcp-8000' | 'timeout' | 'refused'

export interface ProbeResult {
  online: boolean
  reason: ProbeReason
  latencyMs?: number
}

// Outcome of a single TCP handshake attempt. 'open' = accepted, 'refused' =
// actively rejected (RST), 'timeout' = silently dropped / host unreachable.
export type TcpProbeResult = 'open' | 'refused' | 'timeout'

// Transport seam so probeCamera's classification logic can be unit-tested with
// a fake, and the real implementation is the only thing touching sockets.
export interface ProbeTransport {
  tcpConnect(ip: string, port: number, timeoutMs: number): Promise<TcpProbeResult>
  // Resolves the HTTP status code, or null if the request errored/timed out.
  // The response BODY is never read -- only the status line matters.
  httpGet(url: string, timeoutMs: number): Promise<number | null>
}

/**
 * Classify a Hikvision camera's reachability.
 *
 * Strategy:
 *  (a) TCP:80 open  -> GET /ISAPI/System/deviceInfo. 200/401/403 -> 'isapi'
 *      (device online, possibly auth-gated); any other HTTP response or an
 *      HTTP-layer error on an open port -> 'http' (something is listening).
 *  (b) TCP:80 not open -> try TCP:8000 (Hikvision SDK/service port). Open ->
 *      'tcp-8000'.
 *  (c) neither open -> offline; 'timeout' if any attempt was silently dropped,
 *      else 'refused'.
 *
 * `latencyMs` is measured from the start of the probe to the point of a
 * positive (or final) classification.
 */
export async function probeCamera(
  ip: string,
  transport: ProbeTransport,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const start = now()

  const r80 = await transport.tcpConnect(ip, 80, PROBE_TIMEOUT_MS)
  if (r80 === 'open') {
    const status = await transport.httpGet(`http://${ip}/ISAPI/System/deviceInfo`, PROBE_TIMEOUT_MS)
    const latencyMs = now() - start
    if (status === 200 || status === 401 || status === 403) {
      return { online: true, reason: 'isapi', latencyMs }
    }
    // Port 80 accepted the connection but the HTTP layer gave a different
    // status or errored -- still online, just not the ISAPI web service.
    return { online: true, reason: 'http', latencyMs }
  }

  const r8000 = await transport.tcpConnect(ip, 8000, PROBE_TIMEOUT_MS)
  const latencyMs = now() - start
  if (r8000 === 'open') {
    return { online: true, reason: 'tcp-8000', latencyMs }
  }

  const reason: ProbeReason = r80 === 'timeout' || r8000 === 'timeout' ? 'timeout' : 'refused'
  return { online: false, reason }
}

// --- Real socket-backed transport -----------------------------------------

function realTcpConnect(ip: string, port: number, timeoutMs: number): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (r: TcpProbeResult) => {
      if (settled) return
      settled = true
      socket.destroy() // always release the fd -- no leak on any path
      resolve(r)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish('open'))
    socket.once('timeout', () => finish('timeout'))
    socket.once('error', () => finish('refused'))
    socket.connect(port, ip)
  })
}

function realHttpGet(url: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    let req: http.ClientRequest | null = null
    const finish = (v: number | null) => {
      if (settled) return
      settled = true
      if (req) req.destroy() // release the socket -- no leak
      resolve(v)
    }
    req = http.get(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0
      res.destroy() // never read the camera's response body
      finish(status)
    })
    req.on('timeout', () => finish(null))
    req.on('error', () => finish(null))
  })
}

const realTransport: ProbeTransport = {
  tcpConnect: realTcpConnect,
  httpGet: realHttpGet,
}

// --- Route -----------------------------------------------------------------

// Module-level throttle. inFlight blocks concurrent probes; lastRun enforces
// the minimum spacing between successive probes.
const rateState = { inFlight: false, lastRun: 0 }

export async function tryHandleCameraCheck(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/camera-check' || method !== 'POST') return false

  if (rateState.inFlight || Date.now() - rateState.lastRun < RATE_LIMIT_MS) {
    json(res, { error: 'busy' }, 429)
    return true
  }

  let ipRaw = ''
  try {
    const body = await readBody(req, { maxBytes: MAX_BODY_BYTES })
    const data = JSON.parse(body.toString()) as { ip?: unknown }
    ipRaw = typeof data.ip === 'string' ? data.ip : ''
  } catch {
    json(res, { error: 'invalid-ip' }, 400)
    return true
  }

  const v = validatePrivateIPv4(ipRaw)
  if (!v.ok) {
    json(res, { error: v.reason }, 400)
    return true
  }

  rateState.inFlight = true
  try {
    const result = await probeCamera(v.ip, realTransport)
    json(res, result, 200)
  } catch {
    // A probe failure is reported as offline; a stack trace never leaves the
    // process.
    json(res, { online: false, reason: 'refused' }, 200)
  } finally {
    rateState.inFlight = false
    rateState.lastRun = Date.now()
  }
  return true
}
