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

// HBTEMPLATELEAK1002 (measured 2026-10-02, messages 33179 and 33211): the
// heartbeat agent's own ad-hoc parsing took the FIRST "[HB-METRIKA-BLOKK ts="
// marker in its prompt -- the sample line in the task's instructions, with the
// literal placeholder -- and sent "## Heartbeat YYYY-MM-DD HH:MM" plus the
// instruction text before the real report. A message that STARTS with the
// placeholder header is a leaked template, never a report; one that merely
// mentions the placeholder (a review, this comment) does not start that way.
const TEMPLATE_HEADER_RE = /^## Heartbeat YYYY-MM-DD/

export function isHeartbeatTemplateLeak(content: string): boolean {
  return TEMPLATE_HEADER_RE.test(content.trimStart())
}
