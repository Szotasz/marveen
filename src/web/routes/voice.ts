// /api/voice/* -- central STT and TTS service for the agent fleet.
//
// All endpoints require Bearer auth (enforced by src/web.ts before routing).
// STT: POST /api/voice/stt     -- transcribe a Telegram voice file_id
// TTS: POST /api/voice/tts     -- synthesize text to ogg/opus, send via Telegram sendVoice
// Config: GET/PUT /api/agents/:id/voice-config  (handled in agents.ts; see there)
// Modality: GET /api/voice/modality?agent=X&chat=Y
//           POST /api/voice/modality/set -- set last inbound modality (future plugin hook use)
// Directive: GET /api/voice/directive?agent=X&chat=Y  -- TTS curl string for UserPromptSubmit hook
//
// Security:
//   - voiceModel is whitelisted against KNOWN_VOICE_MODELS (no path traversal)
//   - spawn uses arg-array, shell:false (no shell injection)
//   - file_id validated to Telegram's safe character set before use
//   - state_dir resolved only to known agent channel dirs, never raw user paths

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { KNOWN_VOICE_MODELS, AGENTS_BASE_DIR, readAgentVoiceConfig, isKnownAgent } from '../agent-config.js'
import { getLastInboundModality, setLastInboundModality } from '../voice-modality.js'
import { buildTtsDirective, resolveAgentChannelStateDir, inboundIsAudio, parseTtsRequest } from '../voice-directive.js'
import { PROJECT_ROOT, MAIN_AGENT_ID, RESERVED_AGENT_IDS } from '../../config.js'
import type { RouteContext } from './types.js'

const VOICE_DIR = join(homedir(), '.local', 'share', 'marveen-voice')
const VTOOLS_PY = join(VOICE_DIR, '_vtools.py')
const VENV_PY = join(VOICE_DIR, 'venv', 'bin', 'python')

// STT wall-clock budget. Measured 2026-09-18 on an 8-core CPU box with the
// STOCK _vtools.py settings (faster-whisper "small"/int8, beam_size=5): a 2:26
// voice note took 110.1 s. The previous 60 s budget therefore silently killed
// every voice message longer than about two minutes -- the route returned
// transcript=null and nothing said why, so the owner's message simply vanished.
// At that measured rate 160 s covers roughly 3.5 minutes of audio.
// The figure is deliberately quoted for stock settings: an earlier revision of
// this change also lowered beam_size, which would have made the same budget
// stretch further, but that tuning lives in the INSTALLED copy of _vtools.py
// and a merge cannot deliver it -- so the budget must hold without it.
//
// THE THREE BOUNDS MUST BE STRICTLY INCREASING, innermost first:
//   this STT budget 160 s  <  voice-reply-directive.py urlopen 170 s
//                          <  hook `timeout` in settings.json 180 s
// The shortest wins, so if an outer bound is the smallest it fires first and
// the caller sees a bare socket/hook timeout instead of the server's own
// transcript=null -- the same "vanished with no reason" failure this change
// exists to remove, just later. Raising one of the three alone changes nothing.
// The budget is per CALLER, not per whisper run: queue wait + run share it (see runSttSingleFlight).
const STT_TIMEOUT_MS = 160_000

// Telegram file_ids are base64url + some punctuation; reject anything else.
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_\-]{10,200}$/

// Known agent channel dirs -- only these are accepted as state_dir.
// The channel plugin stores its .env (bot token) here.
const CHANNELS_BASE = join(homedir(), '.claude', 'channels')
// Install-scoped main-agent base (#915): <install>/.claude/channels/<provider>.
const INSTALL_CHANNELS_BASE = join(PROJECT_ROOT, '.claude', 'channels')

// Safe paths: ~/.claude/channels/<provider>/, <install>/.claude/channels/<provider>/
// OR <AGENTS_BASE_DIR>/<name>/.claude/channels/<provider>/
// All must contain a .env file. '..' traversal always rejected.
/** #3118: an agent id the TTS route resolves a channel dir for: the main agent or a fleet agent, canonical, never a
 *  reserved system id. */
function ttsAgentKnown(agentId: string): boolean {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId) || RESERVED_AGENT_IDS.includes(agentId)) return false
  return agentId === MAIN_AGENT_ID || isKnownAgent(agentId)
}

/**
 * TTSBIND1125: is this chat in the channel's allowlist (access.json `allowFrom`, the users the bot already lets in)?
 * The route takes a digits-only chat id, so a group (a negative id) never reaches here. A missing, unreadable or
 * malformed access.json allows nothing (fail closed).
 */
export function chatAllowedByChannel(stateDir: string, chatId: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf-8')) as { allowFrom?: unknown }
    if (!Array.isArray(raw.allowFrom)) return false
    return raw.allowFrom.some((e) => (typeof e === 'number' || typeof e === 'string') && String(e).trim() === chatId)
  } catch {
    return false
  }
}

function isSafeStateDir(dir: string): boolean {
  const resolved = dir.replace(/\/$/, '')
  if (resolved.includes('..')) return false
  if (!existsSync(join(resolved, '.env'))) return false
  if (resolved.startsWith(CHANNELS_BASE + '/') || resolved === CHANNELS_BASE) return true
  if (resolved.startsWith(INSTALL_CHANNELS_BASE + '/') || resolved === INSTALL_CHANNELS_BASE) return true
  if (resolved.startsWith(AGENTS_BASE_DIR + '/')) {
    // Must match: <AGENTS_BASE_DIR>/<agentName>/.claude/channels/<provider>
    const rel = resolved.slice(AGENTS_BASE_DIR.length + 1)
    return /^[a-zA-Z0-9_-]+\/\.claude\/channels\/[a-zA-Z0-9_-]+$/.test(rel)
  }
  return false
}

function voiceOnnxPath(model: string): string | null {
  if (!KNOWN_VOICE_MODELS.has(model)) return null
  const p = join(VOICE_DIR, 'voices', `${model}.onnx`)
  return existsSync(p) ? p : null
}

function isVoiceInstalled(): boolean {
  return existsSync(VENV_PY) && existsSync(VTOOLS_PY)
}

// Settle grace for runProc's timeout path when opts.onTimeout fired: the
// cleanup child spawned from there (the systemctl unit kill) is itself capped
// at 5_000 ms -- see runSttWhisper's onTimeout -- so allow that full cap plus
// 3s margin for the expected 'close' before settling anyway. If the cleanup
// fails, the killed child's inherited descriptors stay open for as long as
// the transient service lives, 'close' never arrives, and without this grace
// neither would the resolution (BLOCKER A1, measured 2026-11-18).
const RUNPROC_SETTLE_GRACE_MS = 8_000

function runProc(
  cmd: string,
  args: string[],
  opts: {
    stdinData?: string
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
    /** Opt-in for the STT isolation path only: see the listener below. */
    spawnErrorAsFailure?: boolean
    /**
     * Opt-in for the STT isolation path only: fired from inside the timeout
     * callback, right after the SIGKILL, for cleanup that must NOT wait for
     * the process's own 'close' -- with --pipe that close can be held hostage
     * by descriptors the child handed to a still-living service (see
     * runSttWhisper). Best-effort by contract: any throw is swallowed here,
     * never let it escape the timer.
     */
    onTimeout?: () => void
  } = {},
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false, ...(opts.env ? { env: opts.env } : {}) })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settleTimer: NodeJS.Timeout | null = null
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          proc.kill('SIGKILL')
          if (opts.onTimeout) {
            try { opts.onTimeout() } catch { /* best-effort by contract */ }
            // After the kill + cleanup, 'close' is deliverable ONLY through the
            // cleanup succeeding: if it fails, the descriptors the child handed
            // to a still-living service never close and this promise would hang
            // forever. Bound that wait and settle with the same failure shape a
            // killed child produces; resolving an already-resolved promise (a
            // late 'close') is a no-op, so no extra guard flag is needed.
            settleTimer = setTimeout(() => {
              resolve({ stdout, stderr, code: 1, timedOut: true })
            }, RUNPROC_SETTLE_GRACE_MS)
          }
        }, opts.timeoutMs)
      : null
    // Only the STT isolation spawns opt in: they run systemd-run/systemctl,
    // binaries that may legitimately be absent (container, no user systemd),
    // and there a missing binary must mean "fall back / swallow", not an
    // unhandled 'error' event taking the dashboard down. Every pre-existing
    // caller keeps the exact old behavior of no listener at all.
    if (opts.spawnErrorAsFailure) {
      proc.on('error', () => {
        if (timer) clearTimeout(timer)
        if (settleTimer) clearTimeout(settleTimer)
        resolve({ stdout, stderr, code: 127, timedOut })
      })
    }
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (settleTimer) clearTimeout(settleTimer)
      resolve({ stdout, stderr, code: code ?? 1, timedOut })
    })
  })
}

// Concurrency guard: prevents parallel installs racing on the same venv/DEST.
let _installInProgress = false

// --- STT subprocess isolation (incident 2026-11-18) -------------------------
//
// The whisper python used to run as a DIRECT child of the dashboard process,
// i.e. inside the dashboard's own systemd user-service cgroup (MemoryHigh=3G,
// MemoryMax=4G). Two transcriptions at once (each peaking well over a GiB with
// faster-whisper small/int8) pushed the whole service into
// mem_cgroup_handle_over_high and stalled the fleet's message traffic, while
// the host sat on ~134G free -- the constraint was never the machine, only the
// dashboard's slice. Two independent defenses live below, and both are needed:
//   1. single-flight: one transcription at a time, process-wide, callers queue;
//   2. cgroup isolation: on Linux each transcription runs in its own transient
//      systemd unit with its own MemoryHigh/MemoryMax, so whisper's memory
//      pressure throttles (and, at the ceiling, kills) only that unit.

// Per-transcription cgroup budget, in bytes (the -p properties take bytes):
// 1.5 GiB soft throttle / 3 GiB hard ceiling. Comfortably above one
// small/int8 run so the transcription itself is not throttled to death, yet
// small enough that the dashboard's own 3G/4G slice no longer carries the
// load at all. Overridable for ops tuning via MARVEEN_STT_MEMORY_HIGH/MAX.
const STT_UNIT_MEMORY_HIGH_B = 1_610_612_736
const STT_UNIT_MEMORY_MAX_B = 3_221_225_472

function sttMemoryLimitBytes(envName: string, fallback: number): number {
  const raw = process.env[envName]
  if (raw == null) return fallback
  // Strict digits-only: a lenient parse (parseInt, trimming, unit suffixes)
  // would silently accept "1.5G" or "4096x" and pin a wrong cgroup limit on
  // exactly the host someone was trying to tune. Digits alone are still not
  // a byte count: Number() maps a long-enough digit string to Infinity, and
  // past 2^53 it silently rounds (9007199254740993 comes back as ...992) --
  // either would pin a limit the operator never wrote. Only a safe positive
  // integer is accepted.
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!(Number.isSafeInteger(n) && n > 0)) {
    logger.warn({ envName, raw, fallback }, 'STT memory override invalid (need positive integer bytes), using default')
    return fallback
  }
  return n
}

// Ops escape hatch: MARVEEN_STT_MODE pins the spawn strategy without probing,
// so an on-call can react to a systemd regression without shipping code.
//   'direct'  -> always a plain child process (pre-incident behavior);
//   'systemd' -> always the transient unit;
//   unset/anything else -> auto: probe once, remember for the process lifetime.
let _sttIsolatedCache: boolean | null = null

async function sttUseIsolatedSpawn(): Promise<boolean> {
  // Non-Linux hosts have no systemd to talk to: never probe (the probe would
  // only burn 10s failing), keep the macOS path exactly as it always was.
  if (process.platform !== 'linux') return false
  const forced = process.env.MARVEEN_STT_MODE
  if (forced === 'direct') return false
  if (forced === 'systemd') return true
  if (_sttIsolatedCache != null) return _sttIsolatedCache
  // Capability probe: a host without a user systemd (container, odd distro)
  // must keep transcribing, not fail. /bin/true is the cheapest thing a unit
  // can run; --collect leaves no dead unit behind, --wait/--pipe make the rc
  // observable. 10s so a wedged user manager cannot add minutes to the first
  // voice note after boot. The answer is cached: one failed probe must not
  // re-pay 10s on every transcription for the rest of the process's life.
  const probe = await runProc(
    'systemd-run',
    ['--user', '--quiet', '--pipe', '--collect', '--wait', '/bin/true'],
    { timeoutMs: 10_000, spawnErrorAsFailure: true },
  )
  _sttIsolatedCache = probe.code === 0
  if (_sttIsolatedCache) {
    logger.info('STT: systemd-run transient unit available (probe ok; memory cap not verified)')
  } else {
    logger.warn({ code: probe.code }, 'STT: systemd-run probe failed, whisper stays in the dashboard cgroup (isolation off)')
  }
  return _sttIsolatedCache
}

// Single-flight lock for STT, process-wide. Concurrent callers queue FIFO
// through a promise chain; nobody is rejected, because every caller is a real
// inbound voice note -- racing two whispers into one cgroup is what started the
// incident. The chain is built from the task (never from the caller-facing
// race), so a caller that gives up does NOT release the queue: the next whisper
// starts only after the previous one's runProc settled. The chain remembers
// settlement only, never values, so one failed task cannot poison the rest.
//
// Each caller has a deadline (call time + STT_TIMEOUT_MS): queue wait and run
// share ONE budget, so the 160 s < 170 s < 180 s chain holds for queued callers
// too. A caller whose deadline passes while queued gets null at its deadline
// and its whisper is skipped without spawning when its turn comes.
//
// Same-file merge: the directive route and the router usually ask for the SAME
// voice note. A second call for the same key while the first is queued or
// running gets the same promise: one whisper, both get the transcript.
let _sttChain: Promise<unknown> = Promise.resolve()
// The running transcription plus everyone queued behind it; >1 after the
// increment means "this caller had to wait", at queue position count-1.
let _sttInOut = 0
// Same-file merge: key -> the promise of the caller that is already queued or running for that file.
const _sttInflight = new Map<string, Promise<string | null>>()

function runSttSingleFlight(
  key: string,
  fileId: string,
  deadline: number,
  fn: (deadline: number) => Promise<string | null>,
): Promise<string | null> {
  const existing = _sttInflight.get(key)
  if (existing) return existing
  _sttInOut++
  if (_sttInOut > 1) {
    logger.warn({ fileId, queuePosition: _sttInOut - 1 }, 'transcribeVoiceFile: STT busy, caller queued behind in-flight transcription')
  }
  let abandoned = false
  const task = _sttChain.then(() => {
    if (abandoned || Date.now() >= deadline) return null
    return fn(deadline)
  })
  _sttChain = task.then(() => undefined, () => undefined)
  void task.then(() => { _sttInOut-- }, () => { _sttInOut-- })
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<null>((resolve) => {
    expiryTimer = setTimeout(() => {
      abandoned = true
      resolve(null)
    }, Math.max(0, deadline - Date.now()))
  })
  const result: Promise<string | null> = Promise.race([task, expiry]).finally(() => {
    clearTimeout(expiryTimer)
    if (_sttInflight.get(key) === result) _sttInflight.delete(key)
  })
  _sttInflight.set(key, result)
  return result
}

// Monotonic counter for transient unit names: two calls must never share a
// unit, or the second systemd-run would collide with the first's unit.
let _sttUnitSeq = 0

async function runSttWhisper(fileId: string, stateDir: string, deadline: number): Promise<string | null> {
  let result: { stdout: string; stderr: string; code: number; timedOut: boolean }
  const isolated = await sttUseIsolatedSpawn()
  // Remaining budget, measured after the probe (which may take time).
  const budgetMs = deadline - Date.now()
  if (budgetMs <= 0) return null
  if (isolated) {
    const unit = `marveen-stt-${process.pid}-${++_sttUnitSeq}`
    // NOTE on environment: a transient unit starts from the user manager's
    // environment, NOT the dashboard's. The variables _vtools.py reads on the
    // transcribe path (MARVEEN_WHISPER_MODEL) and the proxy variables for the
    // Telegram download are forwarded by NAME with --setenv=NAME: systemd-run
    // copies the value from its own environment (it is our child), so the
    // value never reaches argv (a proxy URL can hold a password, and argv is
    // visible in /proc and ps).
    // The STT_TIMEOUT_MS budget now guards systemd-run itself (--wait makes
    // it forward the unit's exit), so the wall-clock contract is unchanged.
    //
    // WHY the unit kill fires from the timeout path and NOT after the await:
    // measured on the target host (2026-11-18) -- with --pipe the transient
    // service holds the supervisor's inherited stdout/stderr descriptors, so
    // the timer's SIGKILL only beheads systemd-run and leaves the service
    // alive; Node's 'close' then waits on those descriptors, and the awaited
    // result NEVER resolves while the service lives. A cleanup placed after
    // `await runProc(...)` would sit behind that blocked close: caller hung,
    // single-flight queue head blocked forever. Firing the kill here ends
    // the unit's processes, their inherited descriptors close, 'close' fires,
    // and the caller gets the same null failure as any other whisper death
    // (the unit's cgroup is not left burning CPU/RAM after everyone gave up,
    // either). Fire-and-forget, NOT awaited: best-effort by contract (5s cap,
    // rc and spawn errors swallowed), and the STT call must settle when its
    // descriptors close, not after systemctl finishes.
    const unitArgs: string[] = [
      '--user', '--quiet', '--pipe', '--collect', '--wait',
      '-p', `MemoryHigh=${sttMemoryLimitBytes('MARVEEN_STT_MEMORY_HIGH', STT_UNIT_MEMORY_HIGH_B)}`,
      '-p', `MemoryMax=${sttMemoryLimitBytes('MARVEEN_STT_MEMORY_MAX', STT_UNIT_MEMORY_MAX_B)}`,
      // Unit-side time limit: a unit outlives a dashboard restart by at most ~10 s beyond the budget.
      '-p', `RuntimeMaxSec=${Math.ceil(budgetMs / 1000) + 10}`,
    ]
    for (const name of ['MARVEEN_WHISPER_MODEL', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
      if (process.env[name] !== undefined) unitArgs.push(`--setenv=${name}`)
    }
    unitArgs.push(`--unit=${unit}`, VENV_PY, VTOOLS_PY, 'transcribe', fileId, stateDir)
    result = await runProc(
      'systemd-run',
      unitArgs,
      {
        timeoutMs: budgetMs,
        spawnErrorAsFailure: true,
        onTimeout: () => {
          void runProc(
            'systemctl', ['--user', 'kill', '--signal=SIGKILL', unit],
            { timeoutMs: 5_000, spawnErrorAsFailure: true },
          )
        },
      },
    )
  } else {
    // Direct spawn (non-Linux, MARVEEN_STT_MODE=direct, or failed probe): the
    // exact pre-incident call, semantics untouched.
    result = await runProc(VENV_PY, [VTOOLS_PY, 'transcribe', fileId, stateDir], { timeoutMs: budgetMs })
  }
  // Exit-code semantics shared by both spawn modes, unchanged from before
  // isolation existed: non-zero (incl. killed-on-timeout) -> warn with the
  // stderr head, null; success -> trimmed stdout.
  if (result.code !== 0) {
    logger.warn({ fileId, stderr: result.stderr.slice(0, 200) }, 'transcribeVoiceFile: whisper failed')
    return null
  }
  return result.stdout.trim()
}

// Transcribe a Telegram voice file via the local whisper toolkit. This is the
// single in-process entry point for STT -- both the /api/voice/stt route AND
// the message-router tick call it DIRECTLY. The router must never self-HTTP to
// /api/voice/stt: a process HTTP-calling its own dashboard from the 5s tick
// coupled message delivery to the HTTP server and, under sustained voice
// traffic, threw the event loop (progressive /api/agents latency 73ms -> 12s ->
// timeout). Returns the transcript, or null on any failure (toolkit missing,
// invalid input, whisper non-zero). Each caller has one
// STT_TIMEOUT_MS budget measured from its own call, covering both the wait in
// the queue and the whisper run, so a slow transcription can never hang the
// caller. Calls are serialized process-wide (one whisper at a time, see
// runSttSingleFlight) and on Linux run in an isolated transient systemd unit
// (see runSttWhisper), so STT can no longer drag the dashboard's cgroup into
// reclaim while it transcribes.
export async function transcribeVoiceFile(fileId: string, stateDir: string): Promise<string | null> {
  if (!isVoiceInstalled()) return null
  if (!SAFE_FILE_ID_RE.test(fileId)) return null
  if (!isSafeStateDir(stateDir)) return null
  const deadline = Date.now() + STT_TIMEOUT_MS
  return runSttSingleFlight(`${stateDir}\u0000${fileId}`, fileId, deadline, (dl) => runSttWhisper(fileId, stateDir, dl))
}

/**
 * Package-manager command for the missing system dependencies, per host
 * platform. The command has to match the host: apt-get does not exist on macOS,
 * where the dashboard also runs, and a command the user cannot run is worse
 * than no suggestion -- it reads as authoritative. Homebrew ships venv inside
 * its `python` formula, so there is no python3-venv counterpart to name there.
 */
export function systemDepsInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'brew install ffmpeg python'
    : 'sudo apt-get install -y --no-install-recommends ffmpeg python3-venv python3'
}

export async function tryHandleVoice(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/voice/directive?agent=X&chat=Y[&file=FILE_ID]
  // Returns { directive: string|null, transcript: string|null }.
  // directive semantics by responseMode:
  //   text  -> null (never speaks)
  //   voice -> always buildTtsDirective (speaks even for plain-text input)
  //   auto  -> buildTtsDirective only when the inbound attachment kind is audio
  //            (voice/audio/video_note). A document or photo attachment does NOT speak.
  // transcript: STT result when the attachment is audio and the id is valid (mode-independent --
  //   even text-mode agents benefit from knowing what a voice message said). Non-audio
  //   attachments are never pushed through speech-to-text.
  // fail-safe: STT errors set transcript=null; directive is always attempted independently.
  if (path === '/api/voice/directive' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    const fileParam = ctx.url.searchParams.get('file') ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'Invalid agent' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    const voiceCfg = readAgentVoiceConfig(agentId)
    const stateDir = resolveAgentChannelStateDir(agentId, 'telegram')
    const kindParam = ctx.url.searchParams.get('kind') ?? ''
    const fileIdOk = !!fileParam && SAFE_FILE_ID_RE.test(fileParam)
    // Audio is decided by the declared attachment kind, never by the mere
    // presence of a file id -- a document attachment is not a voice message.
    const inboundWasAudio = fileIdOk && inboundIsAudio(kindParam, fileParam)
    const ttsParams = { chatId, agentId, voiceModel: voiceCfg.voiceModel ?? 'hu_HU-imre-medium' }
    const directive = voiceCfg.responseMode === 'text' ? null
      : voiceCfg.responseMode === 'voice' ? buildTtsDirective(ttsParams)
      : inboundWasAudio ? buildTtsDirective(ttsParams)  // auto: only when inbound was audio
      : null

    let transcript: string | null = null
    if (inboundWasAudio && isVoiceInstalled()) {
      // Through transcribeVoiceFile, not a private runProc: this used to be a
      // SECOND whisper spawn site, and it ran outside any serialization -- the
      // directive endpoint could race the router's transcription and put two
      // whisper processes in the dashboard cgroup at once (incident
      // 2026-11-18). One entry point means one queue and one isolation unit.
      // `|| null` keeps this route's own contract: a failed STT AND an empty
      // transcript both report transcript=null (non-fatal either way).
      transcript = (await transcribeVoiceFile(fileParam, stateDir)) || null
    }

    json(res, { directive, transcript })
    return true
  }

  // GET /api/voice/modality?agent=X&chat=Y
  // Returns the last inbound modality for this agent+chat (for the channel plugin).
  if (path === '/api/voice/modality' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    if (!agentId || !chatId) { json(res, { error: 'agent and chat required' }, 400); return true }
    const modality = getLastInboundModality(agentId, chatId)
    json(res, { modality })
    return true
  }

  // POST /api/voice/modality/set
  // Body: { agent_id: string, chat_id: string, modality: 'voice'|'text' }
  // TODO: currently unused -- message-router sets modality in-process via setLastInboundModality().
  // Kept for future use if a channel plugin fork needs to set modality over HTTP.
  if (path === '/api/voice/modality/set' && method === 'POST') {
    const body = await readBody(req)
    let data: { agent_id?: string; chat_id?: string; modality?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const agentId = data.agent_id?.trim() ?? ''
    const chatId = data.chat_id?.trim() ?? ''
    const modality = data.modality?.trim() ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'Invalid agent_id' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    if (modality !== 'voice' && modality !== 'text') { json(res, { error: 'modality must be voice or text' }, 400); return true }
    setLastInboundModality(agentId, chatId, modality as 'voice' | 'text')
    json(res, { ok: true })
    return true
  }

  // GET /api/voice/status -- is the voice toolkit installed?
  if (path === '/api/voice/status' && method === 'GET') {
    const installed = isVoiceInstalled()
    const voices = installed
      ? Array.from(KNOWN_VOICE_MODELS).filter((m) => existsSync(join(VOICE_DIR, 'voices', `${m}.onnx`)))
      : []
    json(res, { installed, voices, voiceDir: VOICE_DIR })
    return true
  }

  // POST /api/voice/stt
  // Body: { file_id: string, state_dir: string }
  // Returns: { transcript: string }
  if (path === '/api/voice/stt' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'Voice toolkit not installed' }, 503); return true }
    const body = await readBody(req)
    let data: { file_id?: string; state_dir?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const fileId = data.file_id?.trim() ?? ''
    const stateDir = data.state_dir?.trim() ?? ''
    if (!SAFE_FILE_ID_RE.test(fileId)) { json(res, { error: 'Invalid file_id' }, 400); return true }
    if (!isSafeStateDir(stateDir)) { json(res, { error: 'Invalid state_dir' }, 400); return true }

    const transcript = await transcribeVoiceFile(fileId, stateDir)
    if (transcript === null) {
      logger.warn({ fileId }, '/api/voice/stt: whisper failed')
      json(res, { error: 'STT failed' }, 500)
      return true
    }
    json(res, { transcript })
    return true
  }

  // POST /api/voice/tts
  // Body: { text: string, voice_model: string, chat_id: string, state_dir: string }
  //   or, with Content-Type text/plain: the text as the body, and
  //   ?chat_id=&state_dir=&voice_model= in the query string (the directive's shape, #2600).
  // Returns: { ok: boolean, message_id?: number }
  if (path === '/api/voice/tts' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'Voice toolkit not installed' }, 503); return true }
    const body = await readBody(req)
    // text/plain (the directive, #2600) or the JSON body: parseTtsRequest reads both.
    const parsed = parseTtsRequest(req.headers['content-type'], body, ctx.url.searchParams, 'hu_HU-imre-medium')
    if (!parsed) { json(res, { error: 'Invalid JSON' }, 400); return true }
    const { text, voiceModel, chatId, agentId } = parsed

    if (!text) { json(res, { error: 'text required' }, 400); return true }
    if (!/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    // #3118: the directive names the agent, and the dir is resolved here (resolveAgentChannelStateDir), so the
    // sub-agent's command carries no channel path. The old state_dir shape still works; giving both is refused.
    if (agentId && parsed.stateDir) { json(res, { error: 'Give agent or state_dir, not both' }, 400); return true }
    if (agentId && !ttsAgentKnown(agentId)) { json(res, { error: 'Invalid agent' }, 400); return true }
    const stateDir = agentId ? resolveAgentChannelStateDir(agentId, 'telegram') : parsed.stateDir
    if (!isSafeStateDir(stateDir)) { json(res, { error: 'Invalid state_dir' }, 400); return true }
    // TTSBIND1125 (Dani's review on #3125): the caller is not identified (the shared token), so any token holder can
    // name any agent's bot. The voice goes only to a chat that bot already lets in: the channel's own allowlist.
    if (!chatAllowedByChannel(stateDir, chatId)) {
      json(res, { error: 'chat_id is not allowed by this channel (access.json allowFrom)' }, 403)
      return true
    }

    const onnxPath = voiceOnnxPath(voiceModel)
    if (!onnxPath) {
      json(res, { error: `Unknown or missing voice model: ${voiceModel}` }, 400)
      return true
    }

    const result = await runProc(
      VENV_PY,
      [VTOOLS_PY, 'speak', onnxPath, stateDir, chatId, text],
      // The installed toolkit lives outside the install tree; tell it which
      // install it serves so it can find the conversation ledger.
      { timeoutMs: 90_000, env: { ...process.env, MARVEEN_INSTALL_DIR: PROJECT_ROOT } },
    )
    if (result.code !== 0) {
      logger.warn({ voiceModel, chatId, stderr: result.stderr }, '/api/voice/tts: piper/sendVoice failed')
      json(res, { error: 'TTS failed', detail: result.stderr.slice(0, 200) }, 500)
      return true
    }
    // _vtools.py prints "ok=True id=12345" or "ok=False id=None"
    const okMatch = result.stdout.match(/ok=(\w+)/)
    const idMatch = result.stdout.match(/id=(\d+)/)
    json(res, {
      ok: okMatch?.[1]?.toLowerCase() === 'true',
      message_id: idMatch ? parseInt(idMatch[1], 10) : null,
    })
    return true
  }

  // POST /api/voice/install
  // Checks system dependencies (ffmpeg + python3-venv). If missing: returns
  // { needsSudo: true, sudoCommand } so the user can run it manually. If deps
  // are present, spawns install-voice.sh with SKIP_SYSTEM_DEPS=1 (no root
  // needed) and returns immediately; the client polls /api/voice/status.
  if (path === '/api/voice/install' && method === 'POST') {
    if (isVoiceInstalled()) {
      json(res, { ok: true, alreadyInstalled: true })
      return true
    }

    // Check system deps without root
    const depCheck = await runProc('bash', ['-c',
      'command -v ffmpeg >/dev/null 2>&1' +
      ' && ffmpeg -encoders 2>&1 | grep -q libopus' +
      ' && python3 -m venv --help >/dev/null 2>&1' +
      ' && echo OK || echo MISSING',
    ], { timeoutMs: 8000 })
    const depsMissing = !depCheck.stdout.trim().endsWith('OK')

    if (depsMissing) {
      json(res, { needsSudo: true, sudoCommand: systemDepsInstallCommand() })
      return true
    }

    if (_installInProgress) {
      json(res, { ok: true, started: true, alreadyRunning: true })
      return true
    }

    // Deps present -- fire-and-forget the install (no root needed from here).
    // detached:true + unref() keeps the child alive even if the dashboard
    // restarts mid-install (pip + ~126 MB download can take several minutes).
    _installInProgress = true
    const scriptPath = join(PROJECT_ROOT, 'scripts', 'install-voice.sh')
    const child = spawn('bash', [scriptPath], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SKIP_SYSTEM_DEPS: '1' },
    })
    child.unref()
    child.on('error', (err) => { _installInProgress = false; logger.warn({ err }, '/api/voice/install: spawn error') })
    child.on('close', (code) => {
      _installInProgress = false
      if (code !== 0) logger.warn({ code }, '/api/voice/install: install-voice.sh exited non-zero')
      else logger.info('/api/voice/install: install-voice.sh completed successfully')
    })

    json(res, { ok: true, started: true })
    return true
  }

  return false
}
