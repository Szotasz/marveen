// TOKENSWAPRESTART1123 (b): after a NEW fleet token is saved on the dashboard, the sub-agents on the shared fleet
// token are restarted, one at a time, so each picks up the new file (owner decision 2026-11-23: "Magától indítsa
// újra" -- automatically, without asking). Busy or not, like the plan rotation's fleet leg. Agents with their own
// token, own config dir, API key or own team login are not on the fleet token and are left alone (usesFleetToken).
// The owner gets one message with the count.
import { logger } from '../logger.js'
import { notifyOwner } from '../notify.js'
import { restartSharedTokenAgents, type SharedRestartDeps } from '../claude-plan-fleet-rotation.js'

export interface SwapRestartResult { restarted: string[]; failed: Array<{ agent: string; error: string }>; notRunning: string[] }

/** Whether a save is a token SWAP: there was a fleet token before, and the new one differs from it. */
export function isFleetTokenSwap(previous: string | null, next: string): boolean {
  const prev = (previous ?? '').trim()
  return prev !== '' && prev !== next.trim()
}

/** Sent instead of the restart when the new token could not be live-verified (Dani #3077 F1). */
export const UNVERIFIED_SWAP_NOTICE =
  'Flotta-token csere: az új tokent elmentettem, de élőben nem tudtam ellenőrizni (a próba nem adott választ), ezért a kollégákat NEM indítottam újra. ' +
  'Ha a token jó, a dashboardon indítsd újra a kollégákat; ha elírás volt, illeszd be újra.'

/** The owner's message, Hungarian (the dashboard's language for owner alerts). */
export function swapRestartMessage(r: SwapRestartResult): string {
  const parts = [`Flotta-token csere: ${r.restarted.length} kolléga újraindult az új tokennel${r.restarted.length ? ` (${r.restarted.join(', ')})` : ''}.`]
  if (r.failed.length) parts.push(`Nem sikerült: ${r.failed.map((f) => f.agent).join(', ')}; ezeket a dashboardon indítsd újra kézzel.`)
  if (r.notRunning.length) parts.push(`Nem futott, a következő indulásnál már az új tokent kapja: ${r.notRunning.join(', ')}.`)
  return parts.join(' ')
}

export async function restartFleetAfterTokenSwap(
  deps?: SharedRestartDeps & { notify?: (text: string) => Promise<unknown> },
): Promise<SwapRestartResult | null> {
  try {
    const d = deps ?? (await defaultDeps())
    const r = await restartSharedTokenAgents(d)
    logger.warn({ restarted: r.restarted, failed: r.failed, notRunning: r.notRunning }, 'fleet token swap: shared-token sub-agents restarted')
    const notify = deps?.notify ?? notifyOwner
    await notify(swapRestartMessage(r)).catch(() => undefined)
    return r
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fleet token swap: restart pass failed')
    return null
  }
}

async function defaultDeps(): Promise<SharedRestartDeps> {
  // Imported lazily: the fleet wiring pulls in the plan registry and the launcher (as the rotation route does).
  const [{ usesFleetToken }, { listAllAgentNames }, { isAgentRunning, restartAgentProcess }] = await Promise.all([
    import('./claude-plan-fleet-wiring.js'),
    import('./agent-config.js'),
    import('./agent-process.js'),
  ])
  return {
    listAgents: listAllAgentNames,
    usesFleetToken,
    isRunning: isAgentRunning,
    // A conversation-keeping restart with a wake that says why (RESTARTWAKE927).
    restart: (name) => restartAgentProcess(name, { wake: { reason: 'fleet-token-swap' } }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}
