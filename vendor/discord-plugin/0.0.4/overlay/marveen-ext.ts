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
