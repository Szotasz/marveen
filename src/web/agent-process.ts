import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { OLLAMA_URL } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { detectPaneState } from '../pane-state.js'
import { agentDir, readAgentModel, readAgentSecurityProfile, readAgentClaudeConfigDir } from './agent-config.js'
import { parseTelegramToken } from './telegram.js'
import { loadProfileTemplate } from './profiles.js'
import { writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { getSecret } from './vault.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

export function agentSessionName(name: string): string {
  return `agent-${name}`
}

export function isAgentRunning(name: string): boolean {
  try {
    const output = execSync(`${TMUX} list-sessions -F "#{session_name}"`, { timeout: 3000, encoding: 'utf-8' })
    return output.split('\n').some(line => line.trim() === agentSessionName(name))
  } catch {
    return false
  }
}

export function startAgentProcess(name: string): { ok: boolean; pid?: number; error?: string } {
  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }

  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }

  const token = parseTelegramToken(name)
  if (!token) return { ok: false, error: 'Telegram not configured for this agent' }

  const tgStateDir = join(dir, '.claude', 'channels', 'telegram')
  const session = agentSessionName(name)

  try {
    try {
      execSync(`${TMUX} kill-session -t ${session} 2>/dev/null`, { timeout: 3000 })
      execSync('sleep 3', { timeout: 5000 })
    } catch { /* ok */ }

    const model = readAgentModel(name)
    const isClaude = model.startsWith('claude-')
    const isDeepseek = model.startsWith('deepseek-')
    const isOllama = !isClaude && !isDeepseek
    const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && ` : ''
    // DeepSeek's /anthropic base URL accepts the literal Anthropic SDK
    // request format, so Claude Code talks to it as if it were Anthropic.
    // We pull the API key from the encrypted vault (entry id: DEEPSEEK_API_KEY)
    // rather than process.env so operators can rotate it from the dashboard
    // without restarting. We do NOT fail-fast on missing key here -- a 401
    // from the upstream gives a clearer signal in the agent's tmux pane
    // than a pre-flight error string the operator would have to dig out of logs.
    const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
    const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${deepseekKey}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && ` : ''
    // Apply security profile: write allow/deny list into settings.json, and
    // skip the dangerously-skip-permissions flag for strict profiles so
    // Claude Code enforces the list rather than bypassing it.
    const profile = loadProfileTemplate(readAgentSecurityProfile(name))
    writeAgentSettingsFromProfile(name, profile)
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
    const continueFlag = hasPriorSession ? '--continue ' : ''
    // bun lives under ~/.bun/bin, which isn't in the dashboard's launchd PATH.
    // The Claude plugin launcher spawns `bun`, so we must prepend it here.
    // Defensive unset of TELEGRAM_BOT_TOKEN: if anything ever pollutes the
    // tmux server's global env again (fresh upgrades, operator manually
    // sourcing .env), the sub-agent would otherwise inherit the main
    // agent's token and trigger a 409 Conflict loop. The per-agent .env
    // in TELEGRAM_STATE_DIR is still the intended source of truth.
    const cmd = `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && unset TELEGRAM_BOT_TOKEN && export TELEGRAM_STATE_DIR="${tgStateDir}" && ${claudeConfigEnv}${ollamaEnv}${deepseekEnv}cd "${dir}" && ${CLAUDE} ${continueFlag}${skipFlag}--model ${model} --channels plugin:telegram@claude-plugins-official`
    execSync(
      `${TMUX} new-session -d -s ${session} "${cmd}"`,
      { timeout: 10000 }
    )

    logger.info({ name, session, tgStateDir }, 'Agent tmux session started')
    return { ok: true }
  } catch (err) {
    logger.error({ err, name }, 'Failed to start agent tmux session')
    return { ok: false, error: 'Failed to start tmux session' }
  }
}

export function stopAgentProcess(name: string): { ok: boolean; error?: string } {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }

  try {
    execSync(`${TMUX} kill-session -t ${session}`, { timeout: 5000 })
    execSync('sleep 2', { timeout: 4000 })
    // Reap any orphaned bun server.ts (Telegram plugin) grandchildren that
    // tmux didn't get. The plugin writes its pid to the agent's telegram
    // state dir; prefer that, fall back to a token-scoped pkill.
    try {
      const pidPath = join(agentDir(name), '.claude', 'channels', 'telegram', 'bot.pid')
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
        if (pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
      }
      const tgStateDir = join(agentDir(name), '.claude', 'channels', 'telegram')
      execFileSync('/usr/bin/pkill', ['-f', `TELEGRAM_STATE_DIR=${tgStateDir}`], { timeout: 3000 })
    } catch { /* pkill returns non-zero if no match -- fine */ }
    logger.info({ name, session }, 'Agent tmux session stopped')
    return { ok: true }
  } catch (err) {
    logger.error({ err, name, session }, 'Failed to stop agent tmux session')
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

// Send text to a tmux session as if typed at the prompt.
// Uses execFileSync so callers can pass raw text -- tmux send-keys -l treats
// the argument as literal characters, bypassing shell quoting entirely.
export function sendPromptToSession(session: string, text: string): void {
  const oneLine = text.replace(/\r?\n/g, ' ')
  const CHUNK = 80
  // tmux send-keys doesn't support `--` option-terminator, so a chunk that
  // starts with '-' parses as a flag ("command send-keys: unknown flag -s"
  // on Hungarian suffixes like -szal/-vel/-ban). Slide the boundary up to a
  // few chars past any '-' that lands at the start of the next chunk. Capped
  // so a long run of dashes doesn't inflate one chunk past the paste-detector
  // threshold; if the cap is reached, prepend a space to the chunk instead.
  const MAX_SLIDE = 8
  let i = 0
  while (i < oneLine.length) {
    let end = Math.min(i + CHUNK, oneLine.length)
    let slide = 0
    while (end < oneLine.length && oneLine[end] === '-' && slide < MAX_SLIDE) {
      end++; slide++
    }
    let chunk = oneLine.slice(i, end)
    if (chunk.startsWith('-')) chunk = ' ' + chunk
    execFileSync(TMUX, ['send-keys', '-t', session, '-l', chunk], { timeout: 5000 })
    i = end
    if (i < oneLine.length) execFileSync('/bin/sleep', ['0.03'], { timeout: 1000 })
  }
  execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
}

// How long to wait between the two capture samples when the first one
// looks idle. The Claude Code UI renders the "idle footer without `esc
// to interrupt`" line for ~1 frame after a turn submits before the
// spinner lands; a quarter-second settle window is well past that.
const PANE_READY_CONFIRM_DELAY_S = '0.25'

// Capture a pane snapshot with an execSync timeout. Null on any error so
// the caller can treat "capture failed" as "not ready".
export function capturePane(session: string): string | null {
  try {
    return execSync(`${TMUX} capture-pane -t ${session} -p`, { timeout: 3000, encoding: 'utf-8' })
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
export function isSessionReadyForPrompt(session: string): boolean {
  const first = capturePane(session)
  if (first == null) return false
  if (detectPaneState(first) !== 'idle') return false

  try { execFileSync('/bin/sleep', [PANE_READY_CONFIRM_DELAY_S], { timeout: 2000 }) } catch { /* best effort */ }

  const second = capturePane(session)
  if (second == null) return false
  return detectPaneState(second) === 'idle'
}

