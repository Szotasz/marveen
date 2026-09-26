// Boot autostart for always-on sub-agents (BOOTSTART924).
//
// Found 2026-09-24 while planning a macOS update: after a host reboot launchd
// brings back only the dashboard and the main channels session. A sub-agent
// (e.g. the owners' personal assistants and the
// specialists they call) comes back only when one of its scheduled tasks
// happens to fire -- until then its owner's Telegram messages reach nobody,
// and nothing says so. After a power cut this can quietly last for hours.
//
// So on dashboard boot, start every agent named in store/boot-autostart.json
// that is not already running. An explicit list, not "every agent": the fleet
// has no marker for "stopped on purpose", and reviving a bot someone turned off
// deliberately would be worse than the gap. Staggered, so a cold boot does not
// launch a dozen Claude sessions in the same second. On a plain dashboard
// restart every listed agent is already up, so this is a no-op.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { isKnownAgent } from './agent-config.js'
import { isAgentRunning, startAgentProcess } from './agent-process.js'
import { sendAlert } from './channel-monitor.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'boot-autostart.json')
const BOOT_AUTOSTART_DELAY_MS = 45_000
const DEFAULT_STAGGER_MS = 15_000

export interface BootAutostartConfig { enabled: boolean; agents: string[]; staggerMs: number }

export function normalizeBootAutostartConfig(raw: unknown): BootAutostartConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const agents = Array.isArray(o.agents)
    ? [...new Set(o.agents.filter((a): a is string => typeof a === 'string' && /^[A-Za-z0-9_-]+$/.test(a)))]
    : []
  const stagger = typeof o.staggerMs === 'number' && Number.isFinite(o.staggerMs) && o.staggerMs >= 0 ? o.staggerMs : DEFAULT_STAGGER_MS
  return { enabled: o.enabled !== false, agents, staggerMs: stagger }
}

export function readBootAutostartConfig(path = CONFIG_PATH): BootAutostartConfig {
  if (!existsSync(path)) return { enabled: false, agents: [], staggerMs: DEFAULT_STAGGER_MS }
  try { return normalizeBootAutostartConfig(JSON.parse(readFileSync(path, 'utf8'))) }
  catch (err) {
    logger.warn({ err, path }, 'boot-autostart: config unreadable, skipping')
    return { enabled: false, agents: [], staggerMs: DEFAULT_STAGGER_MS }
  }
}

/** Which listed agents need starting: known, and not already running. */
export function agentsToStart(cfg: BootAutostartConfig, known: (n: string) => boolean, running: (n: string) => boolean): string[] {
  if (!cfg.enabled) return []
  return cfg.agents.filter((a) => known(a) && !running(a))
}

async function runBootAutostart(): Promise<void> {
  const cfg = readBootAutostartConfig()
  const todo = agentsToStart(cfg, isKnownAgent, isAgentRunning)
  if (todo.length === 0) {
    logger.info({ listed: cfg.agents.length }, 'boot-autostart: every listed agent already running (or list empty)')
    return
  }
  const started: string[] = []
  const failed: string[] = []
  for (const [i, name] of todo.entries()) {
    if (i > 0 && cfg.staggerMs > 0) await new Promise((r) => setTimeout(r, cfg.staggerMs))
    if (isAgentRunning(name)) continue // came up on its own meanwhile (e.g. a scheduled task)
    const res = await startAgentProcess(name)
    if (res.ok || /already running/i.test(res.error ?? '')) started.push(name)
    else { failed.push(`${name} (${res.error ?? 'unknown error'})`); logger.warn({ name, error: res.error }, 'boot-autostart: start failed') }
  }
  logger.info({ started, failed }, 'boot-autostart: done')
  sendAlert(failed.length
    ? `🔄 Gép-/dashboard-indulás után elindítottam: ${started.join(', ') || '-'}. NEM indult el: ${failed.join('; ')}. Nézd meg kézzel.`
    : `🔄 Gép-/dashboard-indulás után elindítottam a nem futó ágenseket: ${started.join(', ')}.`)
}

export function startBootAutostart(): NodeJS.Timeout {
  return setTimeout(() => {
    runBootAutostart().catch((err) => logger.warn({ err }, 'boot-autostart failed'))
  }, BOOT_AUTOSTART_DELAY_MS)
}
