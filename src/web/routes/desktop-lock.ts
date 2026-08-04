// Desktop-lock API. ONE call sets the state AND tells the fleet -- see
// src/web/desktop-lock.ts for why the broadcast is not left to the caller.
import { MAIN_AGENT_ID } from '../../config.js'
import { createAgentMessage } from '../../db.js'
import { logger } from '../../logger.js'
import { listAgentNames } from '../agent-config.js'
import {
  readDesktopLock, writeDesktopLock, clearDesktopLock, lockExpiresAt,
  DEFAULT_ESTIMATE_MS, type DesktopLock,
} from '../desktop-lock.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Sender label for lock traffic. Deliberately NOT the main agent's id: an
// expiry notice attributed to a colleague reads as that colleague's opinion,
// and the holder would answer the wrong party.
const LOCK_SENDER = 'desktop-lock'

/** Everyone who must keep their hands off, minus the holder. Derived from the
 *  agent registry, never a hand-written list -- a new agent joins the fleet
 *  and is covered without anyone remembering this file. */
function broadcastTargets(owner: string): string[] {
  const all = new Set<string>([MAIN_AGENT_ID, ...listAgentNames()])
  all.delete(owner)
  return [...all]
}

function broadcast(from: string, targets: string[], content: string): void {
  for (const to of targets) {
    try {
      createAgentMessage(from, to, content)
    } catch (err) {
      // One undeliverable peer must not abort the rest of the broadcast, and
      // must not fail the lock itself: the STATE is what the gate reads, the
      // message is only how humans and agents hear about it.
      logger.warn({ err, to }, 'desktop-lock: broadcast to one target failed')
    }
  }
}

function hu(dtMs: number): string {
  return new Date(dtMs).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
}

export async function tryHandleDesktopLock(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/desktop-lock') return false

  if (method === 'GET') {
    const lock = readDesktopLock()
    json(res, lock ? { locked: true, lock, expiresAt: lockExpiresAt(lock) } : { locked: false })
    return true
  }

  if (method === 'POST') {
    const body = await readBody(req)
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(body.toString() || '{}') } catch { /* handled below */ }
    const owner = typeof data.owner === 'string' ? data.owner.trim() : ''
    if (!owner) {
      json(res, { error: 'owner is required' }, 400)
      return true
    }
    const note = typeof data.note === 'string' ? data.note.trim() : undefined
    const minutes = typeof data.estimatedMinutes === 'number' && data.estimatedMinutes > 0
      ? data.estimatedMinutes
      : null

    const now = Date.now()
    const existing = readDesktopLock()
    // A second POST by the same holder EXTENDS rather than conflicts: a round
    // that grows (the operator hands over another job mid-run) is the normal
    // case, and forcing an up-front over-estimate would park the fleet for
    // longer than the work actually takes.
    const isExtension = existing != null && existing.owner === owner
    if (existing && !isExtension) {
      json(res, {
        error: `desktop is locked by ${existing.owner} until ${new Date(lockExpiresAt(existing)).toISOString()}`,
        lock: existing,
      }, 409)
      return true
    }

    const lock: DesktopLock = {
      owner,
      acquiredAt: existing?.acquiredAt ?? now,
      estimatedEndAt: minutes != null ? now + minutes * 60_000 : now + DEFAULT_ESTIMATE_MS,
      estimateProvided: minutes != null,
      note: note ?? existing?.note,
      ...(isExtension ? { extendedAt: now, extensions: (existing?.extensions ?? 0) + 1 } : {}),
    }
    writeDesktopLock(lock)

    const until = hu(lock.estimatedEndAt as number)
    const head = isExtension
      ? `[DESKTOP-LOCK MEGHOSSZABBITVA] ${owner}: a kepernyo tovabbra is foglalt, uj becsult vege ${until}.`
      : `[DESKTOP-LOCK] ${owner}: a kepernyo foglalt, becsult vege ${until}.`
    const estimateNote = lock.estimateProvided
      ? ''
      : ' FIGYELEM: becsult ido NEM erkezett, ezert a rendszer 30 perces alapertelmezest hasznal.'
    broadcast(owner, broadcastTargets(owner),
      `${head}${note ? ` ${note}` : ''}${estimateNote}`
      + ' A kepernyot igenylo utemezett korok addig kimaradnak, es a kihagyas rekordot kap.'
      + ' [DESKTOP-FREE] megy, amint a tulaj felszabaditja.')

    logger.info({ owner, isExtension, estimateProvided: lock.estimateProvided }, 'desktop-lock: acquired')
    json(res, { ok: true, lock, expiresAt: lockExpiresAt(lock) })
    return true
  }

  if (method === 'DELETE') {
    const lock = readDesktopLock()
    if (!lock) {
      json(res, { ok: true, wasLocked: false })
      return true
    }
    clearDesktopLock()
    const heldMin = Math.round((Date.now() - lock.acquiredAt) / 60_000)
    broadcast(lock.owner, broadcastTargets(lock.owner),
      `[DESKTOP-FREE] ${lock.owner}: a kepernyo szabad (${heldMin} perc utan).`)
    logger.info({ owner: lock.owner, heldMin }, 'desktop-lock: released')
    json(res, { ok: true, wasLocked: true, heldMinutes: heldMin })
    return true
  }

  return false
}

/**
 * TTL sweeper. An expired lock is opened AND reported -- to the fleet, to the
 * log, and to the HOLDER, because the holder is the one party that may still
 * be standing at the screen. Learning about it only when two agents collide
 * would be the worst of the three outcomes.
 *
 * The wording distinguishes the two shapes an expiry can have (a bad estimate
 * vs. an agent that died) by naming how long the lock ran past its own number:
 * expiry is a finding, not routine, and a flat "lock expired" line would read
 * as maintenance noise.
 */
export function sweepExpiredDesktopLock(now: number = Date.now()): boolean {
  const lock = readDesktopLock()
  if (!lock) return false
  const expiresAt = lockExpiresAt(lock)
  if (now < expiresAt) return false

  clearDesktopLock()
  const overdueMin = Math.round((now - expiresAt) / 60_000)
  const heldMin = Math.round((now - lock.acquiredAt) / 60_000)
  const detail = lock.estimateProvided
    ? `a sajat becslesenel ${overdueMin} perccel tovabb allt`
    : `becsult ido NEM volt megadva, ezert a 30 perces alapertelmezes + turelmi ido jart le`
  logger.warn({ owner: lock.owner, heldMin, overdueMin, estimateProvided: lock.estimateProvided },
    'desktop-lock: TTL expired, gate opened')

  try {
    createAgentMessage(LOCK_SENDER, lock.owner,
      `[DESKTOP-LOCK LEJART] A te lockod lejart (${heldMin} perc utan; ${detail}), a kapu KINYITOTT.`
      + ' Ha meg a kepernyon dolgozol, AZONNAL nyiss ujat (POST /api/desktop-lock), kulonben masik'
      + ' ugynok is hozzanyulhat. Ha vegeztel, ezt hagyd figyelmen kivul -- de akkor a FREE-t'
      + ' legkozelebb kuldd el, mert enelkul a kapu csak lejaratra nyilik.')
  } catch (err) {
    logger.warn({ err, owner: lock.owner }, 'desktop-lock: could not notify holder about expiry')
  }
  broadcast(LOCK_SENDER, broadcastTargets(lock.owner),
    `[DESKTOP-FREE / LEJARAT] ${lock.owner} lockja LEJART (${heldMin} perc, ${detail}).`
    + ' A kepernyo szabad, DE a tulaj nem zarta le rendesen -- lehet, hogy meg ott dolgozik.'
    + ' Mielott hozzanyulsz, gyozodj meg rola.')
  return true
}
