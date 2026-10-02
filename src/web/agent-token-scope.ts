// Endpoint scopes for per-agent dashboard tokens (TOKENSZUKITES909).
//
// DEFAULT-DENY by construction: a scope is an explicit allowlist of
// (method, path) rules, and the gate refuses anything not listed. That is the
// whole point -- a route added to the dashboard next month is out of scope for
// every existing agent token until someone deliberately widens a profile here.
//
// What is deliberately NOT reachable by ANY profile: the agent terminal, the
// SSH vault, /api/security/*, /api/auth/* administration (an agent token can
// never mint another credential), settings, connectors, federation, schedules,
// and the whole fleet-management surface. A leaked agent token must not be
// upgradable into a foothold on this machine.

import { sanitizeAgentIdent } from '../prompt-safety.js'

export const AGENT_TOKEN_SCOPES = ['messaging', 'remote-agent'] as const
export type AgentTokenScope = (typeof AGENT_TOKEN_SCOPES)[number]

export function isAgentTokenScope(value: string): value is AgentTokenScope {
  return (AGENT_TOKEN_SCOPES as readonly string[]).includes(value)
}

interface Rule {
  readonly methods: readonly string[]
  readonly path: RegExp
}

// Talking to the fleet: send a message, read and acknowledge your own queue.
// The narrowest useful profile -- an outstation that only reports in.
//
// /api/messages/threads and /backlog are deliberately absent: both answer for
// the WHOLE fleet and have no per-caller narrowing, so they would hand a remote
// agent the shape of every other agent's traffic. The mailbox endpoints below
// ARE listed, and messages.ts pins them to the token's own agent.
const MESSAGING_RULES: readonly Rule[] = [
  { methods: ['POST'], path: /^\/api\/messages$/ },
  { methods: ['GET'], path: /^\/api\/messages$/ },
  { methods: ['GET', 'PUT'], path: /^\/api\/messages\/\d+$/ },
]

// A full remote agent: messaging, plus the shared working memory it has to
// keep in sync -- the kanban board, the memory store, the daily log, and the
// approval channel it must use before acting on its own.
const REMOTE_AGENT_RULES: readonly Rule[] = [
  ...MESSAGING_RULES,
  { methods: ['GET', 'POST'], path: /^\/api\/kanban$/ },
  { methods: ['GET'], path: /^\/api\/kanban\/(archived|assignees|labels|heartbeat-summary)$/ },
  { methods: ['GET'], path: /^\/api\/kanban-projects$/ },
  { methods: ['GET', 'PUT'], path: /^\/api\/kanban\/[^/]+$/ },
  { methods: ['POST'], path: /^\/api\/kanban\/[^/]+\/(move|archive|unarchive|comments)$/ },
  { methods: ['GET'], path: /^\/api\/kanban\/[^/]+\/(comments|events)$/ },
  { methods: ['GET', 'POST'], path: /^\/api\/memories$/ },
  { methods: ['GET', 'POST'], path: /^\/api\/daily-log$/ },
  { methods: ['GET'], path: /^\/api\/daily-log\/dates$/ },
  { methods: ['POST'], path: /^\/api\/approvals$/ },
  { methods: ['GET'], path: /^\/api\/approvals\/[^/]+$/ },
]

const SCOPE_RULES: Record<AgentTokenScope, readonly Rule[]> = {
  messaging: MESSAGING_RULES,
  'remote-agent': REMOTE_AGENT_RULES,
}

/** Human-readable endpoint list for the mint response, so whoever hands the
 *  token over can see what it can reach without reading this file. */
export function describeAgentTokenScope(scope: AgentTokenScope): string[] {
  return SCOPE_RULES[scope].map((r) => {
    const readable = r.path.source
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\\\//g, '/')
      .replace(/\[\^\/\]\+/g, ':id')
      .replace(/\\d\+/g, ':id')
    return `${r.methods.join('/')} ${readable}`
  })
}

export function agentTokenAllows(scope: AgentTokenScope, path: string, method: string): boolean {
  const rules = SCOPE_RULES[scope]
  if (!rules) return false
  return rules.some((r) => r.methods.includes(method) && r.path.test(path))
}

// Identity binding. The scope says WHICH endpoints; this says WHOSE name the
// writes may carry. Without it a scoped token could still post a message as
// "marveen" or file a memory under another agent's id -- attribution laundering,
// and on the memory path an injection channel straight into the main agent's
// recall. Compared after sanitizeAgentIdent so "@sam" / "sam." cannot slip past
// the same way the coordinator-id guard in routes/messages.ts handles it.
//
// Returns an error string when the claim is a violation, null when it is fine.
// An ABSENT claim is not a violation: the route's own default (the token's
// agent, substituted by the caller) applies.
export function agentTokenIdentityViolation(
  auth: { kind: string; agent?: string | undefined } | undefined,
  claimed: string | undefined | null,
  field: string,
): string | null {
  if (auth?.kind !== 'agent' || !auth.agent) return null
  if (claimed === undefined || claimed === null || String(claimed).trim() === '') return null
  if (sanitizeAgentIdent(String(claimed)) === sanitizeAgentIdent(auth.agent)) return null
  return `${field} must be '${auth.agent}' -- an agent token cannot write as another agent`
}
