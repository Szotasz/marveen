// Caller evidence for owner WRITE commands (/model, /context clear, ...).
//
// #1530 review: every fleet agent holds the shared dashboard token, and the
// dispatch route used to tell "the owner typed it" from "an agent asked for
// it" only by the ABSENCE of identity fields (agentIdentityOf, mainSession
// defaulting to true). An agent that simply leaves them out could run a write
// as the main session, on the owner's chat -- whose id is not a secret.
//
// A write therefore runs only when the Telegram message it came in is on
// record in the channel plugin's own inbound log: the owner's chat, the same
// message id, the same text, recent, and not used before. The log is written
// by the plugin process itself (scripts/patch-telegram-plugin.py, the `evid`
// patch), just before it hands the message to Claude Code -- the one place
// only a real Telegram update reaches. The prompt text is NOT evidence:
// anything typed into the session pane (an agent message delivered there, or
// cmd-sim.py) can carry a <channel> block, and conversation_log is captured
// from exactly that text.
//
// Reads are unaffected: they expose nothing an agent cannot already read.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelStateDir } from '../channel-provider.js'
import { claimCommandWriteEvidence } from '../db.js'

export const EVIDENCE_FILE = 'inbound-evidence.jsonl'

// From the message reaching the bot to the write running. The idle path takes
// seconds (hook -> deferred re-send after the hook exits); a command that
// arrives mid-turn waits for the next tool boundary (midturn-commands.ts).
// Past this the owner is asked to send it again rather than running a stale
// instruction.
export const EVIDENCE_WINDOW_MS = 10 * 60 * 1000

export type EvidenceRefusal = 'no-message-id' | 'not-found' | 'text-mismatch' | 'too-old' | 'already-used'
export type EvidenceVerdict = { ok: true } | { ok: false; reason: EvidenceRefusal }

export interface EvidenceRequest {
  chatId: string
  messageId: string | null
  text: string
  now: number
}

export interface EvidenceRecord {
  chat_id: string
  message_id: string | null
  text: string
  at: number
}

// Claude Code renders the message into a <channel> block, so what reaches the
// hook may carry the XML entities of what the plugin logged.
function normalizeText(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim()
}

/** The newest record for (chat, message) in the plugin's log lines, or null. */
export function findEvidence(lines: string[], chatId: string, messageId: string): EvidenceRecord | null {
  let found: EvidenceRecord | null = null
  for (const line of lines) {
    if (!line.includes(messageId)) continue
    let r: Partial<EvidenceRecord>
    try { r = JSON.parse(line) as Partial<EvidenceRecord> } catch { continue }
    if (String(r.chat_id) !== chatId || String(r.message_id) !== messageId) continue
    if (typeof r.text !== 'string' || typeof r.at !== 'number') continue
    found = { chat_id: chatId, message_id: messageId, text: r.text, at: r.at }
  }
  return found
}

/** The plugin's log, current file after the rotated one; [] when absent. */
export function readEvidenceLines(stateDir: string = channelStateDir('telegram')): string[] {
  const out: string[] = []
  for (const f of [`${EVIDENCE_FILE}.1`, EVIDENCE_FILE]) {
    try { out.push(...readFileSync(join(stateDir, f), 'utf-8').split('\n')) } catch { /* absent */ }
  }
  return out
}

export function checkWriteEvidence(
  req: EvidenceRequest,
  readLines: () => string[] = () => readEvidenceLines(),
  claim: (chatId: string, messageId: string, now: number) => boolean = claimCommandWriteEvidence,
): EvidenceVerdict {
  if (!req.messageId) return { ok: false, reason: 'no-message-id' }
  const rec = findEvidence(readLines(), req.chatId, req.messageId)
  if (!rec) return { ok: false, reason: 'not-found' }
  if (normalizeText(rec.text) !== normalizeText(req.text)) return { ok: false, reason: 'text-mismatch' }
  if (req.now - rec.at > EVIDENCE_WINDOW_MS || rec.at - req.now > 60_000) return { ok: false, reason: 'too-old' }
  // Last, so a refused check never burns the message.
  if (!claim(req.chatId, req.messageId, req.now)) return { ok: false, reason: 'already-used' }
  return { ok: true }
}

export type WriteEvidenceCheck = (req: EvidenceRequest) => EvidenceVerdict

export const WRITE_EVIDENCE_REPLY = (name: string, reason: EvidenceRefusal): string =>
  reason === 'too-old'
    ? `/${name}: ez az üzenet már túl régi ahhoz, hogy most lefusson. Ha még kell, küldd el újra.`
    : `/${name}: nem futtatom, mert nem találom a Telegram-üzenetet, amiből jött (${reason}). Ha te küldted, küldd el újra.`
