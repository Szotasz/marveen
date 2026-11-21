// What a threaded reply (graph-mail.ts --reply-to, Graph /messages/{id}/reply)
// may be addressed to, decided from the ORIGINAL message before any send.
//
// Why (PR #2983 review, Dani B1): /reply answers inside the original's thread.
// Graph may address it to the original's Reply-To (or From) as well as to the
// recipients we pass, and may quote the original under our text. Neither is
// visible to the outgoing gates or bound by the approval. The draft route
// (createReply, read the draft back, then send) needs Mail.ReadWrite, which
// this app does not hold (measured 2026-11-21: createReply answers 403
// ErrorAccessDenied with Mail.Read + Mail.Send). So the reply is bounded from
// the original instead:
//   1. every --to and --cc address must be a participant of the original
//      (its From, Reply-To, To or Cc): a quoted original then only reaches
//      people who already had it, and the reply cannot carry one customer's
//      thread to someone else;
//   2. the address Graph answers by default (Reply-To if set, else From) must
//      be among --to / --cc: if Graph adds it, it is already in the approved
//      envelope;
//   3. the subject the gates read is the one the reply goes out with. Graph
//      builds it from the original ("RE: <subject>"), so the checked subject is
//      that, and a different --subject is refused rather than approved and
//      then replaced.
// Pure, so every rule is tested without a mailbox.

type Addr = { emailAddress?: { address?: string } }
export interface ReplyOriginal {
  subject?: string
  from?: Addr
  replyTo?: Addr[]
  toRecipients?: Addr[]
  ccRecipients?: Addr[]
}

const norm = (a?: string) => (a ?? '').trim().toLowerCase()
const list = (xs?: Addr[]) => (xs ?? []).map((x) => norm(x.emailAddress?.address)).filter(Boolean)

/** Everyone the original was from, to, cc, or asked replies to go to. */
export function replyParticipants(orig: ReplyOriginal): Set<string> {
  return new Set([norm(orig.from?.emailAddress?.address), ...list(orig.replyTo), ...list(orig.toRecipients), ...list(orig.ccRecipients)].filter(Boolean))
}

/** Where Graph answers by default: the Reply-To addresses, else the From. */
export function defaultReplyAddresses(orig: ReplyOriginal): string[] {
  const rt = list(orig.replyTo)
  if (rt.length) return rt
  const from = norm(orig.from?.emailAddress?.address)
  return from ? [from] : []
}

/** The subject a reply goes out with: Graph's "RE: " on the original's subject. */
export function replySubject(orig: ReplyOriginal): string {
  return `RE: ${orig.subject ?? ''}`
}

/** Null when the reply may go; otherwise the reason it may not. */
export function checkReply(orig: ReplyOriginal, to: string[], cc: string[], typedSubject?: string): string | null {
  const participants = replyParticipants(orig)
  const recipients = [...to, ...cc].map(norm).filter(Boolean)
  if (!recipients.length) return 'a valasznak nincs cimzettje'
  const outsiders = recipients.filter((a) => !participants.has(a))
  if (outsiders.length) {
    return `a valasz csak az eredeti level resztvevoinek mehet (felado, Reply-To, To, Cc); nem resztvevo: ${outsiders.join(', ')}`
  }
  const missing = defaultReplyAddresses(orig).filter((a) => !recipients.includes(a))
  if (missing.length) {
    return `a Graph a valaszt ide is kuldheti, ezert a --to/--cc-ben szerepelnie kell: ${missing.join(', ')}`
  }
  if (typedSubject !== undefined && norm(typedSubject) !== norm(replySubject(orig))) {
    return `a valasz targya "${replySubject(orig)}" lesz (a Graph kesziti); mas --subject-et nem hagyok jova`
  }
  return null
}
