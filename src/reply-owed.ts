// Does an inbound channel message OWE a reply? TypeScript twin of
// scripts/hooks/channel_scope.py -- the two MUST stay equivalent (the Stop
// guard and the prompt directive use the Python one, the restart gates this).
//
// A DM always does. A GROUP message (Telegram: negative chat_id) only when it
// names the agent (@-tag optional, any suffix: "marveent", "<name>bot").
// Extra names via TG_MENTION_NAMES, comma-separated. Fails toward a reply: an
// unclear match counts as a mention.
//
// REPLYOWED924: without this the restart gates treated an unaddressed group
// message as an open question forever -- harmless on the main agent only by
// luck, and a blocker for enabling the conversation ledger on sub-agents.

export function isGroupChat(chatId: string | number | null | undefined): boolean {
  return String(chatId ?? '').trim().startsWith('-')
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionNames(agentId: string): string[] {
  const extra = (process.env.TG_MENTION_NAMES ?? '').split(',').map((n) => n.trim())
  return [agentId.trim(), ...extra].filter(Boolean)
}

export function mentionsAgent(text: string | null | undefined, agentId: string): boolean {
  const t = String(text ?? '')
  return mentionNames(agentId).some((name) =>
    new RegExp(`(?<![\\p{L}\\p{N}_@])@?${escapeRx(name)}[\\p{L}\\p{N}_]*`, 'iu').test(t))
}

export function replyOwed(chatId: string | number | null | undefined, text: string | null | undefined, agentId: string): boolean {
  if (!isGroupChat(chatId)) return true
  return mentionsAgent(text, agentId)
}
