// F9: an agent_messages row saying 'delivered' only means the router typed the
// message into the recipient's tmux pane (push) or the recipient drained it
// (pull). seen_at records stronger evidence: for a pull, the drain itself; for
// a push, the recipient's own Claude Code transcript showing the message.
// Only the router's header ("[Uzenet @<sender>-tol ... msg_id:N...]") counts --
// the router's header (local or federated form) counts only outside the
// source-attributed wrapper that carries the body, at a line start or after
// whitespace (a push types the turn into the pane on one line, so every newline
// arrives as a space and the header follows the preamble after two), naming the
// row's own sender; a cut wrapper hides what it would have enclosed. So a body
// that quotes another message's header, tool output and assistant text never
// mark anything seen; every message of a batch injection is recognised.

import { readTranscriptTailFromProjectDir } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { agentDir } from './agent-config.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { listDeliveredUnseen, markMessagesSeen } from '../db.js'
import { logger } from '../logger.js'
import { whileNotFrozen } from './fleet-freeze.js'

export const SEEN_WINDOW_SEC = 24 * 60 * 60
export const SEEN_SWEEP_INTERVAL_MS = 60_000

const HEADER_RE = /(?:^|\s)\[Uzenet (?:@([^\s\]]+)-tol|a tavoli @([^\s\]]+) ugynoktol)\b[^\]\n]*?msg_id:(\d+)[,\]]/g

export function findSeenMsgIds(transcriptTail: string, candidates: ReadonlyMap<number, string>): Set<number> {
  const found = new Set<number>()
  for (const line of transcriptTail.split('\n')) {
    if (!line.includes('[Uzenet ')) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || entry.type !== 'user') continue
    const content = entry.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((el: any) => el && el.type === 'text' && typeof el.text === 'string')
        .map((el: any) => el.text)
        .join('\n')
    }
    // Real wrappers always carry source="..."; the header text may mention <untrusted> bare.
    let outside = text.replace(/<(trusted-peer|untrusted)\s+source="[^"]*"[^>]*>[\s\S]*?<\/\1>/g, '')
    // A wrapper cut off inside this turn: an opening tag without its close hides
    // everything after it, a closing tag without its opening hides everything before it.
    outside = outside.replace(/<(?:trusted-peer|untrusted)\s+source="[^"]*"[^>]*>[\s\S]*$/, '')
    outside = outside.replace(/^[\s\S]*<\/(?:trusted-peer|untrusted)>/, '')
    for (const m of outside.matchAll(HEADER_RE)) {
      const sender = m[1] ?? m[2]
      const id = Number(m[3])
      if (candidates.get(id) === sender) found.add(id)
    }
  }
  return found
}

export type TailReader = (agent: string) => string | null

export function defaultTailReader(agent: string): string | null {
  try {
    const workingDir = agent === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(agent)
    return readTranscriptTailFromProjectDir(workingDir, configDirFor(agent))
  } catch {
    return null
  }
}

export function sweepSeenMessages(nowSec: number, readTail: TailReader = defaultTailReader): number {
  const rows = listDeliveredUnseen(nowSec - SEEN_WINDOW_SEC)
  if (!rows.length) return 0
  const byAgent = new Map<string, Map<number, string>>()
  for (const r of rows) {
    const ids = byAgent.get(r.to_agent)
    if (ids) ids.set(r.id, r.from_agent)
    else byAgent.set(r.to_agent, new Map([[r.id, r.from_agent]]))
  }
  let n = 0
  for (const [agent, ids] of byAgent) {
    let tail: string | null
    try { tail = readTail(agent) } catch { continue }
    if (tail == null) continue
    const found = findSeenMsgIds(tail, ids)
    n += markMessagesSeen([...found], nowSec)
  }
  if (n > 0) logger.debug({ seen: n }, 'message-seen sweep marked messages as seen')
  return n
}

export function startMessageSeenSweep(): NodeJS.Timeout {
  return setInterval(whileNotFrozen('message-seen', () => {
    try { sweepSeenMessages(Math.floor(Date.now() / 1000)) } catch (err) { logger.warn({ err }, 'message-seen sweep failed') }
  }), SEEN_SWEEP_INTERVAL_MS)
}
