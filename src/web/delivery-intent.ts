/**
 * Per-session delivery-intent registry.
 *
 * Records content that the router/scheduler genuinely delivered into a session,
 * and exposes a truncation-tolerant match so the stuck-input recovery can
 * verify that parked text originated from a real delivery before re-injecting it.
 *
 * Security invariant: only content the router has explicitly recorded here may
 * be re-submitted by the recovery path. Unmatched parked text is held (not
 * re-injected), degrading to a surfaced alert rather than a silent phantom-inject.
 */

const FRESHNESS_MS = 5 * 60 * 1000   // 5-minute window
const RING_CAP = 10                   // per-session ring buffer size

// Minimum length below which we require an exact match (no substring coincidence).
const EXACT_MATCH_THRESHOLD = 40

interface DeliveryRecord {
  content: string
  ts: number
}

// session -> ring of recent deliveries (newest last)
const registry = new Map<string, DeliveryRecord[]>()

/** Record a genuine delivery into session. Called at the actual inject point. */
export function recordDelivery(session: string, content: string): void {
  const ring = registry.get(session) ?? []
  ring.push({ content, ts: Date.now() })
  if (ring.length > RING_CAP) ring.shift()
  registry.set(session, ring)
}

/**
 * Check whether boxContent matches a recent delivery for session.
 *
 * Truncation-tolerant: a long delivery may only be partially visible in the
 * input box. We match if the boxContent is a leading prefix of a fresh delivery
 * (and the boxContent is at least EXACT_MATCH_THRESHOLD chars, to avoid
 * accidental short-string hits).
 *
 * For short boxContent we require an exact match.
 */
export function matchDelivery(session: string, boxContent: string): boolean {
  const trimmed = boxContent.trim()
  if (!trimmed) return false

  const now = Date.now()
  const ring = registry.get(session)
  if (!ring) return false

  for (const rec of ring) {
    if (now - rec.ts > FRESHNESS_MS) continue
    const recTrimmed = rec.content.trim()
    if (trimmed.length >= EXACT_MATCH_THRESHOLD) {
      // Long content: accept if the box shows a leading prefix of the delivery.
      if (recTrimmed.startsWith(trimmed) || recTrimmed === trimmed) return true
    } else {
      // Short content: exact match only to avoid substring coincidence.
      if (recTrimmed === trimmed) return true
    }
  }
  return false
}

/** Remove all delivery records for session (e.g. after a hard restart). */
export function clearDeliveries(session: string): void {
  registry.delete(session)
}

/** Exposed for testing only. */
export function _registrySize(session: string): number {
  return registry.get(session)?.length ?? 0
}
