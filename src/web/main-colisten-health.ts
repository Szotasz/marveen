// BOOTSTAGGER1007 (b): the main session's CO-LISTEN channel plugins
// (CHANNEL_PLUGINS_EXTRA) are watched too, not only the primary provider.
//
// MEASURED 2026-10-07 after a power cut: the co-listen Slack plugin's MCP
// connect timed out at boot ("getaddrinfo ENOTFOUND slack.com"), and the
// owner's main channel stayed deaf for 30 minutes. Every monitor watched only
// the primary (Telegram), which was fine, so nothing alerted (channel-monitor's
// own comment on readExtraChannelPluginIds names the gap: "Liveness probes
// watch the primary, so nothing looks wrong").
//
// What is measured: the same per-provider process probe the primary uses
// (probeChannelPluginLiveness: the provider's plugin process under the main
// claude). It sees this failure: on an MCP connect timeout Claude Code closes
// the stdio transport, which ends the server process (read from the 2.1.292
// binary's connect path: `T.close(); N.close()` in the timeout handler).
//
// This module is the pure part: which provider a plugin id belongs to, and
// what to do with one observation. The caller owns the state and the I/O.

import type { ChannelProviderType } from '../channel-provider.js'

/** Sweeps a co-listen plugin must be seen down in a row before anything acts (one sweep is 60 s). */
export const COLISTEN_CONFIRM_SWEEPS = 2
/** Session restarts the co-listen watch may trigger inside COLISTEN_RESTART_WINDOW_MS. */
export const COLISTEN_MAX_RESTARTS = 2
export const COLISTEN_RESTART_WINDOW_MS = 6 * 60 * 60 * 1000

export interface ColistenState {
  /** When the current down-spell started, null while the plugin is up. */
  downSince: number | null
  /** Consecutive down sweeps in the current spell (reset by a restart). */
  downSweeps: number
  /** Restarts this watch triggered, kept across recoveries: the cap is a window, not a spell. */
  restartsAt: number[]
  /** The cap was reached in this spell and said once; no more action until it is up. */
  gaveUp: boolean
}

export type ColistenAction =
  | 'none'      // nothing to do (up and was up, or the probe knew nothing)
  | 'wait'      // down, but not confirmed yet or inside the post-respawn grace
  | 'restart'   // restart the main session (keeps the conversation)
  | 'give-up'   // down, the restart cap is spent: tell the owner, once
  | 'recovered' // up again after a down-spell that was acted on

export function emptyColistenState(): ColistenState {
  return { downSince: null, downSweeps: 0, restartsAt: [], gaveUp: false }
}

/**
 * The provider a `--channels` plugin id belongs to, from the providers' own
 * plugin ids (src/channel-provider.ts), or null for an id no provider owns.
 */
export function providerOfPluginId(
  pluginId: string,
  providers: ReadonlyArray<{ type: ChannelProviderType; pluginId: string }>,
): ChannelProviderType | null {
  const id = pluginId.trim()
  return providers.find((p) => p.pluginId === id)?.type ?? null
}

/**
 * One observation of one co-listen plugin -> what to do, and the next state.
 * `liveness` is the probe's tri-state verdict ('unknown' = the probe failed,
 * which is no evidence either way). `inRespawnGrace` is true while the main
 * session is still booting after any respawn: a plugin that is not up YET is
 * not down.
 */
export function decideColistenAction(
  prev: ColistenState,
  liveness: 'alive' | 'down' | 'unknown',
  now: number,
  inRespawnGrace: boolean,
): { action: ColistenAction; next: ColistenState } {
  const restartsAt = prev.restartsAt.filter((t) => now - t < COLISTEN_RESTART_WINDOW_MS)
  if (liveness === 'unknown') return { action: 'none', next: { ...prev, restartsAt } }
  if (liveness === 'alive') {
    const actedOn = prev.downSince !== null && (prev.gaveUp || restartsAt.some((t) => t >= (prev.downSince as number)))
    return {
      action: actedOn ? 'recovered' : 'none',
      next: { downSince: null, downSweeps: 0, restartsAt, gaveUp: false },
    }
  }
  // down
  const next: ColistenState = {
    downSince: prev.downSince ?? now,
    downSweeps: prev.downSweeps + 1,
    restartsAt,
    gaveUp: prev.gaveUp,
  }
  if (next.gaveUp) return { action: 'none', next }
  if (inRespawnGrace || next.downSweeps < COLISTEN_CONFIRM_SWEEPS) return { action: 'wait', next }
  if (restartsAt.length >= COLISTEN_MAX_RESTARTS) return { action: 'give-up', next: { ...next, gaveUp: true } }
  return { action: 'restart', next: { ...next, downSweeps: 0, restartsAt: [...restartsAt, now] } }
}

/**
 * The main session's co-listen providers from CHANNEL_PLUGINS_EXTRA: the
 * primary excluded (it has its own watch and its own down-cascade), each
 * provider once, an id no provider owns dropped.
 */
export function colistenProviders(
  primary: ChannelProviderType,
  extraPluginIds: string[],
  providers: ReadonlyArray<{ type: ChannelProviderType; pluginId: string }>,
): ChannelProviderType[] {
  const out: ChannelProviderType[] = []
  for (const id of extraPluginIds) {
    const p = providerOfPluginId(id, providers)
    if (p !== null && p !== primary && !out.includes(p)) out.push(p)
  }
  return out
}

export interface ColistenCheckDeps {
  primary: ChannelProviderType
  /** The co-listen providers, the primary already excluded. */
  extras: ChannelProviderType[]
  probe: (provider: ChannelProviderType) => 'alive' | 'down' | 'unknown'
  now: number
  /** Wall-clock ms of the latest main-session respawn by any path, 0 if none. */
  lastRespawnAt: number
  respawnGraceMs: number
  state: Map<ChannelProviderType, ColistenState>
  alert: (text: string) => void
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => void
  /** Restart the main session keeping the conversation; true when it went through. */
  restart: () => Promise<boolean>
  botName: string
}

/**
 * One sweep over the main session's co-listen plugins. Call it only while the
 * PRIMARY plugin is alive: a dead primary is the down-cascade's job, and a
 * restart from here would race it. At most one restart per sweep.
 */
export async function runColistenCheck(d: ColistenCheckDeps): Promise<ColistenAction[]> {
  const actions: ColistenAction[] = []
  const inGrace = d.lastRespawnAt > 0 && d.now - d.lastRespawnAt < d.respawnGraceMs
  let restarted = false
  for (const p of d.extras) {
    const prev = d.state.get(p) ?? emptyColistenState()
    let { action, next } = decideColistenAction(prev, d.probe(p), d.now, inGrace)
    if (action === 'restart' && restarted) {
      // Another co-listen plugin already restarted the session this sweep:
      // do not spend this one's budget, look again after the grace.
      action = 'wait'
      next = { ...prev, downSince: prev.downSince ?? d.now }
    }
    d.state.set(p, next)
    actions.push(action)
    if (action === 'restart') {
      const n = next.restartsAt.length
      d.log('warn', { provider: p, primary: d.primary, attempt: n, max: COLISTEN_MAX_RESTARTS }, 'co-listen channel plugin down in the main session -- restarting the session (conversation kept)')
      d.alert(`⚠️ A(z) ${d.botName} ${p}-csatornája nem él a fő sessionben (a(z) ${d.primary} igen). Újraindítom a sessiont, a beszélgetés megmarad (${n}/${COLISTEN_MAX_RESTARTS}).`)
      restarted = true
      if (!(await d.restart())) d.log('warn', { provider: p }, 'co-listen restart: the session restart did not go through')
    } else if (action === 'give-up') {
      d.log('error', { provider: p, primary: d.primary, restarts: next.restartsAt.length }, 'co-listen channel plugin still down after the restart cap -- giving up until it is seen alive')
      d.alert(`❌ A(z) ${d.botName} ${p}-csatornája ${COLISTEN_MAX_RESTARTS} újraindítás után sem él a fő sessionben. Addig itt (${d.primary}) érsz el, és tovább figyelem; ha magától helyreáll, szólok.`)
    } else if (action === 'recovered') {
      d.log('info', { provider: p, primary: d.primary }, 'co-listen channel plugin recovered in the main session')
      d.alert(`✅ A(z) ${d.botName} ${p}-csatornája újra él a fő sessionben.`)
    }
  }
  return actions
}
