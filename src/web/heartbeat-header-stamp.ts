// Restamps the clock in a heartbeat-digest header with the server's own time
// at persistence. The digest is composed by an LLM agent, and a session-start
// `date` is no anchor for the rest of that session: on 2026-09-08 the header
// drifted monotonically (0,0,0,0,0,+1h,+3h against created_at) and a "18:00"
// label nearly released the owner's evening decision batch at 15:05
// (HBORACSUSZAS908). The scheduler fires on time; only the written label lies.
// Same principle as the kanban header clock: the machine stamps it, the
// author never types it.
//
// The matcher is intentionally narrow: only the FIRST line, only the exact
// `## Heartbeat YYYY-MM-DD HH:MM` shape. A digest quoted mid-message keeps
// its original (historical) label; any first-line match is by definition a
// digest being published now, so "now" is the only truthful value.

const HEADER_RE = /^## Heartbeat \d{4}-\d{2}-\d{2} \d{2}:\d{2}/

// sv-SE gives `YYYY-MM-DD HH:mm` directly; the digest header is Budapest-local.
const BUDAPEST_STAMP = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Budapest',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
})

export function stampHeartbeatHeader(content: string, now: Date = new Date()): string {
  if (!content.startsWith('## Heartbeat ')) return content
  return content.replace(HEADER_RE, `## Heartbeat ${BUDAPEST_STAMP.format(now)}`)
}
