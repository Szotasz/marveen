import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, BOT_NAME } from '../config.js'
import { agentDir, listAgentNames } from './agent-config.js'
import {
  agentSessionName,
  capturePane,
  isAgentRunning,
  isSessionReadyForPrompt,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { sendMarveenAlert } from './telegram.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// --- Telegram Plugin Health Monitor ---
// Detect when the bun server.ts grandchild dies under a Claude session
// by walking the process tree. (We deliberately don't pane-scan for
// "Failed to reconnect" strings -- those persist in scrollback and fire
// false positives, e.g. if the source containing the regex is shown.)
// Agents recover via stop+start; for the main agent's channels session
// we can only alert, because killing it would terminate the live agent.

function getClaudePidForSession(session: string): number | null {
  try {
    const out = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8' })
    const panePid = parseInt(out.trim().split('\n')[0], 10)
    if (!panePid) return null
    const cmd = execFileSync('/bin/ps', ['-p', String(panePid), '-o', 'comm='], { timeout: 3000, encoding: 'utf-8' }).trim()
    if (cmd === 'claude' || cmd.endsWith('/claude')) return panePid
    try {
      const child = execFileSync('/usr/bin/pgrep', ['-P', String(panePid), '-x', 'claude'], { timeout: 3000, encoding: 'utf-8' }).trim()
      if (child) return parseInt(child.split('\n')[0], 10)
    } catch { /* none */ }
    return null
  } catch {
    return null
  }
}

function hasTelegramPluginAlive(claudePid: number, agentName?: string): boolean {
  try {
    const ps = execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], { timeout: 3000, encoding: 'utf-8' })
    const lines = ps.split('\n').slice(1)
    const childrenOf = new Map<number, number[]>()
    const cmdOf = new Map<number, string>()
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      cmdOf.set(pid, m[3])
      const arr = childrenOf.get(ppid) || []
      arr.push(pid)
      childrenOf.set(ppid, arr)
    }
    const stack = [claudePid]
    const seen = new Set<number>()
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p)) continue
      seen.add(p)
      const cmd = cmdOf.get(p) || ''
      if (cmd.includes('/telegram/') && cmd.includes('bun')) return true
      if (/\bbun\b/.test(cmd) && cmd.includes('server.ts')) return true
      for (const k of (childrenOf.get(p) || [])) stack.push(k)
    }
    // Fallback: bun may have been reparented to init (ppid=1) after its
    // intermediate parent crashed. The subtree walk from claudePid then
    // misses it and we declare the plugin down even though it's fine.
    // Check bot.pid directly as a last-resort liveness signal.
    const pidDir = agentName
      ? join(agentDir(agentName), '.claude', 'channels', 'telegram')
      : join(homedir(), '.claude', 'channels', 'telegram')
    const pidPath = join(pidDir, 'bot.pid')
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
      if (pid > 1) {
        try {
          process.kill(pid, 0)
          const cmd = cmdOf.get(pid) || ''
          if (cmd.includes('bun') || cmd.includes('server.ts') || cmd.includes('telegram')) {
            logger.debug({ claudePid, orphanPid: pid, agentName }, 'Telegram plugin alive via bot.pid (reparented)')
            return true
          }
        } catch { /* process gone */ }
      }
    }
    return false
  } catch {
    return false
  }
}

const agentDownSince: Map<string, number> = new Map()
const agentLastRestart: Map<string, number> = new Map()
const AGENT_RESTART_GRACE_MS = 90_000
const PLUGIN_ALERT_DEDUP_MS = 30 * 60 * 1000

// Marveen recovery is a 5-stage escalator:
//   1. soft:   /mcp → navigate to Telegram → Reconnect (no session disruption)
//   2. save:   ask Marveen to persist memory (~60s grace)
//   3. resume: respawn claude with --continue (context preserved, MCPs reconnect)
//   4. hard:   systemctl/launchctl restart (clean slate)
//   5. gave_up: manual intervention
type MarveenRecoveryStage = 'soft' | 'save' | 'resume' | 'hard' | 'gave_up'
interface MarveenDownState {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  stageStartedAt?: number
}

const SAVE_WINDOW_MS = 60_000
// Confirmation threshold before treating a "plugin not alive" tick as real
// downtime. The 30-min heartbeat scheduled task can monopolise the Claude
// IPC for 60-90s while it processes the prompt, during which the plugin
// IPC briefly looks dead. Two consecutive negative ticks (~120s) filter
// those false positives without delaying real outages by much.
const MARVEEN_DOWN_CONFIRM_MS = 120_000
let marveenSuspectFirstSeen: number | null = null
let marveenDownState: MarveenDownState | null = null

// Navigate a Claude Code interactive picker by pressing Down until ❯ lands
// on a line matching `pattern`. Uses the LAST ❯ in the pane since the
// dialog renders below the prompt line (which also contains ❯).
function navigateToMenuItem(session: string, pattern: RegExp, maxSteps: number = 10): boolean {
  for (let i = 0; i < maxSteps; i++) {
    const pane = capturePane(session)
    if (!pane) return false
    const lines = pane.split('\n')
    let cursorLine: string | undefined
    for (let j = lines.length - 1; j >= 0; j--) {
      if (lines[j].includes('❯')) { cursorLine = lines[j]; break }
    }
    if (cursorLine && pattern.test(cursorLine)) return true
    execFileSync(TMUX, ['send-keys', '-t', session, 'Down'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['0.15'], { timeout: 1000 })
  }
  return false
}

function softReconnectMarveen(): boolean {
  try {
    // Escape interrupts any in-progress turn, making the session ready
    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 2000 })

    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, '/mcp', 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

    const pane1 = capturePane(MAIN_CHANNELS_SESSION)
    if (!pane1) {
      logger.warn('soft reconnect: failed to capture pane after /mcp')
      execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
      return false
    }
    logger.info({ paneContent: pane1.slice(-500) }, 'soft reconnect: /mcp pane')

    if (!navigateToMenuItem(MAIN_CHANNELS_SESSION, /telegram/i)) {
      logger.warn('soft reconnect: Telegram not found in /mcp menu')
      execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
      return false
    }

    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

    // Verify we entered the Telegram submenu, not Gmail/Calendar/Drive
    const pane2 = capturePane(MAIN_CHANNELS_SESSION)
    if (!pane2) {
      logger.warn('soft reconnect: failed to capture submenu')
      execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
      return false
    }
    logger.info({ paneContent: pane2.slice(-500) }, 'soft reconnect: submenu after Enter')

    if (!/telegram/i.test(pane2)) {
      logger.warn('soft reconnect: entered wrong submenu (not Telegram), backing out')
      execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
      return false
    }

    if (!navigateToMenuItem(MAIN_CHANNELS_SESSION, /reconnect/i)) {
      logger.warn('soft reconnect: Reconnect not found in Telegram submenu')
      execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
      return false
    }

    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['2'], { timeout: 4000 })

    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
    logger.info('soft reconnect: /mcp → Telegram → Reconnect completed')
    return true
  } catch (err) {
    logger.warn({ err }, 'Marveen soft reconnect failed')
    try { execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 }) } catch { /* */ }
    return false
  }
}

function triggerMarveenMemorySave(): void {
  // Nudge Marveen to persist whatever hot/warm state is still in context
  // before the hard restart pulls the session. Uses sendPromptToSession
  // so the long prompt isn't buffered as a [Pasted text] and actually
  // reaches the agent as an input turn.
  const prompt = [
    '[SYSTEM: channels recovery] A Telegram plugin nem reagál, kb 60 másodperc',
    `múlva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-ön (a beszélgetés elvész).`,
    'MOST mentsd el a ClaudeClaw memóriába amit a következő sessionnek tudnia kell:',
    'aktív feladatok (category hot), friss döntések/preferenciák (warm), tanulságok (cold).',
    'Használd: curl -s -X POST http://localhost:3420/api/memories ... (lásd CLAUDE.md).',
    'Ha kész vagy, írj egy rövid napi napló bejegyzést is a /api/daily-log-ra. Utána elég.',
  ].join(' ')
  try {
    sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

function resumeMarveenSession(): boolean {
  try {
    const claudeCmd = [
      'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
      '&&', CLAUDE, '--continue', '--dangerously-skip-permissions',
      '--channels plugin:telegram@claude-plugins-official',
    ].join(' ')
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
    logger.warn('Marveen session respawned with --continue')
    return true
  } catch (err) {
    logger.error({ err }, 'Marveen session respawn failed')
    return false
  }
}

const RESUME_GRACE_MS = 90_000
let marveenLastHardRestart = 0
const MARVEEN_HARD_RESTART_GRACE_MS = 120_000

export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {
  try {
    if (process.platform === 'linux') {
      const unit = `${MAIN_AGENT_ID}-channels.service`
      execFileSync('/usr/bin/systemctl', ['--user', 'restart', unit], { timeout: 15000 })
      logger.warn(`Hard restart: systemctl --user restart ${unit}`)
    } else {
      execFileSync('/bin/launchctl', ['unload', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      execFileSync('/bin/launchctl', ['load', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      logger.warn(`Hard restart: launchctl reload of com.${MAIN_AGENT_ID}.channels`)
    }
    marveenLastHardRestart = Date.now()
    return { ok: true }
  } catch (err) {
    logger.error({ err }, 'Hard restart failed')
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function handleMarveenDown(): void {
  const now = Date.now()
  if (marveenLastHardRestart && now - marveenLastHardRestart < MARVEEN_HARD_RESTART_GRACE_MS) {
    // Just hard-restarted; give the plugin time to boot before checking again.
    return
  }
  if (!marveenDownState) {
    // First tick of this outage: log, alert, try the soft fix.
    marveenDownState = { downSince: now, stage: 'soft', lastAlertAt: now, softAttempts: 0 }
    logger.warn('Marveen Telegram plugin down -- stage 1 (soft /mcp reconnect)')
    sendMarveenAlert('⚠️ Marveen Telegram plugin lecsatlakozott. Próbálok /mcp-vel reconnectálni...').catch(() => {})
    if (softReconnectMarveen()) marveenDownState.softAttempts += 1
    return
  }
  if (marveenDownState.stage === 'soft') {
    if (marveenDownState.softAttempts < 3 && softReconnectMarveen()) {
      marveenDownState.softAttempts += 1
      marveenDownState.lastAlertAt = now
      return
    }
    marveenDownState.stage = 'save'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn('Marveen Telegram plugin still down -- stage 2 (memory save)')
    sendMarveenAlert('⚠️ /mcp nem segített. Szólok Marveennek hogy mentsen memóriát session resume előtt (~60s türelmi idő).').catch(() => {})
    triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'resume'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn('Marveen Telegram plugin still down -- stage 3 (session resume)')
    sendMarveenAlert('⚠️ Memória mentés lejárt. Session resume (claude --continue) most...').catch(() => {})
    resumeMarveenSession()
    return
  }
  if (marveenDownState.stage === 'resume') {
    const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - resumeStartedAt < RESUME_GRACE_MS) return
    marveenDownState.stage = 'hard'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn('Marveen Telegram plugin still down -- stage 4 (hard restart)')
    const svcName = process.platform === 'linux' ? 'systemctl' : 'launchctl'
    sendMarveenAlert(`⚠️ Session resume nem segített. Hard restart (${svcName}) most a ${MAIN_CHANNELS_SESSION} session-ön...`).catch(() => {})
    hardRestartMarveenChannels()
    return
  }
  if (marveenDownState.stage === 'hard') {
    marveenDownState.stage = 'gave_up'
    marveenDownState.lastAlertAt = now
    logger.error('Marveen Telegram plugin still down after hard restart -- giving up auto-recovery')
    const serviceCmd = process.platform === 'linux'
      ? `\`systemctl --user status ${MAIN_AGENT_ID}-channels\``
      : `\`launchctl list | grep ${MAIN_AGENT_ID}\``
    sendMarveenAlert(`🚨 Hard restart SEM segített. Kézzel kell megnézni: \`tmux attach -t ${MAIN_CHANNELS_SESSION}\` és ${serviceCmd}.`).catch(() => {})
    return
  }
  // gave_up -- re-alert at most every PLUGIN_ALERT_DEDUP_MS.
  if (now - marveenDownState.lastAlertAt > PLUGIN_ALERT_DEDUP_MS) {
    marveenDownState.lastAlertAt = now
    sendMarveenAlert('🚨 Marveen Telegram plugin még mindig halott. Nézd meg kézzel.').catch(() => {})
  }
}

function handleMarveenUp(): void {
  marveenSuspectFirstSeen = null
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    logger.info({ stage, downedFor }, 'Marveen Telegram plugin recovered')
    if (stage !== 'soft' && stage !== 'save' && stage !== 'resume') {
      sendMarveenAlert(`✅ Marveen Telegram plugin helyreállt (${stage} után, ${downedFor}s kiesés).`).catch(() => {})
    }
    marveenDownState = null
  }
}

// Returns true once the suspect-down state has been observed for
// MARVEEN_DOWN_CONFIRM_MS. Called twice per minute (the monitor tick is
// 60s); the threshold therefore translates to roughly two negative ticks
// before recovery escalates.
function shouldEscalateMarveenDown(): boolean {
  const now = Date.now()
  if (marveenSuspectFirstSeen === null) {
    marveenSuspectFirstSeen = now
    return false
  }
  return now - marveenSuspectFirstSeen >= MARVEEN_DOWN_CONFIRM_MS
}

export function startTelegramPluginMonitor(): NodeJS.Timeout {
  function check() {
    type Target = { session: string; isMarveen: boolean; agentName?: string }
    const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true }]
    for (const a of listAgentNames()) {
      if (isAgentRunning(a)) targets.push({ session: agentSessionName(a), isMarveen: false, agentName: a })
    }
    for (const t of targets) {
      const claudePid = getClaudePidForSession(t.session)
      if (!claudePid) {
        // Grace period: we may have just restarted this agent and the
        // claude process hasn't appeared yet. Don't escalate until boot
        // has had a realistic chance to complete.
        if (!t.isMarveen && t.agentName) {
          const lastRestart = agentLastRestart.get(t.agentName)
          if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
        }
        if (t.isMarveen) {
          if (shouldEscalateMarveenDown()) handleMarveenDown()
        }
        continue
      }
      const alive = hasTelegramPluginAlive(claudePid, t.agentName)
      if (alive) {
        if (t.isMarveen) {
          handleMarveenUp()
        } else if (agentDownSince.has(t.session)) {
          logger.info({ session: t.session }, 'Agent Telegram plugin recovered')
          agentDownSince.delete(t.session)
        }
        continue
      }
      // Same grace period on the plugin-not-yet-connected path: the MCP
      // handshake can take tens of seconds after a fresh claude start.
      if (!t.isMarveen && t.agentName) {
        const lastRestart = agentLastRestart.get(t.agentName)
        if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
      }
      if (t.isMarveen) {
        if (shouldEscalateMarveenDown()) handleMarveenDown()
      } else {
        if (!agentDownSince.has(t.session)) agentDownSince.set(t.session, Date.now())
        logger.warn({ agent: t.agentName }, 'Agent Telegram plugin down -- auto-restarting')
        try {
          stopAgentProcess(t.agentName!)
          execSync('sleep 2', { timeout: 4000 })
          startAgentProcess(t.agentName!)
          agentLastRestart.set(t.agentName!, Date.now())
          agentDownSince.delete(t.session)
        } catch (err) {
          logger.error({ err, agent: t.agentName }, 'Failed to auto-restart agent after telegram plugin down')
        }
      }
    }
  }
  setTimeout(check, 30000)
  return setInterval(check, 60000)
}
