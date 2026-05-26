import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { OLLAMA_URL } from '../config.js'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import {
  detectPaneState,
  decideSubmitFollowup,
  shouldClearTruncatedPreamble,
} from '../pane-state.js'
import { agentDir, readAgentModel, readAgentSecurityProfile, readAgentClaudeConfigDir, readAgentChannelProvider, readAgentAuthMode } from './agent-config.js'
import { parseTelegramToken } from './telegram.js'
import { getProvider, getProviderType, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { loadProfileTemplate } from './profiles.js'
import { writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { getSecret } from './vault.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord') return perAgent
  return CHANNEL_PROVIDER
}

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

  const agentProvider = resolveAgentProvider(name)
  const provider = getProvider(agentProvider)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  // Backward compat: try legacy Telegram token if provider-aware lookup misses
  if (!token && agentProvider === 'telegram') {
    const legacyToken = parseTelegramToken(name)
    if (!legacyToken) return { ok: false, error: 'Channel not configured for this agent' }
  } else if (!token) {
    return { ok: false, error: `${provider.type} channel not configured for this agent` }
  }

  const session = agentSessionName(name)

  try {
    try {
      execSync(`${TMUX} kill-session -t ${session} 2>/dev/null`, { timeout: 3000 })
      execSync('sleep 3', { timeout: 5000 })
    } catch { /* ok */ }

    const model = readAgentModel(name)
    const authMode = readAgentAuthMode(name)
    const isClaude = model.startsWith('claude-')
    const isDeepseek = model.startsWith('deepseek-')
    const isOllama = !isClaude && !isDeepseek
    const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && ` : ''
    const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
    const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${deepseekKey}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && ` : ''
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
    const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : agentProvider === 'discord' ? 'DISCORD_STATE_DIR' : 'TELEGRAM_STATE_DIR'
    const unsetTokens = 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
    // Slack plugin is third-party; its "not on approved allowlist" check is
    // bypassed via `allowedChannelPlugins` in /Library/Application Support/ClaudeCode/managed-settings.json.
    const auditLogEnv = agentProvider === 'slack' ? ` && export SLACK_AUDIT_LOG="${agentChannelDir}/audit.jsonl"` : ''
    const cmd = `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH" && ${unsetTokens} && export ${stateEnvVar}="${agentChannelDir}"${auditLogEnv} && ${apiKeyEnv}${claudeConfigEnv}${ollamaEnv}${deepseekEnv}cd "${dir}" && ${CLAUDE} ${continueFlag}${skipFlag}--model ${model} --channels plugin:${provider.pluginId}`
    execSync(
      `${TMUX} new-session -d -s ${session} "${cmd}"`,
      { timeout: 10000 }
    )

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
    setTimeout(() => {
      try {
        dismissSurveyModalIfPresent(session)
        dismissResumeSummaryModalIfPresent(session)
      } catch (err) {
        logger.warn({ err, name, session }, 'Post-restart modal dismiss failed')
      }
    }, 8000)

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
    // Reap any orphaned plugin grandchildren that tmux didn't get.
    // The plugin writes its pid to the agent's channel state dir;
    // prefer that, fall back to a env-var-scoped pkill.
    try {
      const agentProvider = resolveAgentProvider(name)
      const dir = agentDir(name)
      const chanDir = channelStateDir(agentProvider, dir)
      const pidPath = join(chanDir, 'bot.pid')
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
        if (pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
      }
      const stateEnvVar = agentProvider === 'slack' ? 'SLACK_STATE_DIR' : agentProvider === 'discord' ? 'DISCORD_STATE_DIR' : 'TELEGRAM_STATE_DIR'
      execFileSync('/usr/bin/pkill', ['-f', `${stateEnvVar}=${chanDir}`], { timeout: 3000 })
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

// Claude Code occasionally pops a "How is Claude doing this session? (optional)"
// rating modal above the prompt input. The footer line still reads
// "bypass permissions on (shift+tab to cycle)" so detectPaneState() classifies
// the pane as idle, but the modal swallows the next keystroke and pinches off
// every scheduled prompt + agent message until a human dismisses it. We strip
// it pre-flight by sending "0" (Dismiss) when the marker is visible, so any
// caller writing a prompt has a clear input field.
const SURVEY_MODAL_RX = /How is Claude doing this session/

function dismissSurveyModalIfPresent(session: string): void {
  try {
    const pane = execSync(`${TMUX} capture-pane -t ${session} -p`, { timeout: 3000, encoding: 'utf-8' })
    if (!SURVEY_MODAL_RX.test(pane)) return
    execFileSync(TMUX, ['send-keys', '-t', session, '0'], { timeout: 5000 })
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

function dismissResumeSummaryModalIfPresent(session: string): void {
  try {
    const pane = execSync(`${TMUX} capture-pane -t ${session} -p`, { timeout: 3000, encoding: 'utf-8' })
    if (!RESUME_SUMMARY_MODAL_RX.test(pane)) return
    execFileSync(TMUX, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    // /compact starts immediately and can run for minutes; we only need to
    // unblock the modal so detectPaneState can transition off 'unknown'.
    execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })
    logger.info({ session }, 'Dismissed Claude Code resume-from-summary modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss resume-from-summary modal')
  }
}

// How many follow-up Enters sendPromptToSession() is willing to fire
// when the post-send capture says the prompt is still parked in the
// input box. Two retries cover the observed stuck-rate (single-pane
// recovery typically lands on the first or second extra Enter); a
// stuck-after-two-retries pane gets a logged give-up so the operator
// can intervene rather than the loop spinning indefinitely.
const SUBMIT_RETRY_MAX_ATTEMPTS = 2
// Wait between sending an Enter and re-capturing the pane. Long enough
// for tmux to flush the keystroke into the Claude Code TUI and for
// the TUI to either transition to busy (turn started) or stay idle
// with the parked text (still stuck). Empirically 300ms is past the
// frame-render gap detectPaneState already guards against.
const SUBMIT_RETRY_POLL_MS = '0.3'

// Buffer-clear (Ctrl-U) used pre-flight when shouldClearTruncatedPreamble
// flags a stale preamble. Sent as a single key name (no `-l` literal
// flag) so tmux interprets it as the control sequence.
function clearInputBuffer(session: string): void {
  try {
    execFileSync(TMUX, ['send-keys', '-t', session, 'C-u'], { timeout: 5000 })
    // Settle briefly so the next send-keys lands in the freshly cleared
    // buffer rather than racing the Ctrl-U.
    execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 })
  } catch (err) {
    logger.warn({ err, session }, 'Failed to clear pane input buffer before send')
  }
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
export function sendPromptToSession(session: string, text: string): void {
  dismissSurveyModalIfPresent(session)
  dismissResumeSummaryModalIfPresent(session)

  // Pre-flight buffer-clear when a stale preamble is detected. Reading
  // the pane is best-effort: a capture failure here means we cannot
  // prove the buffer is clean, but proceeding without the clear is no
  // worse than the pre-fix status quo.
  try {
    const preCapture = execSync(`${TMUX} capture-pane -t ${session} -p`, { timeout: 3000, encoding: 'utf-8' })
    if (shouldClearTruncatedPreamble(preCapture)) {
      logger.info({ session }, 'Cleared stale preamble from input buffer before sending prompt')
      clearInputBuffer(session)
    }
  } catch (err) {
    logger.warn({ err, session }, 'Pre-send capture-pane failed; skipping truncated-preamble check')
  }

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

  // Post-send retry loop. The payload hint is the first chunk of oneLine
  // (truncated to a safe length) so the verbatim-stuck path has something
  // recognisable to substring-match against without leaking the whole
  // prompt body into log lines should the give-up branch fire.
  const payloadHint = oneLine.slice(0, Math.min(oneLine.length, 96))
  for (let attempt = 0; ; attempt++) {
    try { execFileSync('/bin/sleep', [SUBMIT_RETRY_POLL_MS], { timeout: 2000 }) } catch { /* best effort */ }
    const pane = capturePane(session)
    const action = decideSubmitFollowup(pane, payloadHint, attempt, SUBMIT_RETRY_MAX_ATTEMPTS)
    if (action === 'done') break
    if (action === 'give-up') {
      logger.warn({ session, attempt }, 'sendPromptToSession: prompt still parked after retries')
      break
    }
    // action === 'retry-enter'
    try {
      execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
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

