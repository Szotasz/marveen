// ROUTEPIN1109: every state-changing /api handler is either behind an owner gate or named, with a class and a
// reason, in UNGATED_ROUTES (helpers/route-owner-table.ts). A new POST/PUT/PATCH/DELETE handler without an owner gate
// fails here until its author either gates it (mayActAsOwner, see routes/auth.ts) or classifies it in the table.
// Gating a listed route fails here too, until its row is removed, so the table stays the true list.
//
// Classes:
//   agent       a fleet operation: the access token is the agent API (kanban, messages, memory, lifecycle, ...).
//   own-check   authenticated by something else than the access token: the caller's own session, the operator
//               credential, a federation peer key.
//   by-design   reachable with the token on purpose and harmless by effect (checks, diagnostics, a refusal).
//   pending     a classification decision is open (gate it, or move it to another class with the reason).
//   unreviewed  classified by its file, not yet reviewed route by route.
//
// The scan (helpers/route-owner-scan.ts) is static and simple: it sees a gate call that runs before a handler's work
// (in the handler, at the top of an enclosing branch, or in an earlier guard naming the path). A gate that covers
// only part of a handler (updates/apply gates only autoStash) counts as a gate. GET handlers are out of scope.

import { describe, it, expect } from 'vitest'
import { scanRoutes } from './helpers/route-owner-scan.js'
import { UNGATED_ROUTES } from './helpers/route-owner-table.js'

const scan = scanRoutes(process.cwd())
const ungated = scan.routes.filter((r) => !r.gated)
const table = new Map(UNGATED_ROUTES.map((r) => [r.key, r]))

describe('state-changing /api routes: owner gate or a classified row', () => {
  it('the scan still sees the route surface (guards against a scanner that silently finds nothing)', () => {
    expect(scan.routes.length).toBeGreaterThan(150)
    expect(scan.gates).toEqual(expect.arrayContaining(['mayActAsOwner', 'mayActAsOwnerOrFirstRun']))
    expect(scan.gates).not.toContain('refuseOwner')
    // Known gated handlers are seen as gated: a direct gate, a guard ahead of the handlers, an enclosing branch.
    const gated = (key: string) => scan.routes.find((r) => r.key === key)?.gated
    expect(gated('fleet.ts POST /api/fleet/import')).toBe(true)
    expect(gated('migrate.ts POST /api/migrate/run')).toBe(true)
    expect(gated('schedules.ts PUT <scheduleUpdateMatch>')).toBe(true)
    expect(gated('agents.ts POST /api/agents/import')).toBe(true)
  })

  it('every handler without an owner gate is classified', () => {
    const unclassified = ungated.filter((r) => !table.has(r.key)).map((r) => `${r.key} (src/web/routes/${r.file}:${r.line})`)
    expect(unclassified, 'a state-changing route has no owner gate and no row in helpers/route-owner-table.ts: '
      + 'gate it with mayActAsOwner, or add a row with its class and reason').toEqual([])
  })

  it('every row still names an ungated handler (a gated or removed route leaves the table)', () => {
    const live = new Set(ungated.map((r) => r.key))
    expect(UNGATED_ROUTES.filter((r) => !live.has(r.key)).map((r) => r.key)).toEqual([])
  })

  it('rows are unique and every row has a reason', () => {
    expect(table.size).toBe(UNGATED_ROUTES.length)
    expect(UNGATED_ROUTES.filter((r) => r.why.trim().length < 8).map((r) => r.key)).toEqual([])
  })
})
