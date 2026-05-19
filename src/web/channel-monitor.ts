import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, BOT_NAME, CHANNEL_PROVIDER } from '../config.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import {
  agentSessionName,
  capturePane,
  isAgentRunning,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { notifyChannel } from '../notify.js'
import { getProvider, channelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

// --- Channel Plugin Health Monitor ---
// Detect when the channel plugin grandchild dies under a Claude session
// by walking the process tree. Agents recover via stop+start; for the
// main agent's channels session we can only alert + escalate, because
// killing it would terminate the live agent.

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

function hasChannelPluginAlive(claudePid: number, providerType: ChannelProviderType, agentName?: string): boolean {
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
      if (providerType === 'telegram') {
        if (cmd.includes('/telegram/') && cmd.includes('bun')) return true
        if (/\bbun\b/.test(cmd) && cmd.includes('server.ts')) return true
      } else {
        if (cmd.includes('slack') && cmd.includes('node')) return true
        if (cmd.includes('slack-channel') && (cmd.includes('bun') || cmd.includes('node'))) return true
      }
      for (const k of (childrenOf.get(p) || [])) stack.push(k)
    }

    // Fallback: plugin may have been reparented to init (ppid=1) after its
    // intermediate parent crashed. Check bot.pid directly as last-resort.
    const stateDir = agentName
      ? channelStateDir(providerType, agentDir(agentName))
      : channelStateDir(providerType)
    const pidPath = join(stateDir, 'bot.pid')
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
      if (pid > 1) {
        try {
          process.kill(pid, 0)
          const cmd = cmdOf.get(pid) || ''
          const isRelevant = providerType === 'telegram'
            ? (cmd.includes('bun') || cmd.includes('server.ts') || cmd.includes('telegram'))
            : (cmd.includes('node') || cmd.includes('slack'))
          if (isRelevant) {
            logger.debug({ claudePid, orphanPid: pid, agentName, providerType }, 'Channel plugin alive via bot.pid (reparented)')
            return true
          }
        } catch { /* process gone */ }
      }
    }

    // Slack Socket Mode: no bot.pid file; check if the slack app token is
    // being actively used by a child process. This is a heuristic -- Slack
    // plugins keep a WebSocket open but don't write a pid file.
    if (providerType === 'slack') {
      for (const [pid, cmd] of cmdOf) {
        if (seen.has(pid)) continue
        if ((cmd.includes('slack') || cmd.includes('socket-mode')) && (cmd.includes('node') || cmd.includes('bun'))) {
          try {
            process.kill(pid, 0)
            logger.debug({ claudePid, slackPid: pid, agentName }, 'Slack plugin alive via process scan')
            return true
          } catch { /* gone */ }
        }
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

type MarveenRecoveryStage = 'soft' | 'save' | 'resume' | 'hard' | 'gave_up'
interface MarveenDownState {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  stageStartedAt?: number
}

const SAVE_WINDOW_MS = 60_000
const MARVEEN_DOWN_CONFIRM_MS = 120_000
let marveenSuspectFirstSeen: number | null = null
let marveenDownState: MarveenDownState | null = null

function getMainAgentProvider(): ChannelProviderType {
  return CHANNEL_PROVIDER
}

function softReconnectMarveen(): boolean {
  return attemptChannelMcpReconnect(MAIN_AGENT_ID).ok
}

function triggerMarveenMemorySave(): void {
  const prompt = [
    '[SYSTEM: channels recovery] A csatorna plugin nem reagal, kb 60 masodperc',
    `mulva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik).`,
    'MOST mentsd el a ClaudeClaw memoriaba amit a kovetkezo sessionnek tudnia kell:',
    'aktiv feladatok (category hot), friss dontesek/preferenciak (warm), tanulsagok (cold).',
    'Hasznald: curl -s -X POST http://localhost:3420/api/memories ... (lasd CLAUDE.md).',
    'Ha kesz vagy, irj egy rovid napi naplo bejegyzest is a /api/daily-log-ra. Utana eleg.',
  ].join(' ')
  try {
    sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

function resumeMarveenSession(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    const claudeCmd = [
      'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
      '&&', CLAUDE, '--continue', '--dangerously-skip-permissions',
      `--channels plugin:${provider.pluginId}`,
    ].join(' ')
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
    logger.warn({ provider: provider.type }, 'Marveen session respawned with --continue')
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

function sendAlert(text: string): void {
  notifyChannel(text).catch(() => {})
}

function handleMarveenDown(): void {
  const now = Date.now()
  const providerLabel = getMainAgentProvider()
  if (marveenLastHardRestart && now - marveenLastHardRestart < MARVEEN_HARD_RESTART_GRACE_MS) {
    return
  }
  if (!marveenDownState) {
    marveenDownState = { downSince: now, stage: 'soft', lastAlertAt: now, softAttempts: 0 }
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin down -- stage 1 (soft /mcp reconnect, silent)')
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
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 2 (memory save)')
    triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'resume'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 3 (session resume)')
    resumeMarveenSession()
    return
  }
  if (marveenDownState.stage === 'resume') {
    const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - resumeStartedAt < RESUME_GRACE_MS) return
    marveenDownState.stage = 'hard'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 4 (hard restart)')
    const svcName = process.platform === 'linux' ? 'systemctl' : 'launchctl'
    sendAlert(`⚠️ Session resume nem segitett. Hard restart (${svcName}) most a ${MAIN_CHANNELS_SESSION} session-on...`)
    hardRestartMarveenChannels()
    return
  }
  if (marveenDownState.stage === 'hard') {
    marveenDownState.stage = 'gave_up'
    marveenDownState.lastAlertAt = now
    logger.error({ provider: providerLabel }, 'Marveen channel plugin still down after hard restart -- giving up auto-recovery')
    const serviceCmd = process.platform === 'linux'
      ? `\`systemctl --user status ${MAIN_AGENT_ID}-channels\``
      : `\`launchctl list | grep ${MAIN_AGENT_ID}\``
    sendAlert(`🚨 Hard restart SEM segitett. Kezzel kell megnezni: \`tmux attach -t ${MAIN_CHANNELS_SESSION}\` es ${serviceCmd}.`)
    return
  }
  if (now - marveenDownState.lastAlertAt > PLUGIN_ALERT_DEDUP_MS) {
    marveenDownState.lastAlertAt = now
    sendAlert(`🚨 Marveen ${providerLabel} plugin meg mindig halott. Nezd meg kezzel.`)
  }
}

function handleMarveenUp(): void {
  marveenSuspectFirstSeen = null
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    const providerLabel = getMainAgentProvider()
    logger.info({ stage, downedFor, provider: providerLabel }, 'Marveen channel plugin recovered')
    if (stage !== 'soft' && stage !== 'save' && stage !== 'resume') {
      sendAlert(`✅ Marveen ${providerLabel} plugin helyrealt (${stage} utan, ${downedFor}s kieses).`)
    }
    marveenDownState = null
  }
}

function shouldEscalateMarveenDown(): boolean {
  const now = Date.now()
  if (marveenSuspectFirstSeen === null) {
    marveenSuspectFirstSeen = now
    return false
  }
  return now - marveenSuspectFirstSeen >= MARVEEN_DOWN_CONFIRM_MS
}

export function startChannelPluginMonitor(): NodeJS.Timeout {
  const mainProvider = getMainAgentProvider()

  function check() {
    type Target = { session: string; isMarveen: boolean; agentName?: string; provider: ChannelProviderType }
    const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]
    for (const a of listAgentNames()) {
      if (isAgentRunning(a)) {
        targets.push({
          session: agentSessionName(a),
          isMarveen: false,
          agentName: a,
          provider: resolveAgentProvider(a),
        })
      }
    }
    for (const t of targets) {
      const claudePid = getClaudePidForSession(t.session)
      if (!claudePid) {
        if (!t.isMarveen && t.agentName) {
          const lastRestart = agentLastRestart.get(t.agentName)
          if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
        }
        if (t.isMarveen) {
          if (shouldEscalateMarveenDown()) handleMarveenDown()
        }
        continue
      }
      const alive = hasChannelPluginAlive(claudePid, t.provider, t.agentName)
      if (alive) {
        if (t.isMarveen) {
          handleMarveenUp()
        } else if (agentDownSince.has(t.session)) {
          logger.info({ session: t.session, provider: t.provider }, 'Agent channel plugin recovered')
          agentDownSince.delete(t.session)
        }
        continue
      }
      if (!t.isMarveen && t.agentName) {
        const lastRestart = agentLastRestart.get(t.agentName)
        if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
      }
      if (t.isMarveen) {
        if (shouldEscalateMarveenDown()) handleMarveenDown()
      } else {
        if (!agentDownSince.has(t.session)) agentDownSince.set(t.session, Date.now())
        logger.warn({ agent: t.agentName, provider: t.provider }, 'Agent channel plugin down -- auto-restarting')
        try {
          stopAgentProcess(t.agentName!)
          execSync('sleep 2', { timeout: 4000 })
          startAgentProcess(t.agentName!)
          agentLastRestart.set(t.agentName!, Date.now())
          agentDownSince.delete(t.session)
        } catch (err) {
          logger.error({ err, agent: t.agentName }, 'Failed to auto-restart agent after channel plugin down')
        }
      }
    }
  }
  setTimeout(check, 30000)
  return setInterval(check, 60000)
}

// Backward-compatible alias
export const startTelegramPluginMonitor = startChannelPluginMonitor
