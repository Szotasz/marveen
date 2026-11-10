import type { AgentMessage } from '../db.js'
import { isUrgentDelivery } from './message-router-window.js'
import { shouldInterruptForUnblock } from './unblocks-interrupt.js'

export interface BusyMemo { janitorTried: boolean }
export type BusyRowAction = 'check' | 'skip' | 'janitor'

/**
 * One busy pane answers the same for every row of a recipient in one tick.
 * STOP/urgent/unblock rows keep their own check; the memo is per tick only.
 */
export function busyRowAction(
  memo: BusyMemo | undefined,
  msg: Pick<AgentMessage, 'from_agent' | 'content' | 'urgent' | 'stop_authorized' | 'affects_current_work'>,
  ageMs: number,
  worksourceServing: boolean,
  janitorMinAgeMs: number,
  mainAgentId: string,
): BusyRowAction {
  if (memo === undefined) return 'check'
  if (worksourceServing) return 'check'
  if (isUrgentDelivery(msg, mainAgentId)) return 'check'
  if (shouldInterruptForUnblock(msg, false, mainAgentId)) return 'check'
  if (!memo.janitorTried && ageMs > janitorMinAgeMs) return 'janitor'
  return 'skip'
}
