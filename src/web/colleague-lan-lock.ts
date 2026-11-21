// The colleague LAN lock (COLLANLOCK1120, Refs #2929; docs/board-access.md, "LAN lock").
//
// The colleague board login (#2929) is meant to be reached from the LAN. With WEB_HOST opened for it, every other
// route, the owner's login included, would be reachable from the LAN as well, over plain HTTP, and anyone there could
// use up the owner login's global failure cap. While this lock is ACTIVE, a request from a non-loopback peer reaches
// only the colleague surface (the same set the colleague gate allows a colleague session: /api/colleague/*,
// /api/board*, the colleague page and its static files). Everything else is refused before authentication, so the
// owner login cannot even be tried from the LAN.
//
// Active (COLLEAGUE_LAN_LOCK):
//   on   always
//   off  never
//   auto (default) only while the colleague login is in use: WEB_HOST is not loopback, at least one colleague account
//        is enabled, and the scoped board is on. Otherwise nothing changes, so an install that opened WEB_HOST for its
//        own remote access (Docker, a VPS) keeps working until it creates a colleague account.
// off, and on -> auto, loosen the lock (config-registry `loosens`): only an owner session sets them, and a loosening
// .env line is ignored. process.env is never read for it.
//
// The peer is req.socket.remoteAddress, never a header (X-Forwarded-For and friends are written by the caller). An
// IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) is loopback. A proxy on the same machine (Tailscale Serve, an SSH
// tunnel) arrives from loopback and is therefore not locked: those are the owner's ways in while the lock is active.

import type http from 'node:http'
import { getEffectiveSettingValue } from '../settings-store.js'
import { readBoardAccess } from './board-access.js'
import { readColleagueAccounts } from './colleague-accounts.js'
import { colleagueGateDecision, type ColleagueGateResult } from './colleague-gate.js'

export type LanLockMode = 'auto' | 'on' | 'off'

/** The setting, from the settings store only (override, else a tightening .env line, else the default). Unknown -> auto. */
export function readLanLockMode(
  read: () => string | undefined = () => {
    try { return String(getEffectiveSettingValue('COLLEAGUE_LAN_LOCK') ?? '') } catch { return undefined }
  },
): LanLockMode {
  const v = (read() ?? '').trim().toLowerCase()
  return v === 'on' || v === 'off' ? v : 'auto'
}

function isLoopbackAddress(a: string): boolean {
  const v = a.trim().toLowerCase()
  if (v === '::1' || v === 'localhost') return true
  const v4 = v.startsWith('::ffff:') ? v.slice(7) : v
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/** Is the bind address a loopback one (127.0.0.0/8, ::1, localhost)? 0.0.0.0, :: or a LAN address is not. */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host)
}

/** Is the connection's peer loopback? A missing address (a closed socket) is not. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return typeof remoteAddress === 'string' && remoteAddress !== '' && isLoopbackAddress(remoteAddress)
}

export interface LanLockInputs {
  mode: LanLockMode
  webHost: string
  /** At least one colleague account that is not disabled. */
  colleagueInUse: boolean
  /** board-access.json readable and enabled. */
  boardOn: boolean
}

export function lanLockActive(i: LanLockInputs): boolean {
  if (i.mode === 'on') return true
  if (i.mode === 'off') return false
  return !isLoopbackHost(i.webHost) && i.colleagueInUse && i.boardOn
}

/**
 * The live answer, read lazily: the setting first, then the bind address, and the accounts file and the board config
 * only when they can still decide it (auto with a non-loopback bind). Same rule as lanLockActive.
 */
export function lanLockActiveNow(webHost: string): boolean {
  const mode = readLanLockMode()
  if (mode !== 'auto') return mode === 'on'
  if (isLoopbackHost(webHost)) return false
  const accounts = readColleagueAccounts()
  const colleagueInUse = !accounts.broken && [...accounts.accounts.values()].some((a) => !a.disabled)
  if (!colleagueInUse) return false
  const board = readBoardAccess()
  return lanLockActive({ mode, webHost, colleagueInUse, boardOn: board.enabled && !board.broken })
}

/**
 * null = let it through; otherwise the refusal (403) or the redirect to the colleague page (302).
 * `active` is asked only for a non-loopback peer, so a loopback request costs no file read.
 */
export function lanLockDecision(
  req: Pick<http.IncomingMessage, 'socket'>,
  path: string,
  method: string,
  active: () => boolean,
): ColleagueGateResult {
  if (isLoopbackPeer(req.socket?.remoteAddress)) return null
  if (!active()) return null
  const d = colleagueGateDecision({ kind: 'colleague' }, path, method)
  if (d && d.status === 403) {
    return { status: 403, reason: 'the colleague LAN lock is active: from this network only the colleague board is reachable' }
  }
  return d
}

/** What an active lock cuts off from a non-loopback peer, for the startup warning and the doc. */
export const LAN_LOCK_CUT_OFF = [
  'the owner dashboard and the owner login',
  'federation inbound (/.well-known/fleetq and the federation endpoints)',
  'the Teams card webhook (/api/approvals/teams-card-action)',
  'Bridge devices connecting over the LAN',
  'the WEB_PUBLIC_PORT public listener (the Docker Caddy proxy)',
] as const
