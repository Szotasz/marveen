// Card #673 -- `affects_current_work: 'unblocks'`: the one named case where an
// inter-agent message may reach a BUSY pane instead of waiting for an idle gap.
//
// WHY THIS EXISTS, MEASURED (2026-09-25, store/claudeclaw.db, 3966 delivered rows):
//
//   webby->cody   n=1805  median  95 s  p95 1765 s  p99 2605 s  max 6550 s
//   every other edge with n>=20 ........ p95 between 62 s and 229 s
//
// The delay is one edge's problem, and on that edge it is measured in tens of
// minutes. On the 2026-08-26 sample, 13 of 26 late content messages would have
// carried this flag, and 10 of those 13 (77%) were blocker RELEASES -- the
// recipient was not working, it was waiting. That is what makes this case safe:
// the owner's objection to interrupts ("it would make more mistakes if
// disturbed") does not apply where there is no work in progress to disturb.
//
// THREE DELIBERATE LIMITS:
//
//  1. ONE VALUE. Only 'unblocks' is built. `revoked` and `danger` wait for
//     their own measurement -- the danger case had no real example in either
//     sample, and a case without an example is a guess.
//  2. THE SENDER SETS IT, EXPLICITLY. Never inferred from the text. A keyword
//     classifier probed over the same 3963 rows matched 1197 of them on "kart"
//     alone, because it also matches the Hungarian word "kartya".
//  3. ONLY THE MAIN AGENT MAY SET IT. Not an edge whitelist: a hardcoded
//     recipient name would be state living in code. The effect is confined to
//     the one slow edge anyway, because every other edge already delivers in
//     seconds -- there is nothing there for the flag to speed up.
//
// A message with no value behaves exactly as it does today: it queues until the
// pane idles. That is the right answer for 94,4% of the traffic.

/** The only accepted value today. */
export const UNBLOCKS = 'unblocks'

/**
 * Validate a caller-supplied `affects_current_work`, returning either the value
 * to store or the reason to reject the request.
 *
 * Fail-closed and LOUD: an unknown value, or a sender that may not set it, is a
 * 400 rather than a silent null. A silently dropped flag is the worst outcome --
 * the sender believes it sent an interrupt and the message queues for half an
 * hour, which is exactly the failure this card exists to remove.
 */
export function validateAffectsCurrentWork(
  raw: unknown,
  fromAgent: string,
  mainAgentId: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'affects_current_work must be a string' }
  const value = raw.trim().toLowerCase()
  if (value === '') return { ok: true, value: null }
  if (value !== UNBLOCKS) {
    return { ok: false, error: `affects_current_work: only '${UNBLOCKS}' is supported (got '${raw}')` }
  }
  if (fromAgent.trim() !== mainAgentId) {
    return { ok: false, error: `affects_current_work: only the main agent ('${mainAgentId}') may set it` }
  }
  return { ok: true, value }
}

/**
 * Does this pending message get to skip the idle gate on this tick?
 *
 * `sessionReady` false alone is not enough -- the sender must have declared the
 * flag AND be the main agent. The from-check is re-applied here on purpose: the
 * route validates on the way in, but a row can also be written straight into
 * the DB (the coordinator does exactly that), so the delivery side must not
 * trust a stored value it did not check itself.
 */
export function shouldInterruptForUnblock(
  msg: { from_agent: string; affects_current_work?: string | null },
  sessionReady: boolean,
  mainAgentId: string,
): boolean {
  if (sessionReady) return false
  if ((msg.affects_current_work ?? null) !== UNBLOCKS) return false
  return msg.from_agent === mainAgentId
}

/**
 * How much of the text may be typed into a BUSY pane.
 *
 * A best-effort send into a busy pane is the ONE delivery mode that can arrive
 * spliced: on 2026-09-10 Cody received a PHP snippet with fragments of a later
 * sentence mixed into its middle, while the stored row was byte-perfect. The
 * text is typed in 80-character chunks, so the splice risk grows with length.
 * An interrupt therefore carries a SHORT notice; the full text stays in the
 * queue row, which the delivery wrap already labels with `msg_id:<n>`, and the
 * recipient re-reads it from GET /api/messages/<id>.
 *
 * A corrupted short line is also self-evident, where a corrupted NUMBER inside
 * a long one is not.
 */
export const UNBLOCK_NOTICE_MAX_CHARS = 240

/**
 * Build the short interrupt body. Below the cap the text goes through
 * unchanged -- there is nothing to gain from truncating what already fits.
 */
export function buildUnblockInterruptContent(content: string, msgId: number): string {
  const head = '[FELOLDAS -- a munkadat blokkolo dolog megoldodott, ez NEM uj feladat]\n'
  const trimmed = content.trim()
  if (trimmed.length <= UNBLOCK_NOTICE_MAX_CHARS) return head + trimmed
  const cut = trimmed.slice(0, UNBLOCK_NOTICE_MAX_CHARS).trimEnd()
  return head + cut + '\n[...] A TELJES szoveg (bajtra, serules nelkul): '
    + `GET /api/messages/${msgId} -- olvasd vissza, mielott dolgozol belole.`
}
