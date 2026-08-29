import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, lstatSync, symlinkSync, rmSync, realpathSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { OLLAMA_URL } from '../config.js'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import {
  paneLooksIdle,
  decideSubmitFollowup,
  shouldClearTruncatedPreamble,
  detectsPastePlaceholder,
  detectPaneState,
  parkedInputText,
  parkedInputRowCount,
  parkedClearSequence,
  stripGhostSuggestion,
  stripSessionTitleBanner,
  stripAllAnsi,
  paneShowsContextSaturation,
  idleConsideringDimGhost,
  detectsFirstRunGate,
  detectsModelConsentDialog,
  type FirstRunGateKind,
} from '../pane-state.js'
import { agentDir, listAgentNames, readAgentModel, readAgentClaudeConfigDir, readAgentClaudePlan, readAgentChannelProvider, readAgentAuthMode, readAgentDisplayName, readAgentRemoteConfig, readAgentRemoteHost, readAgentMemoryIsolation } from './agent-config.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { provisionMemoryBoundaryDir } from './memory-boundary.js'
import { renameSharedCredentialsIfSafe } from './claude-credentials-guard.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { withSessionSendLock, tryAcquireSessionSendLane, type SendLockMode } from './session-send-lock.js'
import {
  buildTmuxInvocation,
  buildSshExec,
  buildRemoteLaunchCommand,
  buildContinueProbeCommand,
  classifyRunState,
  classifyRunStateFromExit,
  sessionInList,
  ensureControlDir,
  cleanStaleSshSockets,
  type AgentRunState,
} from './ssh-tmux.js'
import { parseTelegramToken } from './telegram.js'
import { getProvider, getProviderType, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { CHANNEL_PROVIDER, MAIN_AGENT_ID, STORE_DIR, PROJECT_ROOT, SUBAGENT_INBOX_TEE } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { loadProfileTemplate } from './profiles.js'
import { resolveAgentSecurityProfile } from './agent-team.js'
import { writeAgentSettingsFromProfile, ensureFleetRosterSection, ensureAutonomySection, ensureSkillsPathTrapSection } from './agent-scaffold.js'
import { schedulePluginUnlockAfterRespawn } from './channel-plugin-unlock.js'
import { recordInjectedPrompt } from './injected-prompt-registry.js'
import { getSecret } from './vault.js'
import { resolveOpenRouterModel } from './openrouter-models.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { notifyChannel } from '../notify.js'

// Lazy so a transient PATH gap at import time (e.g. the 04:00 auto-update
// restart, where the finalizer omits the bin dir from PATH) cannot hard-crash
// the dashboard boot and take the scheduler down with it. Resolution happens on
// first use; see makeLazyBinResolver.
const tmuxBin = makeLazyBinResolver('tmux')
const claudeBin = makeLazyBinResolver('claude')

// Shared async pacing helper. Replaces the blocking synchronous `/bin/sleep`
// (execFileSync) pauses in the tmux-driving injection hot-path so a pacing wait
// no longer parks the libuv event loop (the dashboard-accepts-TCP-but-never-
// services-HTTP-under-load starvation). Never throws.
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

import { CHANNEL_PLUGIN_IDS } from './plugin-ids.js'
export { CHANNEL_PLUGIN_IDS }

// Pure: compute the enabledPlugins map for a sub-agent so that exactly its own
// channel plugin is enabled and every other channel plugin is disabled.
// Non-channel plugins in `existing` are preserved untouched.
//
// `explicitProvider` MUST be the agent's EXPLICIT per-agent channelProvider
// (readAgentChannelProvider), or null when unset -- NOT the resolved provider.
// resolveAgentProvider() defaults an agent with no channelProvider to the global
// CHANNEL_PROVIDER (telegram), and a legacy-token fallback then marks it
// hasChannel -- so EVERY channel-less sub-agent (boni/deeper/iris/zara/samu) is
// launched with --channels plugin:telegram and would keep the dup poller. Keying
// on the EXPLICIT provider means a channel-less agent (null) disables all three;
// only an agent that genuinely declares its channel (e.g. slacker=slack) keeps
// its own plugin.
export function scopeChannelPlugins(
  explicitProvider: string | null,
  existing?: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...(existing ?? {}) }
  const ownPlugin = explicitProvider ? CHANNEL_PLUGIN_IDS[explicitProvider as keyof typeof CHANNEL_PLUGIN_IDS] : undefined
  for (const pid of Object.values(CHANNEL_PLUGIN_IDS)) {
    out[pid] = pid === ownPlugin
  }
  return out
}

// Pure: which channel provider a sub-agent should ENABLE the plugin for at spawn.
// The enable decision MUST match the --channels launch gate, which is the
// presence of a REAL own bot token in the agent's own channel .env (hasOwnToken).
// Spawn-time scoping originally keyed enabledPlugins on the EXPLICIT channelProvider
// config field, but that field is null for every sub-agent (none set it) -- so a
// sub-agent with a genuine own token still got its plugin forced off: --channels
// loaded it, yet enabledPlugins:false made Claude Code refuse to register it (no
// MCP entry, no bun poller, no bot.pid -> dead bot after any respawn). Gating on
// the own token keeps the dup-poller intent: a channel-less agent (no own token,
// only the legacy/global-token fallback that still marks hasChannel) returns null,
// so scopeChannelPlugins(null) disables all three and it never fights the main
// agent over the shared getUpdates slot.
export function ownChannelProviderForScope(
  hasOwnToken: boolean,
  resolvedProvider: string | null,
): string | null {
  return hasOwnToken && resolvedProvider ? resolvedProvider : null
}

// Wrap the telegram plugin's bun stdio server in a tee that persists each
// inbound channel notification to <stateDir>/inbox-pending.jsonl, which the
// channel-inbox-drain UserPromptSubmit hook then pulls into the next turn.
// Sub-agents load the plugin as a plain MCP server, so Claude Code drops its
// channel notifications; this tee is what makes SUBAGENT_TELEGRAM_WAKE_ENABLED
// have an inbox to wake on.
export function buildTelegramMcpServerConfig(bunBin: string, pluginDir: string, stateDir: string) {
  const wrapper = join(PROJECT_ROOT, 'scripts', 'channel-inbound-tee.mjs')
  return {
    command: 'node',
    args: [wrapper, bunBin, 'run', '--cwd', pluginDir, '--shell=bun', '--silent', 'start'],
    env: { TELEGRAM_STATE_DIR: stateDir },
  }
}

// The fleet's shared long-lived OAuth token (from `claude setup-token`), stored
// 0600 in store/. Isolated channel sub-agents authenticate via this token in the
// CLAUDE_CODE_OAUTH_TOKEN env var -- NOT via a copied/symlinked .credentials.json.
// See ensureIsolatedChannelConfigDir for why.
export const FLEET_OAUTH_TOKEN_PATH = join(STORE_DIR, '.claude-oauth-token')

// True when the fleet OAuth token file exists and is non-empty. Provisioning an
// isolated config dir WITHOUT auth would launch the sub-agent logged-out, so
// isolation is gated on this: no token -> keep the shared ~/.claude (degraded
// dup-poller risk, but never a broken login).
export function hasFleetOauthToken(): boolean {
  try {
    return existsSync(FLEET_OAUTH_TOKEN_PATH) && readFileSync(FLEET_OAUTH_TOKEN_PATH, 'utf-8').trim().length > 0
  } catch {
    return false
  }
}

// H1 silent-degradation hardening (2026-06-30, refined 2026-07-10).
//
// When the fleet OAuth token is absent, channel sub-agents skip isolation and
// fall back to the SHARED ~/.claude (the pre-isolation behaviour, gated in
// startAgentProcess). ONE channel sub-agent on the shared dir is harmless -- it
// owns the single plugin-install slot and poller. The collision the alert
// guards against needs TWO OR MORE agents actually contending for the SAME
// provider's plugin slot at the same time (only one registers its plugin, the
// rest go deaf -- see ensureIsolatedChannelConfigDir).
//
// 2026-07-10 refinement -- the original check over-triggered ("cried wolf"):
//   - It counted CONFIGURED channel sub-agents. An agent that is not running
//     cannot contend for anything: 6 configured / 2 running must not read as
//     a 6-way collision.
//   - It counted across providers. Plugin installs are keyed per plugin id
//     (telegram/slack/teams/... are separate slots in installed_plugins.json),
//     so a running Teams agent never collides with running Telegram agents.
//   - On macOS the collision does not manifest (verified empirically
//     2026-07-10 on the origin host: three concurrent telegram pollers --
//     main + two sub-agents, distinct own tokens, a live `bun server.ts`
//     each, all on the shared ~/.claude while the installed_plugins.json
//     telegram slot pointed at a THIRD agent's projectPath). Channel agents
//     always launch fresh with an explicit --channels plugin:<id> flag, which
//     loads the plugin regardless of the project-scoped install slot; and
//     macOS auth lives in the Keychain, so the Linux credentials-refresh
//     motive for isolation does not apply either. The guard is
//     process.platform-based -- nothing host-specific is baked into this
//     distribution artifact. On Linux/other the alert stays: the shared-config
//     multi-bot eviction remains the documented failure mode there and has
//     not been empirically cleared. If a real macOS collision is ever
//     observed again, drop the darwin early-return.
//
// The decision stays pure (token, same-provider contender count, platform) so
// it is unit-tested without I/O, mirroring shouldSendDeferAlert. Token PRESENT
// -> isolation works -> never alerts, regardless of agent count.
export function shouldAlertSharedConfigCollision(
  hasToken: boolean,
  sameProviderContenderCount: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'darwin') return false
  return !hasToken && sameProviderContenderCount > 1
}

// Pure: the largest number of channel sub-agents contending for a single
// provider's plugin slot. Only RUNNING agents with a channel of their own
// count; agents on different providers occupy different slots and never
// collide with each other.
export function maxSameProviderContenders(
  agents: Array<{ provider: string; running: boolean; hasChannel: boolean }>,
): number {
  const counts = new Map<string, number>()
  for (const a of agents) {
    if (!a.running || !a.hasChannel) continue
    counts.set(a.provider, (counts.get(a.provider) ?? 0) + 1)
  }
  return counts.size ? Math.max(...counts.values()) : 0
}

// Same-provider contender count for the fleet (main agent excluded -- it comes
// up via channels.sh and keeps the shared root by design). Uses the same
// own-token signal as the launch path. `startingName` is the agent being
// spawned right now: its tmux session does not exist yet at alert time, so it
// is treated as running -- otherwise the very launch that completes a real
// collision would never see itself in the count.
export function countSameProviderChannelContenders(startingName: string): number {
  return maxSameProviderContenders(
    listAgentNames()
      .filter((n) => n !== MAIN_AGENT_ID)
      .map((n) => ({
        provider: resolveAgentProvider(n),
        running: n === startingName || agentRunState(n) === 'running',
        hasChannel: agentHasChannel(n),
      })),
  )
}

// One operator alert per degradation episode: spamming on every spawn would
// bury the signal. Cleared the moment the token reappears (isolation restored),
// so a later token-loss re-alerts. Process-local, like defer-alert's dedup set.
let sharedConfigCollisionAlerted = false

export function resetSharedConfigCollisionAlert(): void {
  sharedConfigCollisionAlerted = false
}

// Loud, owner-facing alert routed via notifyChannel (direct Bot API POST from
// the dashboard process) -- NOT an inter-agent relay, which would itself need a
// healthy channel agent to deliver. No-op unless the token is absent AND >1
// RUNNING same-provider channel sub-agent would share ~/.claude (and never on
// macOS -- see shouldAlertSharedConfigCollision).
function maybeAlertSharedConfigCollision(name: string): void {
  const count = countSameProviderChannelContenders(name)
  if (!shouldAlertSharedConfigCollision(false, count) || sharedConfigCollisionAlerted) return
  sharedConfigCollisionAlerted = true
  logger.error(
    { name, sameProviderContenders: count },
    'isolated-config: fleet OAuth token missing with multiple RUNNING same-provider channel sub-agents -- shared ~/.claude plugin-slot collision, bots may go deaf',
  )
  void notifyChannel(
    `⚠️ Flotta-figyelmeztetes: hianyzik a fleet OAuth token (store/.claude-oauth-token), es ${count} AZONOS csatorna-providerü sub-agent fut egyszerre. Izolacio nelkul mind a kozos ~/.claude-ot hasznalja, igy a plugin-slot utkozhet es bot nemulhat el. Javitas: futtasd a \`claude setup-token\`-t, mentsd a store/.claude-oauth-token fajlba, majd inditsd ujra az agenseket.`,
  ).catch(() => { /* notifyChannel logs internally */ })
}

// Per-agent isolated CLAUDE_CONFIG_DIR provisioning (2026-06-26 fleet outage).
//
// Claude Code records a plugin's PROJECT-scoped install in a single shared file
// -- ~/.claude/plugins/installed_plugins.json -- keyed by ONE projectPath per
// plugin id. Every sub-agent ran out of the SAME ~/.claude, so each agent launch
// (claude --channels plugin:telegram@...) rewrote that single slot to its OWN
// project, evicting whichever agent registered before it. Net effect: only ONE
// agent's channel plugin could be registered (one bun getUpdates poller / one
// bot.pid) fleet-wide; every other agent saw "No MCP servers configured", spawned
// no poller, and went deaf. Sequentialising restarts did NOT help (the slot is
// shared state, not a startup race); the only structural fix is to stop the
// agents sharing one plugin-install file.
//
// This gives each channel sub-agent its own CLAUDE_CONFIG_DIR: symlink every
// top-level ~/.claude entry so project transcripts and plugin marketplaces stay
// shared, EXCEPT settings.json and plugins/ which become per-agent (so each
// agent's project-scoped install lives in its own installed_plugins.json and can
// never evict another's).
//
// AUTH (2026-06-28, addressing Szotasz's #459 review): we DELIBERATELY do NOT
// symlink or copy .credentials.json. On Linux/Windows Claude Code refreshes the
// OAuth token atomically (temp file + rename), which would replace a symlink with
// a standalone file -- the isolated agent's token then diverges from the shared
// one, and because OAuth refresh tokens are single-use, concurrent refreshes from
// multiple isolated dirs race and break the shared login (confirmed: claude-code
// issues #27933, #24317, #43392). Instead the launcher passes a long-lived
// CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, ~1y, no refresh) via env.
// With that env var present Claude Code authenticates from it and writes NO
// .credentials.json into the config dir -- so there is nothing to diverge and no
// refresh race. .credentials.json is therefore in the skip set below.
//
// Idempotent and best-effort: returns the dir on success, or null so the caller
// falls back to the shared ~/.claude (degraded, but never a launch failure).
const ISOLATED_CONFIG_SKIP = new Set(['settings.json', 'plugins', '.credentials.json'])

export function ensureIsolatedChannelConfigDir(
  name: string,
  // null = channel-less agent: provision the isolated dir with EVERY channel
  // plugin disabled (scopeChannelPlugins(null)) instead of enabling one.
  providerType: ChannelProviderType | null,
): string | null {
  return provisionIsolatedConfigDir(join(agentDir(name), '.claude-config'), agentDir(name), providerType, name)
}

// The main channels agent (started by scripts/channels.sh, cwd = PROJECT_ROOT)
// normally keeps the shared ~/.claude by design. That means it authenticates
// from whatever on-process credential refreshes that shared root -- the
// ROTATING macOS Keychain OAuth session, or (Linux) the shared
// ~/.claude/.credentials.json, which self-refreshes on its own ~8h cycle --
// either way, a periodic-401 risk: the refresh can hit a transient error and
// never retry, and Claude Code prefers an on-disk .credentials.json over an
// otherwise-valid CLAUDE_CODE_OAUTH_TOKEN env var (claude-credentials-guard.ts),
// so a stale file wins even with a live token sitting right next to it
// (confirmed root cause of the 2026-07-23 marveen-channels silent outage,
// PLAN.md GAP 1). The isolated sub-agents, which authenticate from the
// long-lived fleet setup-token via an isolated CLAUDE_CONFIG_DIR carrying no
// .credentials.json at all, never hit this. This gives the main agent the SAME
// isolated CLAUDE_CONFIG_DIR as the sub-agents so it too authenticates from
// CLAUDE_CODE_OAUTH_TOKEN and never touches a rotating on-disk credential.
//
// Deliberately narrow and OPT-IN (default OFF), so nothing changes for existing
// installs unless the operator turns it on:
//   - any platform -- the provisioning itself (provisionIsolatedConfigDir) is
//     100% filesystem-based and already proven identical on every platform via
//     the sub-agent path; there is no macOS-specific step here. This does NOT
//     touch shouldAlertSharedConfigCollision's darwin early-return (a different,
//     genuinely macOS-specific failure mode: plugin-slot collision).
//   - gated on the MAIN_AGENT_ISOLATED_CONFIG setting via the settings-store, so
//     BOTH the dashboard toggle (config-overrides.json) AND a hand-set .env key
//     take effect (resolution: override > .env > default '0'). channels.sh no
//     longer parses the flag itself -- it always calls the helper and this
//     function is the single gate.
//   - gated on the fleet OAuth token (no token -> no isolation, since the
//     isolated dir carries no .credentials.json -- identical gate to the
//     sub-agent path in startAgentProcess);
//   - returns null (caller keeps the shared root) whenever not applicable.
export function ensureMainAgentIsolatedConfigDir(
  provider?: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let enabled = false
  try { enabled = String(getEffectiveSettingValue('MAIN_AGENT_ISOLATED_CONFIG')) === '1' } catch { enabled = false }
  if (!enabled) return null
  if (!hasFleetOauthToken()) return null
  return provisionIsolatedConfigDir(
    join(PROJECT_ROOT, '.channels-config'),
    PROJECT_ROOT,
    getProviderType(provider),
    MAIN_AGENT_ID,
  )
}

// An EXPLICIT config dir for the main channels agent (MAIN_AGENT_CONFIG_DIR),
// for the operator who already keeps a separate Claude login for the main bot --
// e.g. a personal subscription for the bot and a different one for the fleet.
// The isolated-config path above cannot serve that case: it provisions a dir with
// NO .credentials.json and authenticates from the fleet setup-token, so the main
// agent necessarily shares the fleet's identity, and it is a hard no-op without
// that token. Pointing CLAUDE_CONFIG_DIR at an existing, separately logged-in dir
// is the only way to keep the two identities apart.
//
// Fails closed: unset -> null (shared ~/.claude, unchanged default); set but
// missing on disk -> null + a warn, because silently falling back to the shared
// root with the WRONG identity is how a bot ends up authenticated as the fleet.
// Takes precedence over MAIN_AGENT_ISOLATED_CONFIG: an explicit dir is a
// deliberate choice, and the two cannot both own CLAUDE_CONFIG_DIR.
export function resolveMainAgentConfigDir(): string | null {
  let raw = ''
  try { raw = String(getEffectiveSettingValue('MAIN_AGENT_CONFIG_DIR') ?? '').trim() } catch { return null }
  if (!raw) return null
  const dir = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  if (!existsSync(dir)) {
    logger.warn({ dir }, 'main-agent config dir: MAIN_AGENT_CONFIG_DIR does not exist, keeping the shared ~/.claude')
    return null
  }
  return dir
}

// Shared provisioning core for BOTH the sub-agents (ensureIsolatedChannelConfigDir)
// and the main agent (ensureMainAgentIsolatedConfigDir) -- one code path so the
// two can never diverge. `cfg` is the isolated CLAUDE_CONFIG_DIR to create; `cwd`
// is the agent's project dir stamped into its own installed_plugins.json; `name`
// is used for logs only.
// Write JSON through a temp file + rename, so a Claude Code process reading
// the file concurrently sees either the old content or the new one, never a
// half-written one. The temp name carries the pid so two provisions racing on
// the same dir cannot truncate each other's staging file.
//
// The mode is carried over deliberately. A plain writeFileSync writes THROUGH
// the existing inode and keeps its permissions; tmp + rename replaces the file
// with a NEW inode, which would silently take the umask default and relax an
// 0600 config to 0644. That matters here: some isolated .claude.json files are
// 0600, and their mcpServers entries carry env blocks with credentials -- and
// this reconcile is exactly the path that starts rewriting the file regularly.
// Fall back to 0600 (not the umask) when the target does not exist yet, since
// the content class is the same either way.
function writeJsonAtomic(path: string, value: unknown): void {
  let mode = 0o600
  try { mode = statSync(path).mode & 0o777 } catch { /* new file -> owner-only */ }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode })
  renameSync(tmp, path)
}

// Fill mcpServers gaps in an ALREADY provisioned isolated .claude.json from the
// shared ~/.claude.json.
//
// Why this exists (issue #834): the isolated .claude.json is seeded from a full
// copy of the shared one ONLY on first provision. Every later spawn just makes
// sure hasCompletedOnboarding stays set, so the server list is frozen at its
// first-seed snapshot -- an MCP server added to ~/.claude.json afterwards
// reaches brand-new agents but never an existing one, silently: the agent just
// lacks the tool, with no error anywhere. Rolling one out to a running fleet
// then needs a manual per-agent backfill, and that only fixes the current set.
//
// ADDITIVE ONLY, deliberately. This is a gap-fill, not a two-way sync:
//   - a server missing from the isolated file is copied in,
//   - an entry that already exists is NEVER overwritten -- Claude Code owns its
//     evolved state, and a per-agent scoping decision must survive,
//   - a server removed from the shared config is left in place,
//   - a non-object mcpServers on either side means we do not touch it at all,
//     because we cannot merge what we do not understand.
// Returns true if the caller should persist `cur`.
function reconcileMcpServers(
  cur: Record<string, unknown>,
  sharedDot: string,
  name: string,
): boolean {
  if (!existsSync(sharedDot)) return false
  let shared: Record<string, unknown>
  try { shared = JSON.parse(readFileSync(sharedDot, 'utf-8')) as Record<string, unknown> }
  catch { return false } // unparseable shared config -> leave the isolated one alone
  if (!isPlainObject(shared.mcpServers)) return false
  // An existing but non-object mcpServers is not ours to repair.
  if ('mcpServers' in cur && !isPlainObject(cur.mcpServers)) {
    logger.warn({ name }, 'isolated-config: mcpServers is not an object, skipping reconcile')
    return false
  }
  const own = isPlainObject(cur.mcpServers) ? cur.mcpServers : {}
  const added: string[] = []
  for (const [key, def] of Object.entries(shared.mcpServers)) {
    if (key in own) continue
    own[key] = def
    added.push(key)
  }
  if (added.length === 0) return false
  cur.mcpServers = own
  logger.info({ name, added }, 'isolated-config: added missing MCP servers from the shared config')
  return true
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function provisionIsolatedConfigDir(
  cfg: string,
  cwd: string,
  providerType: ChannelProviderType | null,
  name: string,
): string | null {
  try {
    const realClaude = join(homedir(), '.claude')
    if (!existsSync(realClaude)) return null
    mkdirSync(cfg, { recursive: true })

    // 1. Symlink every top-level ~/.claude entry except the ones we own or that
    //    must stay out of the isolated dir (.credentials.json -- see header). A
    //    stale non-symlink (e.g. a prior copy, or a .credentials.json left by an
    //    earlier build) is removed so it can never shadow the env-var auth.
    for (const entry of readdirSync(realClaude)) {
      if (ISOLATED_CONFIG_SKIP.has(entry)) {
        // Defensively drop a real .credentials.json that an older build may have
        // symlinked/copied here, so the env-var token is the only auth source.
        const stale = join(cfg, entry)
        if (entry === '.credentials.json') {
          try { rmSync(stale, { force: true }) } catch { /* absent */ }
        }
        continue
      }
      const link = join(cfg, entry)
      let needsLink = true
      try {
        if (lstatSync(link).isSymbolicLink()) needsLink = false
        else rmSync(link, { recursive: true, force: true })
      } catch { /* absent -> create */ }
      if (needsLink) {
        try { symlinkSync(join(realClaude, entry), link) }
        catch (err) { logger.warn({ err, entry, name }, 'isolated-config: symlink failed') }
      }
    }

    // 2. Own settings.json: copy the shared one (keeps hooks etc.) but force
    //    enabledPlugins to this agent's own provider only (all other channel
    //    plugins false), matching the spawn-time scope decision.
    const sharedSettings = join(realClaude, 'settings.json')
    let settings: Record<string, unknown> = {}
    if (existsSync(sharedSettings)) {
      try { settings = JSON.parse(readFileSync(sharedSettings, 'utf-8')) as Record<string, unknown> }
      catch { settings = {} }
    }
    const scopedPlugins = scopeChannelPlugins(
      providerType,
      settings.enabledPlugins as Record<string, boolean> | undefined,
    )
    settings.enabledPlugins = scopedPlugins
    // Keys the isolated file already carries that the shared file never
    // mentions must SURVIVE this rewrite. The rewrite runs on every main-agent
    // start, so a straight copy silently drops agent-only configuration. That
    // is how `statusLine` went missing three times (2026-07-28, 07-30, 08-03):
    // it is configured for the main agent alone, the shared file never names
    // it, and the symptom is invisible -- the agent starts fine, it just stops
    // reporting context usage, so nothing alerts.
    //
    // Shared wins on conflict: for every key the shared file DOES define it
    // stays the source of truth (that is the point of the copy). Target-only
    // keys are purely additive, so this cannot resurrect a key the shared file
    // deliberately changed.
    //
    // Scope: this is the shared provisioning core, so the change applies to
    // EVERY isolated config dir -- the main agent's and each sub-agent's alike
    // (ensureIsolatedChannelConfigDir and ensureMainAgentIsolatedConfigDir both
    // land here). There is no pre-existing merge anywhere to be consistent
    // with: before this commit every one of them was a pure copy.
    //
    // enabledPlugins is explicitly never inherited -- it is decided by the
    // scope call above and must not survive from the dir's own older copy.
    const ownSettingsPath = join(cfg, 'settings.json')
    if (existsSync(ownSettingsPath)) {
      try {
        const own = JSON.parse(readFileSync(ownSettingsPath, 'utf-8')) as unknown
        // A JSON array or `null` parses fine but is not a settings object;
        // spreading one would invent numeric keys instead of failing.
        if (isPlainObject(own)) {
          const inherited: string[] = []
          for (const [key, value] of Object.entries(own)) {
            if (key !== 'enabledPlugins' && !(key in settings)) {
              settings[key] = value
              inherited.push(key)
            }
          }
          // Additive merges must not be silent: the whole point of this block
          // is that a key nobody can see is a key nobody can debug. Key NAMES
          // only -- a settings.json may hold secrets, so values never land in
          // the log.
          if (inherited.length) {
            logger.info({ name, path: ownSettingsPath, keys: inherited }, 'isolated-config: kept target-only settings keys')
          }
        }
      } catch (err) {
        // Deliberately loud: rewriting an unparseable own-settings file from
        // the shared one is exactly the silent-loss shape this block fixes.
        logger.warn({ err, name, path: ownSettingsPath }, 'isolated-config: unparseable own settings.json, rewriting from shared')
      }
    }
    // Atomic: the file's CONTENT now depends on reading its own previous
    // content back. A torn write would fail the parse on the next start, the
    // code would fall back to the shared file, and that is precisely the
    // key-loss this commit fixes.
    writeJsonAtomic(ownSettingsPath, settings)

    // 3. Own plugins/ dir: symlink the heavy shared parts, own the install state.
    const pluginsDir = join(cfg, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const sharedPlugins = join(realClaude, 'plugins')
    for (const sub of ['cache', 'marketplaces', 'data']) {
      const link = join(pluginsDir, sub)
      const target = join(sharedPlugins, sub)
      if (!existsSync(target)) continue
      let needsLink = true
      try {
        if (lstatSync(link).isSymbolicLink()) needsLink = false
        else rmSync(link, { recursive: true, force: true })
      } catch { /* absent -> create */ }
      if (needsLink) {
        try { symlinkSync(target, link) }
        catch (err) { logger.warn({ err, sub, name }, 'isolated-config: plugin symlink failed') }
      }
    }
    const sharedKnown = join(sharedPlugins, 'known_marketplaces.json')
    if (existsSync(sharedKnown)) {
      writeFileSync(join(pluginsDir, 'known_marketplaces.json'), readFileSync(sharedKnown, 'utf-8'))
    }
    // Seed installed_plugins.json with every project-scoped install re-pointed at
    // THIS agent's cwd, so the channel plugin is registered for this project from
    // first launch (Claude Code keeps maintaining it thereafter).
    const sharedInstalled = join(sharedPlugins, 'installed_plugins.json')
    if (existsSync(sharedInstalled)) {
      try {
        const inst = JSON.parse(readFileSync(sharedInstalled, 'utf-8')) as {
          plugins?: Record<string, Array<{ scope?: string; projectPath?: string }>>
        }
        for (const entries of Object.values(inst.plugins ?? {})) {
          for (const e of entries) {
            if (e.scope === 'project') e.projectPath = cwd
          }
        }
        writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify(inst, null, 2) + '\n')
      } catch (err) {
        logger.warn({ err, name }, 'isolated-config: failed to seed installed_plugins.json')
      }
    }

    // 4. Seed onboarding/consent state so the FIRST interactive launch of this
    //    fresh CLAUDE_CONFIG_DIR does not drop into Claude Code's first-run
    //    dialogs. A brand-new config dir triggers a CHAIN of interactive prompts
    //    -- "Select login method" (gated on hasCompletedOnboarding) and the
    //    per-project "allow external imports" trust dialog (gated on
    //    projects[cwd].hasTrustDialogAccepted) -- each of which blocks the
    //    channels TUI before it ever authenticates from CLAUDE_CODE_OAUTH_TOKEN
    //    (the env token works headlessly but the interactive pickers bypass it).
    //    Rather than enumerate every flag (the set grows across Claude Code
    //    versions; confirmed on 2.1.195, 2026-06-29 fleet rollout), seed the
    //    isolated .claude.json from a COPY of the already-consented shared
    //    ~/.claude.json on first provision, so every consent flag is inherited.
    //    Only seed when absent -- once Claude Code owns the file we leave its
    //    evolved state alone, just guaranteeing hasCompletedOnboarding stays set.
    try {
      const dotClaude = join(cfg, '.claude.json')
      const sharedDot = join(homedir(), '.claude.json')
      if (!existsSync(dotClaude)) {
        let seed: Record<string, unknown> = { hasCompletedOnboarding: true }
        if (existsSync(sharedDot)) {
          try { seed = JSON.parse(readFileSync(sharedDot, 'utf-8')) as Record<string, unknown> } catch { /* keep minimal */ }
        }
        seed.hasCompletedOnboarding = true
        writeJsonAtomic(dotClaude, seed)
      } else {
        try {
          const cur = JSON.parse(readFileSync(dotClaude, 'utf-8')) as Record<string, unknown>
          let dirty = false
          if (cur.hasCompletedOnboarding !== true) {
            cur.hasCompletedOnboarding = true
            dirty = true
          }
          if (reconcileMcpServers(cur, sharedDot, name)) dirty = true
          if (dirty) writeJsonAtomic(dotClaude, cur)
        } catch { /* unparseable -> leave for Claude Code to recreate */ }
      }
    } catch (err) {
      logger.warn({ err, name }, 'isolated-config: failed to seed onboarding state')
    }

    return cfg
  } catch (err) {
    logger.warn({ err, name }, 'isolated-config: provisioning failed, falling back to shared ~/.claude')
    return null
  }
}

// Guarantee hasCompletedOnboarding in the SHARED ~/.claude.json.
//
// 2026-07-15 bootcamp field incident (root-caused live on the reference VPS):
// the key vanished from ~/.claude.json within ~1h of install despite
// install-linux.sh seeding it, so EVERY fresh (re)spawn of an agent on the
// shared config root parked on Claude Code's first-run "Select login method"
// picker -- looking exactly like a mass /login ejection -- while the on-disk
// credential was valid the whole time (the picker is gated ONLY on this flag;
// even a valid CLAUDE_CODE_OAUTH_TOKEN env does not bypass it, see the
// provisionIsolatedConfigDir comment above). Isolated config dirs already get
// this guarantee at provision time; this closes the same gap for the shared
// root. Called before every main-session respawn and sub-agent launch.
//
// The write is ATOMIC (tmp + rename): a non-atomic rewrite racing a live
// Claude Code process is the leading suspect for how the key got clobbered in
// the first place. An unparseable file is left alone -- Claude Code owns its
// recovery, and overwriting would destroy MCP/project state.
export function ensureSharedClaudeOnboarded(dotClaudePath: string = join(homedir(), '.claude.json')): boolean {
  try {
    if (!existsSync(dotClaudePath)) {
      atomicWriteFileSync(dotClaudePath, JSON.stringify({ hasCompletedOnboarding: true }, null, 2) + '\n', { mode: 0o600 })
      logger.info({ dotClaudePath }, 'shared-config: created ~/.claude.json with hasCompletedOnboarding')
      return true
    }
    const cur = JSON.parse(readFileSync(dotClaudePath, 'utf-8')) as Record<string, unknown>
    if (cur.hasCompletedOnboarding === true) return false
    cur.hasCompletedOnboarding = true
    atomicWriteFileSync(dotClaudePath, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
    logger.warn({ dotClaudePath }, 'shared-config: re-seeded missing hasCompletedOnboarding (prevents the first-run "Select login method" picker)')
    return true
  } catch (err) {
    logger.warn({ err, dotClaudePath }, 'shared-config: could not guarantee hasCompletedOnboarding (unparseable or unwritable ~/.claude.json)')
    return false
  }
}

// Pre-accept the PER-PROJECT first-run consent for an agent's working dir in
// the config root the session will boot from. Claude Code keys the "Do you
// trust the files in this folder?" dialog on projects[<cwd>].hasTrustDialogAccepted
// in <config root>/.claude.json -- a GLOBAL hasCompletedOnboarding does not
// cover it. The main session gets this via the channels.sh startup guard and
// the generation workers stamp it themselves (agent-worker.ts), but a normal
// sub-agent launch never did: on the ORIGIN fleet every agents/<name> dir was
// trusted interactively long ago, so the gap only bites on a FRESH install,
// where every newly created agent parks on the trust dialog forever and its
// scheduled tasks pile up as pending retries (Oligo2000 VPS, 2026-07-22).
//
// Stamps both the given dir and its realpath (macOS /var vs /private/var,
// symlinked homes) since Claude Code keys trust by the resolved path. Write is
// atomic and only performed on actual change, so a live Claude Code process
// racing us never sees a torn file and an already-stamped launch is a no-op.
export function stampProjectTrustForDir(dotClaudePath: string, projectDir: string): boolean {
  try {
    let data: Record<string, unknown> = {}
    if (existsSync(dotClaudePath)) {
      data = JSON.parse(readFileSync(dotClaudePath, 'utf-8')) as Record<string, unknown>
    }
    const dirs = new Set<string>([projectDir])
    try { dirs.add(realpathSync(projectDir)) } catch { /* dir may not resolve yet */ }
    const projects: Record<string, unknown> =
      (data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects))
        ? data.projects as Record<string, unknown>
        : {}
    let changed = false
    if (data.hasCompletedOnboarding !== true) {
      data.hasCompletedOnboarding = true
      changed = true
    }
    for (const dir of dirs) {
      const base = (projects[dir] && typeof projects[dir] === 'object')
        ? projects[dir] as Record<string, unknown>
        : {}
      if (base.hasTrustDialogAccepted === true && base.hasCompletedProjectOnboarding === true) continue
      projects[dir] = {
        ...base,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: Math.max(1, Number(base.projectOnboardingSeenCount) || 0),
      }
      changed = true
    }
    if (!changed) return false
    data.projects = projects
    atomicWriteFileSync(dotClaudePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    logger.info({ dotClaudePath, projectDir }, 'project-trust: stamped folder-trust consent for agent dir')
    return true
  } catch (err) {
    // Unparseable/unwritable file: leave it to Claude Code (same policy as
    // ensureSharedClaudeOnboarded). The scheduler's first-run gate + the
    // channel-monitor's dialog answering remain the runtime backstop.
    logger.warn({ err, dotClaudePath, projectDir }, 'project-trust: could not stamp trust flags (agent may park on the folder-trust dialog)')
    return false
  }
}

// Pre-stamp the Fable overage-consent acknowledgment in a config root's
// .claude.json so the "Fable 5 now uses usage credits" dialog never renders.
//
// Root cause chain (2026-07-23, card b71fc541): a config root without
// fableOverageConsentV2[<orgUuid>] parks the first Fable 5 turn on a TUI
// dialog whose DEFAULT option is "Switch to Sonnet 5 and continue". The
// fleet's own blind Enters (identity /name, sendPromptToSession retry-Enter)
// accept that default, silently switching the session to Sonnet while
// agent-config still says claude-fable-5 -- the long-unexplained
// model/activeModel drift. Fleet policy (owner decision 2026-07-23): the
// fleet stays on Fable 5, so the consent is pre-acknowledged the same way
// onboarding/trust flags already are (see stampProjectTrustForDir above).
//
// Claude Code keys the consent on oauthAccount.organizationUuid (or
// "acct:<accountUuid>" for org-less accounts) in the SAME .claude.json. A
// file without an oauthAccount (brand-new config root that has never
// authenticated) is left alone -- there is nothing to key the consent on;
// the runtime dialog-answer backstop (dismissModelConsentDialogIfPresent)
// covers that first session and this stamp catches up on the next launch.
// Write is atomic and change-only, mirroring ensureSharedClaudeOnboarded.
export function stampFableOverageConsent(dotClaudePath: string): boolean {
  try {
    if (!existsSync(dotClaudePath)) return false
    const data = JSON.parse(readFileSync(dotClaudePath, 'utf-8')) as Record<string, unknown>
    const oauth = (data.oauthAccount && typeof data.oauthAccount === 'object' && !Array.isArray(data.oauthAccount))
      ? data.oauthAccount as Record<string, unknown>
      : null
    const orgUuid = typeof oauth?.organizationUuid === 'string' && oauth.organizationUuid ? oauth.organizationUuid : null
    const acctUuid = typeof oauth?.accountUuid === 'string' && oauth.accountUuid ? oauth.accountUuid : null
    const key = orgUuid ?? (acctUuid ? `acct:${acctUuid}` : null)
    if (!key) return false
    const consent = (data.fableOverageConsentV2 && typeof data.fableOverageConsentV2 === 'object' && !Array.isArray(data.fableOverageConsentV2))
      ? data.fableOverageConsentV2 as Record<string, unknown>
      : {}
    if (consent[key] === true) return false
    data.fableOverageConsentV2 = { ...consent, [key]: true }
    atomicWriteFileSync(dotClaudePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    logger.info({ dotClaudePath }, 'fable-consent: pre-stamped fableOverageConsentV2 (prevents the usage-credit model-switch dialog)')
    return true
  } catch (err) {
    logger.warn({ err, dotClaudePath }, 'fable-consent: could not stamp consent (runtime dialog-answer backstop remains)')
    return false
  }
}

// FABLEFALL1: the per-agent stamp above only runs on the startAgentProcess
// spawn path. The MAIN channels session (spawned by channels.sh / launchd)
// and the interactive workers' shared roots never pass through it, so those
// roots never self-heal -- and the main session is exactly the long-running
// process the menu-recovery keystrokes hit (silent Fable->Sonnet drift,
// measured on 2026-07-28: 5 events, 514 post-fallback Sonnet turns here, 12
// events at a customer). Called at dashboard boot and before every hard
// restart of the channels session. Worker dir resolution mirrors
// agent-worker.ts (env override + fixed default); change-only writes.
export function stampFableOverageConsentSharedRoots(): void {
  const mainDir = ensureMainAgentIsolatedConfigDir()
  const candidates = [
    mainDir ? join(mainDir, '.claude.json') : null,
    join(homedir(), '.claude.json'),
    join(process.env.MARVEEN_WORKER_DIR || join(homedir(), '.marveen-worker'), '.claude-config', '.claude.json'),
    join(process.env.MARVEEN_WORKER_DIR_FAST || join(homedir(), '.marveen-worker-fast'), '.claude-config', '.claude.json'),
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) stampFableOverageConsent(p)
  }
}

export function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord' || perAgent === 'googlechat' || perAgent === 'teams') return perAgent
  return CHANNEL_PROVIDER
}

export function agentSessionName(name: string): string {
  return `agent-${name}`
}

/**
 * POSIX single-quote a value for safe interpolation into a shell command STRING (card b7fa5281).
 *
 * The agent launch is a shell string tmux runs (`new-session -d -s <s> <cmd>`), and the model id --
 * which the operator controls via the dashboard -- was interpolated as `'${model}'`. Single-quoting
 * made a `:` safe but not a `'`: `x'; curl ... | sh; echo '` closed the quote and injected a command.
 * Wrapping in single quotes with each embedded `'` rewritten as `'\''` makes ANY value a single inert
 * shell word. This is defence #2 at the sink; the model-id allowlist (model-id.ts) is defence #1.
 */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// All tmux operations route through these two wrappers so the local-vs-remote
// (ssh) decision and the quoting live in ONE place (ssh-tmux.ts). host=null is
// byte-identical to the prior direct local tmux call. Remote calls get a larger
// default timeout because an ssh round-trip (handshake + remote exec) is slower
// than a local fork; ServerAlive/ConnectTimeout in SSH_OPTS bound a dead host.
function runTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): void {
  // Ensure the private ControlMaster socket dir exists before ANY remote ssh
  // call (idempotent, ~free). Without this a watcher-first remote call after a
  // marveen restart would lose connection multiplexing and re-handshake each tick.
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, tmuxBin(), tmuxArgs)
  // stdio: capture the child's stderr into the thrown error instead of letting
  // execFileSync's default inherit it to the parent stderr. A restarting agent
  // makes tmux emit `can't find session: agent-X` / `no server running`; without
  // this those leaked as ~450 bare (non-pino) lines into store/dashboard.log.
  // Callers that care read err.stderr via logger.warn({ err }).
  execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), stdio: ['ignore', 'ignore', 'pipe'] })
}

function captureTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): string {
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, tmuxBin(), tmuxArgs)
  // stdout piped (we return it); stderr piped too so tmux's `can't find session`
  // noise lands in err.stderr on failure rather than the parent stderr / dashboard.log.
  return execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Tri-state run state. For a remote agent a failed list-sessions query is
// 'unreachable' (the session is almost certainly still alive on the laptop --
// an SSH drop must never read as 'stopped', which would trigger a wrong
// auto-restart or a duplicate start). See classifyRunState.
export function agentRunState(name: string): AgentRunState {
  const host = readAgentRemoteHost(name)
  try {
    const out = captureTmux(host, ['list-sessions', '-F', '#{session_name}'])
    return classifyRunState(out, agentSessionName(name), host != null)
  } catch (err) {
    // tmux list-sessions exits non-zero ("no server running") when there are
    // zero sessions -- on a REACHABLE remote that means 'stopped', not
    // 'unreachable'. Only a true ssh transport failure (exit 255 / killed)
    // is unreachable. The exit status carries that distinction.
    const status = (err && typeof err === 'object' && 'status' in err)
      ? (err as { status?: number | null }).status
      : undefined
    return classifyRunStateFromExit(status, host != null)
  }
}

export function isAgentRunning(name: string): boolean {
  return agentRunState(name) === 'running'
}

// Host-aware "does this tmux session exist" check, shared by the message router
// and schedule runner. For a remote agent the list-sessions query runs on the
// laptop over ssh; an ssh failure returns false (the loop retries next tick),
// matching the local "session not found" semantics.
export function sessionExistsOnHost(host: string | null, session: string): boolean {
  try {
    return sessionInList(captureTmux(host, ['list-sessions', '-F', '#{session_name}']), session)
  } catch {
    return false
  }
}

export function getAgentRunningSince(name: string): number | null {
  try {
    const host = readAgentRemoteHost(name)
    const out = captureTmux(host, ['display-message', '-p', '-t', agentSessionName(name), '#{session_created}']).trim()
    const ts = parseInt(out, 10)
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}


export function agentHasChannel(name: string): boolean {
  const agentProvider = resolveAgentProvider(name)
  const dir = agentDir(name)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  if (token) return true
  if (agentProvider === 'telegram') return !!parseTelegramToken(name)
  return false
}

// Remote agent launch (ssh). Starts a DETACHED tmux session on the laptop so
// the claude process is a child of the laptop's tmux server -- NOT of sshd --
// and therefore survives any ssh disconnect; an outage only pauses the orchestrator's
// ability to message/observe it. Launch-only + channel-less: the laptop's own
// ~/.claude login and the remote workdir's CLAUDE.md drive behaviour, so none of
// the local channel/token/vault/settings scaffolding applies. Has its own
// tri-state start guard: it refuses on 'unreachable' so a brief outage never
// spawns a duplicate session.
function startRemoteAgentProcess(
  name: string,
  host: string,
  workdir: string,
  opts: { fresh?: boolean },
): { ok: boolean; error?: string } {
  const state = agentRunState(name)
  if (state === 'running') return { ok: false, error: 'Agent is already running' }
  if (state === 'unreachable') {
    return { ok: false, error: `Remote host '${host}' unreachable -- refusing to start (cannot confirm state)` }
  }

  ensureControlDir()
  cleanStaleSshSockets(host)

  const session = agentSessionName(name)

  // Pre-flight: claude must be on PATH on the laptop, else the session starts
  // and instantly dies with a silent "command not found".
  try {
    const probe = buildSshExec(host, 'which claude')
    execFileSync(probe.file, probe.args, { timeout: 8000, stdio: 'ignore' })
  } catch {
    return { ok: false, error: `claude not found on PATH on '${host}' (or host unreachable)` }
  }

  // --continue only when the remote session dir already exists. workdir is an
  // absolute path (validated), so the `/`->`-` encoding matches Claude Code's
  // own leading-'-' scheme. A probe failure defaults to a fresh launch (safe).
  let hasPriorSession = false
  if (!opts.fresh) {
    try {
      const probe = buildSshExec(host, buildContinueProbeCommand(workdir))
      execFileSync(probe.file, probe.args, { timeout: 8000, stdio: 'ignore' })
      hasPriorSession = true
    } catch {
      hasPriorSession = false
    }
  }

  const model = readAgentModel(name)
  const cmd = buildRemoteLaunchCommand({ workdir, model, continue: hasPriorSession })

  try {
    runTmux(host, ['new-session', '-d', '-s', session, cmd], { timeout: 10000 })
    logger.info({ name, session, host, workdir }, 'Remote agent tmux session started')
    // Fire-and-forget: scheduleIdentitySetup only schedules delayed timers and
    // resolves immediately; startRemoteAgentProcess stays synchronous (out of scope).
    void scheduleIdentitySetup(session, readAgentDisplayName(name), host)
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, host }, 'Failed to start remote agent tmux session')
    return { ok: false, error: 'Failed to start remote tmux session' }
  }
}

export async function startAgentProcess(name: string, opts: { fresh?: boolean } = {}): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }

  // Remote agents are handled entirely by the ssh path above (with its own
  // start guard), before any local already-running check / scaffolding.
  const remote = readAgentRemoteConfig(name)
  if (remote.host && remote.workdir) {
    return startRemoteAgentProcess(name, remote.host, remote.workdir, opts)
  }

  // Opt-in per-agent auto-memory isolation (local agents only; a remote
  // workdir cannot be provisioned from here). Default OFF: without the
  // memoryIsolation flag this is a no-op and the shared-memory behavior of
  // existing installs is byte-identical.
  if (readAgentMemoryIsolation(name)) provisionMemoryBoundaryDir(dir)

  // Linux shared-credentials race guard (opt-in, default OFF; no-op on macOS
  // and without the flag). Runs before launch so a valid setup-token retires
  // the rotating ~/.claude/.credentials.json; idempotent, so calling it per
  // start also self-heals if Claude Code recreates the file on a refresh.
  renameSharedCredentialsIfSafe(claudeBin())

  // Shared-root agents park on the first-run "Select login method" picker when
  // ~/.claude.json lost hasCompletedOnboarding (2026-07-15 bootcamp incident);
  // idempotent re-seed before every launch.
  ensureSharedClaudeOnboarded()


  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }

  const agentProvider = resolveAgentProvider(name)
  const provider = getProvider(agentProvider)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  // Backward compat: try legacy Telegram token if provider-aware lookup misses
  let hasChannel = !!token
  if (!token && agentProvider === 'telegram') {
    const legacyToken = parseTelegramToken(name)
    hasChannel = !!legacyToken
    // Channel-less agents (inter-agent only, no direct Telegram/Slack) are allowed to start
  }

  // Teams name-sync (companion to make-teams-manifest.sh): keep
  // TEAMS_BOT_DISPLAY_NAME in the agent's teams .env equal to the agent's
  // displayName, so the generated Teams manifest names the bot after the agent
  // (not the generic fallback). Idempotent; writes only on drift, non-fatal.
  if (agentProvider === 'teams' && hasChannel) {
    try {
      const envPath = join(agentChannelDir, '.env')
      const displayName = readAgentDisplayName(name)
      const raw = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
      const current = raw.match(/^TEAMS_BOT_DISPLAY_NAME=(.*)$/m)?.[1]?.trim()
      if (displayName && current !== displayName) {
        const line = `TEAMS_BOT_DISPLAY_NAME=${displayName}`
        const next = current !== undefined
          ? raw.replace(/^TEAMS_BOT_DISPLAY_NAME=.*$/m, line)
          : (raw === '' || raw.endsWith('\n') ? raw + line + '\n' : raw + '\n' + line + '\n')
        writeFileSync(envPath, next)
      }
    } catch { /* best-effort name-sync; never block launch */ }
  }

  const session = agentSessionName(name)

  try {
    try {
      runTmux(null, ['kill-session', '-t', session])
      await delay(3000)
    } catch { /* ok */ }

    // Reap any orphan poller (bun/node) left over from a previous run BEFORE
    // we spawn the new tmux session. The plugin process is a grandchild of
    // the tmux server, so a tmux kill-session does not always tear it down -
    // it can be orphaned and keep polling getUpdates with the agent's bot
    // token, racing the freshly-spawned poller and producing 409 Conflict on
    // a roughly hourly cadence. See channel-poller-reap.ts.
    try {
      const agentProvider = resolveAgentProvider(name)
      const dir = agentDir(name)
      reapChannelOrphans(agentProvider, dir)
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch channel-poller reap failed (continuing)')
    }

    // Also reap DETACHED channel claudes (the parent-process leak): a prior
    // --continue session that survived kill-session keeps a poller 409-racing
    // this agent's bot token, which the health monitor reads as "down" and
    // restarts -- a self-feeding thrash loop (zara, 2026-06-03). We just killed
    // this agent's tmux session above, so its leftover claude is now detached;
    // pane attribution spares every live sibling and the main session.
    try {
      reapDetachedChannelClaudes({ tmuxPath: tmuxBin() })
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch detached-claude reap failed (continuing)')
    }

    // `openrouter-auto:<tier>` resolves to the tier's current recommended model
    // (weekly-refreshed); a concrete OpenRouter id (contains '/') passes through.
    const model = resolveOpenRouterModel(readAgentModel(name))
    const authMode = readAgentAuthMode(name)
    const isClaude = model.startsWith('claude-')
    const isDeepseek = model.startsWith('deepseek-')
    // OpenRouter model ids are `provider/model` (contain '/'); Ollama tags use
    // ':' and no '/'. This discriminator keeps OpenRouter ids off the Ollama path.
    const isOpenRouter = !isClaude && !isDeepseek && model.includes('/')
    const isOllama = !isClaude && !isDeepseek && !isOpenRouter
    // ANTHROPIC_MODEL is REQUIRED for non-Claude models: the interactive TUI
    // validates the `--model` flag against known Anthropic models and silently
    // falls back to the built-in default (claude-opus-...) for an unrecognized
    // value like `qwen3.6:27b` or `deepseek-v4-pro` -- which then errors against
    // the custom ANTHROPIC_BASE_URL ("model does not exist"). The env var is
    // authoritative and bypasses that validation. (`--print` honors --model, but
    // the agents run the TUI.) Single-quoted so a `:` in the tag is shell-safe.
    const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL=${shSingleQuote(model)} && ` : ''
    const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
    const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${deepseekKey}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && export ANTHROPIC_MODEL=${shSingleQuote(model)} && ` : ''
    // OpenRouter: Anthropic-compatible endpoint at https://openrouter.ai/api
    // (the SDK appends /v1/messages). Key from the vault (openrouter-fleet-key).
    const openrouterKey = isOpenRouter ? (getSecret('openrouter-fleet-key') ?? '') : ''
    const openrouterEnv = isOpenRouter ? `export ANTHROPIC_AUTH_TOKEN="${openrouterKey}" && export ANTHROPIC_BASE_URL=https://openrouter.ai/api && export ANTHROPIC_MODEL=${shSingleQuote(model)} && ` : ''
    // When authMode is 'api', the agent uses its own ANTHROPIC_API_KEY from
    // the vault instead of the host's OAuth. The vault entry ID follows the
    // convention `agent-{name}-api-key`. We inject it as an env var so Claude
    // Code picks it up without needing OAuth credentials at all.
    let apiKeyEnv = ''
    if (isClaude && authMode === 'api') {
      const agentApiKey = getSecret(`agent-${name}-api-key`) ?? ''
      if (agentApiKey) {
        apiKeyEnv = `export ANTHROPIC_API_KEY="${agentApiKey}" && `
      }
    }
    // Apply security profile: write allow/deny list into settings.json, and
    // skip the dangerously-skip-permissions flag for strict profiles so
    // Claude Code enforces the list rather than bypassing it.
    // Role-derived applier-pool: an explicit non-default profile wins, else a
    // `leader` (tech-lead) -> 'applier' (Supabase retained), everyone else ->
    // 'default' (deny-by-default). Keeps a fresh install's tech-lead an applier
    // without hardcoding agent names.
    const profile = loadProfileTemplate(resolveAgentSecurityProfile(name))
    writeAgentSettingsFromProfile(name, profile)
    ensureFleetRosterSection(name)
    ensureAutonomySection(name)
    ensureSkillsPathTrapSection(name)
    // A sub-agent must load ONLY its own channel plugin. The user-scope
    // enabledPlugins would otherwise make EVERY sub-agent spawn a telegram
    // (and slack/discord) poller that falls back to the main agent's bot
    // token and fights it over the same getUpdates slot (409 Conflict /
    // orphan-poller churn / recurring MCP disconnects). Scope the agent's
    // settings.json so exactly its configured provider stays enabled and the
    // other channel plugins are forced off; a channel-less agent disables all
    // three. Applies to channel-HAVING sub-agents too (e.g. a slack agent must
    // not also run a telegram poller). Re-applied on EVERY spawn because
    // writeAgentSettingsFromProfile() above regenerates settings.json from the
    // profile template -- so this survives respawns, unlike a one-off manual
    // per-agent override (which a respawn silently wiped). The main agent runs
    // via channels.sh, not this path, so it remains the sole telegram poller.
    //
    // CATASTROPHE GUARD: never scope the MAIN agent's plugins here. marveen is
    // not in agents/ (so listAgentNames never spawns it through this path) and
    // its channel comes up via channels.sh -- but if a future caller ever passed
    // MAIN_AGENT_ID in, scopeChannelPlugins(null) would DISABLE the owner's
    // telegram channel (Szabi's primary line). Refuse outright.
    //
    // Telegram agents use a per-agent .mcp.json to spawn their own bun process
    // instead of the shared --channels flag path. The --channels path goes
    // through the plugin's .in_use/<pid> lock: if one process already holds the
    // lock, every other agent that starts with --channels gets "already in use"
    // and ends up with No MCP servers configured -- no bun, no bot.pid, deaf to
    // inbound Telegram. The mcp.json path bypasses the lock: Claude Code spawns a
    // fresh bun stdio server per agent, each with its own TELEGRAM_STATE_DIR. The
    // stdio tee wrapper restores inbound delivery by persisting notifications to a
    // local inbox that the UserPromptSubmit drain hook pulls into context.
    //
    // OPT-IN / DEFAULT OFF (SUBAGENT_INBOX_TEE). This mcp.json+tee swap is a
    // delivery-path change: it writes inbound message content to a local inbox
    // file for the drain hook to pull. With the flag off, telegram sub-agents
    // keep the upstream `--channels` path unchanged and nothing is written to
    // disk. Only opt in together with the channel-inbox-drain hook + (optionally)
    // SUBAGENT_TELEGRAM_WAKE_ENABLED.
    let useMcpJsonForChannel = false
    if (SUBAGENT_INBOX_TEE && hasChannel && agentProvider === 'telegram' && name !== MAIN_AGENT_ID) {
      try {
        const pluginCacheDir = join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram')
        const versions = existsSync(pluginCacheDir)
          ? readdirSync(pluginCacheDir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort().reverse()
          : []
        const pluginVersion = versions[0] ?? '0.0.6'
        const pluginDir = join(pluginCacheDir, pluginVersion)
        const bunBin = join(homedir(), '.bun', 'bin', 'bun')
        // The agent working-dir .mcp.json (NOT .claude/mcp.json) is what Claude Code
        // loads as project-scope MCP config. An empty .mcp.json already present would
        // override .claude/mcp.json, so write to the same file Claude Code reads.
        const mcpJsonPath = join(agentDir(name), '.mcp.json')
        const mcpConfig = {
          mcpServers: {
            'plugin:telegram:telegram': buildTelegramMcpServerConfig(bunBin, pluginDir, agentChannelDir),
          },
        }
        writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2))
        useMcpJsonForChannel = true
        logger.info({ name, pluginVersion, pluginDir }, 'Wrote per-agent mcp.json for telegram plugin')
      } catch (err) {
        logger.warn({ err, name }, 'Could not write mcp.json for telegram agent; falling back to --channels flag')
      }
    }

    if (name !== MAIN_AGENT_ID) {
      const settingsPath = join(agentDir(name), '.claude', 'settings.json')
      try {
        const s = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        // When mcp.json is used for the telegram plugin, force enabledPlugins.telegram
        // to false so Claude Code does not ALSO load the plugin via the marketplace
        // enabledPlugins path -- that would spawn a second bun process and produce
        // 409 Conflict / poller races. When --channels is still used (non-telegram
        // providers or mcp.json write failure), keep the original token-gated logic.
        const scopeProvider = useMcpJsonForChannel
          ? null
          : ownChannelProviderForScope(!!token, agentProvider)
        s.enabledPlugins = scopeChannelPlugins(
          scopeProvider,
          s.enabledPlugins as Record<string, boolean> | undefined,
        )
        writeFileSync(settingsPath, JSON.stringify(s, null, 2))
      } catch (err) {
        logger.warn({ err, name }, 'Could not scope channel plugins for sub-agent')
      }
    }
    const skipFlag = profile.permissionMode === 'strict' ? '' : '--dangerously-skip-permissions '
    // Optional per-agent CLAUDE_CONFIG_DIR (alternate Claude Code config dir,
    // e.g. for routing this agent to a separate Anthropic login). When the
    // agent-config field is missing or blank, claudeConfigDir is null and we
    // emit no export, preserving the default Claude Code behavior.
    // An explicit per-agent config dir wins. Otherwise, a channel sub-agent gets
    // an auto-provisioned isolated config dir so its plugin install cannot collide
    // with the rest of the fleet in the shared ~/.claude (see
    // ensureIsolatedChannelConfigDir). The main agent comes up via channels.sh and
    // keeps the shared root. Isolation is GATED on the fleet OAuth token: the
    // isolated dir carries no .credentials.json, so without CLAUDE_CODE_OAUTH_TOKEN
    // the sub-agent would launch logged-out -- so when the token is absent we skip
    // isolation and keep the shared ~/.claude (the pre-isolation, still-stable
    // behaviour) rather than break auth.
    // Named plan wins over the raw per-agent claudeConfigDir; both are opt-in,
    // so with neither set this is exactly the prior behaviour. The plan's
    // configDir is already launcher-validated (claude-plans.ts reuses
    // expandAndValidateConfigDir). NOTE: this covers regular agents only; the
    // main agent still launches via channels.sh (separate, gated follow-up).
    const planResolution = resolveAgentConfigDir(name)
    if (planResolution.planUnresolved) {
      // The agent has a claudePlan set but it no longer resolves (registry
      // entry removed/renamed). Do NOT silently boot on the host login --
      // surface it. The channelsAllowed enforcement guardrail is a separate
      // gated follow-up; this is just the visibility floor.
      logger.warn(
        { name, plan: readAgentClaudePlan(name) },
        'claude-plan: configured plan id does not resolve in store/claude-plans.json; falling back to raw config-dir / default login',
      )
    }
    let claudeConfigDir = planResolution.configDir
    let oauthTokenEnv = ''
    // Shared-home agents (no isolated config dir) authenticate from the rotating
    // ~/.claude/.credentials.json by default. If the operator has a long-lived
    // fleet setup-token, export it so EVERY locally launched agent uses the
    // stable token instead -- this is what makes the Linux credentials-guard
    // rename safe (a shared sub-agent with no env token would otherwise be
    // locked out once credentials.json is moved aside). No-op without a token.
    if (!claudeConfigDir && hasFleetOauthToken()) {
      oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')" && `
    }
    // Isolation must also cover CHANNEL-LESS Claude-OAuth agents, not just
    // channel ones. A shared-root agent authenticates from the ROTATING shared
    // credential (macOS Keychain entry / .credentials.json), which Claude Code
    // prefers over an otherwise-valid CLAUDE_CODE_OAUTH_TOKEN env var (see the
    // ensureMainAgentIsolatedConfigDir header) -- so when that credential
    // rotates or expires, the agent parks on a 401 even though the fleet token
    // exported right next to it is fine (dani/geri recurring outage,
    // 2026-07-25). Only agents that never touch Anthropic OAuth stay on the
    // shared root: local/BYO-endpoint models (Ollama/DeepSeek/OpenRouter) and
    // per-agent API-key (authMode 'api') agents.
    const needsFleetOauth = isClaude && authMode !== 'api'
    if (!claudeConfigDir && (hasChannel || needsFleetOauth) && name !== MAIN_AGENT_ID) {
      if (hasFleetOauthToken()) {
        // Token present -> isolation works; any earlier degradation is resolved,
        // so re-arm the one-shot alert for a future token loss.
        resetSharedConfigCollisionAlert()
        // A channel-less agent provisions with a null provider so its isolated
        // settings.json disables EVERY channel plugin -- it has no bot token,
        // so a loaded plugin could only fight the fleet over poller slots.
        const isolated = ensureIsolatedChannelConfigDir(name, hasChannel ? agentProvider : null)
        if (isolated) {
          claudeConfigDir = isolated
          // Read the token at launch via $(cat) so the literal secret never
          // appears in the JS-built command string or in `ps`. The file is 0600
          // and the value lands only in this process's own environment.
          oauthTokenEnv = `export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')" && `
        }
      } else {
        logger.warn({ name }, 'isolated-config: no fleet OAuth token (store/.claude-oauth-token); keeping shared ~/.claude. Run `claude setup-token` and store it to enable per-agent isolation.')
        // H1: the WARN above is silent. With >1 channel sub-agent sharing
        // ~/.claude this is an active plugin-slot collision -> raise a loud
        // alert. Channel-less agents cannot contend for a plugin slot, so they
        // only get the WARN.
        if (hasChannel) maybeAlertSharedConfigCollision(name)
      }
    }
    // Per-project trust pre-seed in the config root this session will ACTUALLY
    // use (isolated CLAUDE_CONFIG_DIR when set, shared ~/.claude.json
    // otherwise). Without it a fresh install's first launch of each agent
    // parks on the "Do you trust the files in this folder?" dialog -- see
    // stampProjectTrustForDir.
    stampProjectTrustForDir(
      claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(homedir(), '.claude.json'),
      dir,
    )
    // Same target file: pre-acknowledge the Fable usage-credit consent so the
    // model-switch dialog (default: Sonnet) never renders -- see
    // stampFableOverageConsent for the drift root-cause chain.
    stampFableOverageConsent(
      claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(homedir(), '.claude.json'),
    )
    const claudeConfigEnv = claudeConfigDir ? `export CLAUDE_CONFIG_DIR="${claudeConfigDir}" && ` : ''
    // `--continue` requires an existing session; on a brand-new agent the
    // Claude Code projects directory does not yet exist and `claude` exits
    // immediately with an obscure "No deferred tool marker found" error
    // that is silent inside tmux. Detect first launch by probing for the
    // encoded project dir and skip `--continue` only then. The encoding
    // mirrors Claude Code's own scheme: replace every `/` with `-`.
    const projectsRoot = claudeConfigDir
      ? join(claudeConfigDir, 'projects')
      : join(homedir(), '.claude', 'projects')
    const encodedProject = dir.replace(/\//g, '-')
    const hasPriorSession = existsSync(join(projectsRoot, encodedProject))
    // opts.fresh forces a brand-new conversation (auto-restart 'fresh' mode):
    // omit --continue so the heavy accumulated context is dropped. Without it
    // we resume the prior session (the 'continue' mode / normal restart).
    //
    // CC 2.1.193 REGRESSION: a `--continue` resume does NOT re-initialise the
    // `--channels` plugin MCP server -- the agent comes up with the plugin
    // absent from /mcp, no bun poller, no bot.pid -> permanently deaf on its
    // channel. A FRESH launch loads the plugin correctly. So channel-having
    // agents are ALWAYS launched fresh: the lost conversation context is the
    // price of a reachable bot (file/db memory persists either way). Channel-
    // less agents keep --continue to preserve their accumulated context.
    const continueFlag = (hasPriorSession && !opts.fresh && !hasChannel) ? '--continue ' : ''
    const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : agentProvider === 'discord' ? 'DISCORD_STATE_DIR' : agentProvider === 'googlechat' ? 'GOOGLECHAT_STATE_DIR' : agentProvider === 'teams' ? 'TEAMS_STATE_DIR' : 'TELEGRAM_STATE_DIR'
    const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
    // Slack plugin is third-party; its "not on approved allowlist" check is
    // bypassed via `allowedChannelPlugins` in /Library/Application Support/ClaudeCode/managed-settings.json.
    const auditLogEnv = agentProvider === 'slack' ? ` && export SLACK_AUDIT_LOG="${agentChannelDir}/audit.jsonl"` : ''
    const channelSetup = hasChannel
      ? `export ${stateEnvVar}="${agentChannelDir}"${auditLogEnv} && `
      : ''
    // When the per-agent mcp.json+tee path is active (SUBAGENT_INBOX_TEE), the
    // plugin is already loaded as a plain MCP server, so ALSO passing --channels
    // would register the plugin a SECOND way -- a duplicate poller racing the tee
    // process over the same getUpdates slot. Suppress --channels in that case and
    // rely solely on mcp.json (enabledPlugins is already forced false above for
    // the same reason). Every other agent (non-telegram, main, or flag off) keeps
    // the --channels launch path unchanged.
    const channelFlag = hasChannel && !useMcpJsonForChannel ? `--channels plugin:${provider.pluginId}` : ''
    // Channel-plugin MCP-registration guard (2026-06-23): the telegram/slack/etc.
    // channel plugin registers as a stdio MCP server loaded via --channels. Claude
    // Code connects stdio MCP servers in batches of MCP_SERVER_CONNECTION_BATCH_SIZE
    // (default 3); when an agent ALSO runs a slow local .mcp.json stdio server
    // (e.g. google-workspace/workspace-mcp, which spends seconds on OAuth + Google
    // API init) plus many claude.ai connectors, the channel plugin gets starved
    // out of the startup batch / hits MCP_TIMEOUT and never registers -- no /mcp
    // entry, no bun poller, dead bot (observed: balazsmarveenja with workspace-mcp
    // had NO telegram; removing workspace-mcp restored it). Raise the stdio batch
    // size and per-server timeout, and force non-blocking startup, so a slow local
    // MCP can never crowd the channel plugin out of registration. Only set for
    // channel-having agents (channel-less agents have no plugin to protect).
    const mcpEnv = hasChannel
      ? 'export MCP_SERVER_CONNECTION_BATCH_SIZE=10 && export MCP_CONNECTION_NONBLOCKING=1 && export MCP_TIMEOUT=60000 && '
      : ''
    // Disable Claude Code's history-based prompt suggestions -- the DIM (ANSI
    // SGR-2 faint) ghost-text of a previous prompt that Claude shows in an empty
    // input box. The stuck-input recovery scrapes the pane with `capture-pane -p`
    // (no colour), so it cannot tell a dim ghost suggestion apart from REAL
    // parked input and re-submits the suggestion as a command. That is the root
    // of the 2026-06-26 phantom-injection incident: a stale "Sztornózd" ghost was
    // re-submitted and cancelled a live invoice; an earlier ghost emailed a family
    // member. Killing the suggestion at the source removes the ghost the recovery
    // misreads. Env var verified present in claude.exe (CLAUDE_CODE_ENABLE_*).
    const promptSuggestionEnv = 'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false && '
    // Disable Claude Code's in-place auto-updater for every spawned agent. A
    // running agent whose updater fires does an in-place global reinstall into the
    // shared package prefix; a half-completed update can leave a broken stub and
    // drop the bin symlink, corrupting the one install every agent resolves
    // through. Agents launch from a deliberately pinned install, so the updater
    // must never move it out from under a live process.
    const autoUpdaterEnv = 'export DISABLE_AUTOUPDATER=1 && '
    // shSingleQuote(model) (card b7fa5281): the model is POSIX single-quote ESCAPED, which both keeps
    // values like `claude-opus-4-8[1m]` (1M-context suffix) from being glob-expanded AND makes a `'`
    // in the value inert rather than a quote-break -> command injection. Same escape at the three
    // ANTHROPIC_MODEL env sites above.
    const cmd = `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${autoUpdaterEnv}${promptSuggestionEnv}${mcpEnv}${channelSetup}${apiKeyEnv}${claudeConfigEnv}${oauthTokenEnv}${ollamaEnv}${deepseekEnv}${openrouterEnv}cd "${dir}" && ${claudeBin()} ${continueFlag}${skipFlag}--model ${shSingleQuote(model)} ${channelFlag}`.trimEnd()
    runTmux(null, ['new-session', '-d', '-s', session, cmd], { timeout: 10000 })

    logger.info({ name, session, channelDir: agentChannelDir }, 'Agent tmux session started')

    // After a restart with --continue, a session that's been idle for >24h
    // shows the "Resume from summary" modal before the prompt input is ready
    // (113.6k tokens at 2d age in observed cases). Until the operator either
    // sends a new prompt or dismisses the modal, every scheduled task and
    // every inter-agent message stalls because isSessionReadyForPrompt sees
    // a non-idle pane state. The pre-flight dismiss baked into
    // sendPromptToSession only fires on outgoing traffic -- so on a fresh
    // restart with no inbound, the modal can sit indefinitely.
    //
    // Fire a delayed dismiss after Claude Code has had time to render the
    // modal. 8 seconds is a comfortable margin in observed restarts (modal
    // typically appears within 4-6s). Survey-rating modals from prior
    // sessions can also be present, so dismiss both. Errors are swallowed
    // -- the outbound pre-flight remains the safety net if this misses.
    // Fire-and-forget: scheduleIdentitySetup only schedules delayed timers;
    // startAgentProcess stays synchronous (out of scope, per the conversion rules).
    void scheduleIdentitySetup(session, readAgentDisplayName(name))

    // Colleague auto-unlock (2026-06-22): mirror the main session's
    // post-respawn unlock probe for channel-having sub-agents. After a restart
    // the bun channel poller sometimes never attaches during the cold-start
    // window (observed fleet-wide after a managed restart: the TUI comes up but
    // bot.pid stays empty, so the agent goes deaf to inbound). The main session
    // self-heals because channel-monitor schedules schedulePluginUnlockAfterRespawn;
    // sub-agents had no such probe and stayed stuck until a manual /mcp kick.
    // Schedule the same probe here. It is gated on bun-absence (a healthy poller
    // is left untouched) and on an idle pane, so it never disturbs a colleague
    // mid-turn. Channel-less agents (hasChannel false) get no probe; MAIN never
    // takes this path (it comes up via channels.sh) but guard defensively.
    if (hasChannel && name !== MAIN_AGENT_ID) {
      schedulePluginUnlockAfterRespawn(session, provider.type)
    }

    return { ok: true }
  } catch (err) {
    logger.error({ err, name }, 'Failed to start agent tmux session')
    return { ok: false, error: 'Failed to start tmux session' }
  }
}

export async function stopAgentProcess(name: string): Promise<{ ok: boolean; error?: string }> {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }

  const host = readAgentRemoteHost(name)

  try {
    runTmux(host, ['kill-session', '-t', session], { timeout: 5000 })
    await delay(2000)
    // Reap any orphaned plugin grandchild that tmux did not tear down. This is
    // a LOCAL pkill against this host's process table, so it only makes sense
    // for local agents; a remote agent is channel-less and its processes live
    // on the laptop, so skip it.
    if (!host) {
      try {
        const agentProvider = resolveAgentProvider(name)
        const dir = agentDir(name)
        reapChannelOrphans(agentProvider, dir)
      } catch (err) {
        logger.warn({ err, name }, 'post-stop channel-poller reap failed')
      }
    }
    logger.info({ name, session, host }, 'Agent tmux session stopped')
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, session, host }, 'Failed to stop agent tmux session')
    return { ok: false, error: 'Failed to stop tmux session' }
  }
}

export function getAgentProcessInfo(name: string): { running: boolean; session?: string } {
  const running = isAgentRunning(name)
  if (!running) return { running: false }
  return {
    running: true,
    session: agentSessionName(name),
  }
}

export async function restartAgentProcess(name: string, opts: { fresh?: boolean } = {}): Promise<{ ok: boolean; pid?: number; error?: string }> {
  if (isAgentRunning(name)) {
    const stopResult = await stopAgentProcess(name)
    if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }
  }
  return startAgentProcess(name, opts)
}

// Claude Code occasionally pops a "How is Claude doing this session? (optional)"
// rating modal above the prompt input. The footer line still reads
// "bypass permissions on (shift+tab to cycle)" so detectPaneState() classifies
// the pane as idle, but the modal swallows the next keystroke and pinches off
// every scheduled prompt + agent message until a human dismisses it. We strip
// it pre-flight by sending "0" (Dismiss) when the marker is visible, so any
// caller writing a prompt has a clear input field.
const SURVEY_MODAL_RX = /How is Claude doing this session/

async function dismissSurveyModalIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!SURVEY_MODAL_RX.test(pane)) return
    runTmux(host, ['send-keys', '-t', session, '0'], { timeout: 5000 })
    // Modal close is one frame; settle window so the next send-keys lands in
    // the prompt input, not the now-stale modal handler.
    await delay(300)
    logger.info({ session }, 'Dismissed Claude Code session-rating modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss session-rating modal')
  }
}

// When a session approaches its context limit Claude Code shows a "Resume from
// summary" modal with three numbered options and footer "Enter to confirm".
// detectPaneState() reads that footer as 'unknown' (not the usual "bypass
// permissions" string), so isSessionReadyForPrompt() refuses to deliver and
// every scheduled task / inter-agent message piles up behind it. Pre-flight
// pick option 1 (Resume from summary, recommended) and Enter to confirm.
const RESUME_SUMMARY_MODAL_RX = /Resume from summary/

export async function dismissResumeSummaryModalIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!RESUME_SUMMARY_MODAL_RX.test(pane)) return
    runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    await delay(100)
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    // /compact starts immediately and can run for minutes; we only need to
    // unblock the modal so detectPaneState can transition off 'unknown'.
    await delay(300)
    logger.info({ session }, 'Dismissed Claude Code resume-from-summary modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss resume-from-summary modal')
  }
}

// Runtime backstop for the model overage-consent dialog ("Fable 5 now uses
// usage credits" -- see detectsModelConsentDialog in pane-state.ts for the
// full anatomy and the drift root cause). The stampFableOverageConsent
// pre-seed normally prevents the dialog entirely; this handler covers the
// windows the seed cannot reach (a config root that had no oauthAccount yet,
// a future consent-key version bump). Unlike the generic dismissals above it
// must NOT send a bare Enter: the dialog's default option SWITCHES the model
// to Sonnet. It actively selects option 1 ("Continue with <configured
// model>") -- number first, then confirm, mirroring answerFirstRunGates. The
// keystrokes only ever fire when the specific dialog is visibly on screen
// (pure detector, quoted-text-proof), so this adds no blind-injection surface.
export async function dismissModelConsentDialogIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!detectsModelConsentDialog(pane)) return
    runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    await delay(150)
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    await delay(300)
    logger.info({ session }, 'Answered model usage-credit consent dialog: kept the configured model (option 1, never the switch default)')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/answer model usage-credit consent dialog')
  }
}

// Walk a session out of the Claude Code FIRST-RUN dialog chain (folder-trust,
// bypass-permissions acceptance, theme picker, welcome screen), answering each
// dialog exactly the way scripts/channels.sh's startup guard does for the main
// session: trust -> "1" Enter (Yes, proceed), bypass -> "2" Enter (Yes, I
// accept), theme/welcome -> Enter (accept default / continue). The login
// picker is NEVER answered -- nobody can authenticate on the operator's
// behalf -- so it is returned for the caller to alert on.
//
// Escape is deliberately NOT used anywhere here: on the trust/bypass dialogs
// Escape selects "No, exit" and quits the TUI, which is exactly the
// respawn-loop failure the channel-monitor's generic menu recovery would cause
// on these panes (hence the detectsFirstRunGate carve-out at its call site).
//
// Bounded walk: the chain is at most a handful of dialogs; each answered
// dialog gets a settle delay before the re-capture. Returns 'cleared' when at
// least one dialog was answered and none remains, 'login' when the login
// picker is (or becomes) the blocker, 'unchanged' when no gate was present.
const FIRST_RUN_ANSWER_MAX_STEPS = 6
const FIRST_RUN_ANSWER_SETTLE_MS = 1500

export async function answerFirstRunGates(
  session: string,
  host: string | null = null,
): Promise<'cleared' | 'login' | 'unchanged'> {
  let acted = false
  for (let i = 0; i < FIRST_RUN_ANSWER_MAX_STEPS; i++) {
    const pane = capturePane(session, host)
    const gate: FirstRunGateKind | null = pane != null ? detectsFirstRunGate(pane) : null
    if (gate == null) return acted ? 'cleared' : 'unchanged'
    if (gate === 'login') return 'login'
    try {
      if (gate === 'trust') {
        runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
        await delay(150)
        runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      } else if (gate === 'bypass-permissions') {
        runTmux(host, ['send-keys', '-t', session, '2'], { timeout: 5000 })
        await delay(150)
        runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      } else {
        // theme / welcome: Enter accepts the highlighted default and moves on.
        runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      }
    } catch (err) {
      logger.warn({ err, session, gate }, 'first-run gate: answer keystroke failed')
      return acted ? 'cleared' : 'unchanged'
    }
    acted = true
    logger.info({ session, gate, step: i }, 'first-run gate: answered dialog')
    await delay(FIRST_RUN_ANSWER_SETTLE_MS)
  }
  return acted ? 'cleared' : 'unchanged'
}

// Post-(re)start identity setup. Every freshly spawned Claude Code session is
// given `/name` so it is identifiable. (`/remote-control` was dropped: the
// operator no longer uses Remote Control, and the agent's inference-only OAuth
// token can't satisfy it anyway.) Pure helper for the exact slash commands so
// they are unit-tested; scheduleIdentitySetup wires them to tmux after a wait.
export function identitySlashCommands(displayName: string): string[] {
  return [`/name ${displayName}`]
}

// Delays mirror the observed Claude Code first-render timing: the first-run /
// resume modals appear within ~4-6s, so dismiss at 8s; the prompt input is
// reliably ready ~5s after that.
const MODAL_DISMISS_DELAY_MS = 8000
const IDENTITY_SEND_DELAY_MS = 5000

// Schedule the identity setup for a freshly (re)spawned session: once it has
// had time to render, dismiss any first-run/resume modals, then send `/name`.
// Shared by startAgentProcess and the channel-monitor recovery respawns
// (resumeMarveenSession / respawnMarveenSessionFresh), which previously left the
// main session without its identity after auto-recovery. Fire-and-forget; all
// errors are swallowed/logged so a missed setup never tears down the caller.
export async function scheduleIdentitySetup(session: string, displayName: string, host: string | null = null): Promise<void> {
  setTimeout(() => {
    void (async () => {
      try {
        await dismissSurveyModalIfPresent(session, host)
        await dismissResumeSummaryModalIfPresent(session, host)
        await dismissModelConsentDialogIfPresent(session, host)
      } catch (err) {
        logger.warn({ err, session }, 'Post-restart modal dismiss failed')
      }
      setTimeout(() => {
        void (async () => {
          try {
            for (const cmd of identitySlashCommands(displayName)) {
              runTmux(host, ['send-keys', '-t', session, cmd, 'Enter'], { timeout: 5000 })
              await delay(1000)
            }
            logger.info({ session, displayName }, 'Set session /name')
          } catch (err) {
            logger.warn({ err, session, displayName }, 'Failed to set session /name')
          }
        })()
      }, IDENTITY_SEND_DELAY_MS)
    })()
  }, MODAL_DISMISS_DELAY_MS)
}

// How many follow-up actions (retry-Enter OR clear-and-resend)
// sendPromptToSession() is willing to fire when the post-send capture says
// the prompt is still parked in the input box. The verbatim path lands on the
// first or second extra Enter; the placeholder clear-and-resend path needs a
// little more headroom because a resend can itself occasionally park (the
// observed convergence was placeholder -> resend -> verbatim/placeholder ->
// resend -> submitted, i.e. up to ~3 cycles). Four bounds the loop well past
// the empirical worst case (which converged within 5 in a 12/12 proof) while
// still giving a logged give-up so a pathologically stuck pane does not spin
// indefinitely.
const SUBMIT_RETRY_MAX_ATTEMPTS = 4
// Wait between sending an Enter and re-capturing the pane. Long enough
// for tmux to flush the keystroke into the Claude Code TUI and for
// the TUI to either transition to busy (turn started) or stay idle
// with the parked text (still stuck). Empirically 300ms is past the
// frame-render gap detectPaneState already guards against.
const SUBMIT_RETRY_POLL_MS = 300

// Pre-flight wait-until-idle gate (root-cause fix for the busy-stuck class).
// Before streaming chunks we poll the pane and wait for it to return to the
// 'idle' state. Sending while the target is mid-turn (footer `esc to
// interrupt`) is the condition the stuck-input incidents correlated with: the
// typed text + trailing Enter can be parked in the input box (verbatim or as a
// `[Pasted text #N]` stub) and only "land" much later, so a delegated prompt
// sits unsubmitted until a human presses Enter. Waiting for idle removes that
// condition for EVERY caller of sendPromptToSession (router, scheduler,
// channel-monitor, /login, worker) rather than relying on each caller to gate
// itself -- and it closes the check->send TOCTOU gap where a caller's own
// readiness check passed but the agent started a turn before the bytes landed.
//
// Budget: poll every PANE_IDLE_POLL_MS up to PANE_IDLE_WAIT_TIMEOUT_MS total.
// The timeout is generous on purpose -- it must NOT truncate a legitimately
// long turn into a premature "give up and send anyway". 12s comfortably spans
// the inter-turn gaps and short tool-calls we observe between a turn's visible
// completion and the input box settling, while still bounding the wait so a
// genuinely long-running turn does not block the 5s router / 60s scheduler tick
// indefinitely. On timeout we proceed best-effort: the existing post-send
// retry loop (decideSubmitFollowup) remains the backstop, and a hard-busy
// session that never idles must still receive its prompt eventually.
const PANE_IDLE_WAIT_TIMEOUT_MS = 12_000
const PANE_IDLE_POLL_MS = 300

// Block until the session's pane looks idle, or the budget elapses. Returns
// true if idle was observed, false on timeout-still-busy (caller proceeds
// best-effort). Reuses the shared paneLooksIdle predicate -- the SAME rule the
// readiness check and the auto-restart idle-guard use -- so the busy regex is
// never re-inlined here. A capture failure is treated as "not yet idle" and we
// keep polling within the budget (a transient tmux hiccup should not be read as
// idle and let us blast a prompt into a busy pane).
export async function waitForPaneIdle(
  session: string,
  host: string | null = null,
  timeoutMs: number = PANE_IDLE_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pane = capturePane(session, host)
    if (pane != null && paneLooksIdle(pane)) return true
    if (Date.now() >= deadline) return false
    await delay(PANE_IDLE_POLL_MS)
  }
}

// Pre-flight buffer clear, used when shouldClearTruncatedPreamble flags a stale
// preamble. This used to send a single Ctrl-U, which is a no-op whenever the
// cursor sits at offset 0 of the buffer -- the normal state for text that
// arrived via send-keys (see parkedClearSequence). A failed pre-flight clear is
// worse than none: the prompt about to be typed is APPENDED to the stale text
// instead of replacing it, which is how a box accumulates tick after tick until
// nothing can be submitted at all. Keys are sent by name (no `-l` literal flag)
// so tmux interprets them as control sequences.
export async function clearInputBuffer(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = capturePane(session, host)
    for (const key of parkedClearSequence(pane != null ? parkedInputRowCount(pane) : 0)) {
      runTmux(host, ['send-keys', '-t', session, key], { timeout: 5000 })
    }
    // Settle briefly so the next send-keys lands in the freshly cleared
    // buffer rather than racing the clear.
    await delay(100)
  } catch (err) {
    logger.warn({ err, session }, 'Failed to clear pane input buffer before send')
  }
}

// How many Ctrl-C presses the placeholder-discard will attempt before giving
// up. Empirically a single Ctrl-C discards a `[Pasted text #N]` stub (and
// expanded verbatim text) and returns to the empty prompt; the extra presses
// cover a frame race where the first one was eaten mid-render.
const PLACEHOLDER_DISCARD_MAX = 3
// Settle window after a Ctrl-C so the next capture reflects the cleared box.
const PLACEHOLDER_DISCARD_SETTLE_MS = 450

// Discard a `[Pasted text #N]` placeholder (or the verbatim text it expands
// into) from the input box with Ctrl-C, then confirm the box no longer holds
// the placeholder. Ctrl-U is deliberately NOT used: it is proven NOT to clear
// a paste placeholder, and on a multi-row verbatim buffer it only clears the
// row the cursor sits on. Ctrl-C is the only key that reliably empties the box.
//
// SAFETY: Ctrl-C on an EMPTY Claude Code box quits the TUI, and on a BUSY pane
// it interrupts the live turn. This helper must therefore only ever be called
// when a placeholder is CONFIRMED present (box non-empty, not busy) -- which
// detectsPastePlaceholder guarantees at the call site. We re-check before each
// press and stop the instant the placeholder is gone, so we never press Ctrl-C
// into an already-empty box. Returns true if the placeholder was cleared.
async function discardPlaceholderBuffer(session: string, host: string | null = null): Promise<boolean> {
  for (let i = 0; i < PLACEHOLDER_DISCARD_MAX; i++) {
    const pane = capturePane(session, host)
    // Stop pressing once the stub is gone -- a further Ctrl-C on an empty box
    // would quit the TUI.
    if (pane != null && !detectsPastePlaceholder(pane)) return true
    try {
      runTmux(host, ['send-keys', '-t', session, 'C-c'], { timeout: 5000 })
    } catch (err) {
      logger.warn({ err, session }, 'discardPlaceholderBuffer: Ctrl-C send failed')
      return false
    }
    await delay(PLACEHOLDER_DISCARD_SETTLE_MS)
  }
  const finalPane = capturePane(session, host)
  return finalPane != null && !detectsPastePlaceholder(finalPane)
}

// Send text to a tmux session as if typed at the prompt.
// Uses execFileSync so callers can pass raw text -- tmux send-keys -l treats
// the argument as literal characters, bypassing shell quoting entirely.
//
// Pre-flight: if the live input box already shows a stale preamble from
// a previous wrapped message that never fully landed (shouldClearTrun-
// catedPreamble), Ctrl-U the buffer first so a fresh prompt is not
// concatenated onto the stale trust-marker. Skipping this guard would
// let an UNTRUSTED payload sit behind a stale TEAM MEMBER NOTICE
// preamble and read as if it came from a trusted peer.
//
// Post-flight: bracketed-paste detection and frame-level races in the
// Claude Code TUI occasionally swallow the trailing Enter, leaving the
// fully written prompt parked in the input box (either as a [Pasted
// text #N] placeholder or as verbatim text under an idle footer). We
// re-sample the pane after the initial Enter and, if shouldRetrySubmit
// still reports stuck, send up to SUBMIT_RETRY_MAX_ATTEMPTS extra
// Enters. The retry budget bounds the loop so a pathologically stuck
// pane gives up rather than spinning.
export async function sendPromptToSession(
  session: string,
  text: string,
  host: string | null = null,
  opts: { waitForIdle?: boolean; onBusyTimeout?: 'send' | 'abort'; idleTimeoutMs?: number; lockMode?: SendLockMode } = {},
): Promise<'sent' | 'aborted-busy' | 'skipped-locked'> {
  const lockMode: SendLockMode = opts.lockMode ?? 'deliver'
  // PANEWRITERS805: the three modal dismissals are probe+act keystroke writers
  // that ran BEFORE the lane lock -- so they could press Escape/Enter into a
  // pane mid-delivery (an Enter on the model-consent dialog confirms its
  // DEFAULT, the FABLEFALL1 model switch). They must stay BEFORE the idle gate
  // (a modal keeps the pane non-idle, so dismiss-after-wait would always time
  // out), so they get their own fail-closed acquire instead of moving into the
  // emit span. Skipping on a busy lane is safe: if a modal is really up, the
  // idle gate below times out and the emit still queues behind the holder.
  // 'held' callers already own the lane -- acquiring again would deadlock.
  if (lockMode === 'held') {
    await dismissSurveyModalIfPresent(session, host)
    await dismissResumeSummaryModalIfPresent(session, host)
    await dismissModelConsentDialogIfPresent(session, host)
  } else {
    const releaseDismissLane = tryAcquireSessionSendLane(session, host)
    if (releaseDismissLane) {
      try {
        await dismissSurveyModalIfPresent(session, host)
        await dismissResumeSummaryModalIfPresent(session, host)
        await dismissModelConsentDialogIfPresent(session, host)
      } finally {
        releaseDismissLane()
      }
    } else {
      logger.info({ session }, 'sendPromptToSession: modal dismissals skipped -- a delivery holds this pane send lane (fail-closed); emit will queue behind it')
    }
  }

  // Pre-flight wait-until-idle (root-cause gate). Placed here -- inside
  // sendPromptToSession, AFTER the modal dismissals (a modal keeps the pane
  // non-idle, so we must clear it first or the wait would always time out) and
  // BEFORE the truncated-preamble check + chunk-send -- so EVERY caller is
  // protected by default and the live input box we inspect/clear below reflects
  // a settled, idle pane. On timeout we fall through and send anyway: a session
  // that never idles must still receive its prompt, and the post-send retry
  // loop is the backstop. host is threaded so a remote agent's pane is polled
  // over ssh.
  //
  // opts.waitForIdle defaults to true (the gate is ON for every caller). The
  // forceSend scheduled-task path opts OUT (waitForIdle:false): forceSend is
  // documented to skip the busy-state check so a task does NOT pile up retries
  // against a session that stays busy for hours (the overnight 275-retry loop).
  // Eating the 12s idle wait here would defeat that contract -- the whole point
  // of forceSend is to inject regardless and let Claude Code queue it.
  // opts.onBusyTimeout selects what a timed-out idle wait means. The default
  // 'send' keeps the historical contract (a session that never idles must
  // still receive its prompt eventually -- router/scheduler messages MUST
  // deliver). 'abort' is for OPTIONAL prompts (the inbox-nudge watcher): a
  // nudge typed into a busy pane would park in the input box, and a parked
  // multi-row line on the MAIN channels session has no automatic recovery --
  // better to send nothing and let the caller retry on its own cadence.
  // opts.idleTimeoutMs lets such callers use a short budget instead of the
  // default 12s (they already confirmed idleness moments ago).
  const waitForIdle = opts.waitForIdle !== false
  if (waitForIdle && !(await waitForPaneIdle(session, host, opts.idleTimeoutMs))) {
    if (opts.onBusyTimeout === 'abort') {
      logger.info({ session }, 'sendPromptToSession: pane busy past idle budget; aborting per caller policy (no keystrokes sent)')
      return 'aborted-busy'
    }
    logger.warn({ session }, 'sendPromptToSession: pane still busy after wait-until-idle budget; sending best-effort')
  }

  // DELIVLOCK805: everything from here to `return 'sent'` EMITS keystrokes into
  // the pane (preamble-clear, chunk stream, submit-retry loop). Two writers
  // interleaving this span splice foreign text into one framed message, so it
  // is the per-session critical section. Held under a per-pane in-process mutex
  // (session-send-lock): normal delivery is fail-open (a stuck holder must not
  // silence the fleet); a `recover` caller skips instead of racing a live send.
  const emitToPane = async (): Promise<'sent'> => {
  // Pre-flight buffer-clear when a stale preamble is detected. Reading
  // the pane is best-effort: a capture failure here means we cannot
  // prove the buffer is clean, but proceeding without the clear is no
  // worse than the pre-fix status quo.
  try {
    const preCapture = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (shouldClearTruncatedPreamble(preCapture)) {
      logger.info({ session }, 'Cleared stale preamble from input buffer before sending prompt')
      await clearInputBuffer(session, host)
    }
  } catch (err) {
    logger.warn({ err, session }, 'Pre-send capture-pane failed; skipping truncated-preamble check')
  }

  const oneLine = text.replace(/\r?\n/g, ' ')
  // STUCKINPUT827: remember the EXACT byte stream we are about to type. If the
  // submitting Enter does not land, the stuck-input watcher re-injects THIS
  // instead of guessing from a lossy screen scrape. Recorded before the send so
  // a delivery that parks mid-stream is recoverable too.
  recordInjectedPrompt(session, oneLine)
  const CHUNK = 80
  // Stream oneLine into the pane as CHUNK-sized literal send-keys writes,
  // followed by a submitting Enter. Extracted as a closure so the
  // clear-and-resend recovery path below can replay the EXACT same byte
  // stream after a Ctrl-C, rather than duplicating the dash-slide logic.
  //
  // tmux send-keys doesn't support `--` option-terminator, so a chunk that
  // starts with '-' parses as a flag ("command send-keys: unknown flag -s"
  // on Hungarian suffixes like -szal/-vel/-ban). Slide the boundary up to a
  // few chars past any '-' that lands at the start of the next chunk. Capped
  // so a long run of dashes doesn't inflate one chunk past the paste-detector
  // threshold; if the cap is reached, prepend a space to the chunk instead.
  const MAX_SLIDE = 8
  const sendChunks = async (): Promise<void> => {
    let i = 0
    while (i < oneLine.length) {
      let end = Math.min(i + CHUNK, oneLine.length)
      let slide = 0
      while (end < oneLine.length && oneLine[end] === '-' && slide < MAX_SLIDE) {
        end++; slide++
      }
      let chunk = oneLine.slice(i, end)
      if (chunk.startsWith('-')) chunk = ' ' + chunk
      runTmux(host, ['send-keys', '-t', session, '-l', chunk], { timeout: 5000 })
      i = end
      if (i < oneLine.length) await delay(30)
    }
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
  }
  await sendChunks()

  // Post-send retry loop. The payload hint is the first chunk of oneLine
  // (truncated to a safe length) so the verbatim-stuck path has something
  // recognisable to substring-match against without leaking the whole
  // prompt body into log lines should the give-up branch fire.
  //
  // Two stuck modes, two recoveries (see decideSubmitFollowup):
  //   - VERBATIM text parked under an idle footer -> a plain Enter submits it
  //     ('retry-enter').
  //   - A `[Pasted text #N]` placeholder -> a plain Enter does NOT submit it
  //     (proven: Enter only expands the stub to still-parked verbatim text,
  //     and once the text spans multiple visual rows a plain Enter inserts a
  //     newline rather than submitting). The placeholder forms when several
  //     chunks coalesce into one >~700-char PTY read under tmux-server
  //     contention, tripping the TUI's bracketed-paste detector. The only
  //     reliable fix is to Ctrl-C the buffer empty and re-send the chunks
  //     ('clear-and-resend'). The same Ctrl-C path also clears an expanded
  //     multi-row verbatim buffer that a plain Enter cannot submit, so a
  //     resend that itself parks is re-cleared and retried until it lands.
  const payloadHint = oneLine.slice(0, Math.min(oneLine.length, 96))
  for (let attempt = 0; ; attempt++) {
    await delay(SUBMIT_RETRY_POLL_MS)
    const pane = capturePane(session, host)
    const action = decideSubmitFollowup(pane, payloadHint, attempt, SUBMIT_RETRY_MAX_ATTEMPTS)
    if (action === 'done') break
    if (action === 'give-up') {
      logger.warn({ session, attempt }, 'sendPromptToSession: prompt still parked after retries')
      break
    }
    if (action === 'clear-and-resend') {
      // Placeholder confirmed in the pane (box non-empty, not busy), so the
      // Ctrl-C in discardPlaceholderBuffer is safe. Clear it, then replay the
      // chunk stream. The loop re-samples on the next iteration and will keep
      // recovering (or give up at the budget) if the resend itself parks.
      logger.info({ session, attempt }, 'sendPromptToSession: paste placeholder detected; clearing and re-sending')
      if (!(await discardPlaceholderBuffer(session, host))) {
        logger.warn({ session, attempt }, 'sendPromptToSession: failed to clear paste placeholder before resend')
      }
      try {
        await sendChunks()
      } catch (err) {
        logger.warn({ err, session, attempt }, 'Clear-and-resend chunk replay failed')
        break
      }
      continue
    }
    // action === 'retry-enter'
    try {
      runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    } catch (err) {
      logger.warn({ err, session, attempt }, 'Retry-Enter send failed')
      break
    }
  }
    return 'sent'
  }

  // 'held': the caller already owns this pane's lane (e.g. the stuck-input
  // recovery clears + re-injects as ONE recover-mode critical section). Re-
  // acquiring the same lane here would deadlock against ourselves, so emit
  // directly.
  if (lockMode === 'held') {
    return emitToPane()
  }

  const lockResult = await withSessionSendLock(session, host, lockMode, emitToPane)
  if (!lockResult.ran) {
    // recover mode + lane busy: a delivery is mid-flight into this pane. Do NOT
    // race it (we would clear or submit the wrong buffer). Skip this round and
    // say so out loud -- a skip nobody logs is not a skip.
    logger.info({ session }, 'sendPromptToSession: pane delivery in progress; recover-mode send skipped this round')
    return 'skipped-locked'
  }
  if (lockResult.failedOpen) {
    // Fail-open: the wait budget elapsed against a stuck holder and we wrote
    // without the lock. Delivery still happened; log loudly so a wedged holder
    // is visible rather than silently degrading into re-interleaving.
    logger.warn({ session }, 'sendPromptToSession: delivery lock wait budget elapsed; sent WITHOUT the per-pane lock (fail-open) -- a holder may be wedged')
  }
  return 'sent'
}

// How long to wait between the two capture samples when the first one
// looks idle. The Claude Code UI renders the "idle footer without `esc
// to interrupt`" line for ~1 frame after a turn submits before the
// spinner lands; a quarter-second settle window is well past that.
const PANE_READY_CONFIRM_DELAY_MS = 250

// Send a bare Enter to a session. Used by the stuck-input watcher to
// re-submit a prompt whose trailing Enter was swallowed on the channel-
// notification path (where the plugin, not sendPromptToSession, delivered
// the text, so the post-send retry budget never ran). Best-effort: a
// tmux failure is logged and swallowed so the watcher loop keeps going.
export function sendEnterToSession(session: string, host: string | null = null): boolean {
  try {
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    return true
  } catch (err) {
    logger.warn({ err, session }, 'sendEnterToSession: failed to send recovery Enter')
    return false
  }
}

// Capture a pane snapshot with an execSync timeout. Null on any error so
// the caller can treat "capture failed" as "not ready".
export function capturePane(session: string, host: string | null = null): string | null {
  try {
    // Capture WITH colour, strip a trailing /rename session-title banner, then
    // remove all remaining ANSI. For a pane without a banner this is byte-for-byte
    // the old `capture-pane -p` output; when a pathological rename-banner is pinned
    // to the bottom it is removed so the live footer/spinner classifies normally
    // (a banner otherwise pins detectPaneState 'unknown', blocking scheduler +
    // inter-agent delivery). See stripSessionTitleBanner.
    return stripAllAnsi(stripSessionTitleBanner(captureTmux(host, ['capture-pane', '-t', session, '-e', '-p'])))
  } catch {
    return null
  }
}

// Capture a pane for STUCK-INPUT detection, with the editor's dim "ghost
// suggestion" autocomplete removed. Captures WITH colour (`-e`) and strips the
// SGR-2 (dim) ghost + all ANSI, so a hint shown in an empty input box is never
// mistaken for a genuinely parked input. Every auto-submitting recovery path
// (channel-monitor recoverStuckInputForSession, stuck-input-watcher
// bareEnterRecovery) MUST read the pane through THIS, not plain capturePane --
// otherwise the dim ghost reads as real text and gets re-typed + Enter-
// submitted (phantom prompt-injection, 2026-06-26). Returns null on capture
// failure (treated as "nothing parked"), matching capturePane's contract.
export function captureParkedInputView(session: string, host: string | null = null): string | null {
  try {
    return stripGhostSuggestion(captureTmux(host, ['capture-pane', '-t', session, '-e', '-p']))
  } catch {
    return null
  }
}

// Check if a Claude Code tmux session is ready to accept a new prompt.
//
// The detection has two layers, both needed to close the frame-level
// false-positive that let PR1+PR2's smoke test fire a prompt into a pane
// that was actually mid-thinking:
//
//   1. detectPaneState() looks for a set of turn-scoped busy signals
//      (spinner glyph labels paired with the runtime tail, token-count
//      pattern, and the footer's `esc to interrupt` marker) so even the
//      single frame where the footer lacks `· esc to interrupt` is
//      classified busy by the spinner that is already rendered above
//      the input box.
//
//   2. Double-sample confirmation: if the first capture looks idle, we
//      sleep 250ms and re-capture. Only agreement from both samples
//      returns true. Cost on the ready path: ~250ms sleep plus a second
//      tmux capture-pane round-trip (typically tens of ms). Busy pass
//      through layer 1 and return immediately without the delay.
//
// A saturated pane ("100% context used") is refused up front: it can present
// as perfectly idle, so without this a new prompt would be dispatched into a
// session that cannot act on it. We only log/audit the refusal here; recovery
// is the context-guard runner's saturation net (fresh restart -- see
// src/web/context-guard-runner.ts), so this predicate stays a pure,
// dependency-free readiness check. NOTE the refusal is part of a deadlock by
// design: Claude Code's auto-compact only runs when a new turn starts, and
// this refusal is exactly what prevents a new turn -- so a saturated session
// never self-heals and MUST be restarted from outside.
export async function isSessionReadyForPrompt(session: string, host: string | null = null): Promise<boolean> {
  // Dim-ghost tolerant idle read: CC >=2.1.202 paints a dim placeholder into
  // the empty input box, which a plain capture reads as parked text. Only when
  // the plain view says 'typing' do we pay for the second (-e, dim-stripped)
  // capture to decide whether anything REAL is parked (see
  // idleConsideringDimGhost / captureParkedInputView).
  const idleOrGhost = (plain: string): boolean =>
    idleConsideringDimGhost(plain, detectPaneState(plain) === 'typing' ? captureParkedInputView(session, host) : null)
  const first = capturePane(session, host)
  if (first == null) return false
  if (paneShowsContextSaturation(first)) {
    logger.warn({ session }, 'dispatch: refusing prompt — session shows context saturation (100% context)')
    return false
  }
  if (!idleOrGhost(first)) return false

  await delay(PANE_READY_CONFIRM_DELAY_MS)

  const second = capturePane(session, host)
  if (second == null) return false
  if (paneShowsContextSaturation(second)) {
    logger.warn({ session }, 'dispatch: refusing prompt — session shows context saturation (100% context)')
    return false
  }
  return idleOrGhost(second)
}

// How long to wait between the two parked-input captures when deciding whether
// the input box is STUCK (stale) vs being actively typed. Identical parked text
// across this gap means nobody is typing -> it is a stranded artifact.
const PARKED_STABLE_CONFIRM_MS = 2000
// Settle after a batch of clearing keystrokes so the next capture reflects the
// emptied box.
const PARKED_CLEAR_SETTLE_MS = 300
// How often to re-capture while working through parkedClearSequence(): often
// enough that a box which empties early stops right away, rarely enough that the
// settle delay is not paid per keystroke.
const PARKED_CLEAR_RECHECK_EVERY = 8
// A parked input that resists clearing must NOT be retried on every router tick:
// each attempt awaits ~PARKED_STABLE_CONFIRM_MS on the settle
// delay, so a permanently-stuck box would otherwise starve the loop, stall the HTTP server
// (health probes read 000) and drive the watchdog into a dashboard restart loop.
// Retry the SAME stuck text at most once per this window, per session.
const UNWEDGE_COOLDOWN_MS = 30_000
// Escalate to the operator (NOTIFY only -- a Telegram message, never a
// keystroke) once per stuck episode after this many consecutive confirmed-stuck
// detections (~one per UNWEDGE_COOLDOWN_MS). The main agent escalates sooner
// because its box is NEVER auto-cleared (the parked line may be a real reply),
// so escalation is the only recovery; a sub-agent escalates only after the
// auto-clear has genuinely failed several times.
const SUBAGENT_PARKED_ESCALATE_AFTER = 6  // ~3min for a sub-agent whose auto-clear keeps failing
// MAINBOXPARK816: two-stage escalation for the (never-cleared) main box. Each
// fails increment costs one UNWEDGE_COOLDOWN_MS round, so 6 = ~3 min visible to
// the heartbeat, 12 = ~6 min -> the owner's phone as the FINAL stage (double
// the first threshold, per the spec).
export const MAIN_PARKED_HEARTBEAT_AFTER = 6
export const MAIN_PARKED_OWNER_AFTER = 12

// Pure decision, exported for tests: which escalation stage applies. 'owner'
// fires once per episode (ownerNotified latches via the record's escalated
// flag); afterwards the state stays 'heartbeat'-visible until the box clears.
export function decideMainParkedEscalation(
  fails: number,
  ownerNotified: boolean,
): 'none' | 'heartbeat' | 'owner' {
  if (fails >= MAIN_PARKED_OWNER_AFTER && !ownerNotified) return 'owner'
  if (fails >= MAIN_PARKED_HEARTBEAT_AFTER) return 'heartbeat'
  return 'none'
}

// MAINBOXPARK816 stage-1 surface: the heartbeat round (same process) reads this
// and puts the fact into its prompt -- deliberately NOT the inter-agent queue,
// because a message queued to the main agent would strand behind the very
// parked text it reports. Returns null when there is no FRESH parked episode
// (last attempt older than two cooldown windows = the box cleared or the
// router stopped observing it).
export function getMainParkedState(nowMs: number = Date.now()):
  | { preview: string; fails: number; approxMinutes: number }
  | null {
  const rec = unwedgeAttempts.get('local:' + MAIN_CHANNELS_SESSION)
  if (!rec || rec.fails < MAIN_PARKED_HEARTBEAT_AFTER) return null
  if (nowMs - rec.last > 2 * UNWEDGE_COOLDOWN_MS + PARKED_STABLE_CONFIRM_MS) return null
  return {
    preview: rec.sig.slice(0, 80),
    fails: rec.fails,
    approxMinutes: Math.round((rec.fails * UNWEDGE_COOLDOWN_MS) / 60000),
  }
}
// Per-session record of the last un-wedge attempt: when, on what text, how many
// consecutive attempts failed to empty the box, and whether we already notified
// the operator for this exact stuck text (one-shot; resets when sig/clears).
const unwedgeAttempts = new Map<string, { last: number; sig: string; fails: number; escalated: boolean }>()

// Un-wedge a session whose input box holds STALE parked text: a non-submitted
// line (e.g. a weak local model that typed its heartbeat reply into the box
// instead of ending the turn). Parked text makes isSessionReadyForPrompt()
// false forever, so every inbound message strands as pending and the channel
// goes silent with no recovery. Acts ONLY when the pane is 'typing' (idle WITH
// parked text -- never 'busy'/processing) AND the text is unchanged across a
// short settle, so input a human or agent is actively typing is never clobbered.
// Returns true if it cleared something (caller should retry delivery next tick).
export async function clearStaleParkedInput(session: string, host: string | null = null): Promise<boolean> {
  const a = capturePane(session, host)
  if (a == null || detectPaneState(a) !== 'typing') return false
  // DIM-GUARD (2026-06-30, Szabi insight): extract the parked TEXT from the
  // dim-stripped (-e) view. Ghost/phantom frames -- stale captures, placeholder
  // hints, a persona fragment left by a send-keys delivery (the "Koszi a halakat."
  // false-positive) -- render DIM (SGR-2 faint) and are stripped by
  // captureParkedInputView, so they read as NO parked text and are never treated
  // as a wedge (no clear, no escalate). Only a REAL typed line (normal intensity)
  // survives the strip. Falls back to the plain capture only if the -e capture
  // fails (rare), preserving prior behaviour in that edge case.
  const parked = parkedInputText(captureParkedInputView(session, host) ?? a)
  if (!parked) return false

  // Cooldown guard FIRST, before any blocking sleep: if the same parked text was
  // attempted within the cooldown window, bail in microseconds. This is what
  // keeps a stubborn box from starving the event loop on every router tick --
  // the root cause of the dashboard crash-loop (constant ~2s blocking sleeps ->
  // HTTP 000 -> watchdog restart -> re-wedge on the same persisted input).
  const key = (host ?? 'local') + ':' + session
  const nowMs = Date.now()
  const prev = unwedgeAttempts.get(key)
  if (prev && prev.sig === parked && nowMs - prev.last < UNWEDGE_COOLDOWN_MS) return false

  await delay(PARKED_STABLE_CONFIRM_MS)
  const b = capturePane(session, host)
  // Changed (someone is typing) or already cleared -> leave it alone, and do not
  // record an attempt (this was never a stuck box). Compare on the SAME dim-
  // stripped view as the initial extraction so a dim ghost can't flip the result.
  if (b == null || detectPaneState(b) !== 'typing' || parkedInputText(captureParkedInputView(session, host) ?? b) !== parked) return false

  // The main agent's input box is NEVER auto-cleared (a parked line could be a
  // real reply -- the 2026-06-30 "Balogh" near-miss). That stays absolute.
  //
  // MAINBOXPARK816 (2026-08-16): the total MUTE is gone, because its premise
  // aged out. The 2026-06-30 mute existed for dim ghost-frame noise -- but the
  // dim-guard above now strips ghosts BEFORE this branch, so a line that gets
  // here is normal-intensity, 2s-stable, REAL text. And a parked main box is
  // exactly the state that silences the channel UNSUPERVISED: every sub-agent
  // gets an auto-heal for this, only the main agent got silence. Two-stage
  // escalation, never a keystroke:
  //   stage 1 (fails >= MAIN_PARKED_HEARTBEAT_AFTER, ~3 min): WARN log + the
  //     state is exposed via getMainParkedState() so the heartbeat round's
  //     prompt carries it (same process; NOT the inter-agent queue -- an alert
  //     queued to the main agent would strand BEHIND the very text it reports).
  //   stage 2 (fails >= MAIN_PARKED_OWNER_AFTER, ~6 min, one-shot/episode):
  //     notifyChannel direct to the owner (pure HTTP, does not touch the box)
  //     with the CONCRETE manual fix -- a message actionable in seconds, not
  //     "something is wrong".
  if (session === MAIN_CHANNELS_SESSION) {
    const fails = (prev && prev.sig === parked ? prev.fails : 0) + 1
    let escalated = !!(prev && prev.sig === parked && prev.escalated)
    const stage = decideMainParkedEscalation(fails, escalated)
    if (stage === 'owner') {
      const preview = parked.slice(0, 80).replace(/[<>&]/g, ' ')
      notifyChannel(
        `🚨 A fo agens (${session}) input-mezojeben ~${Math.round((fails * UNWEDGE_COOLDOWN_MS) / 60000)} perce all egy parkolt sor, ` +
        `es emiatt a csatorna nem dolgoz fel bejovo uzenetet. KEZI FELOLDAS (par masodperc): ` +
        `tmux attach -t ${session}, majd Ctrl-C es utana Ctrl-U (a sor torlese), vegul kilepes: Ctrl-B d. ` +
        `A parkolt sor eleje: "${preview}"`,
      ).catch(() => { /* notify is best-effort */ })
      escalated = true
      logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: main-agent parked input -- owner notified with manual fix (box untouched)')
    } else if (stage === 'heartbeat') {
      logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: main-agent parked input -- persisting; visible to the heartbeat round (box untouched)')
    } else {
      logger.debug({ session, parked: parked.slice(0, 60), fails }, 'message-router: main-agent parked input -- left untouched')
    }
    unwedgeAttempts.set(key, { last: nowMs, sig: parked, fails, escalated })
    return false
  }

  // Forward deletion, budgeted by the visible row count -- see the rationale and
  // the 2026-08-01 measurement above parkedClearSequence(). The cursor sits at
  // offset 0 of the buffer, so the previous Ctrl-U rounds were no-ops and the
  // single C-a + C-k escalation could only ever strip ONE line off a multi-line
  // box. Re-check every few keystrokes so a box that empties early stops
  // immediately instead of spending the whole budget.
  const sequence = parkedClearSequence(parkedInputRowCount(a))
  for (let i = 0; i < sequence.length; i++) {
    runTmux(host, ['send-keys', '-t', session, sequence[i]], { timeout: 5000 })
    if (i % PARKED_CLEAR_RECHECK_EVERY === PARKED_CLEAR_RECHECK_EVERY - 1) {
      await delay(PARKED_CLEAR_SETTLE_MS)
      const after = capturePane(session, host)
      if (after == null || detectPaneState(after) !== 'typing') break
    }
  }
  await delay(PARKED_CLEAR_SETTLE_MS)

  // Verify the box is ACTUALLY empty before claiming success: only then is the
  // pending message safe to deliver next tick. Otherwise record the failure so
  // the cooldown guard above backs us off instead of hammering every tick.
  const final = capturePane(session, host)
  const stillStuck = final != null && detectPaneState(final) === 'typing' && parkedInputText(final) === parked
  if (stillStuck) {
    const fails = (prev && prev.sig === parked ? prev.fails : 0) + 1
    let escalated = !!(prev && prev.sig === parked && prev.escalated)
    // A sub-agent box that resists the Ctrl-U clear this many times is genuinely
    // wedged (not the usual junk heartbeat line the auto-clear handles) -- surface
    // it to the operator ONCE so it cannot stall silently like the 1h main-agent
    // incident did behind a lone WARN.
    if (!escalated && fails >= SUBAGENT_PARKED_ESCALATE_AFTER) {
      const preview = parked.slice(0, 80).replace(/[<>&]/g, ' ')
      notifyChannel(
        `⚠️ Egy sub-agent (${session}) input-mezojebe beragadt egy parkolt sor, ` +
        `az auto-tisztitas ${fails}x sikertelen -- lehet kezi beavatkozas kell. Reszlet: "${preview}"`,
      ).catch(() => { /* notify is best-effort */ })
      escalated = true
      logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: sub-agent parked input resisted clearing -- escalated to operator')
    }
    unwedgeAttempts.set(key, { last: nowMs, sig: parked, fails, escalated })
    logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: parked input resisted clearing, backing off')
    return false
  }
  unwedgeAttempts.set(key, { last: nowMs, sig: parked, fails: 0, escalated: false })
  logger.warn({ session, parked: parked.slice(0, 60) }, 'message-router: cleared stale parked input (channel un-wedge)')
  return true
}

