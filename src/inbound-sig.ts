// HMACINBOUND1125: the server's signature on an agent_messages row.
//
// Who speaks with the owner's voice (the channel-inbound envelope) and which row may STOP or interrupt a busy pane
// used to be read off the row itself: from_agent and the urgent / stop_authorized / priority / affects_current_work
// columns. Any process that can write the database could therefore mint an owner-voiced row, STOP included, with one
// INSERT (CHANINBOUNDFORGE1125, measured by Dani: the db-write-gate lets agent_messages writes through). The gate
// rule added for that is a text brake; this is the lock behind it: the rows the server writes carry an HMAC over
// their fields, and delivery honours the owner's voice and the flags only on a row whose HMAC checks out.
//
// The key is store/.inbound-sig-key: 32 random bytes, mode 0600, created by the dashboard at boot. The Telegram
// backfill coordinator (a separate process) only reads it. Stated limit: the key is a file of the same OS user the
// agents run as, so a pre-written script can read it. The bar moves from "one raw INSERT" to "read the key and
// compute the HMAC"; sub-agents are denied the Read (agent-scaffold.ts SUBAGENT_INBOUND_SIG_KEY_DENY) and the file
// is left out of every export (backup.sh STORE_SKIP).
//
// The signed fields include the row id, so a signed row copied into a new row (INSERT ... SELECT) does not verify.
// A delivered signed row put back to pending verifies, so the delivery log in db.ts (inbound_sig_log) stops that one.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, openSync, readFileSync, renameSync, writeSync, fsyncSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'

export const INBOUND_SIG_KEY_FILE = '.inbound-sig-key'
const KEY_BYTES = 32
const SIG_VERSION = 'v1'

/** The fields the signature covers, in this order. */
export interface SignedRowFields {
  id: number
  from_agent: string
  to_agent: string
  content: string
  created_at: number
  stop_authorized?: number | null
  urgent?: number | null
  priority?: number | null
  affects_current_work?: string | null
}

export function inboundSigKeyPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, INBOUND_SIG_KEY_FILE)
}

let cached: { dir: string; key: Buffer | null; at: number } | null = null
// A missing key is looked up again after this long, so a coordinator that started before the dashboard created the
// key starts signing without a restart.
const MISSING_RECHECK_MS = 10_000

/** The key, or null when the file is missing or not KEY_BYTES long. Never creates it. */
export function readInboundSigKey(storeDir: string = STORE_DIR): Buffer | null {
  const now = Date.now()
  if (cached && cached.dir === storeDir && (cached.key !== null || now - cached.at < MISSING_RECHECK_MS)) return cached.key
  let key: Buffer | null = null
  try {
    const raw = readFileSync(inboundSigKeyPath(storeDir))
    key = raw.length === KEY_BYTES ? raw : null
  } catch {
    key = null
  }
  cached = { dir: storeDir, key, at: now }
  return key
}

/**
 * The key, created when missing (the dashboard's boot). Written to a temp file with mode 0600 and renamed into place
 * with no overwrite race that matters: a second creator's rename would replace the first's key only if both started
 * on a missing file, and both run in the one dashboard process at boot. Returns null when the store is not writable.
 */
export function ensureInboundSigKey(storeDir: string = STORE_DIR): Buffer | null {
  const existing = readInboundSigKey(storeDir)
  if (existing) return existing
  const path = inboundSigKeyPath(storeDir)
  const tmp = `${path}.tmp-${process.pid}`
  try {
    const key = randomBytes(KEY_BYTES)
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeSync(fd, key)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    cached = null
    return readInboundSigKey(storeDir)
  } catch {
    try { unlinkSync(tmp) } catch { /* not there */ }
    cached = null
    return readInboundSigKey(storeDir)
  }
}

/** Test hook: forget the cached key. */
export function _resetInboundSigKeyCacheForTest(): void {
  cached = null
}

/** The canonical bytes: "v1:" and a JSON array, numbers as numbers, the content as it is stored. */
export function canonicalSignedRow(r: SignedRowFields): string {
  return `${SIG_VERSION}:${JSON.stringify([
    r.id, r.from_agent, r.to_agent, r.content, r.created_at,
    r.stop_authorized ?? 0, r.urgent ?? 0, r.priority ?? 0, r.affects_current_work ?? null,
  ])}`
}

export function signRow(r: SignedRowFields, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalSignedRow(r), 'utf8').digest('hex')
}

/** True when the row carries a signature that checks out under the current key (constant-time compare). */
export function rowSigOk(r: SignedRowFields & { inbound_sig?: string | null }, storeDir: string = STORE_DIR): boolean {
  const sig = r.inbound_sig
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false
  const key = readInboundSigKey(storeDir)
  if (!key) return false
  const want = Buffer.from(signRow(r, key), 'hex')
  const got = Buffer.from(sig, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}
