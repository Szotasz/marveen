// DELEGAPPROVER1123 (PR1): the delegated human approver.
//
// An approver is a dashboard login with role 'approver' (dashboard_users.role). The owner creates it and gives it
// scopes (approver_scopes: category x agent, agent '*' for every agent). An approver session resolves to its own auth
// kind, 'approver' (auth-gate.ts), never 'session': every owner check in the code (mayActAsOwner, and the direct
// kind === 'session' tests) therefore refuses it, and the approver gate (approver-gate.ts) keeps it on the approval
// routes. This file is the one place that decides whether an approver may decide ONE approval request (mayApprove).
//
// An approver never decides as the owner: its decision goes through the decision core with the evidence
// { channel: 'dashboard', mode: 'approver', trail: [username] } and an approval_events 'decided' row (routes/approvals.ts).
// The owner keeps receiving every request as before; an approver is an addition, not a routing change.

import type http from 'node:http'
import { getDashboardUser, listApproverScopes, type Approval, type ApproverScope } from '../db.js'
import { mayActAsOwner } from './routes/auth.js'
import type { RouteContext } from './routes/types.js'

/**
 * The categories an approver MAY be given: an ALLOWLIST (Dani's review of #3094, B1). Every other category, the locked
 * ones, update_rebase, second_review, deploy_retry, skill_patch, agent_create and any key added later or made up by an
 * agent, is decided by the owner only. A CODE constant on purpose, not config: the config files live on the owner's
 * machine where an agent can write them, and widening this list must be a review. The category is the requesting
 * agent's own claim; the allowlist keeps an approver to the low-risk housekeeping keys of the autonomy config.
 */
export const DELEGABLE_APPROVAL_CATEGORIES: readonly string[] = Object.freeze([
  'kanban_archive_done',
  'kanban_stuck_nudge',
  'kanban_restructure',
  'memory_maintenance',
  'routine_trivial_fix',
])

export function isOwnerOnlyCategory(category: string): boolean {
  return !DELEGABLE_APPROVAL_CATEGORIES.includes(category)
}

/** A scope's category: a category key as the autonomy config spells them (the same alphabet as routes/approvals.ts
 *  isCategoryKey). */
export function isScopeCategory(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v)
}

/** A scope's agent: '*' (every agent) or one agent id (the alphabet of routes/approvals.ts isForAgentName). */
export function isScopeAgent(v: unknown): v is string {
  return v === '*' || (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v))
}

/**
 * The live scope that lets this approver session decide this approval, or null. All must hold: the caller is an
 * approver session whose login still exists, is enabled and still has the approver role; the request is still pending
 * (a request already decided, by the owner or anyone, is not the approver's to touch); its category is not owner-only;
 * and a scope row matches its category and requesting agent (or '*').
 */
export function approverScopeFor(auth: RouteContext['auth'], approval: Pick<Approval, 'category' | 'agent_id' | 'status'> | undefined): ApproverScope | null {
  if (auth?.kind !== 'approver' || !auth.user || !approval) return null
  if (approval.status !== 'pending') return null
  if (isOwnerOnlyCategory(approval.category)) return null
  const user = getDashboardUser(auth.user)
  if (!user || user.disabled || user.role !== 'approver') return null
  return listApproverScopes(user.id).find((s) => s.category === approval.category && (s.agent === '*' || s.agent === approval.agent_id)) ?? null
}

/** May this caller decide this approval request? The owner (mayActAsOwner) always; an approver only within a live,
 *  non-owner-only scope (approverScopeFor). Used on the approval decide route only (routes/approvals.ts PATCH). */
export function mayApprove(auth: RouteContext['auth'], approval: Pick<Approval, 'category' | 'agent_id' | 'status'> | undefined, req?: http.IncomingMessage): boolean {
  if (mayActAsOwner(auth, req)) return true
  return approverScopeFor(auth, approval) !== null
}
