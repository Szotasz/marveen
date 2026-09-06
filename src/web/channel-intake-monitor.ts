/**
 * Channel intake monitor: measures whether a channel's inbound side is still
 * being consumed, using a signal that EXISTS while the channel is deaf.
 *
 * Why this is not covered by what we already run:
 *   - channel-health-monitor greps the pane for `✘ failed`. A plugin whose
 *     poll loop stopped while the process stayed alive renders nothing.
 *   - channel-poller-reap and channel-conflict-probe answer "is someone else
 *     holding the getUpdates slot", and only once the monitor already believes
 *     the channel is down.
 *   - inbound-probe is the gold standard, but it covers the MAIN channels
 *     session only (one transcript dir, one telethon prober account), and it
 *     is gated on an operator allowlisting that prober.
 * Finy sat deaf for five days in July 2026 with all of the above green. The
 * absence of inbound is not an event, so nothing fired.
 *
 * The positive signal used here is getWebhookInfo.pending_update_count: the
 * number of updates Telegram is holding that NOBODY has fetched. A live poller
 * keeps it at zero; a dead poll loop lets it grow the moment anyone writes to
 * the bot. It costs one HTTP call, contends with nothing, and -- unlike a
 * getUpdates probe -- cannot itself cause the deafness it is looking for
 * (grammy gives up permanently after 8 consecutive 409s, and a healthy poller
 * answered 409 to 2 of 5 hand-run getUpdates probes on 2026-09-06).
 *
 * Inbound silence is carried alongside as context only. An agent with nothing
 * to do is legitimately silent for days, so silence never alerts on its own.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir, listAgentNames } from './agent-config.js'
import { isAgentRunning } from './agent-process.js'
import { readLastIngestionTimestamp } from './inbound-probe.js'
import { sendRoutineAlert } from './routine-alert.js'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// Silence long enough that a working agent would normally have heard something,
// short enough to still be actionable. Only ever downgrades an alert to a log
// line -- see decideIntakeVerdict.
export const INTAKE_SILENCE_THRESHOLD_MS = 2 * DAY_MS

// Two readings taken this close together describe one moment, not a trend.
export const BACKLOG_CONFIRM_MIN_GAP_MS = 3 * MINUTE_MS

// The channel is either deaf or it is not; repeating hourly buries the first
// message (see routine-alert). Matches the fleet's 3h re-alert cadence.
export const INTAKE_ALERT_COOLDOWN_MS = 3 * 60 * MINUTE_MS

const CHECK_INTERVAL_MS = 5 * MINUTE_MS
const INITIAL_DELAY_MS = 100 * 1000
const PROBE_TIMEOUT_MS = 8_000

export interface IntakeProbe {
  /** false only when OUR side failed to complete the call (network, timeout). */
  reachable: boolean
  /** false when Telegram answered but rejected the token. */
  tokenOk: boolean
  /** Updates queued upstream that nobody has fetched; null when unknown. */
  pendingUpdates: number | null
  webhookUrl: string | null
  lastErrorMessage: string | null
}

export interface IntakeObservation {
  at: number
  pendingUpdates: number
}

export type IntakeVerdict =
  | 'ok'
  | 'quiet'
  | 'unknown-inbound'
  | 'draining'
  | 'backlog-suspected'
  | 'deaf-backlog'
  | 'token-invalid'
  | 'unreachable'

export interface IntakeDecision {
  verdict: IntakeVerdict
  alert: boolean
}

interface TelegramWebhookInfoBody {
  ok?: boolean
  description?: string
  result?: {
    url?: string
    pending_update_count?: number
    last_error_message?: string
  }
}

/**
 * Turn one getWebhookInfo response into a probe reading.
 *
 * `status === 0` is the caller's marker for "the HTTP call never completed",
 * which must NOT be read as a bad token: our own network being down would
 * otherwise page the owner about every agent at once.
 */
export function parseIntakeProbe(status: number, body: unknown): IntakeProbe {
  if (status === 0) {
    return { reachable: false, tokenOk: true, pendingUpdates: null, webhookUrl: null, lastErrorMessage: null }
  }
  const parsed = (body ?? {}) as TelegramWebhookInfoBody
  if (status !== 200 || parsed.ok !== true || !parsed.result) {
    return {
      reachable: true,
      tokenOk: false,
      pendingUpdates: null,
      webhookUrl: null,
      lastErrorMessage: parsed.description ?? null,
    }
  }
  const pending = parsed.result.pending_update_count
  return {
    reachable: true,
    tokenOk: true,
    pendingUpdates: typeof pending === 'number' ? pending : null,
    webhookUrl: parsed.result.url ?? null,
    lastErrorMessage: parsed.result.last_error_message ?? null,
  }
}

/**
 * Pure verdict for one agent's channel intake.
 *
 * Alerting cases (both are positive evidence):
 *   - `token-invalid`: Telegram answered and refused the token.
 *   - `deaf-backlog`: updates were queued upstream at two readings far enough
 *     apart to be a trend, and the queue did not shrink between them. A live
 *     poller drains in milliseconds, so a queue that survives minutes means
 *     nobody is fetching.
 *
 * Everything else is logged only. `quiet` in particular is a suspicion, not a
 * finding: silence is also what a correctly working idle agent looks like.
 */
export function decideIntakeVerdict(opts: {
  probe: IntakeProbe
  prev: IntakeObservation | null
  lastInboundAt: number | null
  now: number
  silenceThresholdMs: number
}): IntakeDecision {
  const { probe, prev, lastInboundAt, now, silenceThresholdMs } = opts

  if (!probe.reachable) return { verdict: 'unreachable', alert: false }
  if (!probe.tokenOk) return { verdict: 'token-invalid', alert: true }

  const pending = probe.pendingUpdates ?? 0
  if (pending > 0) {
    const confirmed =
      prev != null &&
      prev.pendingUpdates > 0 &&
      now - prev.at >= BACKLOG_CONFIRM_MIN_GAP_MS
    if (!confirmed) return { verdict: 'backlog-suspected', alert: false }
    if (pending < prev.pendingUpdates) return { verdict: 'draining', alert: false }
    return { verdict: 'deaf-backlog', alert: true }
  }

  // No ingestion timestamp is missing evidence, not evidence of silence: the
  // transcript scan reads the newest JSONL's tail, and an agent whose newest
  // session is a worker or a scheduled run shows no channel line at all. Saying
  // "silent forever" there would be an unmeasured claim on every tick.
  if (lastInboundAt == null) return { verdict: 'unknown-inbound', alert: false }
  if (now - lastInboundAt >= silenceThresholdMs) return { verdict: 'quiet', alert: false }
  return { verdict: 'ok', alert: false }
}

export function formatIntakeAlert(agentName: string, decision: IntakeDecision, probe: IntakeProbe, silentForMs: number | null): string {
  const silence =
    silentForMs == null ? 'nem érkezett bejövő üzenet, amióta figyeljük'
    : `${Math.floor(silentForMs / DAY_MS)} napja nem érkezett bejövő üzenet`
  if (decision.verdict === 'token-invalid') {
    return `🔇 ${agentName}: a Telegram elutasította a bot tokent (${probe.lastErrorMessage ?? 'nincs indoklás'}). A csatorna nem tud fogadni. ${silence}.`
  }
  return `🔇 ${agentName}: ${probe.pendingUpdates} bejövő üzenet áll a Telegram sorában, és senki nem veszi le. A plugin fut, de a poll-ciklusa halott. ${silence}.`
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const lastObservation = new Map<string, IntakeObservation>()
const lastQuietLogAt = new Map<string, number>()

// A quiet channel is a standing condition, not an event; repeating it every
// tick would bury the lines that matter in dashboard.log.
const QUIET_LOG_INTERVAL_MS = 6 * 60 * MINUTE_MS

/** Test seam: reset the per-agent backlog history. */
export function resetIntakeObservations(): void {
  lastObservation.clear()
  lastQuietLogAt.clear()
}

/**
 * The main agent's channel lives under the global ~/.claude install; every
 * sub-agent has its own copy under its agent dir (mirrors telegram.ts).
 */
export function channelEnvPathFor(agentName: string): string {
  const root = agentName === MAIN_AGENT_ID ? homedir() : agentDir(agentName)
  return join(root, '.claude', 'channels', 'telegram', '.env')
}

function readTelegramToken(agentName: string): string | null {
  const envPath = channelEnvPathFor(agentName)
  if (!existsSync(envPath)) return null
  try {
    const match = readFileSync(envPath, 'utf-8').match(/^\s*TELEGRAM_BOT_TOKEN=(.+)$/m)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** Transcript dir Claude Code uses for a cwd: every '/' replaced with '-'. */
export function transcriptDirFor(agentName: string, projectRoot: string): string {
  const cwd = agentName === MAIN_AGENT_ID ? projectRoot : agentDir(agentName)
  return join(process.env['HOME'] ?? homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'))
}

async function probeIntake(token: string): Promise<IntakeProbe> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // Telegram always answers JSON; a proxy in between might not.
    }
    return parseIntakeProbe(res.status, body)
  } catch {
    return parseIntakeProbe(0, null)
  }
}

async function checkAgentIntake(agentName: string, projectRoot: string): Promise<void> {
  const token = readTelegramToken(agentName)
  if (!token) return

  const probe = await probeIntake(token)
  const now = Date.now()
  const lastInboundAt = readLastIngestionTimestamp(transcriptDirFor(agentName, projectRoot))
  const decision = decideIntakeVerdict({
    probe,
    prev: lastObservation.get(agentName) ?? null,
    lastInboundAt,
    now,
    silenceThresholdMs: INTAKE_SILENCE_THRESHOLD_MS,
  })

  if (probe.pendingUpdates != null) {
    lastObservation.set(agentName, { at: now, pendingUpdates: probe.pendingUpdates })
  }

  const silentForMs = lastInboundAt == null ? null : now - lastInboundAt
  // Never log message bodies -- only counts and timestamps (see inbound-probe).
  logger.debug(
    { agent: agentName, verdict: decision.verdict, pending: probe.pendingUpdates, silentForMs },
    'channel-intake-monitor: probe',
  )

  if (decision.verdict === 'quiet') {
    const loggedAt = lastQuietLogAt.get(agentName) ?? 0
    if (now - loggedAt >= QUIET_LOG_INTERVAL_MS) {
      lastQuietLogAt.set(agentName, now)
      logger.info(
        { agent: agentName, silentForMs },
        'channel-intake-monitor: no inbound for a long while, but the intake is clean (not an alert on its own)',
      )
    }
    return
  }
  if (!decision.alert) return

  logger.warn(
    { agent: agentName, verdict: decision.verdict, pending: probe.pendingUpdates, silentForMs },
    'channel-intake-monitor: channel intake is dead',
  )
  sendRoutineAlert(
    `channel-intake:${agentName}:${decision.verdict}`,
    formatIntakeAlert(agentName, decision, probe, silentForMs),
    { cooldownMs: INTAKE_ALERT_COOLDOWN_MS },
  )
}

export function startChannelIntakeMonitor(projectRoot: string): NodeJS.Timeout {
  async function check(): Promise<void> {
    const names = [MAIN_AGENT_ID, ...listAgentNames().filter(n => n !== MAIN_AGENT_ID)]
    for (const name of names) {
      // A stopped agent has no poller by design; that is not deafness.
      if (name !== MAIN_AGENT_ID && !isAgentRunning(name)) {
        lastObservation.delete(name)
        continue
      }
      try {
        await checkAgentIntake(name, projectRoot)
      } catch (err) {
        logger.debug({ err, agent: name }, 'channel-intake-monitor: check error')
      }
    }
  }

  // Offset past channel-monitor (30s) and channel-health-monitor (45s) so the
  // three do not share a tick.
  setTimeout(() => void check(), INITIAL_DELAY_MS)
  return setInterval(() => void check(), CHECK_INTERVAL_MS)
}
