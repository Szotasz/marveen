// Does an inbound channel message OWE a reply? TypeScript twin of
// scripts/hooks/channel_scope.py -- the two MUST stay equivalent (the Stop
// guard, the prompt directive, the live drain and the replay use the Python
// one, the restart gates this). The parity cases live in
// src/__tests__/open-question-reply-owed.test.ts and
// scripts/__tests__/channel-scope.test.py.
//
// A DM always does. A GROUP message (Telegram: negative chat_id) only when it
// addresses the agent:
//   - a Telegram reply to one of the agent's own messages (repliesToAgent), or
//   - one of its name forms in the text, accent-folded (NFD, marks dropped,
//     lower-cased) and inflection-tolerant: "@<form>" with any tail, or a word
//     that starts with <form> followed by at most MAX_SUFFIX letters
//     ("Zárát" -> zara+t, "Írisz" -> iris+z).
// Name forms: the agent id, displayName + mentionNames from
// agents/<id>/agent-config.json, and TG_MENTION_NAMES (comma-separated).
// Fails toward a reply: an unclear match counts as a mention.
//
// Without this the restart gates treated an unaddressed group message as an
// open question forever -- harmless on the main agent only by luck, and a
// blocker for enabling the conversation ledger on sub-agents.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from './config.js'

export const MAX_SUFFIX = 5

export function isGroupChat(chatId: string | number | null | undefined): boolean {
  return String(chatId ?? '').trim().startsWith('-')
}

export function fold(text: string | null | undefined): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function agentsDir(): string {
  return process.env.CHANNEL_SCOPE_AGENTS_DIR || join(PROJECT_ROOT, 'agents')
}

function configuredNames(agentId: string): string[] {
  const aid = agentId.trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(aid) || aid === '.' || aid === '..') return []
  let cfg: unknown
  try {
    cfg = JSON.parse(readFileSync(join(agentsDir(), aid, 'agent-config.json'), 'utf-8'))
  } catch {
    return []
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return []
  const c = cfg as { displayName?: unknown; mentionNames?: unknown }
  const names: string[] = []
  if (typeof c.displayName === 'string') names.push(c.displayName)
  if (Array.isArray(c.mentionNames)) {
    for (const n of c.mentionNames) if (typeof n === 'string') names.push(n)
  }
  return names
}

export function mentionNames(agentId: string): string[] {
  const raw = [agentId, ...configuredNames(agentId), ...(process.env.TG_MENTION_NAMES ?? '').split(',')]
  const out: string[] = []
  for (const n of raw) {
    const f = fold(n).trim().replace(/^@+/, '')
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}

const W = '[\\p{L}\\p{N}_]'

function formRx(form: string): RegExp {
  const body = form.split(/\s+/).filter(Boolean).map(escapeRx).join('\\s+')
  return new RegExp(`@${body}${W}*|(?<![\\p{L}\\p{N}_@])${body}${W}{0,${MAX_SUFFIX}}(?!${W})`, 'u')
}

export function mentionsAgent(text: string | null | undefined, agentId: string, names?: string[]): boolean {
  const t = fold(text)
  return (names ?? mentionNames(agentId)).some((form) => formRx(form).test(t))
}

export interface ReplyOwedOptions {
  // True, or a thunk evaluated only for an unnamed group message, when the
  // inbound is a Telegram reply to one of this agent's own messages.
  repliesToAgent?: boolean | (() => boolean)
  // Precomputed mentionNames(agentId), for callers that test many rows.
  names?: string[]
}

export function replyOwed(
  chatId: string | number | null | undefined,
  text: string | null | undefined,
  agentId: string,
  opts: ReplyOwedOptions = {},
): boolean {
  if (!isGroupChat(chatId)) return true
  if (mentionsAgent(text, agentId, opts.names)) return true
  const r = opts.repliesToAgent
  if (typeof r === 'function') {
    try { return Boolean(r()) } catch { return true } // unclear -> addressed
  }
  return Boolean(r)
}
