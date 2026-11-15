// /options (owner request 2026-11-15): the Discord channel's switches, their current values and where each is set.
// Read-only, Discord-only. Two sources:
//   1. the Discord plugin's access.json (its state dir), set in the terminal with /discord:access;
//   2. Marveen's Discord overlay settings (config registry, effective value), set on the dashboard.
// No ids of people or roles (counts only), never a token. A channel id is shown: it names the channel.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelStateDir } from '../channel-provider.js'
import { getEffectiveSettingSource, type SettingSource } from '../settings-store.js'

export const OPTIONS_DISCORD_ONLY_REPLY = '/options csak Discordon érhető el.'

// The plugin's own defaults when a field is missing (vendor/discord-plugin/0.0.4/upstream/server.ts).
export const ACCESS_DEFAULTS = { dmPolicy: 'pairing', replyToMode: 'first', textChunkLimit: 2000, chunkMode: 'length' } as const

export type AccessRead = { state: 'ok'; access: Record<string, unknown> } | { state: 'missing' } | { state: 'unreadable' }
export type SettingRead = { value: string; source: SettingSource } | null // null: this version does not know the key

export interface OptionsDeps {
  readAccess: () => AccessRead
  setting: (key: string) => SettingRead
}

export function readDiscordAccess(dir: string = channelStateDir('discord')): AccessRead {
  const f = join(dir, 'access.json')
  if (!existsSync(f)) return { state: 'missing' }
  try {
    const v = JSON.parse(readFileSync(f, 'utf-8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? { state: 'ok', access: v as Record<string, unknown> } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

function effectiveSetting(key: string): SettingRead {
  try {
    const r = getEffectiveSettingSource(key)
    return { value: String(r.value), source: r.source }
  } catch {
    return null
  }
}

export const defaultOptionsDeps: OptionsDeps = { readAccess: () => readDiscordAccess(), setting: effectiveSetting }

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
const oneLine = (v: string, max = 60) => {
  const flat = v.replace(/[\r\n]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function accessField(a: Record<string, unknown>, key: keyof typeof ACCESS_DEFAULTS | 'ackReaction' | 'mentionPatterns'): string {
  const v = a[key]
  if (key === 'ackReaction') return typeof v === 'string' && v ? v : 'nincs (alap)'
  if (key === 'mentionPatterns') return Array.isArray(v) && v.length > 0 ? `${v.length} minta` : 'nincs (alap)'
  const def = ACCESS_DEFAULTS[key]
  return v === undefined || v === null || v === '' ? `${def} (alap)` : oneLine(String(v))
}

function settingLine(key: string, r: SettingRead, render: (v: string) => string): string {
  if (r === null) return `${key}: ez a verzió még nem ismeri`
  return `${key}: ${render(r.value)}${r.source === 'default' ? ' (alap)' : ''}`
}

function onOff(v: string): string {
  return /^(1|true|on|yes|igen)$/i.test(v.trim()) ? 'be' : /^(0|false|off|no|nem)$/i.test(v.trim()) ? 'ki' : oneLine(v)
}

function channelPolicyLines(raw: string): string[] {
  const t = raw.trim()
  if (!t) return []
  let o: unknown
  try { o = JSON.parse(t) } catch { return ['  · hibás JSON: a csatorna-indítás figyelmen kívül hagyja'] }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['  · nem JSON-objektum: a csatorna-indítás figyelmen kívül hagyja']
  return Object.entries(o as Record<string, Record<string, unknown> | null>).map(([ch, p]) => {
    const yes = (k: string) => (p && p[k] === true ? 'be' : 'ki')
    return `  · ${oneLine(ch, 25)}: history ${yes('history')}, autoThread ${yes('autoThread')}, allowRoles ${count(p?.allowRoles)}`
  })
}

export function discordOptionsText(deps: OptionsDeps = defaultOptionsDeps): string {
  const out: string[] = ['Discord-kapcsolók', '', 'Discord plugin (access.json) · állítás: terminál, /discord:access set <kulcs> <érték>']
  const a = deps.readAccess()
  if (a.state === 'missing') out.push('nincs access.json (a Discord csatorna nincs beállítva ezen a telepítésen)')
  else if (a.state === 'unreadable') out.push('az access.json nem olvasható (hibás JSON)')
  else {
    const acc = a.access
    for (const k of ['dmPolicy', 'ackReaction', 'replyToMode', 'textChunkLimit', 'chunkMode', 'mentionPatterns'] as const) out.push(`${k}: ${accessField(acc, k)}`)
    const groups = acc.groups && typeof acc.groups === 'object' && !Array.isArray(acc.groups) ? Object.entries(acc.groups as Record<string, Record<string, unknown>>) : []
    out.push(`csatornák: ${groups.length}`)
    for (const [ch, g] of groups) {
      const rm = g?.requireMention === false ? 'nem' : `igen${g?.requireMention === undefined ? ' (alap)' : ''}`
      out.push(`  · ${oneLine(ch, 25)}: megszólítás kell ${rm}, allowFrom ${count(g?.allowFrom)} fő`)
    }
  }
  out.push('', 'Marveen-bővítés · állítás: dashboard, Beállítások, Csatornák')
  out.push(settingLine('DISCORD_PLUGIN_EXT', deps.setting('DISCORD_PLUGIN_EXT'), onOff))
  out.push(settingLine('DISCORD_OWNER_USER_ID', deps.setting('DISCORD_OWNER_USER_ID'), v => (v.trim() ? 'beállítva' : 'nincs beállítva')))
  out.push(settingLine('DISCORD_ADMIN_ACTIONS', deps.setting('DISCORD_ADMIN_ACTIONS'), v => (v.trim() ? oneLine(v) : 'nincs')))
  const policy = deps.setting('DISCORD_CHANNEL_POLICY')
  if (policy === null) out.push('DISCORD_CHANNEL_POLICY: ez a verzió még nem ismeri')
  else {
    const lines = channelPolicyLines(policy.value)
    out.push(`DISCORD_CHANNEL_POLICY: ${lines.length === 0 ? 'nincs (alap)' : `${lines.length} csatorna`}`)
    out.push(...lines)
  }
  return out.join('\n')
}
