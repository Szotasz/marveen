/**
 * Inbound-probe: active deafness watchdog for the main main channels session.
 *
 * Architecture note: the actual Telegram ping is sent by a Python script
 * (scripts/watchdog-inbound-prober.py) using the existing telethon session.
 * Rationale: telethon's asyncio event loop, StringSession handling, and
 * FloodWait back-off are already Python-shaped (see watchdog-userbot-login.py).
 * Re-implementing MTProto session handling in TS for a 30-line prober is
 * disproportionate. This TS module manages the Python prober's lifecycle and
 * implements the pure decision logic.
 *
 * MANUAL GATE: the prober account must be /telegram:access allowlisted
 * by the operator before the inbound probe can send messages. Until then the Python
 * prober detects the unauthorised state and exits 0 (no-op). No respawn is
 * triggered by the TS side when the session file is absent.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { readEnvFile } from '../env.js'

// Mirrors KEEPALIVE_RESPAWN_GRACE_MS from channel-monitor.ts (15 min).
// Not imported directly to avoid a circular module dependency: channel-monitor.ts
// lazy-imports inbound-probe.ts; inbound-probe.ts uses dynamic import() of
// channel-monitor.ts to call hardRestartMarveenChannels at respawn time.
const RESPAWN_GRACE_MS = 15 * 60 * 1000

const SESSION_FILE = join(PROJECT_ROOT, 'store', '.watchdog-userbot.session')
const PROBE_LAST_SENT_FILE = join(PROJECT_ROOT, 'store', '.watchdog-probe-last-sent')
const VENV_PYTHON = join(PROJECT_ROOT, '.watchdog-venv', 'bin', 'python3')
const PROBER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'watchdog-inbound-prober.py')

// Transcript directory for the main channels session JSONL files. Claude Code
// encodes a project dir by replacing every '/' in the cwd with '-', so we
// derive it from PROJECT_ROOT rather than hardcoding a host-specific path.
// Sub-agents live in separate project dirs (one per agent cwd), so picking the
// newest file in the main dir is reliable.
export const TRANSCRIPT_DIR = join(
  process.env.HOME ?? homedir(),
  '.claude',
  'projects',
  PROJECT_ROOT.replace(/\//g, '-'),
)

// N3: named constant for the probe timeout multiplier.
// probeTimeoutMs = probeIntervalMs * PROBE_TIMEOUT_MULTIPLIER (allow 2x interval before declaring deaf).
const PROBE_TIMEOUT_MULTIPLIER = 2

// W4: env-derived values cached once at startInboundProber() startup.
// Reading .env from disk every tick is unnecessary and wasteful.
let _cachedProbeIntervalMs: number | null = null
let _cachedAllowedChatId: string | null | undefined = undefined // undefined = not yet read

// W3: one-shot flags to avoid repeating "session missing" / "ALLOWED_CHAT_ID absent" warnings every tick.
let _warnedSessionMissing = false
let _warnedChatIdAbsent = false

// Module-level last-respawn tracker for the inbound-probe path.
// Separate from marveenLastKeepaliveRespawn in channel-monitor.ts so the two
// paths do not interfere with each other's grace windows.
let lastInboundRespawn = 0

let proberProcess: ChildProcess | null = null

// ---------------------------------------------------------------------------
// Pure exported functions
// ---------------------------------------------------------------------------

/**
 * Pure decision: should the watchdog trigger a deafness respawn?
 *
 * @param markerTs         When the __wd_ping was sent (ms since epoch).
 * @param lastIngestionTs  When the most recent <channel source= ingestion was
 *                         seen in the session transcript, or null if no
 *                         ingestion has been recorded yet.
 * @param probeTimeoutMs   Inactivity window after which we declare deaf.
 * @param nowMs            Current wall-clock time (ms since epoch).
 *
 * Returns true (trigger respawn) when:
 *   - nowMs - markerTs >= probeTimeoutMs (the timeout has elapsed), AND
 *   - lastIngestionTs is null OR lastIngestionTs < markerTs
 *     (no ingestion has been seen since the marker was sent).
 *
 * Returns false in all other cases.
 */
export function shouldTriggerDeafnessRespawn(opts: {
  markerTs: number
  lastIngestionTs: number | null
  probeTimeoutMs: number
  nowMs: number
}): boolean {
  const { markerTs, lastIngestionTs, probeTimeoutMs, nowMs } = opts
  if (nowMs - markerTs < probeTimeoutMs) return false
  return lastIngestionTs == null || lastIngestionTs < markerTs
}

/**
 * Scan the newest JSONL session file for the most recent inbound-channel
 * ingestion. Returns the timestamp (ms since epoch) of the last line
 * containing `<channel source=`, or null if none found.
 *
 * The "newest" file is determined by mtime: stat all *.jsonl under
 * transcriptDir, pick the one with the highest mtime. This is the main
 * session's active log. Returns null when the directory does not exist or
 * no JSONL files are present.
 *
 * NOTE: Do NOT log line contents — JSONL lines may contain full Telegram
 * message text (PII). Only the extracted timestamp is ever logged.
 */
export function readLastIngestionTimestamp(transcriptDir: string): number | null {
  try {
    if (!existsSync(transcriptDir)) return null
    const entries = readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl'))
    if (entries.length === 0) return null

    // Pick the newest file by mtime.
    let newestFile = ''
    let newestMtime = 0
    for (const entry of entries) {
      const fullPath = join(transcriptDir, entry)
      try {
        const st = statSync(fullPath)
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs
          newestFile = fullPath
        }
      } catch {
        // file disappeared between readdir and stat — skip
      }
    }
    if (!newestFile) return null

    // B1 fix: tail-read only the last 256 KB to avoid blocking the event loop
    // on a transcript that has grown to 100s of MB.
    const TAIL_BYTES = 262144 // 256 KB
    const fd = openSync(newestFile, 'r')
    let rawText: string
    try {
      const fileSize = statSync(newestFile).size
      const readOffset = Math.max(0, fileSize - TAIL_BYTES)
      const readLength = fileSize - readOffset
      const buf = Buffer.allocUnsafe(readLength)
      readSync(fd, buf, 0, readLength, readOffset)
      rawText = buf.toString('utf-8')
    } finally {
      // fd is always closed — openSync never leaves a dangling descriptor
      closeSync(fd)
    }

    // Drop a possibly-partial first line when we started mid-file.
    const firstNewline = rawText.indexOf('\n')
    const trimmed = firstNewline > 0 ? rawText.slice(firstNewline + 1) : rawText
    const lines = trimmed.split('\n')
    let lastTs: number | null = null
    for (const line of lines) {
      if (!line.includes('<channel source=')) continue
      try {
        const obj = JSON.parse(line) as { timestamp?: string }
        if (typeof obj.timestamp === 'string') {
          const ts = new Date(obj.timestamp).getTime()
          if (Number.isFinite(ts)) {
            lastTs = ts
          }
        }
      } catch {
        // malformed line — skip, do not abort
      }
    }
    return lastTs
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Prober lifecycle
// ---------------------------------------------------------------------------

function readProbeLastSentMs(): number | null {
  try {
    const raw = readFileSync(PROBE_LAST_SENT_FILE, 'utf-8').trim()
    const ts = new Date(raw).getTime()
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

// W4: read once at startup; subsequent calls return the cached value.
// W1: enforce a minimum floor of 30 000 ms to prevent inadvertent DoS.
function readProbeIntervalMs(): number {
  if (_cachedProbeIntervalMs !== null) return _cachedProbeIntervalMs
  const env = readEnvFile(['PROBE_INTERVAL_MS'])
  const raw = env['PROBE_INTERVAL_MS']
  const DEFAULT_MS = 180_000 // 3 minutes
  let parsed = DEFAULT_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) parsed = n
  }
  // W1: minimum 30 s floor
  _cachedProbeIntervalMs = Math.max(parsed, 30_000)
  return _cachedProbeIntervalMs
}

// W4: read once at startup; subsequent calls return the cached value.
function readAllowedChatId(): string | null {
  if (_cachedAllowedChatId !== undefined) return _cachedAllowedChatId
  const env = readEnvFile(['ALLOWED_CHAT_ID'])
  const v = env['ALLOWED_CHAT_ID']
  _cachedAllowedChatId = v && v.trim() ? v.trim() : null
  return _cachedAllowedChatId
}

function spawnProber(): void {
  if (!existsSync(SESSION_FILE)) {
    // W3: one-shot warning — log only on first occurrence, debug on subsequent ticks.
    if (!_warnedSessionMissing) {
      logger.warn('Inbound prober: store/.watchdog-userbot.session missing -- prober is a no-op until the session is created')
      _warnedSessionMissing = true
    } else {
      logger.debug('Inbound prober: session still missing -- skipping')
    }
    return
  }
  // Reset session-missing flag if the file now exists.
  _warnedSessionMissing = false

  const allowedChatId = readAllowedChatId()
  if (!allowedChatId) {
    // CW addendum D3: if ALLOWED_CHAT_ID is absent/empty, log warning and skip.
    // W3: one-shot via logger.warn; subsequent ticks use logger.debug.
    if (!_warnedChatIdAbsent) {
      logger.warn('inbound-prober: ALLOWED_CHAT_ID absent in .env -- prober skipped')
      _warnedChatIdAbsent = true
    } else {
      logger.debug('inbound-prober: ALLOWED_CHAT_ID still absent -- skipping')
    }
    return
  }
  // Reset chat-id-absent flag if the value is now present.
  _warnedChatIdAbsent = false

  if (!existsSync(VENV_PYTHON)) {
    logger.warn('Inbound prober: .watchdog-venv/bin/python3 not found -- prober skipped')
    return
  }

  if (!existsSync(PROBER_SCRIPT)) {
    logger.warn('Inbound prober: scripts/watchdog-inbound-prober.py not found -- prober skipped')
    return
  }

  if (proberProcess && proberProcess.exitCode === null) {
    // Still running — do not double-spawn.
    return
  }

  logger.info('Inbound prober: spawning watchdog-inbound-prober.py')
  try {
    proberProcess = spawn(VENV_PYTHON, [PROBER_SCRIPT], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proberProcess.stdout?.on('data', (data: Buffer) => {
      // Do not log stdout content as it may carry debug info with timing data.
      const text = data.toString('utf-8').trim()
      if (text) logger.debug({ prober: 'stdout' }, text)
    })
    proberProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim()
      if (text) logger.warn({ prober: 'stderr' }, text)
    })
    proberProcess.on('exit', (code) => {
      logger.info({ code }, 'Inbound prober process exited')
      proberProcess = null
    })
    proberProcess.on('error', (err) => {
      logger.error({ err }, 'Inbound prober spawn error')
      proberProcess = null
    })
  } catch (err) {
    logger.error({ err }, 'Inbound prober: failed to spawn')
    proberProcess = null
  }
}

// N5: renamed doInboundProbeCheck → checkInboundProbeDeafness (match check* convention)
function checkInboundProbeDeafness(probeTimeoutMs: number): void {
  // Session file absent — safe no-op.
  if (!existsSync(SESSION_FILE)) return

  const markerTs = readProbeLastSentMs()
  if (markerTs === null) {
    // No probe has been sent yet — nothing to check.
    return
  }

  const nowMs = Date.now()
  const lastIngestionTs = readLastIngestionTimestamp(TRANSCRIPT_DIR)

  const needsRespawn = shouldTriggerDeafnessRespawn({
    markerTs,
    lastIngestionTs,
    probeTimeoutMs,
    nowMs,
  })

  if (!needsRespawn) return

  // Lazy import to avoid circular dependency at module load time.
  // B2: also import lastMainRespawnAt to enforce cross-path grace (an inbound-probe
  // respawn must suppress the keepalive path and vice-versa).
  import('./channel-monitor.js').then(({ hardRestartMarveenChannels, lastMainRespawnAt }) => {
    const nowAfterImport = Date.now()

    // B2 fix: cross-path grace — skip if EITHER path has respawned recently.
    const msSinceCrossPathRespawn = nowAfterImport - lastMainRespawnAt()
    if (lastMainRespawnAt() > 0 && msSinceCrossPathRespawn < RESPAWN_GRACE_MS) {
      logger.info({ msSinceCrossPathRespawn }, 'Inbound deafness detected but within cross-path respawn grace -- skipping')
      return
    }

    // Inbound-path self-rate-cap (covers the period before marveenLastHardRestart
    // is set by the async call completing).
    if (lastInboundRespawn && nowAfterImport - lastInboundRespawn < RESPAWN_GRACE_MS) {
      logger.info({ msSinceLastRespawn: nowAfterImport - lastInboundRespawn }, 'Inbound deafness detected but within respawn grace -- skipping')
      return
    }

    logger.warn({ markerTs, lastIngestionTs, nowMs }, 'Inbound deafness detected -- triggering respawn')

    // hardRestartMarveenChannels sets marveenLastHardRestart on success, which
    // automatically suppresses the keepalive path for KEEPALIVE_RESPAWN_GRACE_MS.
    const result = hardRestartMarveenChannels()
    if (result.ok) {
      lastInboundRespawn = nowAfterImport
      logger.warn('Inbound deafness respawn triggered successfully')
    } else {
      logger.error({ error: result.error }, 'Inbound deafness respawn failed')
    }
  }).catch((err) => {
    logger.error({ err }, 'Inbound probe: failed to import channel-monitor for respawn')
  })
}

/**
 * Start the inbound-probe background loop.
 *
 * Called once during server startup (immediately after startChannelPluginMonitor).
 * A failure here must never crash the server — wrapped in try/catch at call site.
 *
 * The prober is a safe no-op when:
 *   - store/.watchdog-userbot.session is missing (account not set up)
 *   - ALLOWED_CHAT_ID is absent in .env
 *   - auth fails in the Python prober (exits 0 with warning)
 *
 * MANUAL GATE: the operator must run /telegram:access in the main channels session to
 * allowlist the prober account before messages will
 * be delivered. Until then the prober sends messages that are silently
 * dropped by the allowlist, and no respawn is triggered (the probe-last-sent
 * file won't be written).
 */
export function startInboundProber(): void {
  const probeIntervalMs = readProbeIntervalMs()

  // Spawn the Python prober immediately (it manages its own send loop).
  spawnProber()

  // TS-side check loop: runs at the same interval as the prober's send loop.
  // Each tick: re-spawn the prober if it died, then check the transcript.
  setInterval(() => {
    try {
      spawnProber()
      checkInboundProbeDeafness(probeIntervalMs * PROBE_TIMEOUT_MULTIPLIER)
    } catch (err) {
      logger.error({ err }, 'Inbound probe check tick failed')
    }
  }, probeIntervalMs)

  logger.info({ probeIntervalMs }, 'Inbound prober started')
}
