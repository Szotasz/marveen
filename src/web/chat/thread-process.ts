// Thread session lifecycle for the chat app: N extra Claude Code sessions per
// agent, one per conversation thread, next to the untouched main session
// (agent-<name>). Deliberately narrower than startAgentProcess:
//
//   - local only (no remote/ssh agents -- a chat thread runs where the
//     orchestrator runs)
//   - channel-less ALWAYS: no --channels flag, channel state-dir env vars
//     pointed at an empty per-thread dir and token vars unset, so the channel
//     plugin in the shared agent workdir has nothing to poll with (the same
//     mechanism startAgentProcess uses for channel-less agents -- a second
//     poller on the agent's bot token would 409-war the main session)
//   - deterministic session id: spawned with `claude --session-id <uuid>`
//     (the uuid is minted at thread creation and stored on the chat_threads
//     row), so the transcript file is <uuid>.jsonl and suspend/reopen is
//     `--resume <uuid>` with zero "newest file" guessing
//
// The thread runs in the agent's own workdir, so it shares CLAUDE.md and the
// memory tiers with the main session -- only the conversation context is
// separate. That is the whole point of the feature.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../../platform.js'
import { logger } from '../../logger.js'
import { OLLAMA_URL } from '../../config.js'
import {
  agentDir, readAgentModel, readAgentSecurityProfile, readAgentClaudeConfigDir,
  readAgentAuthMode, readAgentRemoteConfig,
} from '../agent-config.js'
import { loadProfileTemplate } from '../profiles.js'
import { getSecret } from '../vault.js'
import { sessionExistsOnHost, sendPromptToSession, isSessionReadyForPrompt, scheduleIdentitySetup } from '../agent-process.js'
import { projectsDirFor } from '../active-model.js'
import { buildTmuxInvocation } from '../ssh-tmux.js'
import {
  type ChatThread, getChatThread, listOpenChatThreads, setChatThreadStatus,
} from '../../db.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

export function threadSessionName(agentName: string, threadId: string): string {
  return `agent-${agentName}-thread-${threadId}`
}

export function isThreadRunning(agentName: string, threadId: string): boolean {
  return sessionExistsOnHost(null, threadSessionName(agentName, threadId))
}

// Pure command builder, unit-tested. Mirrors the relevant parts of
// startAgentProcess's launch line (PATH, model providers, per-agent api key /
// config dir, security-profile skip flag) minus everything channel-related.
export function buildThreadLaunchCommand(opts: {
  claudePath: string
  dir: string
  model: string
  resume: boolean
  sessionId: string
  skipPermissions: boolean
  claudeConfigDir?: string | null
  apiKey?: string | null
  ollamaUrl?: string
  deepseekKey?: string | null
  threadStateDir: string
}): string {
  const isClaude = opts.model.startsWith('claude-')
  const isDeepseek = opts.model.startsWith('deepseek-')
  const isOllama = !isClaude && !isDeepseek
  const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${opts.ollamaUrl ?? OLLAMA_URL} && ` : ''
  const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${opts.deepseekKey ?? ''}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && ` : ''
  const apiKeyEnv = isClaude && opts.apiKey ? `export ANTHROPIC_API_KEY="${opts.apiKey}" && ` : ''
  const claudeConfigEnv = opts.claudeConfigDir ? `export CLAUDE_CONFIG_DIR="${opts.claudeConfigDir}" && ` : ''
  // Channel neutralisation: empty state dir + no tokens => the plugin (auto-
  // loaded from the shared workdir's enabledPlugins) has no credentials and
  // stays inert in this session.
  const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
  const stateEnv = `export TELEGRAM_STATE_DIR="${opts.threadStateDir}" && export SLACK_STATE_DIR="${opts.threadStateDir}" && export DISCORD_STATE_DIR="${opts.threadStateDir}" && `
  const sessionFlag = opts.resume ? `--resume ${opts.sessionId} ` : `--session-id ${opts.sessionId} `
  const skipFlag = opts.skipPermissions ? '--dangerously-skip-permissions ' : ''
  // Single-quote the model for the same reason as startAgentProcess: ids like
  // `claude-opus-4-8[1m]` must not glob-expand.
  return `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && ${stateEnv}${apiKeyEnv}${claudeConfigEnv}${ollamaEnv}${deepseekEnv}cd "${opts.dir}" && ${opts.claudePath} ${sessionFlag}${skipFlag}--model '${opts.model}'`.trimEnd()
}

function runLocalTmux(args: string[]): void {
  const inv = buildTmuxInvocation(null, TMUX, args)
  execFileSync(inv.file, inv.args, { timeout: 10000 })
}

export function transcriptPathForThread(agentName: string, claudeSessionId: string): string {
  const dir = agentDir(agentName)
  const configDir = readAgentClaudeConfigDir(agentName) ?? undefined
  return join(projectsDirFor(dir, configDir), `${claudeSessionId}.jsonl`)
}

// Start (or reopen) a thread session. Fresh threads get --session-id; a
// suspended thread whose transcript already exists resumes it. A thread that
// was suspended before its first message has no transcript yet -- --resume
// would die instantly -- so it starts fresh under the SAME session id.
export function startThreadSession(agentName: string, thread: ChatThread): { ok: boolean; error?: string } {
  const dir = agentDir(agentName)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }
  if (readAgentRemoteConfig(agentName).host) {
    return { ok: false, error: 'Chat threads are not supported for remote agents' }
  }
  const session = threadSessionName(agentName, thread.id)
  if (sessionExistsOnHost(null, session)) return { ok: false, error: 'Thread session already running' }

  const threadStateDir = join(dir, '.claude', 'chat-thread-state')
  try { mkdirSync(threadStateDir, { recursive: true }) } catch { /* exists */ }

  const model = readAgentModel(agentName)
  const profile = loadProfileTemplate(readAgentSecurityProfile(agentName))
  const apiKey = readAgentAuthMode(agentName) === 'api' ? (getSecret(`agent-${agentName}-api-key`) ?? null) : null
  const deepseekKey = model.startsWith('deepseek-') ? (getSecret('DEEPSEEK_API_KEY') ?? null) : null
  const claudeConfigDir = readAgentClaudeConfigDir(agentName)
  const resume = existsSync(transcriptPathForThread(agentName, thread.claude_session_id))

  const cmd = buildThreadLaunchCommand({
    claudePath: CLAUDE,
    dir,
    model,
    resume,
    sessionId: thread.claude_session_id,
    skipPermissions: profile.permissionMode !== 'strict',
    claudeConfigDir,
    apiKey,
    deepseekKey,
    threadStateDir,
  })

  try {
    runLocalTmux(['new-session', '-d', '-s', session, cmd])
    setChatThreadStatus(thread.id, 'open')
    // Same post-spawn care as startAgentProcess: dismiss first-run/resume
    // modals once the TUI has rendered and set the session /name -- without
    // this a resumed thread can sit behind a "Resume from summary" modal and
    // every message bounces with "Thread is busy".
    scheduleIdentitySetup(session, thread.title || 'Chat szál')
    logger.info({ agentName, threadId: thread.id, session, resume }, 'Chat thread session started')
    return { ok: true }
  } catch (err) {
    logger.error({ err, agentName, threadId: thread.id }, 'Failed to start chat thread session')
    return { ok: false, error: 'Failed to start thread tmux session' }
  }
}

function killThreadSession(agentName: string, threadId: string): void {
  const session = threadSessionName(agentName, threadId)
  if (!sessionExistsOnHost(null, session)) return
  try {
    runLocalTmux(['kill-session', '-t', session])
  } catch (err) {
    logger.warn({ err, session }, 'Failed to kill thread tmux session')
  }
}

// Suspend = stop the process, keep the conversation reopenable (--resume).
export function suspendThread(agentName: string, threadId: string): boolean {
  killThreadSession(agentName, threadId)
  return setChatThreadStatus(threadId, 'suspended')
}

// Close = user says the task is done. Same teardown; only the status differs
// (closed threads drop out of the default thread list but stay reopenable).
export function closeThread(agentName: string, threadId: string): boolean {
  killThreadSession(agentName, threadId)
  return setChatThreadStatus(threadId, 'closed')
}

export function sendPromptToThread(agentName: string, threadId: string, text: string): { ok: boolean; error?: string } {
  const thread = getChatThread(threadId)
  if (!thread || thread.agent_id !== agentName) return { ok: false, error: 'Thread not found' }
  const session = threadSessionName(agentName, threadId)
  if (!sessionExistsOnHost(null, session)) {
    // Unlike the message-router's queue-and-retry (built for the always-on
    // main session), a chat message to a dead thread fails synchronously: the
    // caller reopens the thread explicitly. No silent 1-hour abandon window.
    return { ok: false, error: 'Thread session is not running' }
  }
  if (!isSessionReadyForPrompt(session)) return { ok: false, error: 'Thread is busy' }
  sendPromptToSession(session, text)
  return { ok: true }
}

// Pure idle-sweep decision, unit-tested separately from the tmux side effects.
export function pickIdleThreads(threads: ChatThread[], nowMs: number, idleMs: number): ChatThread[] {
  return threads.filter(t => t.status === 'open' && nowMs - t.last_activity_at >= idleMs)
}

// Backstop sweep for forgotten threads (user-driven close is the primary
// mechanism). Suspended threads cost nothing and reopen losslessly.
export function sweepIdleThreads(idleMinutes: number): number {
  const idleMs = idleMinutes * 60 * 1000
  let suspended = 0
  for (const t of pickIdleThreads(listOpenChatThreads(), Date.now(), idleMs)) {
    try {
      suspendThread(t.agent_id, t.id)
      suspended++
      logger.info({ agentId: t.agent_id, threadId: t.id }, 'Idle chat thread auto-suspended')
    } catch (err) {
      logger.warn({ err, threadId: t.id }, 'Idle thread suspend failed')
    }
  }
  return suspended
}
