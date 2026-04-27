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
  isAgentRunning,
  isSessionReadyForPrompt,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { sendMarveenAlert } from './telegram.js'

const TMUX = resolveFromPath('tmux')

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

// Marveen recovery is a 4-stage escalator because killing the session
// terminates the live Marveen conversation, so we try cheap fixes first.
// The "save" stage gives Marveen one tick to persist hot/warm memory to
// SQLite before we pull the rug, so the next session wakes up with the
// last-moment context from the dying one.
type MarveenRecoveryStage = 'soft' | 'save' | 'hard' | 'gave_up'
interface MarveenDownState {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  // When we last transitioned to the current stage. Used by 'save' to
  // honour the announced ~60s memory-save grace before jumping to 'hard'.
  stageStartedAt?: number
}

const SAVE_WINDOW_MS = 60_000
let marveenDownState: MarveenDownState | null = null

function softReconnectMarveen(): boolean {
  // /mcp opens Claude Code's MCP status dialog; a follow-up Enter picks
  // the first action (Reconnect if the plugin is disconnected). We send
  // Escape first in case a different dialog is already open.
  //
  // Guard: if the session is mid-turn (esc to interrupt on screen) or the
  // operator has text parked in the input box, our Escape would interrupt
  // their turn or wipe what they typed. In that case bail out -- the caller
  // will retry on the next outage tick, by which point the pane is likely
  // idle again.
  if (!isSessionReadyForPrompt(MAIN_CHANNELS_SESSION)) {
    logger.warn('Marveen soft reconnect skipped: main session busy or has pending input')
    return false
  }
  try {
    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Escape'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['0.2'], { timeout: 1000 })
    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, '/mcp', 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['0.3'], { timeout: 1000 })
    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'Enter'], { timeout: 3000 })
    logger.info('Marveen soft reconnect: sent /mcp + Enter')
    return true
  } catch (err) {
    logger.warn({ err }, 'Marveen soft reconnect failed')
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

let marveenLastHardRestart = 0
const MARVEEN_HARD_RESTART_GRACE_MS = 120_000

export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {
  try {
    execFileSync('/bin/launchctl', ['unload', MAIN_CHANNELS_PLIST], { timeout: 5000 })
    execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
    execFileSync('/bin/launchctl', ['load', MAIN_CHANNELS_PLIST], { timeout: 5000 })
    marveenLastHardRestart = Date.now()
    logger.warn(`Hard restart: launchctl reload of com.${MAIN_AGENT_ID}.channels`)
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
    // If the main session was busy on the first tick, retry soft a few times
    // before escalating so we don't wipe the operator's input / interrupt a
    // long turn. Cap at 3 attempts so a permanently busy session still gets
    // the memory-save + hard-restart path eventually.
    if (marveenDownState.softAttempts < 3 && softReconnectMarveen()) {
      marveenDownState.softAttempts += 1
      marveenDownState.lastAlertAt = now
      return
    }
    // Soft didn't help; ask Marveen to persist memory before we pull the plug.
    marveenDownState.stage = 'save'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn('Marveen Telegram plugin still down -- stage 2 (memory save)')
    sendMarveenAlert('⚠️ /mcp nem segített. Szólok Marveennek hogy mentsen memóriát hard restart előtt (~60s türelmi idő).').catch(() => {})
    triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    // Give the memory-save prompt a real ~60s window to land a turn before
    // we hard-restart. Without this check, the next monitor tick (also 60s
    // cadence, so effectively immediate) jumps straight to 'hard' and the
    // save prompt either hasn't started or is mid-turn when we pull the plug.
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'hard'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn('Marveen Telegram plugin still down -- stage 3 (hard restart)')
    sendMarveenAlert(`⚠️ Memória mentés türelmi idő lejárt. Hard restart most a ${MAIN_CHANNELS_SESSION} session-ön (új session a SQLite memóriával indul).`).catch(() => {})
    hardRestartMarveenChannels()
    return
  }
  if (marveenDownState.stage === 'hard') {
    // Hard didn't help either; give up, keep alerting.
    marveenDownState.stage = 'gave_up'
    marveenDownState.lastAlertAt = now
    logger.error('Marveen Telegram plugin still down after hard restart -- giving up auto-recovery')
    sendMarveenAlert(`🚨 Hard restart SEM segített. Kézzel kell megnézni: \`tmux attach -t ${MAIN_CHANNELS_SESSION}\` és \`launchctl list | grep ${MAIN_AGENT_ID}\`.`).catch(() => {})
    return
  }
  // gave_up -- re-alert at most every PLUGIN_ALERT_DEDUP_MS.
  if (now - marveenDownState.lastAlertAt > PLUGIN_ALERT_DEDUP_MS) {
    marveenDownState.lastAlertAt = now
    sendMarveenAlert('🚨 Marveen Telegram plugin még mindig halott. Nézd meg kézzel.').catch(() => {})
  }
}

function handleMarveenUp(): void {
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    logger.info({ stage, downedFor }, 'Marveen Telegram plugin recovered')
    if (stage !== 'soft' && stage !== 'save') {
      // Only alert on recovery if we actually pulled the session -- the soft
      // and save stages don't destroy state, so a "recovered" message there
      // would just be noise.
      sendMarveenAlert(`✅ Marveen Telegram plugin helyreállt (${stage} után, ${downedFor}s kiesés).`).catch(() => {})
    }
    marveenDownState = null
  }
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
        if (t.isMarveen) handleMarveenDown()
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
        handleMarveenDown()
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
