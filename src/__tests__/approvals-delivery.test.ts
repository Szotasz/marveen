// APPROVALVAK821: the approval gate was a closed loop -- three independent
// legs, each silently non-delivering:
//   (1) creation never sent anything to the owner (telegram_message_id was
//       only writable via PATCH, which nothing called),
//   (2) notifyMainAgent delivered the notification back to the REQUESTER
//       when the requester was the main agent itself,
//   (3) timeout_at was always NULL (no category carries timeout_minutes and
//       the request's timeout_seconds was never read), so the sweeper's
//       'timeout' status was structurally unreachable.
// These tests pin the fix for all three legs: the pure pieces behaviorally,
// the wiring as string contracts (house idiom of approvals-prompt-contract).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeTimeoutAt,
  buildOwnerApprovalText,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_SECONDS,
} from '../web/routes/approvals.js'
import type { Approval } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTE = readFileSync(join(__dirname, '../../src/web/routes/approvals.ts'), 'utf-8')
const TELEGRAM = readFileSync(join(__dirname, '../../src/web/telegram.ts'), 'utf-8')

const NOW_MS = 1_787_300_000_000

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'test-id-1234',
    agent_id: 'samu',
    category: 'skill_patch',
    action_description: 'Skill frissítése a mérési eredmény alapján',
    action_payload: null,
    status: 'pending',
    timeout_at: Math.floor(NOW_MS / 1000) + 3600,
    telegram_message_id: null,
    requested_at: Math.floor(NOW_MS / 1000),
    resolved_at: null,
    resolved_by: null,
    ...over,
  }
}

describe('computeTimeoutAt (leg 3: the timeout state must be reachable)', () => {
  const now = Math.floor(NOW_MS / 1000)

  it('the request timeout_seconds wins', () => {
    expect(computeTimeoutAt('nonexistent-category', 3600, NOW_MS)).toBe(now + 3600)
  })

  it('caps a timeout past a week (it would equal the old "never")', () => {
    expect(computeTimeoutAt('x', 10 * 24 * 3600, NOW_MS)).toBe(now + MAX_TIMEOUT_SECONDS)
  })

  it('ignores junk timeout_seconds and falls through', () => {
    for (const junk of ['3600', -5, 0, NaN, Infinity, null, undefined, {}]) {
      expect(computeTimeoutAt('nonexistent-category', junk, NOW_MS)).toBe(now + DEFAULT_TIMEOUT_MINUTES * 60)
    }
  })

  it('NEVER returns null: with no param and no category value the default applies', () => {
    expect(computeTimeoutAt('nonexistent-category', undefined, NOW_MS)).toBe(now + DEFAULT_TIMEOUT_MINUTES * 60)
  })
})

describe('buildOwnerApprovalText (leg 1: what the owner reads)', () => {
  it('carries the id, requester, category and description', () => {
    const text = buildOwnerApprovalText(approval())
    expect(text).toContain('samu')
    expect(text).toContain('skill_patch')
    expect(text).toContain('Skill frissítése a mérési eredmény alapján')
    expect(text).toContain('test-id-1234')
    expect(text).toContain('Jóváhagyások')
    expect(text).not.toContain('undefined')
  })

  it('renders the expiry in local (Budapest) time, or "nincs" without one', () => {
    expect(buildOwnerApprovalText(approval())).toContain('Lejárat: 2026.')
    expect(buildOwnerApprovalText(approval({ timeout_at: null }))).toContain('Lejárat: nincs')
  })
})

describe('wiring contracts on the route source', () => {
  it('the POST handler notifies the OWNER, not only the main agent', () => {
    const post = ROUTE.slice(ROUTE.indexOf("path === '/api/approvals' && method === 'POST'"))
    const owner = post.indexOf('notifyOwner(approval)')
    const main = post.indexOf('notifyMainAgent(approval)')
    expect(owner).toBeGreaterThan(0)
    expect(main).toBeGreaterThan(owner)
  })

  it('a successful owner send stamps telegram_message_id onto the row', () => {
    expect(ROUTE).toContain('setApprovalTelegramMessageId(approval.id, messageId)')
  })

  it('leg 2: the main-agent notify short-circuits when the requester IS the main agent', () => {
    const fn = ROUTE.slice(ROUTE.indexOf('function notifyMainAgent('))
    const guard = fn.indexOf('approval.agent_id === MAIN_AGENT_ID')
    const send = fn.indexOf('createAgentMessage')
    expect(guard).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(guard)
  })

  it('the POST handler reads timeout_seconds from the body', () => {
    expect(ROUTE).toContain('computeTimeoutAt(category, timeout_seconds)')
  })

  it('a failed owner send is loud, not silent', () => {
    expect(ROUTE).toContain('approval owner notification FAILED')
  })

  it('sendTelegramMessage exposes the message_id for the stamp', () => {
    expect(TELEGRAM).toContain('Promise<number | null>')
    expect(TELEGRAM).toContain('message_id')
  })
})
