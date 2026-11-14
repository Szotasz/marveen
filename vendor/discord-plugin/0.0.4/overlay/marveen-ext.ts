// Marveen's additions to the Discord channel plugin (DCEXT1111). Plain logic, no discord.js import: server.ts
// wires it in, the tests (src/__tests__/discord-plugin-ext.test.ts) run it directly. Settings come from
// marveen-ext.json, written next to server.ts by scripts/patch-discord-plugin.py at every channel start.
import { readFileSync } from 'fs'
import { join } from 'path'

export type ExtConfig = { ownerUserId: string; backfill: boolean }

const SNOWFLAKE = /^[1-9][0-9]{16,19}$/

// A missing or unreadable file means the safe side: nobody named, no backfill.
export function loadExtConfig(dir: string): ExtConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'marveen-ext.json'), 'utf8')) as Record<string, unknown>
    const owner = typeof raw?.ownerUserId === 'string' && SNOWFLAKE.test(raw.ownerUserId) ? raw.ownerUserId : ''
    return { ownerUserId: owner, backfill: raw?.backfill === true }
  } catch {
    return { ownerUserId: '', backfill: false }
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
