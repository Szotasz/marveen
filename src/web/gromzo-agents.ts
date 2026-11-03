// GROMZOAGENTPICK1101: the owner chooses, from the dashboard, which agents are on Gromzo.
//
// The way in is mxd's own (dash.sock, mxd-dash.ts): agent_add asks the owner to approve in the app, agent_add_check
// adds the agent once approved (mxd reloads to start it), agent_remove takes one off (mxd reloads to stop it). The
// dashboard never writes mxd's config.toml.
//
// Safety (Samu 64081 (3), Dani 64126):
// - A slug is checked BEFORE any mxd call: mxd's slug rule, an agent of this fleet, never the main agent. A bad one
//   makes no call at all.
// - The consent id stays on the SERVER, bound to the slug it was asked for. The check takes only the slug; the
//   client never sends an id, so a consent approved for A can never switch on B. mxd itself also answers with the
//   slug it added (the controller's), and a different slug writes nothing.
// - Only the agent in question is touched: its flag, and a restart of that one agent (so the Gromzo plugin loads or
//   goes). Nothing else is restarted, and a failure is that row's, not the others'.
// - A removal mxd refused leaves the flag as it is: the list never shows "off" for an agent mxd still runs.
// - One pending add at a time (Ábel 64168): a second slug is refused with add_in_progress until the first is decided
//   or lapses.
// - A held agent (mxd listed it, but its last start held it back: dash status held_agents) may be asked for again,
//   even with its flag on; the list shows it as held.
// - agent_add_check costs mxd an install_proof challenge, and mxd answers too_soon within MIN_ADD_CHECK_S (10 s,
//   one shared clock for every slug). The dashboard holds its own checks to one per CHECK_GAP_MS across all slugs:
//   a faster poll from the panel gets the pending answer back without a call.

import { MAIN_AGENT_ID } from '../config.js'
import { MXD_AGENT_SLUG_RE, checkAgentAdd, requestAgentAdd, requestAgentAvatar, requestAgentRemove, type MxdDashCall } from './mxd-dash.js'
import type { AvatarProblem, AvatarRead } from './gromzo-avatar.js'

export interface GromzoAgentDeps {
  call: MxdDashCall
  /** The fleet's agents (sub-agents; the main agent is added by the list itself). */
  agents: () => string[]
  readFlag: (slug: string) => boolean
  writeFlag: (slug: string, on: boolean) => void
  displayName: (slug: string) => string
  isRunning: (slug: string) => boolean
  /** Runs the synchronous row building in one batch (the route: withTmuxBatch, so the run state costs one
   *  tmux call per server instead of one per agent). Optional: without it the rows are built as they are. */
  batch?: <T>(fn: () => T) => T
  /** The agent's picture, read under the guards of gromzo-avatar.ts (no symlink, size before read, magic bytes). */
  readAvatar: (slug: string) => AvatarRead
  /** What would stop the picture from being sent, without reading it (the list shows it); null = fine. */
  avatarProblem: (slug: string) => AvatarProblem | null
  /** The slugs mxd's last start held back (dash status held_agents); empty when unknown. */
  held: () => Promise<Set<string>>
  /** Restarts that ONE agent, once mxd is back from its reload (fire and forget). */
  restartOne: (slug: string) => void
  now: () => number
}

export interface GromzoAgentRow {
  slug: string
  name: string
  main: boolean
  gromzo: boolean
  running: boolean
  /** mxd lists it, but its last start held it back (the owner can ask for a new approval). */
  held: boolean
  /** Why its picture cannot go to Gromzo (missing, too large, not PNG/JPEG, not a plain file); null = fine. */
  avatarProblem: AvatarProblem | null
  /** A consent is waiting for the owner in the app (until this time, ms). */
  pendingUntil: number | null
}

export type GromzoAgentOutcome =
  | { ok: true, state: 'pending', expiresIn: number }
  | { ok: true, state: 'added' | 'removed' | 'on' | 'refused' | 'expired' | 'used' }
  | { ok: true, state: 'avatar_sent', applied: boolean, pending: boolean, bytes: number }
  /** added: on consent_mismatch, the slug mxd actually added (its flag stays as it was). */
  | { ok: false, code: string, added?: string }

/** slug -> the consent asked for it (server side only). */
const pending = new Map<string, { consentId: string, expiresAt: number }>()

/** mxd's MIN_ADD_CHECK_S is 10 s (whole seconds, one clock for every slug); one more second keeps clear of it. */
export const CHECK_GAP_MS = 11_000
/** When the last agent_add_check went out (any slug); 0 = never. */
let lastCheckAt = 0

/** Test seam: forget every pending consent and the check clock. */
export function resetPendingGromzoConsents(): void {
  pending.clear()
  lastCheckAt = 0
}

function dropExpired(now: number): void {
  for (const [slug, p] of pending) if (p.expiresAt <= now) pending.delete(slug)
}

/** Why a slug may not be switched, or null when it may. Checked before any mxd call. */
export function slugRefusal(slug: string, deps: Pick<GromzoAgentDeps, 'agents'>): string | null {
  if (!MXD_AGENT_SLUG_RE.test(slug)) return 'bad_request'
  if (slug === MAIN_AGENT_ID) return 'main_agent'
  if (!deps.agents().includes(slug)) return 'unknown_agent'
  return null
}

export async function listGromzoAgents(deps: GromzoAgentDeps): Promise<GromzoAgentRow[]> {
  const held = await deps.held()
  const now = deps.now()
  dropExpired(now)
  const build = (): GromzoAgentRow[] => {
    const rows: GromzoAgentRow[] = [{ slug: MAIN_AGENT_ID, name: deps.displayName(MAIN_AGENT_ID), main: true, gromzo: true, running: deps.isRunning(MAIN_AGENT_ID), held: false, avatarProblem: null, pendingUntil: null }]
    for (const slug of [...deps.agents()].sort()) {
      if (slug === MAIN_AGENT_ID) continue
      rows.push({
        slug,
        name: deps.displayName(slug),
        main: false,
        gromzo: deps.readFlag(slug),
        running: deps.isRunning(slug),
        held: held.has(slug),
        avatarProblem: deps.avatarProblem(slug),
        pendingUntil: pending.get(slug)?.expiresAt ?? null,
      })
    }
    return rows
  }
  return deps.batch ? deps.batch(build) : build()
}

/** Switch on: the owner's consent first (in the app); the flag only after mxd added the agent. */
export async function enableGromzoAgent(slug: string, deps: GromzoAgentDeps): Promise<GromzoAgentOutcome> {
  const refused = slugRefusal(slug, deps)
  if (refused) return { ok: false, code: refused }
  if (deps.readFlag(slug) && !(await deps.held()).has(slug)) return { ok: true, state: 'on' }
  const now = deps.now()
  dropExpired(now)
  const waiting = pending.get(slug)
  if (waiting) return { ok: true, state: 'pending', expiresIn: Math.max(1, Math.round((waiting.expiresAt - now) / 1000)) }
  if (pending.size > 0) return { ok: false, code: 'add_in_progress' }
  const r = await requestAgentAdd(deps.call, slug, deps.displayName(slug))
  if (!r.ok) return { ok: false, code: r.code }
  pending.set(slug, { consentId: r.consentId, expiresAt: now + r.expiresIn * 1000 })
  return { ok: true, state: 'pending', expiresIn: r.expiresIn }
}

/** The pending consent of `slug` (the id is the server's own, never the client's). */
export async function checkGromzoAgent(slug: string, deps: GromzoAgentDeps): Promise<GromzoAgentOutcome> {
  const refused = slugRefusal(slug, deps)
  if (refused) return { ok: false, code: refused }
  const now = deps.now()
  dropExpired(now)
  const p = pending.get(slug)
  if (!p) return deps.readFlag(slug) ? { ok: true, state: 'on' } : { ok: false, code: 'no_pending' }
  const stillPending: GromzoAgentOutcome = { ok: true, state: 'pending', expiresIn: Math.max(1, Math.round((p.expiresAt - now) / 1000)) }
  if (lastCheckAt !== 0 && now - lastCheckAt < CHECK_GAP_MS) return stillPending
  lastCheckAt = now
  const r = await checkAgentAdd(deps.call, p.consentId)
  // too_soon: mxd's own gap (another caller, a clock step); nothing was asked, so the consent is still pending.
  if (!r.ok && r.code === 'too_soon') return stillPending
  // Any other failure (mxd reloading or down, rate_limited, a refused pair) keeps the consent: the next check asks again.
  if (!r.ok) return { ok: false, code: r.code }
  if (r.state === 'pending') return stillPending
  pending.delete(slug)
  if (r.state !== 'added') return { ok: true, state: r.state }
  if (r.slug !== slug) return { ok: false, code: 'consent_mismatch', added: r.slug }
  deps.writeFlag(slug, true)
  deps.restartOne(slug)
  return { ok: true, state: 'added' }
}

/** Switch off: mxd takes the agent off its list; only then the flag goes. */
export async function disableGromzoAgent(slug: string, deps: GromzoAgentDeps): Promise<GromzoAgentOutcome> {
  const refused = slugRefusal(slug, deps)
  if (refused) return { ok: false, code: refused }
  const r = await requestAgentRemove(deps.call, slug)
  // unknown_agent: mxd does not list it, so it is off there already; the flag follows.
  if (!r.ok && r.code !== 'unknown_agent') return { ok: false, code: r.code }
  pending.delete(slug)
  deps.writeFlag(slug, false)
  deps.restartOne(slug)
  return { ok: true, state: 'removed' }
}

/** Sends the agent's dashboard picture to Gromzo (mxd agent_avatar), after an add. The slug is checked first; the
 *  file is read only for a slug that passed. A failure is only that: it never undoes the add. There is no other
 *  path: a picture the agent writes later is never sent automatically (Dani 64587, Samu 64633). */
export async function sendGromzoAvatar(slug: string, deps: GromzoAgentDeps): Promise<GromzoAgentOutcome> {
  const refused = slugRefusal(slug, deps)
  if (refused) return { ok: false, code: refused }
  const img = deps.readAvatar(slug)
  if (!img.ok) return { ok: false, code: img.code }
  const r = await requestAgentAvatar(deps.call, slug, img.bytes)
  if (!r.ok) return { ok: false, code: r.code }
  return { ok: true, state: 'avatar_sent', applied: r.applied, pending: r.pending, bytes: img.bytes.length }
}
