import { resolve, sep } from 'node:path'

// NFD + combining-mark strip so Hungarian input like "etrendiro" decays
// to "etrendiro" instead of silently losing every accented character
// and producing "trendr".
// Whitespace becomes a hyphen, like sanitizeScheduleName: "Lean Writer" used
// to decay to "leanwriter", a name nobody typed. Every lookup resolves an
// existing directory name, which never contains whitespace, so this changes
// only what a NEW name becomes.
export function sanitizeAgentName(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// Ids the message layer already owns, so a main agent must never take one
// (FLEETRESERVEDNAME1021). 'system' is the in-process directive sender and is
// 403'd on every POST lane; 'telegram-coordinator' is 403'd too; 'heartbeat'
// and 'channel-coordinator' are hidden as chat threads. A main agent with one
// of these ids could not send, or would speak as something it is not.
// Literals, not imports: the shell migration script keeps the same list, and a
// test pins both to the source constants. This is only the FIXED part: the
// voice channel id is configurable (VOICECHANNELID1022), so the full list,
// RESERVED_AGENT_IDS, is built in config.ts. Kept here so this module stays a
// leaf with no load-time .env read.
export const FIXED_RESERVED_AGENT_IDS: readonly string[] =
  ['system', 'heartbeat', 'telegram-coordinator', 'channel-coordinator']

// Same rules as sanitizeAgentName -- used for skill names to prevent path traversal.
export function sanitizeSkillName(raw: string): string {
  return sanitizeAgentName(raw)
}

export function sanitizeScheduleName(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Joins segments and verifies the resolved path stays inside `base`. Throws on escape.
export function safeJoin(base: string, ...parts: string[]): string {
  const resolvedBase = resolve(base)
  const target = resolve(base, ...parts)
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal rejected: ${parts.join('/')}`)
  }
  return target
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
