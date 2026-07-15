// System-qualified addressing for federation: "<system>/<agent>".
//
// Parsing is STRICT by design -- an id either matches the whitelist exactly or
// is rejected, never "sanitized and passed along". sanitizeAgentIdent strips
// '/' (and anything non-[a-zA-Z0-9_-]), so lenient handling would collapse
// distinct ids into each other ('a/bc' and 'ab/c' both become 'abc') and let
// Unicode/homoglyph names impersonate ASCII ones. The whitelist has no '.',
// so a '..' path segment can never reach the agentDir/safeJoin layer either.
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export interface QualifiedId {
  system: string
  agent: string
}

/** True when the raw id is federation-shaped (contains a '/'). Total predicate:
 *  the router uses this to divert EVERY slash-bearing to_agent away from the
 *  local tmux path, valid or not -- an invalid one is failed, never retried
 *  against the filesystem. */
export function isQualifiedId(raw: unknown): boolean {
  return typeof raw === 'string' && raw.includes('/')
}

/** Strict parse of "<system>/<agent>". Returns null for local (slash-free)
 *  ids and for ANY malformed qualified id (two slashes, empty/oversized/
 *  non-whitelist segments). */
export function parseQualifiedId(raw: unknown): QualifiedId | null {
  if (typeof raw !== 'string') return null
  const idx = raw.indexOf('/')
  if (idx < 0) return null
  const system = raw.slice(0, idx)
  const agent = raw.slice(idx + 1)
  if (agent.includes('/')) return null
  if (!SEGMENT_RE.test(system) || !SEGMENT_RE.test(agent)) return null
  return { system, agent }
}

/** A single id segment (system id, local agent name) valid on its own. */
export function isValidIdSegment(raw: unknown): boolean {
  return typeof raw === 'string' && SEGMENT_RE.test(raw)
}

export function formatQualifiedId(system: string, agent: string): string {
  return `${system}/${agent}`
}

/** The <untrusted source="..."> attribute value for a federated sender.
 *  sanitizeAgentSource allows ':' so this survives the wrap unchanged. */
export function federationSource(id: QualifiedId): string {
  return `federation:${id.system}:${id.agent}`
}
