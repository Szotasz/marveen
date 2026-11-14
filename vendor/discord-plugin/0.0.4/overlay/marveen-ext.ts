// Marveen's additions to the Discord channel plugin (DCEXT1111). Plain logic, no discord.js import: server.ts
// wires it in, the tests (src/__tests__/discord-plugin-ext.test.ts) run it directly. Settings come from
// marveen-ext.json, written next to server.ts by scripts/patch-discord-plugin.py at every channel start.
import { readFileSync } from 'fs'
import { join } from 'path'

export type ExtConfig = { ownerUserId: string; backfill: boolean; channelPolicy: ChannelPolicy }

const SNOWFLAKE = /^[1-9][0-9]{16,19}$/

// A missing or unreadable file means the safe side: nobody named, no backfill.
export function loadExtConfig(dir: string): ExtConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'marveen-ext.json'), 'utf8')) as Record<string, unknown>
    const owner = typeof raw?.ownerUserId === 'string' && SNOWFLAKE.test(raw.ownerUserId) ? raw.ownerUserId : ''
    return { ownerUserId: owner, backfill: raw?.backfill === true, channelPolicy: parseChannelPolicy(raw?.channelPolicy) }
  } catch {
    return { ownerUserId: '', backfill: false, channelPolicy: {} }
  }
}

export type Owner = { id: string; source: 'setting' | 'sole-dm' } | { id: null; reason: string }

// Who decides a tool permission from Discord. Never the first of several paired DMs (OWNERAUTHGUESS1106):
// the setting, else the only paired DM, else nobody. The named owner must also be paired: pairing is the proof
// that the person controls that Discord account.
export function resolveOwner(cfg: ExtConfig, allowFrom: readonly string[]): Owner {
  if (cfg.ownerUserId) {
    return allowFrom.includes(cfg.ownerUserId)
      ? { id: cfg.ownerUserId, source: 'setting' }
      : { id: null, reason: 'DISCORD_OWNER_USER_ID is not a paired DM (not in allowFrom)' }
  }
  if (allowFrom.length === 1) return { id: allowFrom[0]!, source: 'sole-dm' }
  return {
    id: null,
    reason: allowFrom.length === 0 ? 'no paired DM' : `${allowFrom.length} paired DMs and DISCORD_OWNER_USER_ID is not set`,
  }
}

// A permission is decided only by the owner, only in a DM: never in a guild channel, where any member could
// type "yes <code>".
export function mayDecidePermission(owner: Owner, userId: string, isDM: boolean): boolean {
  return isDM && owner.id !== null && owner.id === userId
}

// DM channel -> paired user, also after a restart. The plugin only learns a DM channel from an INBOUND message
// (dmChannelUsers starts empty), so after every restart it could not write first to anyone who had not written
// since ("channel is not allowlisted"). openDm is client.users.fetch(id) + createDM(): REST only, never a
// gateway connect, and each unknown channel is looked up at most once per process.
export class DmResolver {
  private readonly tried = new Set<string>()

  constructor(
    private readonly openDm: (userId: string) => Promise<string>,
    private readonly known: Map<string, string>,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  private async open(userId: string): Promise<string | undefined> {
    try {
      const channelId = await this.openDm(userId)
      this.known.set(channelId, userId)
      return channelId
    } catch (err) {
      this.warn(`discord channel: cannot open the DM of paired user ${userId}: ${err}`)
      return undefined
    }
  }

  async warm(allowFrom: readonly string[]): Promise<void> {
    for (const userId of allowFrom) await this.open(userId)
  }

  async resolve(channelId: string, allowFrom: readonly string[]): Promise<string | undefined> {
    const hit = this.known.get(channelId)
    if (hit !== undefined) return hit
    if (this.tried.has(channelId)) return undefined
    this.tried.add(channelId)
    const mapped = new Set(this.known.values())
    for (const userId of allowFrom) {
      if (mapped.has(userId)) continue
      if ((await this.open(userId)) === channelId) return userId
    }
    return undefined
  }
}

// F3: Discord marks a recorded voice message with this message flag (discord-api-types MessageFlags.IsVoiceMessage).
const IS_VOICE_MESSAGE = 1 << 13

export function voiceMeta(flags: number): { voice?: 'true' } {
  return (flags & IS_VOICE_MESSAGE) !== 0 ? { voice: 'true' } : {}
}

// F5: fetch_messages paging. Discord takes one of before/after per call; a message id is a snowflake.
export function pagingOptions(args: Record<string, unknown>): { before?: string; after?: string } {
  const out: { before?: string; after?: string } = {}
  for (const key of ['before', 'after'] as const) {
    const v = args[key]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || !/^[0-9]{15,20}$/.test(v)) throw new Error(`${key} must be a message id`)
    out[key] = v
  }
  if (out.before && out.after) throw new Error('pass before OR after, not both')
  return out
}

// F5: a thread name as Discord takes it: 1-100 characters, one line.
export function threadName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!name) throw new Error('name is required')
  return [...name].slice(0, 100).join('')
}

// F4: messages that came while the plugin was down, delivered once at start. REST only (messages.fetch), never a
// gateway connect, and at most once per 10 minutes, so a respawn loop cannot multiply the load
// (anthropics/claude-plugins-official#1965).
export const BACKFILL = {
  minIntervalMs: 10 * 60_000,
  maxPerChannel: 50,
  maxAgeMs: 24 * 60 * 60_000,
  fetchLimit: 100,
} as const

export type CursorFile = { lastBackfillAt: number; channels: Record<string, string> }

const SNOWFLAKE_ID = /^[0-9]{15,20}$/

function newer(a: string, than: string | undefined): boolean {
  return than === undefined || BigInt(a) > BigInt(than)
}

export function readCursor(path: string): { state: CursorFile | null; bad: boolean } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { state: null, bad: false }
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const channels: Record<string, string> = {}
    const ch = raw?.channels
    if (typeof raw?.lastBackfillAt !== 'number' || typeof ch !== 'object' || ch === null) throw new Error('shape')
    for (const [k, v] of Object.entries(ch)) {
      if (!SNOWFLAKE_ID.test(k) || typeof v !== 'string' || !SNOWFLAKE_ID.test(v)) throw new Error('entry')
      channels[k] = v
    }
    return { state: { lastBackfillAt: raw.lastBackfillAt, channels }, bad: false }
  } catch {
    return { state: null, bad: true }
  }
}

// Whether this start recovers anything. No file: the first start, nothing to compare against, so nothing is
// replayed (no flood). A damaged file: nothing either, the caller starts a fresh one.
export function backfillDue(read: { state: CursorFile | null; bad: boolean }, nowMs: number): { due: boolean; reason: string } {
  if (read.bad) return { due: false, reason: 'the cursor file is unreadable: starting a fresh one, nothing recovered this time' }
  if (read.state === null) return { due: false, reason: 'first start: nothing to recover yet' }
  const ago = nowMs - read.state.lastBackfillAt
  if (ago < BACKFILL.minIntervalMs) {
    return { due: false, reason: `the last recovery ran ${Math.max(0, Math.round(ago / 60_000))} min ago (at most every ${BACKFILL.minIntervalMs / 60_000} min)` }
  }
  return { due: true, reason: '' }
}

export class BackfillCursor {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    public readonly state: CursorFile,
    private readonly save: (state: CursorFile) => void,
    private readonly debounceMs = 1000,
  ) {}

  // The newest delivered message per channel; never moves back.
  note(channelId: string, messageId: string): void {
    if (!SNOWFLAKE_ID.test(channelId) || !SNOWFLAKE_ID.test(messageId)) return
    if (!newer(messageId, this.state.channels[channelId])) return
    this.state.channels[channelId] = messageId
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  markRun(nowMs: number): void {
    this.state.lastBackfillAt = nowMs
    this.flush()
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.save(this.state)
  }
}

export type Candidate = { id: string; createdTimestamp: number; authorId: string; authorBot: boolean }

// What to deliver from one channel: after the cursor, before the start (later ones come live), within 24 h, not a
// bot's, only the paired user's in a DM, not already delivered live; oldest first, the newest 50 when more.
export function selectRecovered(
  candidates: readonly Candidate[],
  o: { cursorId: string; cutoffMs: number; nowMs: number; selfId: string; onlyAuthor?: string; exclude?: ReadonlySet<string> },
): { take: Candidate[]; skipped: number } {
  const ok = candidates
    .filter(c => SNOWFLAKE_ID.test(c.id) && newer(c.id, o.cursorId))
    .filter(c => c.createdTimestamp < o.cutoffMs && c.createdTimestamp >= o.nowMs - BACKFILL.maxAgeMs)
    .filter(c => !c.authorBot && c.authorId !== o.selfId)
    .filter(c => o.onlyAuthor === undefined || c.authorId === o.onlyAuthor)
    .filter(c => !o.exclude?.has(c.id))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  const skipped = Math.max(0, ok.length - BACKFILL.maxPerChannel)
  return { take: ok.slice(skipped), skipped }
}

// D1: the client-wide default for every outgoing message. Users (and the replied-to user) are pinged; @everyone,
// @here and roles are never parsed, whatever text the model writes.
export const SAFE_MENTIONS: { parse: Array<'users'>; repliedUser: boolean } = { parse: ['users'], repliedUser: true }

// D2: a reply longer than this many 2000-char parts is refused before anything is sent (Hermes caps at 8 too).
export const MAX_REPLY_CHUNKS = 8

// A1: threads in allowed channels the bot has written in, so a follow-up there needs no @mention. Bounded and
// aged out; the caller only adds threads whose parent channel is opted in (Etelka 7021).
export const BOT_THREADS = { max: 500, ttlMs: 30 * 24 * 60 * 60_000 } as const

export class BotThreads {
  private readonly seen: Map<string, number>

  constructor(
    initial: Record<string, number>,
    private readonly save: (state: Record<string, number>) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.seen = new Map(Object.entries(initial).filter(([k, v]) => SNOWFLAKE_ID.test(k) && typeof v === 'number'))
    this.prune()
  }

  static parse(text: string | null): Record<string, number> {
    if (text === null) return {}
    try {
      const raw = JSON.parse(text) as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {}
    } catch {
      return {}
    }
  }

  private prune(): void {
    const cutoff = this.now() - BOT_THREADS.ttlMs
    for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k)
    while (this.seen.size > BOT_THREADS.max) this.seen.delete(this.seen.keys().next().value!)
  }

  has(threadId: string): boolean {
    const t = this.seen.get(threadId)
    return t !== undefined && t >= this.now() - BOT_THREADS.ttlMs
  }

  add(threadId: string): void {
    if (!SNOWFLAKE_ID.test(threadId)) return
    this.seen.delete(threadId)
    this.seen.set(threadId, this.now())
    this.prune()
    this.save(Object.fromEntries(this.seen))
  }
}

// A2: what the message replies to, in the meta. Newlines folded, as fetch_messages does: a multi-line quote
// must not forge adjacent attributes. The attachment list is names only.
export const REPLY_CONTEXT_MAX = 500

export function replyContextMeta(ref: { id: string; username: string; content: string; attachments: string[] }): Record<string, string> {
  const text = ref.content.replace(/[\r\n]+/g, ' ⏎ ')
  const cut = [...text].length > REPLY_CONTEXT_MAX ? [...text].slice(0, REPLY_CONTEXT_MAX).join('') + '…' : text
  return {
    reply_to_message_id: ref.id,
    reply_to_user: ref.username,
    reply_to_text: cut,
    ...(ref.attachments.length > 0 ? { reply_to_attachments: ref.attachments.join('; ') } : {}),
  }
}

// A3: a forwarded message carries its text and files in message snapshots, its own content is empty.
export function forwardedParts(snapshots: ReadonlyArray<{ content: string; attachmentCount: number }>): { text: string; attachmentCount: number } | null {
  if (snapshots.length === 0) return null
  return {
    text: snapshots.map(s => s.content.trim()).filter(Boolean).join('\n'),
    attachmentCount: snapshots.reduce((n, s) => n + s.attachmentCount, 0),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PR2 (Hermes parity): B1 role-based access, E1 liveness with an IDENTIFY-aware reconnect governor
// ---------------------------------------------------------------------------------------------------------------

// B1: per-channel extras from DISCORD_CHANNEL_POLICY (an owner-only setting; access.json's group object is
// overwritten by `/discord:access group add`, so it cannot hold them). Junk is dropped, never widened.
export type ChannelPolicy = Record<string, { allowRoles: string[]; history?: true }>

export function parseChannelPolicy(raw: unknown): ChannelPolicy {
  const out: ChannelPolicy = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [ch, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SNOWFLAKE_ID.test(ch) || !v || typeof v !== 'object') continue
    const roles = (v as { allowRoles?: unknown }).allowRoles
    const allowRoles = Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string' && SNOWFLAKE_ID.test(r)) : []
    const history = (v as { history?: unknown }).history === true // PR3 A4: only a literal true turns it on
    if (allowRoles.length > 0 || history) out[ch] = history ? { allowRoles, history } : { allowRoles }
  }
  return out
}

// Who may speak in an opted-in channel. Without roles for the channel: the upstream rule (its allowFrom, or anyone
// when that is empty). With roles: its allowFrom OR any of the roles -- an empty allowFrom no longer means anyone.
export function channelSenderAllowed(
  groupAllowFrom: readonly string[], allowRoles: readonly string[] | undefined, senderId: string, memberRoleIds: readonly string[],
): boolean {
  if (groupAllowFrom.includes(senderId)) return true
  if (allowRoles && allowRoles.length > 0) return memberRoleIds.some(r => allowRoles.includes(r))
  return groupAllowFrom.length === 0
}

// E1: when the gateway is wedged. discord.js reconnects a closed socket itself; this catches what it does not see.
// Every reconnect is a new IDENTIFY, and Discord resets a bot token after ~1000 in 24 h
// (anthropics/claude-plugins-official#1965), so the governor below is deliberately slow. Pinned by tests.
export const LIVENESS = {
  probeIntervalMs: 15_000,
  failThreshold: 2,
  heartbeatMaxLatencyMs: 30_000,
  eventSilenceMaxMs: 4 * 60 * 60_000,
  notReadyMaxMs: 2 * 60_000,
  reconnectMinIntervalMs: 5 * 60_000,
  backoffMs: [5, 10, 20, 40, 60].map(m => m * 60_000),
  backoffWindowMs: 2 * 60 * 60_000,
  maxReconnectsPer24h: 20,
} as const

export type HealthSample = { ready: boolean; notReadyForMs: number; pingMs: number; eventSilenceMs: number }

// One sample's verdict. Event silence alone is NOT bad: a quiet server goes hours without an event (Etelka 7021);
// it counts only together with a bad heartbeat. Not-ready only counts once discord.js has had time to resume.
export function assessHealth(s: HealthSample): { bad: boolean; reason: string } {
  if (!s.ready) {
    return s.notReadyForMs >= LIVENESS.notReadyMaxMs
      ? { bad: true, reason: `not ready for ${Math.round(s.notReadyForMs / 1000)} s` }
      : { bad: false, reason: 'resuming' }
  }
  const heartbeatBad = s.pingMs < 0 || s.pingMs > LIVENESS.heartbeatMaxLatencyMs
  if (heartbeatBad && s.eventSilenceMs >= LIVENESS.eventSilenceMaxMs) {
    return { bad: true, reason: `no gateway event for ${Math.round(s.eventSilenceMs / 60_000)} min and heartbeat ${s.pingMs} ms` }
  }
  if (heartbeatBad && s.pingMs > LIVENESS.heartbeatMaxLatencyMs) {
    return { bad: true, reason: `heartbeat ${s.pingMs} ms` }
  }
  return { bad: false, reason: 'ok' }
}

// Whether a reconnect may happen now: at most 20 in 24 h, never sooner than 5 min after the last, and the wait
// grows with recent reconnects (5, 10, 20, 40, 60 min). The history survives a restart (the caller persists it).
export function reconnectDecision(history: readonly number[], now: number): { allowed: boolean; waitMs: number; reason: string } {
  const day = history.filter(t => t > now - 24 * 60 * 60_000)
  if (day.length >= LIVENESS.maxReconnectsPer24h) {
    return { allowed: false, waitMs: Infinity, reason: `${day.length} reconnects in 24 h (max ${LIVENESS.maxReconnectsPer24h})` }
  }
  const recent = history.filter(t => t > now - LIVENESS.backoffWindowMs).length
  const gap = Math.max(LIVENESS.reconnectMinIntervalMs, LIVENESS.backoffMs[Math.min(recent, LIVENESS.backoffMs.length - 1)]!)
  const last = history.length > 0 ? Math.max(...history) : -Infinity
  const waitMs = Math.max(0, last + gap - now)
  return waitMs > 0 ? { allowed: false, waitMs, reason: `backoff: ${Math.ceil(waitMs / 60_000)} min left` } : { allowed: true, waitMs: 0, reason: '' }
}

// ---------------------------------------------------------------------------------------------------------------
// PR3 (Hermes parity): D3 continuous typing, A4 channel history, D8 embed + select, G1 discord_info, A5 edit/delete
// ---------------------------------------------------------------------------------------------------------------

// D3: Discord shows "typing" for ~10 s per call. It is renewed until the reply goes to that channel, at most 10 min.
export const TYPING = { intervalMs: 9_000, maxMs: 10 * 60_000 } as const

export class TypingKeeper {
  private readonly running = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private readonly now: () => number = Date.now) {}

  start(channelId: string, send: () => Promise<unknown>): void {
    this.stop(channelId)
    const fire = () => { void send().catch(() => {}) }
    fire()
    const until = this.now() + TYPING.maxMs
    const timer = setInterval(() => (this.now() >= until ? this.stop(channelId) : fire()), TYPING.intervalMs)
    ;(timer as { unref?: () => void }).unref?.()
    this.running.set(channelId, timer)
  }

  stop(channelId: string): void {
    const timer = this.running.get(channelId)
    if (timer === undefined) return
    clearInterval(timer)
    this.running.delete(channelId)
  }

  active(channelId: string): boolean {
    return this.running.has(channelId)
  }
}

// A4: when the bot is addressed in a channel that opted in ("history": true), what was said there since the bot's
// own last message, so it does not answer blind. Only senders the gate would let speak; bots never.
export const HISTORY = { fetchLimit: 50, maxMessages: 20, maxCharsPerMessage: 300 } as const

export type HistoryCandidate = { id: string; authorId: string; authorBot: boolean; username: string; content: string; createdTimestamp: number }

// The messages after our own last one, oldest first, no bots. The caller passes those fetched BEFORE the mention.
export function historyWindow(candidates: readonly HistoryCandidate[], selfId: string): HistoryCandidate[] {
  const sorted = candidates.filter(c => SNOWFLAKE_ID.test(c.id)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  let start = 0
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.authorId === selfId) { start = i + 1; break }
  }
  return sorted.slice(start).filter(c => !c.authorBot && c.authorId !== selfId)
}

// The marked block in front of the content: only the allowed senders, the newest 20, one line per message
// (newlines folded, as fetch_messages does), so a multi-line message cannot forge more rows.
export function historyBlock(window: readonly HistoryCandidate[], allowed: ReadonlySet<string>): { text: string; count: number } {
  const take = window.filter(c => allowed.has(c.authorId)).slice(-HISTORY.maxMessages)
  if (take.length === 0) return { text: '', count: 0 }
  const lines = take.map(c => `[${new Date(c.createdTimestamp).toISOString()}] ${oneLine(c.username, 100)}: ${oneLine(c.content, HISTORY.maxCharsPerMessage)}`)
  return { text: `[Recent channel messages]\n${lines.join('\n')}\n[/Recent channel messages]\n\n`, count: take.length }
}

// D8: reply's embed. Discord's limits, checked before anything is sent (an over-long embed rejects the whole send).
export const EMBED_LIMITS = { title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, total: 6000 } as const

export type EmbedData = { title?: string; description?: string; color?: number; fields?: Array<{ name: string; value: string; inline?: true }> }

const len = (t: string) => [...t].length

export function embedSpec(raw: unknown): EmbedData | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('embed must be an object')
  const r = raw as Record<string, unknown>
  const str = (k: 'title' | 'description', max: number): string | undefined => {
    const v = r[k]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string') throw new Error(`embed.${k} must be a string`)
    if (len(v) > max) throw new Error(`embed.${k} is longer than ${max} characters`)
    return v
  }
  const out: EmbedData = {}
  const title = str('title', EMBED_LIMITS.title)
  const description = str('description', EMBED_LIMITS.description)
  if (title !== undefined) out.title = title
  if (description !== undefined) out.description = description
  if (r.color !== undefined && r.color !== null) {
    if (typeof r.color !== 'number' || !Number.isInteger(r.color) || r.color < 0 || r.color > 0xffffff) throw new Error('embed.color must be an integer 0-16777215')
    out.color = r.color
  }
  if (r.fields !== undefined && r.fields !== null) {
    if (!Array.isArray(r.fields)) throw new Error('embed.fields must be an array')
    if (r.fields.length > EMBED_LIMITS.fields) throw new Error(`embed.fields: max ${EMBED_LIMITS.fields}`)
    out.fields = r.fields.map((f, i) => {
      const name = typeof f?.name === 'string' ? f.name.trim() : ''
      const value = typeof f?.value === 'string' ? f.value.trim() : ''
      if (!name || !value) throw new Error(`embed.fields[${i}]: name and value are required`)
      if (len(name) > EMBED_LIMITS.fieldName) throw new Error(`embed.fields[${i}].name is longer than ${EMBED_LIMITS.fieldName}`)
      if (len(value) > EMBED_LIMITS.fieldValue) throw new Error(`embed.fields[${i}].value is longer than ${EMBED_LIMITS.fieldValue}`)
      return f?.inline === true ? { name, value, inline: true as const } : { name, value }
    })
  }
  if (out.title === undefined && out.description === undefined && (out.fields?.length ?? 0) === 0) throw new Error('embed needs a title, a description or fields')
  const total = [out.title ?? '', out.description ?? '', ...(out.fields ?? []).flatMap(f => [f.name, f.value])].reduce((n, t) => n + len(t), 0)
  if (total > EMBED_LIMITS.total) throw new Error(`embed is ${total} characters in all (max ${EMBED_LIMITS.total})`)
  return out
}

// D8: reply's select menu. The customId is fixed; an option's value is its index, and the label the session gets
// back is looked up in the message's own component (selectedLabel), never taken from what the client sent.
export const SELECT_CUSTOM_ID = 'select:choice'
export const SELECT_LIMITS = { options: 25, label: 100, description: 100, placeholder: 150 } as const

export type SelectData = { placeholder?: string; options: Array<{ label: string; value: string; description?: string }> }

export function selectSpec(raw: unknown): SelectData | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('select must be an object')
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.options) || r.options.length === 0) throw new Error('select.options must be a non-empty array')
  if (r.options.length > SELECT_LIMITS.options) throw new Error(`select: max ${SELECT_LIMITS.options} options`)
  const seen = new Set<string>()
  const options = r.options.map((o, i) => {
    const label = typeof o?.label === 'string' ? o.label.trim() : ''
    if (!label) throw new Error(`select option ${i}: label is required`)
    if (len(label) > SELECT_LIMITS.label) throw new Error(`select option ${i}: label longer than ${SELECT_LIMITS.label} chars`)
    if (seen.has(label)) throw new Error(`select option ${i}: duplicate label "${label}"`)
    seen.add(label)
    const description = typeof o?.description === 'string' && o.description.trim() ? o.description.trim() : undefined
    if (description !== undefined && len(description) > SELECT_LIMITS.description) throw new Error(`select option ${i}: description longer than ${SELECT_LIMITS.description} chars`)
    return description === undefined ? { label, value: String(i) } : { label, value: String(i), description }
  })
  const placeholder = typeof r.placeholder === 'string' && r.placeholder.trim() ? r.placeholder.trim() : undefined
  if (placeholder !== undefined && len(placeholder) > SELECT_LIMITS.placeholder) throw new Error(`select.placeholder longer than ${SELECT_LIMITS.placeholder} chars`)
  return placeholder === undefined ? { options } : { placeholder, options }
}

// A message has at most 5 component rows: the buttons take one per 5, the select a whole row.
export const MAX_COMPONENT_ROWS = 5

export function selectedLabel(options: ReadonlyArray<{ label: string; value: string }>, values: readonly string[]): string | null {
  if (values.length !== 1) return null
  return options.find(o => o.value === values[0])?.label ?? null
}

// G1: discord_info, read-only. Every action and what it needs; nothing here writes.
export const INFO_ACTIONS = {
  list_guilds: [],
  server_info: ['guild_id'],
  list_channels: ['guild_id'],
  channel_info: ['channel_id'],
  list_roles: ['guild_id'],
  list_pins: ['channel_id'],
  member_info: ['guild_id', 'user_id'],
  search_members: ['guild_id', 'query'],
} as const satisfies Record<string, readonly string[]>

export type InfoAction = keyof typeof INFO_ACTIONS
export type InfoRequest = { action: InfoAction; guild_id?: string; channel_id?: string; user_id?: string; query?: string }

export function infoRequest(args: Record<string, unknown>): InfoRequest {
  const action = args.action
  if (typeof action !== 'string' || !Object.hasOwn(INFO_ACTIONS, action)) throw new Error(`action must be one of: ${Object.keys(INFO_ACTIONS).join(', ')}`)
  const out: Record<string, string> = { action }
  for (const k of INFO_ACTIONS[action as InfoAction] as readonly string[]) {
    const v = args[k]
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${action} needs ${k}`)
    if (k !== 'query' && !SNOWFLAKE_ID.test(v)) throw new Error(`${k} must be an id`)
    out[k] = k === 'query' ? [...v.trim()].slice(0, 100).join('') : v
  }
  return out as InfoRequest
}

export const SEARCH_MEMBERS_LIMIT = 10

// One line per item: a name or topic is user-controlled text, so newlines are folded as fetch_messages does.
export function oneLine(text: string | null | undefined, max = 200): string {
  const flat = (text ?? '').replace(/[\r\n]+/g, ' ⏎ ')
  return len(flat) > max ? [...flat].slice(0, max).join('') + '…' : flat
}

// G1 is limited to the servers the bot is actually used in: those with an opted-in channel.
export function allowedGuildIds(channelGuild: ReadonlyMap<string, string | null | undefined>): Set<string> {
  return new Set([...channelGuild.values()].filter((g): g is string => typeof g === 'string' && SNOWFLAKE_ID.test(g)))
}

// A5: message ids that reached the session, so a delete is reported only for those. Bounded, oldest dropped first.
export const DELIVERED_MAX = 1000

export class BoundedIds {
  private readonly ids = new Set<string>()

  constructor(private readonly max: number = DELIVERED_MAX) {}

  add(id: string): void {
    this.ids.delete(id)
    this.ids.add(id)
    while (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!)
  }

  // Reported once: a delete takes the id out.
  take(id: string): boolean {
    return this.ids.delete(id)
  }

  get size(): number {
    return this.ids.size
  }
}

// A5: an edit goes on only when the text changed: Discord also sends an update when a link preview appears.
// No old text (the message was not in the cache) means it is not known what changed: not passed on.
export function editWorthDelivering(oldContent: string | null | undefined, newContent: string | null | undefined): boolean {
  return typeof oldContent === 'string' && (newContent ?? '') !== oldContent
}
