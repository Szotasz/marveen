import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { OLLAMA_URL } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import {
  paneLooksIdle,
  decideSubmitFollowup,
  shouldClearTruncatedPreamble,
  detectsPastePlaceholder,
  detectPaneState,
  parkedInputText,
  stripGhostSuggestion,
} from '../pane-state.js'
import { agentDir, readAgentModel, readAgentClaudeConfigDir, readAgentChannelProvider, readAgentAuthMode, readAgentDisplayName, readAgentRemoteConfig, readAgentRemoteHost } from './agent-config.js'
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
import { CHANNEL_PROVIDER, MAIN_AGENT_ID } from '../config.js'
import { loadProfileTemplate } from './profiles.js'
import { resolveAgentSecurityProfile } from './agent-team.js'
import { writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { schedulePluginUnlockAfterRespawn } from './channel-plugin-unlock.js'
import { getSecret } from './vault.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// The fleet's channel plugins keyed by provider. A sub-agent must enable ONLY
// its own provider's plugin; the others are forced off so it cannot spawn a
// competing poller against the main agent's bot token (the dup-poller / 409
// Conflict class). Keep in sync with the user-scope enabledPlugins ids.
export const CHANNEL_PLUGIN_IDS: Record<string, string> = {
  telegram: 'telegram@claude-plugins-official',
  slack: 'slack-channel@marveen-marketplace',
  discord: 'discord@claude-plugins-official',
  googlechat: 'googlechat@claude-channel-googlechat',
}

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
  const ownPlugin = explicitProvider ? CHANNEL_PLUGIN_IDS[explicitProvider] : undefined
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

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord' || perAgent === 'googlechat') return perAgent
  return CHANNEL_PROVIDER
}

export function agentSessionName(name: string): string {
  return `agent-${name}`
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
  const inv = buildTmuxInvocation(host, TMUX, tmuxArgs)
  execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000) })
}

function captureTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): string {
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, TMUX, tmuxArgs)
  return execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), encoding: 'utf-8' })
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
    scheduleIdentitySetup(session, readAgentDisplayName(name), host)
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, host }, 'Failed to start remote agent tmux session')
    return { ok: false, error: 'Failed to start remote tmux session' }
  }
}

export function startAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string } {
  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }

  // Remote agents are handled entirely by the ssh path above (with its own
  // start guard), before any local already-running check / scaffolding.
  const remote = readAgentRemoteConfig(name)
  if (remote.host && remote.workdir) {
    return startRemoteAgentProcess(name, remote.host, remote.workdir, opts)
  }

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

  const session = agentSessionName(name)

  try {
    try {
      runTmux(null, ['kill-session', '-t', session])
      execSync('sleep 3', { timeout: 5000 })
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
      reapDetachedChannelClaudes({ tmuxPath: TMUX })
    } catch (err) {
      logger.warn({ err, name }, 'pre-launch detached-claude reap failed (continuing)')
    }

    const model = readAgentModel(name)
    const authMode = readAgentAuthMode(name)
    const isClaude = model.startsWith('claude-')
    const isDeepseek = model.startsWith('deepseek-')
    const isOllama = !isClaude && !isDeepseek
    // ANTHROPIC_MODEL is REQUIRED for non-Claude models: the interactive TUI
    // validates the `--model` flag against known Anthropic models and silently
    // falls back to the built-in default (claude-opus-...) for an unrecognized
    // value like `qwen3.6:27b` or `deepseek-v4-pro` -- which then errors against
    // the custom ANTHROPIC_BASE_URL ("model does not exist"). The env var is
    // authoritative and bypasses that validation. (`--print` honors --model, but
    // the agents run the TUI.) Single-quoted so a `:` in the tag is shell-safe.
    const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL='${model}' && ` : ''
    const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
    const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${deepseekKey}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && export ANTHROPIC_MODEL='${model}' && ` : ''
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
    if (name !== MAIN_AGENT_ID) {
      const settingsPath = join(agentDir(name), '.claude', 'settings.json')
      try {
        const s = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        // Gate the enable decision on the SAME signal as the --channels launch
        // flag: a real own bot token in this agent's channel .env (token, above).
        // A genuine own-token agent enables its own provider's plugin; a channel-
        // less agent (no own token, only the legacy/global fallback that still
        // marks hasChannel) yields null -> all providers disabled, so it never
        // fights the main agent over the shared getUpdates slot. Keying on the
        // explicit channelProvider config field instead (always null for sub-agents)
        // was the regression that disabled the plugin for every legitimately-
        // channelled sub-agent after a respawn (truly-unreachable plugin, no poller).
        s.enabledPlugins = scopeChannelPlugins(
          ownChannelProviderForScope(!!token, agentProvider),
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
    const claudeConfigDir = readAgentClaudeConfigDir(name)
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
    const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : agentProvider === 'discord' ? 'DISCORD_STATE_DIR' : agentProvider === 'googlechat' ? 'GOOGLECHAT_STATE_DIR' : 'TELEGRAM_STATE_DIR'
    const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
    // Slack plugin is third-party; its "not on approved allowlist" check is
    // bypassed via `allowedChannelPlugins` in /Library/Application Support/ClaudeCode/managed-settings.json.
    const auditLogEnv = agentProvider === 'slack' ? ` && export SLACK_AUDIT_LOG="${agentChannelDir}/audit.jsonl"` : ''
    const channelSetup = hasChannel
      ? `export ${stateEnvVar}="${agentChannelDir}"${auditLogEnv} && `
      : ''
    const channelFlag = hasChannel ? `--channels plugin:${provider.pluginId}` : ''
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
    // Single-quote `${model}` so values like `claude-opus-4-8[1m]` (1M-context
    // suffix) are not glob-expanded by the shell that tmux spawns the command in.
    const cmd = `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${promptSuggestionEnv}${mcpEnv}${channelSetup}${apiKeyEnv}${claudeConfigEnv}${ollamaEnv}${deepseekEnv}cd "${dir}" && ${CLAUDE} ${continueFlag}${skipFlag}--model '${model}' ${channelFlag}`.trimEnd()
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
    scheduleIdentitySetup(session, readAgentDisplayName(name))

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

export function stopAgentProcess(name: string): { ok: boolean; error?: string } {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }

  const host = readAgentRemoteHost(name)

  try {
    runTmux(host, ['kill-session', '-t', session], { timeout: 5000 })
    execSync('sleep 2', { timeout: 4000 })
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

export function restartAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string } {
  if (isAgentRunning(name)) {
    const stopResult = stopAgentProcess(name)
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

function dismissSurveyModalIfPresent(session: string, host: string | null = null): void {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!SURVEY_MODAL_RX.test(pane)) return
    runTmux(host, ['send-keys', '-t', session, '0'], { timeout: 5000 })
    // Modal close is one frame; settle window so the next send-keys lands in
    // the prompt input, not the now-stale modal handler.
    execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })
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

export function dismissResumeSummaryModalIfPresent(session: string, host: string | null = null): void {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!RESUME_SUMMARY_MODAL_RX.test(pane)) return
    runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    // /compact starts immediately and can run for minutes; we only need to
    // unblock the modal so detectPaneState can transition off 'unknown'.
    execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })
    logger.info({ session }, 'Dismissed Claude Code resume-from-summary modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss resume-from-summary modal')
  }
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
export function scheduleIdentitySetup(session: string, displayName: string, host: string | null = null): void {
  setTimeout(() => {
    try {
      dismissSurveyModalIfPresent(session, host)
      dismissResumeSummaryModalIfPresent(session, host)
    } catch (err) {
      logger.warn({ err, session }, 'Post-restart modal dismiss failed')
    }
    setTimeout(() => {
      try {
        for (const cmd of identitySlashCommands(displayName)) {
          runTmux(host, ['send-keys', '-t', session, cmd, 'Enter'], { timeout: 5000 })
          execFileSync('/bin/sleep', ['1'], { timeout: 2000 })
        }
        logger.info({ session, displayName }, 'Set session /name')
      } catch (err) {
        logger.warn({ err, session, displayName }, 'Failed to set session /name')
      }
    }, IDENTITY_SEND_DELAY_MS)
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
const SUBMIT_RETRY_POLL_MS = '0.3'

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
// String form for /bin/sleep (seconds), kept in sync with PANE_IDLE_POLL_MS.
const PANE_IDLE_POLL_S = (PANE_IDLE_POLL_MS / 1000).toFixed(3)

// Block until the session's pane looks idle, or the budget elapses. Returns
// true if idle was observed, false on timeout-still-busy (caller proceeds
// best-effort). Reuses the shared paneLooksIdle predicate -- the SAME rule the
// readiness check and the auto-restart idle-guard use -- so the busy regex is
// never re-inlined here. A capture failure is treated as "not yet idle" and we
// keep polling within the budget (a transient tmux hiccup should not be read as
// idle and let us blast a prompt into a busy pane).
export function waitForPaneIdle(
  session: string,
  host: string | null = null,
  timeoutMs: number = PANE_IDLE_WAIT_TIMEOUT_MS,
): boolean {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pane = capturePane(session, host)
    if (pane != null && paneLooksIdle(pane)) return true
    if (Date.now() >= deadline) return false
    try { execFileSync('/bin/sleep', [PANE_IDLE_POLL_S], { timeout: 2000 }) } catch { /* best effort */ }
  }
}

// Buffer-clear (Ctrl-U) used pre-flight when shouldClearTruncatedPreamble
// flags a stale preamble. Sent as a single key name (no `-l` literal
// flag) so tmux interprets it as the control sequence.
export function clearInputBuffer(session: string, host: string | null = null): void {
  try {
    runTmux(host, ['send-keys', '-t', session, 'C-u'], { timeout: 5000 })
    // Settle briefly so the next send-keys lands in the freshly cleared
    // buffer rather than racing the Ctrl-U.
    execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
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
const PLACEHOLDER_DISCARD_SETTLE_S = '0.45'

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
function discardPlaceholderBuffer(session: string, host: string | null = null): boolean {
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
    try { execFileSync('/bin/sleep', [PLACEHOLDER_DISCARD_SETTLE_S], { timeout: 2000 }) } catch { /* best effort */ }
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
export function sendPromptToSession(
  session: string,
  text: string,
  host: string | null = null,
  opts: { waitForIdle?: boolean } = {},
): void {
  dismissSurveyModalIfPresent(session, host)
  dismissResumeSummaryModalIfPresent(session, host)

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
  const waitForIdle = opts.waitForIdle !== false
  if (waitForIdle && !waitForPaneIdle(session, host)) {
    logger.warn({ session }, 'sendPromptToSession: pane still busy after wait-until-idle budget; sending best-effort')
  }

  // Pre-flight buffer-clear when a stale preamble is detected. Reading
  // the pane is best-effort: a capture failure here means we cannot
  // prove the buffer is clean, but proceeding without the clear is no
  // worse than the pre-fix status quo.
  try {
    const preCapture = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (shouldClearTruncatedPreamble(preCapture)) {
      logger.info({ session }, 'Cleared stale preamble from input buffer before sending prompt')
      clearInputBuffer(session, host)
    }
  } catch (err) {
    logger.warn({ err, session }, 'Pre-send capture-pane failed; skipping truncated-preamble check')
  }

  const oneLine = text.replace(/\r?\n/g, ' ')
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
  const sendChunks = (): void => {
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
      if (i < oneLine.length) execFileSync('/bin/sleep', ['0.03'], { timeout: 1000 })
    }
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
  }
  sendChunks()

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
    try { execFileSync('/bin/sleep', [SUBMIT_RETRY_POLL_MS], { timeout: 2000 }) } catch { /* best effort */ }
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
      if (!discardPlaceholderBuffer(session, host)) {
        logger.warn({ session, attempt }, 'sendPromptToSession: failed to clear paste placeholder before resend')
      }
      try {
        sendChunks()
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
}

// How long to wait between the two capture samples when the first one
// looks idle. The Claude Code UI renders the "idle footer without `esc
// to interrupt`" line for ~1 frame after a turn submits before the
// spinner lands; a quarter-second settle window is well past that.
const PANE_READY_CONFIRM_DELAY_S = '0.25'

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
    return captureTmux(host, ['capture-pane', '-t', session, '-p'])
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
export function isSessionReadyForPrompt(session: string, host: string | null = null): boolean {
  const first = capturePane(session, host)
  if (first == null) return false
  if (!paneLooksIdle(first)) return false

  try { execFileSync('/bin/sleep', [PANE_READY_CONFIRM_DELAY_S], { timeout: 2000 }) } catch { /* best effort */ }

  const second = capturePane(session, host)
  if (second == null) return false
  return paneLooksIdle(second)
}

// How long to wait between the two parked-input captures when deciding whether
// the input box is STUCK (stale) vs being actively typed. Identical parked text
// across this gap means nobody is typing -> it is a stranded artifact.
const PARKED_STABLE_CONFIRM_S = '2'
// Settle after a Ctrl-U so the next capture reflects the cleared box.
const PARKED_CLEAR_SETTLE_S = '0.3'
// Bound the Ctrl-U presses for a (possibly multi-line) stale parked input.
const PARKED_CLEAR_MAX = 3

// Un-wedge a session whose input box holds STALE parked text: a non-submitted
// line (e.g. a weak local model that typed its heartbeat reply into the box
// instead of ending the turn). Parked text makes isSessionReadyForPrompt()
// false forever, so every inbound message strands as pending and the channel
// goes silent with no recovery. Acts ONLY when the pane is 'typing' (idle WITH
// parked text -- never 'busy'/processing) AND the text is unchanged across a
// short settle, so input a human or agent is actively typing is never clobbered.
// Returns true if it cleared something (caller should retry delivery next tick).
export function clearStaleParkedInput(session: string, host: string | null = null): boolean {
  const a = capturePane(session, host)
  if (a == null || detectPaneState(a) !== 'typing') return false
  const parked = parkedInputText(a)
  if (!parked) return false
  try { execFileSync('/bin/sleep', [PARKED_STABLE_CONFIRM_S], { timeout: 4000 }) } catch { /* best effort */ }
  const b = capturePane(session, host)
  // Changed (someone is typing) or already cleared -> leave it alone.
  if (b == null || detectPaneState(b) !== 'typing' || parkedInputText(b) !== parked) return false
  for (let i = 0; i < PARKED_CLEAR_MAX; i++) {
    runTmux(host, ['send-keys', '-t', session, 'C-u'], { timeout: 5000 })
    try { execFileSync('/bin/sleep', [PARKED_CLEAR_SETTLE_S], { timeout: 2000 }) } catch { /* best effort */ }
    const after = capturePane(session, host)
    if (after == null || detectPaneState(after) !== 'typing') break
  }
  logger.warn({ session, parked: parked.slice(0, 60) }, 'message-router: cleared stale parked input (channel un-wedge)')
  return true
}

