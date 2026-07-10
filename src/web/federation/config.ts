// Federation peer configuration (round 2: per-peer inbound tokens).
//
// Source of truth is store/federation.json (NOT the settings registry: a
// registry entry would create a second, conflicting switch via the generic
// /api/settings route writing config-overrides.json -- the terminal-input
// toggle precedent applies: own store file + own endpoints).
//
// FAIL-CLOSED: any read/parse/validation error yields a disabled config with
// no peers. A partially valid file does NOT enable a subset -- one bad peer
// disables the whole feature, with a single warn log. An unknown `trust`
// value is likewise a validation error: a half-deployed future trust feature
// must fail closed, not open.
//
// LOSSLESS DISABLE (round 2): enabled:false configs still parse and retain
// their peers, so flipping the switch back on needs no re-pairing. This
// deliberately amends the v1 doctrine "a disabled install never carries an
// authenticating secret": per-peer inboundTokens stay in the 0600 file while
// disabled (dashboard-only visibility; the full-removal endpoint purges
// everything). The GATE still refuses all federation auth while disabled.
//
// Tokens per peer:
//   inboundToken  -- REQUIRED, unique, >=32 chars. We mint it when the peer
//                    is added; the peer presents it to us. It identifies the
//                    caller (from-prefix must match).
//   outboundToken -- what WE present to the peer. MAY BE EMPTY: the pairing
//                    dance necessarily has a window where the other side has
//                    not minted ours yet ("pairing pending"). An empty
//                    outbound token never authenticates anything and the
//                    bridge refuses to send to such a peer.
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { STORE_DIR, MAIN_AGENT_ID } from '../../config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { logger } from '../../logger.js'
import { isValidIdSegment } from './address.js'

const CONFIG_FILENAME = 'federation.json'
// Legacy round-1 shared-token file: no longer written or read for auth, but
// the removal path still deletes it if a pre-round-2 store carries one.
const LEGACY_TOKEN_FILENAME = '.federation-token'
export const FEDERATION_MIN_TOKEN_LENGTH = 32
// Per-peer patience window before a pending outbound message is abandoned.
// Default mirrors the local queue's 60min; a laptop peer that sleeps for
// hours can be given a longer window (e.g. 1440 = a day).
export const DEFAULT_ABANDON_WINDOW_MINUTES = 60
export const MIN_ABANDON_WINDOW_MINUTES = 5
export const MAX_ABANDON_WINDOW_MINUTES = 7 * 24 * 60

// How eagerly the MAIN agent routes a domain request to a fitting specialist
// (local or federated), rendered into the CLAUDE.md delegation directive:
//   'strong'        -- always delegate a domain task to the fitting specialist
//   'catalog-first' -- fetch the catalog first, delegate when one fits (DEFAULT)
//   'advisory'      -- self-handle mostly, delegate only when clearly better
export type FederationRoutingMode = 'strong' | 'catalog-first' | 'advisory'
export const FEDERATION_ROUTING_MODES: readonly FederationRoutingMode[] = ['strong', 'catalog-first', 'advisory']
export const DEFAULT_ROUTING_MODE: FederationRoutingMode = 'catalog-first'

export interface FederationPeer {
  id: string
  baseUrl: string
  outboundToken: string // '' = pairing pending
  inboundToken: string
  trust: 'untrusted'
  abandonWindowMinutes?: number
  // Opt-in, per peer (default false, fail-closed): whether THIS peer's
  // manifest fetches see our agents' LLM-generated capability summaries.
  // Summaries are derived from persona files and may carry personal color --
  // the owner grants them peer by peer, not globally.
  shareCapabilitySummaries?: boolean
}

export interface FederationConfig {
  enabled: boolean
  systemId: string
  // Main-agent delegation eagerness. Absent in legacy configs -> the validator
  // fills DEFAULT_ROUTING_MODE, so a persisted config always carries it.
  routingMode?: FederationRoutingMode
  peers: FederationPeer[]
}

const DISABLED: FederationConfig = Object.freeze({ enabled: false, systemId: '', routingMode: DEFAULT_ROUTING_MODE, peers: [] })

// Test seam: the store dir is swappable so tests never touch the real
// checkout's store/ (initDatabase(':memory:') precedent -- explicit override,
// not NODE_ENV magic).
let storeDir = STORE_DIR

function configPath(): string { return join(storeDir, CONFIG_FILENAME) }
function legacyTokenPath(): string { return join(storeDir, LEGACY_TOKEN_FILENAME) }

// https is mandatory except on loopback, which the local two-instance smoke
// test needs (http://127.0.0.1:<port> peers).
export function isAcceptablePeerBaseUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
}

function isValidToken(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim().length >= FEDERATION_MIN_TOKEN_LENGTH
}

export function generatePeerInboundToken(): string {
  return randomBytes(32).toString('hex')
}

/** Pure validator: parsed JSON -> config, or a string describing why it is
 *  invalid (the caller logs once and fails closed). Peers are parsed for
 *  DISABLED configs too (lossless disable). Exported for tests. */
export function validateFederationConfig(parsed: unknown): FederationConfig | string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'root is not an object'
  const obj = parsed as Record<string, unknown>
  const enabled = obj.enabled === true // strict; anything else is off
  const rawSystemId = obj.systemId === undefined ? MAIN_AGENT_ID : obj.systemId
  if (!isValidIdSegment(rawSystemId)) return 'invalid systemId'
  // Ids are CASE-INSENSITIVE and stored lowercase. Operators keep typing the
  // display name ('Teodor', the BOT_NAME) where the machine slug ('teodor',
  // the MAIN_AGENT_ID) is meant, and a case-sensitive match then fails as a
  // silent "system mismatch". Normalizing here (the single write path) makes
  // every downstream === comparison case-insensitive for free.
  const systemId = (rawSystemId as string).toLowerCase()
  // A missing peers key is tolerated for the minimal off state {"enabled":false}.
  const rawPeers = obj.peers === undefined ? [] : obj.peers
  if (!Array.isArray(rawPeers)) return 'peers is not an array'
  const peers: FederationPeer[] = []
  const seenIds = new Set<string>()
  const seenInbound = new Set<string>()
  for (const raw of rawPeers) {
    if (raw === null || typeof raw !== 'object') return 'peer entry is not an object'
    const p = raw as Record<string, unknown>
    if (!isValidIdSegment(p.id)) return 'invalid peer id'
    const id = (p.id as string).toLowerCase() // case-insensitive ids, stored lowercase
    if (id === systemId) return `peer id equals own systemId (${id})`
    if (seenIds.has(id)) return `duplicate peer id (${id})`
    seenIds.add(id)
    if (!isAcceptablePeerBaseUrl(p.baseUrl)) return `invalid peer baseUrl for ${id} (https required; http only on loopback)`
    // inboundToken is what identifies the caller at the gate; a duplicate
    // would make the first-match loop misattribute peer B as peer A --
    // cross-peer impersonation. Hard requirement.
    if (!isValidToken(p.inboundToken)) return `invalid inbound token for ${id} (min ${FEDERATION_MIN_TOKEN_LENGTH} chars)`
    const inbound = (p.inboundToken as string).trim()
    if (seenInbound.has(inbound)) return `duplicate inbound token (${id})`
    seenInbound.add(inbound)
    // outboundToken may be empty ("pairing pending") but a PRESENT value must
    // be well-formed -- a short junk token would just burn 401s at the peer.
    let outbound = ''
    if (p.outboundToken !== undefined && p.outboundToken !== null && p.outboundToken !== '') {
      if (!isValidToken(p.outboundToken)) return `invalid outbound token for ${id} (min ${FEDERATION_MIN_TOKEN_LENGTH} chars, or empty while pairing)`
      outbound = (p.outboundToken as string).trim()
    }
    const trust = p.trust === undefined ? 'untrusted' : p.trust
    if (trust !== 'untrusted') return `unsupported trust value for ${id}`
    let abandonWindowMinutes: number | undefined
    if (p.abandonWindowMinutes !== undefined) {
      const w = p.abandonWindowMinutes
      if (typeof w !== 'number' || !Number.isInteger(w) || w < MIN_ABANDON_WINDOW_MINUTES || w > MAX_ABANDON_WINDOW_MINUTES) {
        return `invalid abandonWindowMinutes for ${id} (${MIN_ABANDON_WINDOW_MINUTES}..${MAX_ABANDON_WINDOW_MINUTES})`
      }
      abandonWindowMinutes = w
    }
    // Strict boolean; a present non-boolean is a config error (fail-closed),
    // and the parsed value MUST round-trip through the return object -- every
    // mutating endpoint persists this validator's output, so a dropped field
    // here would silently reset the owner's grant on the next peer edit.
    let shareCapabilitySummaries = false
    if (p.shareCapabilitySummaries !== undefined) {
      if (typeof p.shareCapabilitySummaries !== 'boolean') return `invalid shareCapabilitySummaries for ${id} (boolean)`
      shareCapabilitySummaries = p.shareCapabilitySummaries
    }
    peers.push({
      id,
      baseUrl: (p.baseUrl as string).replace(/\/+$/, ''),
      outboundToken: outbound,
      inboundToken: inbound,
      trust: 'untrusted',
      ...(abandonWindowMinutes !== undefined ? { abandonWindowMinutes } : {}),
      ...(shareCapabilitySummaries ? { shareCapabilitySummaries: true } : {}),
    })
  }
  // Main-agent delegation eagerness (global, not per-peer). Absent -> default;
  // a present-but-unknown value is a config error (fail-closed). MUST round-trip
  // through the return: every mutating endpoint persists this validator output.
  let routingMode: FederationRoutingMode = DEFAULT_ROUTING_MODE
  if (obj.routingMode !== undefined) {
    if (typeof obj.routingMode !== 'string' || !FEDERATION_ROUTING_MODES.includes(obj.routingMode as FederationRoutingMode)) {
      return `invalid routingMode (${FEDERATION_ROUTING_MODES.join('|')})`
    }
    routingMode = obj.routingMode as FederationRoutingMode
  }
  return { enabled, systemId, routingMode, peers }
}

/** Wall-clock patience for a peer's pending outbound messages. The system
 *  segment may come from a stored to_agent, so match case-insensitively
 *  (stored peer ids are lowercase; pre-normalization rows may not be). */
export function abandonWindowMsForPeer(cfg: FederationConfig, system: string): number {
  const wanted = system.toLowerCase()
  const peer = cfg.peers.find((p) => p.id === wanted)
  const minutes = peer?.abandonWindowMinutes ?? DEFAULT_ABANDON_WINDOW_MINUTES
  return minutes * 60_000
}

// ---- cached, watch-refreshed readers ---------------------------------------
//
// settings-store pattern: lazy watch on the store DIRECTORY ({persistent:
// false} so vitest workers are not held open; mkdir first because fs.watch
// throws on a missing dir), filename-filtered, and our OWN writes refresh the
// cache synchronously instead of waiting for a (possibly coalesced) event --
// otherwise the auth gate could serve one more request against the pre-write
// enabled/token state.
let cachedConfig: FederationConfig | null = null
let lastConfigWarning = ''
let watcher: FSWatcher | undefined

function loadConfigFromDisk(): FederationConfig {
  try {
    if (!existsSync(configPath())) return DISABLED
    const result = validateFederationConfig(JSON.parse(readFileSync(configPath(), 'utf-8')))
    if (typeof result === 'string') {
      if (result !== lastConfigWarning) {
        lastConfigWarning = result
        logger.warn({ reason: result }, 'federation: invalid federation.json -- federation disabled (fail-closed)')
      }
      return DISABLED
    }
    lastConfigWarning = ''
    return result
  } catch (err) {
    if (lastConfigWarning !== 'unreadable') {
      lastConfigWarning = 'unreadable'
      logger.warn({ err }, 'federation: cannot read federation.json -- federation disabled (fail-closed)')
    }
    return DISABLED
  }
}

function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(storeDir, { recursive: true })
    watcher = watch(storeDir, { persistent: false }, (_event, filename) => {
      if (filename === CONFIG_FILENAME) cachedConfig = loadConfigFromDisk()
    })
  } catch {
    // Best-effort: without a watch the cache reflects this process's own
    // reads/writes, which is still correct for the single-process case.
  }
}

export function getFederationConfig(): FederationConfig {
  ensureWatching()
  if (cachedConfig === null) cachedConfig = loadConfigFromDisk()
  return cachedConfig
}

/** Health of the stored file, for config-MUTATING handlers. When the file
 *  exists but fails validation, getFederationConfig() fail-closes to
 *  peers:[] -- a mutation that reads that cache and writes it back would
 *  DESTROY the (hand-recoverable) peers in the file. Such handlers must
 *  refuse instead. 'absent' is healthy (a fresh add creates the file). */
export function federationFileHealth(): 'ok' | 'absent' | 'invalid' {
  try {
    if (!existsSync(configPath())) return 'absent'
    const result = validateFederationConfig(JSON.parse(readFileSync(configPath(), 'utf-8')))
    return typeof result === 'string' ? 'invalid' : 'ok'
  } catch {
    return 'invalid'
  }
}

/** Identify the calling peer from an Authorization header by trying each
 *  configured peer's inboundToken. Returns the peer id, or null. NEVER
 *  throws and does NO auth work while disabled (fail-closed): the gate runs
 *  outside the dispatcher try{} -- a throw there leaves the socket hanging.
 *  The comparator is injected (checkBearerToken) to avoid an import cycle
 *  with dashboard-auth consumers. */
export function identifyFederationCaller(
  authHeader: string | undefined,
  check: (header: string | undefined, expected: string) => boolean,
): string | null {
  try {
    const cfg = getFederationConfig()
    if (!cfg.enabled) return null
    for (const peer of cfg.peers) {
      // Per-candidate guard: an empty/short expected token must never reach
      // the comparator ('Bearer ' + whitespace would authenticate against '').
      if (typeof peer.inboundToken !== 'string' || peer.inboundToken.length < FEDERATION_MIN_TOKEN_LENGTH) continue
      if (check(authHeader, peer.inboundToken)) return peer.id
    }
    return null
  } catch {
    return null
  }
}

/** Persist a validated config. Caller must pass an object that
 *  validateFederationConfig accepts. Synchronous write + synchronous cache
 *  refresh (no await window for concurrent writers). */
export function writeFederationConfig(cfg: FederationConfig): void {
  mkdirSync(storeDir, { recursive: true })
  atomicWriteFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
  cachedConfig = loadConfigFromDisk()
}

/** Master-switch flip that never loses peer data (lossless disable/enable).
 *  Works from the RAW file, not the validated cache: an invalid stored peer
 *  fail-closes the VIEW to peers:[], and writing that back would turn a
 *  view-loss into real data loss. Returns false when the file is unreadable
 *  garbage (nothing to flip -- the validator already fail-closes it). */
export function setFederationEnabledPreservingFile(enabled: boolean): boolean {
  try {
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf-8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      raw = parsed as Record<string, unknown>
    }
    raw.enabled = enabled === true
    if (raw.systemId === undefined) raw.systemId = MAIN_AGENT_ID
    mkdirSync(storeDir, { recursive: true })
    atomicWriteFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 })
    cachedConfig = loadConfigFromDisk()
    // Report whether the request actually took effect: enabling an
    // invalid-but-parseable file writes enabled:true but loadConfigFromDisk
    // fail-closes to DISABLED, so the caller must NOT report success.
    // Disabling always matches (DISABLED.enabled === false).
    return cachedConfig.enabled === (enabled === true)
  } catch {
    return false
  }
}

/** Set the main-agent delegation routing mode, preserving the rest of the file
 *  (peers, tokens, enabled) even when a stored peer is invalid -- same
 *  raw-file discipline as setFederationEnabledPreservingFile. Returns false on
 *  unreadable garbage. */
export function setFederationRoutingModePreservingFile(mode: FederationRoutingMode): boolean {
  try {
    let raw: Record<string, unknown> = {}
    if (existsSync(configPath())) {
      const parsed = JSON.parse(readFileSync(configPath(), 'utf-8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      raw = parsed as Record<string, unknown>
    }
    raw.routingMode = mode
    if (raw.systemId === undefined) raw.systemId = MAIN_AGENT_ID
    mkdirSync(storeDir, { recursive: true })
    atomicWriteFileSync(configPath(), JSON.stringify(raw, null, 2), { mode: 0o600 })
    cachedConfig = loadConfigFromDisk()
    // The mode is now persisted to the file. Unlike the enabled flip, routing
    // mode is orthogonal to peer validity: an invalid stored peer fail-closes
    // the VIEW to DISABLED, but the mode is still written and applies once the
    // config is valid again -- so a successful write is a success. Only
    // unreadable garbage (caught below) is a failure.
    return true
  } catch {
    return false
  }
}

/** Full removal: delete the store files and reset the cache SYNCHRONOUSLY
 *  (never trust the async fs.watch -- macOS may deliver filename=null).
 *  ENOENT-tolerant so removal is idempotent. */
export function removeFederationStore(): void {
  for (const p of [configPath(), legacyTokenPath()]) {
    try {
      unlinkSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, path: p }, 'federation: store file unlink failed')
      }
    }
  }
  cachedConfig = DISABLED
  lastConfigWarning = ''
}

// ---- test seams -------------------------------------------------------------

export function _setFederationStoreDirForTest(dir: string): void {
  storeDir = dir
  if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = undefined }
  reloadFederationForTest()
}

export function reloadFederationForTest(): void {
  cachedConfig = null
  lastConfigWarning = ''
}
