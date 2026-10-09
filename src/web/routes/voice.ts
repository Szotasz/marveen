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
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { KNOWN_VOICE_MODELS, AGENTS_BASE_DIR, readAgentVoiceConfig } from '../agent-config.js'
import { getLastInboundModality, setLastInboundModality } from '../voice-modality.js'
import { buildTtsDirective, resolveAgentChannelStateDir, inboundIsAudio, mainChannelStateDirFor } from '../voice-directive.js'
import { PROJECT_ROOT, STORE_DIR, VOICE_CALIBRATION_ALERT_AGENT, voiceSttCalibration, type VoiceSttCalibration } from '../../config.js'
import { notifyChat } from '../../notify.js'
import { MORNING_BATCH_VOICE_KEYWORD, queueVoiceNoticeForMorningBatch, voiceNoticeHeldFor, VOICE_QUIET_END_HOUR, VOICE_QUIET_START_HOUR } from '../voice-quiet-hours.js'
import { createAgentMessage } from '../../db.js'
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

function runProc(
  cmd: string,
  args: string[],
  opts: { stdinData?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false, ...(opts.env ? { env: opts.env } : {}) })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => { proc.kill('SIGKILL') }, opts.timeoutMs)
      : null
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}

// Concurrency guard: prevents parallel installs racing on the same venv/DEST.
let _installInProgress = false

// Transcribe a Telegram voice file via the local whisper toolkit. This is the
// single in-process entry point for STT -- both the /api/voice/stt route AND
// the message-router tick call it DIRECTLY. The router must never self-HTTP to
// /api/voice/stt: a process HTTP-calling its own dashboard from the 5s tick
// coupled message delivery to the HTTP server and, under sustained voice
// traffic, threw the event loop (progressive /api/agents latency 73ms -> 12s ->
// timeout). The whisper subprocess keeps its own STT_TIMEOUT_MS budget inside
// runProc, so a slow transcription can never hang the caller.
//
// The outcome of one speech-to-text attempt, as four DISTINGUISHABLE states.
//
// Why a union and not `string | null` (2026-09-07, kanban deeaa175): the old
// signature collapsed three different things into one `null` --
//   the toolkit is missing / the input was rejected,
//   the model ran fine and produced nothing,
//   the model crashed or timed out.
// Both endpoints then had to guess. `/api/voice/directive` answered 200 + null
// for all of them; `/api/voice/stt` answered 500 for all of them. Two endpoints,
// same situation, opposite verdicts -- and neither told the caller which case it
// was in. Measured that day: two real owner voice messages hit the middle case
// (exit 0, empty output, no stderr) and vanished with no signal to anyone.
export type VoiceTranscription =
  | { status: 'ok'; transcript: string; confidence: 'high' | 'uncertain' | 'unreliable'; noSpeechProb: number | null; durationSec: number | null; temperature: number | null; calibrationMismatch: CalibrationMismatch | null }
  | { status: 'no-transcript'; transcript: null; durationSec: number | null; calibrationMismatch: CalibrationMismatch | null }
  | { status: 'failed'; transcript: null; reason: string }
  | { status: 'unavailable'; transcript: null; reason: string }

// The calibrated speech-to-text chain and the one that actually ran, when the two
// differ (card 75c3d163). See VOICE_STT_CALIBRATED_MODEL below.
export type CalibrationMismatch = { expected: string; actual: string }

// Above this the model is telling us it probably was not speech. A transcript from
// the upper band is a CANDIDATE, and the agent has to be told so -- it is the
// difference between acting on a message and asking about one.
//
// THIS NUMBER IS CALIBRATED TO A SPECIFIC MODEL, AND IT DOES NOT SURVIVE A MODEL
// CHANGE. Measured 2026-09-07 on faster-whisper **small**: genuine owner messages sat
// at 0.024-0.108, the two lost ones at 0.772, a quiet-noise clip that hallucinated
// confidently at 0.875. The gap between 0.108 and 0.772 is what made 0.2 safe.
// Re-measured the same six files after the toolkit moved to **medium**: the same
// genuine messages came back HIGHER, and most of them crossed this threshold. The
// recordings did not change; the scale did.
// The figures from that first re-measurement are deliberately NOT repeated here.
// They were superseded within the hour (the toolkit changed again at 15:34), and a
// corrected number's old copy is exactly what keeps getting cited afterwards. The one
// set of live figures is in the block below; there is no second place to read them.
// SO: whoever changes the model or the decoding options of the INSTALLED toolkit
// (~/.local/share/marveen-voice/_vtools.py, deployed by scripts/install-voice.sh) is
// also moving this threshold, whether they mean to or not. Re-measure the known-good
// files first and put the new value into the install's configuration, with the model
// name next to it (the end of this block). A threshold without its measurement
// conditions is a number without a denominator.
//
// ONE INSTALL'S VALUE, 0.9, AND WHAT IT RESTS ON (measured 2026-09-07 15:30-15:45Z on the
// calibrating install; a record of how the measurement is done, NOT a default):
//   chain      faster-whisper MEDIUM, revision 08e178d4879074, float16 on a GPU,
//              WITH vad_filter=True, condition_on_previous_text=False AND an
//              initial_prompt domain vocabulary (STT_INITIAL_PROMPT). That was a
//              pinned build of the toolkit on that install, NOT the repo's
//              scripts/voice/_vtools.py, which runs MARVEEN_WHISPER_MODEL from the Hub
//              (default small), int8 on the CPU, without VAD or vocabulary. Every one
//              of those is part of the calibration; change any and this number is
//              stale. So the repo ships neither this number nor its key (the end of
//              this block).
//   speech     n=4 real owner voice messages, 4.4-9.1s, all plainly understandable
//              Hungarian: 0.153, 0.213, 0.304, 0.860. Measured max 0.860.
//   NON-speech n=3 synthetic controls -- digital silence, quiet pink noise, loud white
//              noise -- ALL produced ZERO segments and therefore land on the
//              'no-transcript' branch. They never reach this comparison at all.
//
// THESE NUMBERS MOVED ONCE ALREADY, INSIDE THE SAME HOUR, AND THAT IS WHY THE
// VOCABULARY IS LISTED ABOVE. The first reading on this very model was MEASURABLY
// LOWER. Then the initial_prompt was extended (brand names plus our own words: DNS,
// Let's Encrypt, certbot...) -- a change nobody would file under "threshold" -- and the
// SAME six recordings came back at the figures above. A decoding hint moved a safety
// limit. The earlier figures are not reproduced anywhere in this file on purpose: they
// are superseded, and a superseded number that stays readable is a number that will be
// quoted again.
// AND THE SHIFT IS NOT RUN-TO-RUN NOISE, WHICH HAD TO BE MEASURED SEPARATELY, because a
// number that moves is otherwise indistinguishable from a number that wobbles: the worst
// file was transcribed THREE times on the current chain and returned 0.860 each time
// (15:43-15:48Z, independently of the reading above). Same input, same output, three
// times -- so what changed between the two readings was the CHAIN, not the dice.
//
// The controls are the actual argument, not the maximum: with the VAD in front, this
// threshold can no longer separate speech from non-speech, because non-speech does not
// arrive here any more. At 0.2 it can only produce FALSE POSITIVES -- on the current
// chain ALL FOUR genuine messages are above 0.2. 0.9 keeps the mechanism alive for a
// genuine outlier, but the headroom above the measured maximum is 0.040 -- roughly a
// quarter of what the first, superseded reading suggested. A margin that thin is a
// standing instruction to re-measure before touching the toolkit again.
// STOPPING RULE, agreed in advance on 2026-09-07: if a GENUINE message crosses 0.9
// within the next week, the labelling gets SUSPENDED -- the number does not get raised
// again. A threshold that keeps retreating in front of the data is not a threshold, it
// is a running commentary.
//
// AND THE SECOND BRANCH OF THAT RULE, WHICH THE FIRST ONE CANNOT SEE: the rule above
// only measures FALSE POSITIVES -- the number. It says nothing about the OTHER way this
// fails, which is that the RECIPIENT stops reacting. If an owner gets a doubt-flag on
// most of their good messages, they learn to skip it, and then the one genuinely
// uncertain transcript is skipped too. A brake that people are trained to ignore has
// already stopped being a brake, and no measurement of the threshold will reveal that --
// the threshold looks fine right up to the end. So the labelling is ALSO suspended if
// the owner says it bothers them, OR if they visibly stop responding to it. That second
// condition is not measured here; it is observed by whoever talks to them, which is the
// point: this failure mode lives outside the code, so the code has to name it or nobody
// will.
// n=4 IS A SMALL SAMPLE. This is the best available evidence, not a law; four owner
// recordings are what exists. Widen it before leaning harder on this number than
// "suppress a notice", and re-measure on the FIRST model change either way.
//
// THE NUMBER AND THE CHAIN IT WAS MEASURED ON ARE INSTALL CONFIGURATION (card 75c3d163),
// read TOGETHER in src/config.ts (voiceSttCalibration), so that whoever re-measures the
// threshold updates its key in the same edit: a threshold and its calibration key that
// live apart drift apart, which is how the 2026-09-07 model change moved this number
// while nobody knew it had moved. The key is the model as the toolkit names it on its
// diag line; the install above runs a pinned model directory whose name carries the
// revision, so it sets
//   VOICE_STT_CALIBRATED_MODEL=faster-whisper-medium-08e178d48790749d25932bbc082711ddcfdfbc4f@08e178d48790749d25932bbc082711ddcfdfbc4f
//   VOICE_STT_UNCERTAIN_NO_SPEECH_PROB=0.9
// UNSET, the default and the repo's own toolkit's case (it has not been calibrated): no
// transcript is labelled 'uncertain' from no_speech_prob (the 'unreliable' and
// 'no-transcript' outcomes do not depend on it), and there is no calibration for a model
// to mismatch, so no warn, no state and no alert.
let sttCalibrationProblemLogged = false
function sttCalibration(): VoiceSttCalibration | null {
  const { calibration, problem } = voiceSttCalibration()
  if (problem && !sttCalibrationProblemLogged) {
    sttCalibrationProblemLogged = true
    logger.warn({ problem }, 'voice: the STT calibration setting is ignored -- no uncertainty labelling and no mismatch signal')
  }
  return calibration
}

type VtoolsDiag = {
  model: string | null
  revision: string | null
  segments: number | null
  durationSec: number | null
  noSpeechProb: number | null
  temperature: number | null
}

// One line on stderr from _vtools.py. Absent on an older installed copy of the
// toolkit (scripts/install-voice.sh deploys it separately from the dashboard),
// so every field is optional and the caller degrades to "unknown" rather than
// to a wrong answer.
// Every vtools-diag line is read, not only the first, and the LAST value of a key
// wins: a toolkit may emit an earlier line of its own (a pinned GPU build writes
// `vtools-diag device_fallback=cpu ...` before it transcribes), and reading only the
// first line would then lose every measurement -- silently, as "unknown".
// model= and revision= are strings (a directory name carries letters and dashes), so
// they get a token reader; the measurements keep the numeric one.
function parseVtoolsDiag(stderr: string): VtoolsDiag {
  const fields = new Map<string, string>()
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('vtools-diag ')) continue
    for (const m of line.slice('vtools-diag '.length).matchAll(/(?:^|\s)([a-z_]+)=(\S*)/g)) fields.set(m[1], m[2])
  }
  const num = (key: string): number | null => {
    const v = fields.get(key)
    if (!v || !/^-?[0-9.]+$/.test(v)) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const str = (key: string): string | null => fields.get(key) || null
  return {
    model: str('model'),
    revision: str('revision'),
    segments: num('segments'),
    durationSec: num('duration'),
    noSpeechProb: num('no_speech_prob'),
    temperature: num('temperature'),
  }
}

// Card 75c3d163, and the design decision recorded on it (2026-09-07 18:15Z): a model
// that is not the calibrated one does NOT change the classification. Refusing 'high' on
// a mismatch would flag every genuine message on the foreign chain -- the very false
// positives deeaa175 removed, brought back through another door. Two different claims:
// "the text is uncertain" belongs to the SENDER, "the threshold was made for another
// chain" belongs to US; packing the second into the first is a category error. So the
// mismatch travels separately (the response field, a warn, a one-time message, a state).
// A MISSING model field is an OLDER toolkit, not a foreign model: today's behaviour,
// no degradation, no signal. NO CALIBRATION CONFIGURED is not a mismatch either: there
// is nothing to compare with, so the repo's default model raises nothing.
function calibrationMismatchOf(diag: VtoolsDiag, cal: VoiceSttCalibration | null): CalibrationMismatch | null {
  if (cal == null || diag.model == null) return null
  const sameModel = diag.model === cal.model
  const sameRevision = cal.revision == null || diag.revision == null || diag.revision === cal.revision
  if (sameModel && sameRevision) return null
  return { expected: cal.model, actual: diag.revision ? `${diag.model}@${diag.revision}` : diag.model }
}

// The persistent state of the mismatches seen so far, one entry per (expected, actual)
// pair. It does two jobs: it is the DEDUP (the message goes once per pair and does not
// come back after a dashboard restart), and it is the place the mismatch can still be
// READ later (GET /api/voice/status), because a one-time message gets lost in a queue
// and a state that nobody opens never speaks: each covers the other's failure mode.
type CalibrationEntry = {
  expected: string
  actual: string
  firstSeenAt: string
  lastSeenAt: string
  count: number
  notifiedAt: string | null
  notifiedAgent: string | null
  messageId: number | null
}
// Fallback dedup for a process that cannot write the state file: without it, every
// voice message would queue the same notice again.
const calibrationNotifiedThisProcess = new Set<string>()
// The warn goes once per model pair per process, not once per message: the state keeps
// counting, and GET /api/voice/status shows the count.
const calibrationWarnedThisProcess = new Set<string>()

function calibrationStatePath(): string {
  return join(STORE_DIR, 'voice-calibration.json')
}

export function readCalibrationState(): Record<string, CalibrationEntry> {
  let raw: string
  try {
    raw = readFileSync(calibrationStatePath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn({ err }, 'voice: calibration state unreadable')
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, CalibrationEntry>
    logger.warn('voice: calibration state is not an object, ignoring it')
  } catch (err) {
    logger.warn({ err }, 'voice: calibration state is not valid JSON, ignoring it')
  }
  return {}
}

function writeCalibrationState(state: Record<string, CalibrationEntry>): void {
  const target = calibrationStatePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
    renameSync(tmp, target)
  } catch (err) {
    logger.warn({ err, target }, 'voice: could not write the calibration state')
  }
}

function reportCalibrationMismatch(m: CalibrationMismatch, threshold: number): void {
  const key = `${m.expected} -> ${m.actual}`
  if (!calibrationWarnedThisProcess.has(key)) {
    calibrationWarnedThisProcess.add(key)
    logger.warn({ expected: m.expected, actual: m.actual },
      'voice: the STT model is not the calibrated one -- the uncertainty threshold is NOT measured on this chain')
  }
  const now = new Date().toISOString()
  const state = readCalibrationState()
  const entry: CalibrationEntry = state[key] ?? {
    expected: m.expected, actual: m.actual, firstSeenAt: now, lastSeenAt: now, count: 0,
    notifiedAt: null, notifiedAgent: null, messageId: null,
  }
  entry.count += 1
  entry.lastSeenAt = now
  if (!entry.notifiedAt && !calibrationNotifiedThisProcess.has(key)) {
    try {
      const msg = createAgentMessage(
        'voice-calibration',
        VOICE_CALIBRATION_ALERT_AGENT,
        `[voice-calibration] A hang-toolkit mas beszedfelismero modellt futtat, mint amire a leirat-bizonytalansagi kuszob kalibralva van: kalibralt ${m.expected}, a diag-sor szerint ${m.actual}. ` +
        `A besorolas (high/uncertain/unreliable) valtozatlanul fut, de a kuszob (${threshold}) ezen a modellen NEM MERT, tehat a bizonytalan-jelolesek ervenyessege ismeretlen. ` +
        'Teendo: az ismert jo felveteleken a no_speech_prob tartomany ujramerese ezen a modellen, es a telepites VOICE_STT_CALIBRATED_MODEL es VOICE_STT_UNCERTAIN_NO_SPEECH_PROB beallitasanak egyutt frissitese (card 75c3d163). ' +
        'Ez az uzenet erre a modell-parra egyszer megy; az allapot: GET /api/voice/status, calibration mezo.',
      )
      calibrationNotifiedThisProcess.add(key)
      entry.notifiedAt = now
      entry.notifiedAgent = VOICE_CALIBRATION_ALERT_AGENT
      entry.messageId = msg.id
    } catch (err) {
      logger.warn({ err, key }, 'voice: could not queue the calibration-mismatch notice')
    }
  }
  state[key] = entry
  writeCalibrationState(state)
}

export async function transcribeVoiceFileDetailed(fileId: string, stateDir: string): Promise<VoiceTranscription> {
  if (!isVoiceInstalled()) return { status: 'unavailable', transcript: null, reason: 'voice toolkit not installed' }
  if (!SAFE_FILE_ID_RE.test(fileId)) return { status: 'unavailable', transcript: null, reason: 'invalid file id' }
  if (!isSafeStateDir(stateDir)) return { status: 'unavailable', transcript: null, reason: 'invalid state dir' }
  const result = await runProc(VENV_PY, [VTOOLS_PY, 'transcribe', fileId, stateDir], { timeoutMs: STT_TIMEOUT_MS })
  const diag = parseVtoolsDiag(result.stderr)
  if (result.code !== 0) {
    logger.warn({ fileId, code: result.code, stderr: result.stderr.slice(0, 200) }, 'transcribeVoiceFile: STT chain failed')
    return { status: 'failed', transcript: null, reason: `stt exited ${result.code}` }
  }
  const cal = sttCalibration()
  const calibrationMismatch = calibrationMismatchOf(diag, cal)
  if (calibrationMismatch && cal) reportCalibrationMismatch(calibrationMismatch, cal.threshold)
  const text = result.stdout.trim()
  if (!text) {
    // The chain SUCCEEDED and produced nothing. This is the case that used to be
    // silent, and it is deliberately NOT an error: the model made a decision.
    // It still has to reach a human, because a voice message did arrive.
    logger.warn({ fileId, durationSec: diag.durationSec, segments: diag.segments },
      'transcribeVoiceFile: audio accepted, model produced no transcript')
    return { status: 'no-transcript', transcript: null, durationSec: diag.durationSec, calibrationMismatch }
  }
  // TWO INDEPENDENT DOUBTS, and they do not mean the same thing (measured 2026-09-07):
  //   temperature > 0 -> the DETERMINISTIC decode failed and this text was SAMPLED off
  //                      the fallback ladder. Not "probably misheard" -- "there is no
  //                      reliable reading of this audio at all".
  //   noSpeechProb    -> the model doubts there was speech here, but it read it confidently.
  //                      This is the band that produced a clean-looking "Sziasztok!" from
  //                      quiet noise, at temperature 0.0.
  // 'unreliable' ranks first because it is the stronger claim about the same text.
  //
  // MEASURED LIMIT, so nobody expects more from this field than it gives: in the sample
  // we have, every temperature>0 case ended with ZERO segments and therefore lands on the
  // no-transcript branch instead of here -- the diag line carries the segment's values, and
  // a dropped segment has none. So today this branch catches nothing the other one misses.
  // It is here for the case that DOES reach us: a sampled text that survives the filter.
  const sampled = diag.temperature != null && diag.temperature > 0
  // No calibration configured, no threshold: no_speech_prob labels nothing (see the threshold block).
  const uncertain = cal != null && diag.noSpeechProb != null && diag.noSpeechProb >= cal.threshold
  return {
    status: 'ok',
    transcript: text,
    confidence: sampled ? 'unreliable' : uncertain ? 'uncertain' : 'high',
    noSpeechProb: diag.noSpeechProb,
    durationSec: diag.durationSec,
    temperature: diag.temperature,
    calibrationMismatch,
  }
}

// Back-compat wrapper: same contract as before for callers that only want text
// (the message-router tick): the transcript, or null on any other outcome.
export async function transcribeVoiceFile(fileId: string, stateDir: string): Promise<string | null> {
  const r = await transcribeVoiceFileDetailed(fileId, stateDir)
  return r.status === 'ok' ? r.transcript : null
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
  // Returns { directive: string|null, transcript: string|null, transcriptStatus, transcriptConfidence,
  //   transcriptNotice, noticeDelivered, calibrationMismatch } (the last five: cards deeaa175, 75c3d163).
  // directive semantics by responseMode:
  //   text  -> null (never speaks)
  //   voice -> always buildTtsDirective (speaks even for plain-text input)
  //   auto  -> buildTtsDirective only when the inbound attachment kind is audio
  //            (voice/audio/video_note). A document or photo attachment does NOT speak.
  // transcript: STT result when the attachment is audio and the id is valid (mode-independent --
  //   even text-mode agents benefit from knowing what a voice message said). Non-audio
  //   attachments are never pushed through speech-to-text.
  // fail-safe: STT errors set transcript=null and say why in transcriptStatus/transcriptNotice;
  //   directive is always attempted independently.
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
    const ttsParams = { chatId, stateDir, voiceModel: voiceCfg.voiceModel ?? 'hu_HU-imre-medium' }
    const directive = voiceCfg.responseMode === 'text' ? null
      : voiceCfg.responseMode === 'voice' ? buildTtsDirective(ttsParams)
      : inboundWasAudio ? buildTtsDirective(ttsParams)  // auto: only when inbound was audio
      : null

    let transcript: string | null = null
    let transcriptStatus: VoiceTranscription['status'] | null = null
    let transcriptNotice: string | null = null
    let transcriptConfidence: 'high' | 'uncertain' | 'unreliable' | null = null
    let calibrationMismatch: CalibrationMismatch | null = null
    if (inboundWasAudio && isVoiceInstalled()) {
      const stt = await transcribeVoiceFileDetailed(fileParam, stateDir)
      transcriptStatus = stt.status
      if (stt.status === 'ok' || stt.status === 'no-transcript') calibrationMismatch = stt.calibrationMismatch
      if (stt.status === 'ok') {
        transcript = stt.transcript
        transcriptConfidence = stt.confidence
        // An uncertain transcript is still delivered -- withholding it would
        // recreate the silent loss from the other side -- but it is delivered
        // WITH the doubt attached, so the agent asks instead of acting.
        if (stt.confidence === 'unreliable') {
          transcriptNotice = 'A leiratot a modell NEM olvasta ki megbizhatoan (a determinisztikus dekodolas megbukott, ez a szoveg mintavetelezett). Ne kezeld tenykent: mondd vissza a kuldonek, es kerd, hogy erositse meg.'
        } else if (stt.confidence === 'uncertain') {
          // MONDD VISSZA, not merely "ask back": when the channel notice below goes out, it PROMISES
          // the sender that we will repeat what we understood. If the agent only asks a question
          // instead, the sender waits for a promise nobody keeps -- which is worse than sending
          // nothing, because now they are expecting it. The manual step this automates (2026-09-07)
          // was exactly a read-back, not a question. Whether the promise was made is added below,
          // after the send (75c3d163 G1): the agent is told what actually reached the sender.
          transcriptNotice = 'A leirat BIZONYTALAN (a modell szerint lehet, hogy nem beszed volt). MONDD VISSZA a valaszodban SZO SZERINT, amit ertettunk, es kerd, hogy javitson. Ne kezeld tenykent.'
        }
      } else if (stt.status === 'no-transcript') {
        // THE CASE THAT USED TO BE SILENT. A voice message arrived, the chain
        // worked, and there is nothing to show for it. The sender is waiting for
        // an answer, so this must reach the agent -- a log line reaches nobody.
        const secs = stt.durationSec != null ? ` (${stt.durationSec.toFixed(1)} mp)` : ''
        transcriptNotice = `Hangüzenet erkezett${secs}, de NEM sikerult leiratozni. Nem tudod, mi hangzott el -- kerdezz vissza a kuldotol.`
      } else {
        transcriptNotice = 'Hangüzenet erkezett, de a leiratozas HIBAVAL allt le. Kerdezz vissza a kuldotol, es jelezd, hogy a leiratozo nem mukodik.'
      }
    }

    // ---- (A) THE DELIVERY (card deeaa175) ----------------------------------
    // The hook's stdout reaches the AGENT. That is not delivery to the PERSON
    // who spoke: if the agent forgets to mention it, the sender is back to
    // silence -- which is the exact failure this card exists to remove. So the
    // SERVER tells them, on the channel, addressed to the validated `chat` that
    // just sent the audio (never a configured alert or owner chat -- see notifyChat).
    //
    // NO TRANSCRIPT TEXT IN THIS MESSAGE, in either case, and that is
    // structural rather than a compromise: this send performs the DELIVERY, the
    // agent's reply performs the CONTENT. So the rule "transcript text does not
    // go anywhere that leaves the machine" holds without needing an exception.
    //
    // ONLY ON THE MAIN BOT (75c3d163 G1, review): notifyChat sends with the install's bot (CHANNEL_TOKEN). An
    // agent with its OWN bot has the sender's chat on that bot, so a notice from the main bot would reach the person from
    // the wrong bot, or fail with 403 when they never started the main bot. For such an agent the server does not try
    // (noticeDelivered stays null), and the transcriptNotice below tells the agent to say it in its own reply.
    let noticeDelivered: boolean | null = null
    // 75c3d163 (a): null = not a quiet-list case; true = in the main agent's morning batch row; false = that write failed
    let noticeQueued: boolean | null = null
    const needsChannelNotice =
      transcriptStatus === 'no-transcript' || transcriptConfidence === 'uncertain' || transcriptConfidence === 'unreliable'
    const chatOnMainBot = stateDir === mainChannelStateDirFor('telegram')
    if (needsChannelNotice && !chatOnMainBot) {
      logger.info({ agentId, chatId, transcriptStatus, transcriptConfidence },
        'voice: csatorna-ertesites kihagyva -- az ugynok sajat botjan ir, a szerver csak a fo bottal kuld; az ugynok mondja el a kuldonek')
    } else if (needsChannelNotice) {
      const text = transcriptStatus === 'no-transcript'
        ? 'A hangüzenetedet megkaptam, de nem sikerült leiratozni, ezért nem tudom, mi hangzott el. Kérlek, írd le szöveggel.'
        : 'A hangüzenetedet megkaptam, de csak bizonytalanul értettem. A válaszomban visszamondom, mit értettem belőle -- kérlek javíts, ha félreértettem.'
      const now = Date.now()
      if (voiceNoticeHeldFor(chatId, now)) {
        // 75c3d163 (a): a recipient on the quiet list (VOICE_NOTICE_QUIET_CHATS) gets no
        // server-initiated channel message for it, neither 23:00-07:00 Budapest nor after 07:00: the notice goes at
        // once into the main agent's morning batch row (src/web/voice-quiet-hours.ts). The repo ships NO consumer of
        // that row: only an install's own morning batch carries it, so the agent is not told that it will arrive.
        // Everyone else is notified at once, as before.
        try {
          const q = queueVoiceNoticeForMorningBatch({ chatId, text, heldAt: now })
          noticeQueued = true
          logger.info({ chatId, transcriptStatus, transcriptConfidence, rowId: q.rowId, count: q.count, morning: q.morning },
            'voice: csatorna-ertesites helyett reggeli koteg-sor (csendes idoszak, 23:00-07:00 Budapest)')
        } catch (err) {
          // The write's OWN failure has to be visible, like the immediate notice's below.
          noticeQueued = false
          logger.warn({ err, chatId, transcriptStatus, transcriptConfidence },
            'voice: a csendes idoszakos jelzes a reggeli kotegbe SEM kerult -- a kuldo nem kap jelzest')
        }
      } else {
        noticeDelivered = await notifyChat(chatId, text)
        if (!noticeDelivered) {
          // The notice's OWN failure has to be visible. A silent catch here would
          // rebuild the silence one layer up: the sender would get nothing, and
          // nothing would say so.
          logger.warn({ chatId, transcriptStatus, transcriptConfidence },
            'voice: a csatorna-ertesites NEM ment ki -- a kuldo nem tudja, hogy baj volt a leirattal')
        }
      }
    }

    // What the AGENT is told must match what reached the SENDER (75c3d163 G1): the read-back promise only when the
    // notice actually went out; otherwise the agent learns that the sender knows nothing yet, and why.
    if (needsChannelNotice && transcriptNotice) {
      if (noticeDelivered === true) {
        if (transcriptConfidence === 'uncertain') transcriptNotice += ' A kuldo mar kapott egy csatorna-jelzest, hogy ezt varja tolunk.'
      } else if (noticeQueued === true) {
        // Review of #1732, request 2: no delivery is promised. The row reaches the sender only through a morning batch
        // that reads it, and this repo has none (VOICE_NOTICE_QUIET_CHATS documents it as a requirement).
        const mit = transcriptStatus === 'no-transcript' ? 'nem sikerult leiratozni' : 'csak bizonytalanul ertettuk'
        transcriptNotice += ` A KULDO NEM KAPOTT JELZEST, ES A SZERVER 0${VOICE_QUIET_END_HOUR}:00 UTAN SEM KULD (csendes idoszak, ${VOICE_QUIET_START_HOUR}:00-0${VOICE_QUIET_END_HOUR}:00 Budapest). ` +
          `A jelzes a fo ugynok ${MORNING_BATCH_VOICE_KEYWORD} memoria-soraba kerult: a kuldohoz csak akkor jut el, ha ezen a telepitesen egy reggeli koteg ezt a sort kezbesiti. ` +
          `Ha ilyen nincs, a kuldo csak a te valaszodbol tudja meg, hogy a hangüzenetet ${mit}.`
      } else if (noticeQueued === false) {
        const mit = transcriptStatus === 'no-transcript' ? 'nem sikerult leiratozni' : 'csak bizonytalanul ertettuk'
        transcriptNotice += ` A KULDO NEM KAPOTT JELZEST, ES A REGGELI KOTEG-SOR IRASA HIBARA FUTOTT (csendes idoszak, ${VOICE_QUIET_START_HOUR}:00-0${VOICE_QUIET_END_HOUR}:00 Budapest): a reggeli kotegben te mondd meg neki, hogy a hangüzenetet ${mit}.`
      } else {
        const ok = chatOnMainBot ? 'a csatorna-jelzes nem ment ki' : 'a sajat botodon irt, a szerver csak a fo bottal kuld'
        const mit = transcriptStatus === 'no-transcript' ? 'nem sikerult leiratozni' : 'csak bizonytalanul ertettuk'
        transcriptNotice += ` A KULDOT A SZERVER NEM ERTESITETTE (${ok}): a valaszod elejen te mondd meg neki, hogy a hangüzenetet ${mit}.`
      }
    }

    // calibrationMismatch is for US, not for the sender or the agent (card 75c3d163):
    // the hook does not print it, and it never changes transcriptConfidence above.
    json(res, { directive, transcript, transcriptStatus, transcriptConfidence, transcriptNotice, noticeDelivered, calibrationMismatch })
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

  // GET /api/voice/status -- is the voice toolkit installed? (+ calibration state, card 75c3d163)
  if (path === '/api/voice/status' && method === 'GET') {
    const installed = isVoiceInstalled()
    const voices = installed
      ? Array.from(KNOWN_VOICE_MODELS).filter((m) => existsSync(join(VOICE_DIR, 'voices', `${m}.onnx`)))
      : []
    // calibration: the model the uncertainty threshold was measured on and the threshold
    // (null, null: none configured), and every model-pair mismatch seen so far with its
    // first/last time and whether the one-time notice went out (card 75c3d163). Readable
    // here long after the notice itself has scrolled out of a queue.
    const cal = sttCalibration()
    json(res, { installed, voices, voiceDir: VOICE_DIR, calibration: {
      model: cal?.model ?? null, revision: cal?.revision ?? null, threshold: cal?.threshold ?? null,
      mismatches: Object.values(readCalibrationState()),
    } })
    return true
  }

  // POST /api/voice/stt
  // Body: { file_id: string, state_dir: string }
  // Returns: 200 { transcript, status: 'ok', confidence, no_speech_prob, calibrationMismatch },
  //   422 no-transcript, 500 failed, 503 unavailable (card deeaa175).
  if (path === '/api/voice/stt' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'Voice toolkit not installed' }, 503); return true }
    const body = await readBody(req)
    let data: { file_id?: string; state_dir?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const fileId = data.file_id?.trim() ?? ''
    const stateDir = data.state_dir?.trim() ?? ''
    if (!SAFE_FILE_ID_RE.test(fileId)) { json(res, { error: 'Invalid file_id' }, 400); return true }
    if (!isSafeStateDir(stateDir)) { json(res, { error: 'Invalid state_dir' }, 400); return true }

    // Same source of truth as /api/voice/directive -- the two endpoints used to
    // disagree about the identical situation (200+null here, 500 there). Now the
    // STATE decides the code, and the body always says which state it was.
    const stt = await transcribeVoiceFileDetailed(fileId, stateDir)
    if (stt.status === 'ok') {
      json(res, { transcript: stt.transcript, status: stt.status, confidence: stt.confidence, no_speech_prob: stt.noSpeechProb, calibrationMismatch: stt.calibrationMismatch })
      return true
    }
    if (stt.status === 'no-transcript') {
      // NOT a 500: nothing failed. The model ran and produced no text, which is
      // an outcome the caller has to be able to tell apart from a crash.
      json(res, { transcript: null, status: stt.status, duration_sec: stt.durationSec, calibrationMismatch: stt.calibrationMismatch }, 422)
      return true
    }
    logger.warn({ fileId, status: stt.status, reason: stt.reason }, '/api/voice/stt: STT unavailable or failed')
    json(res, { error: 'STT failed', status: stt.status, reason: stt.reason }, stt.status === 'unavailable' ? 503 : 500)
    return true
  }

  // POST /api/voice/tts
  // Body: { text: string, voice_model: string, chat_id: string, state_dir: string }
  // Returns: { ok: boolean, message_id?: number }
  if (path === '/api/voice/tts' && method === 'POST') {
    if (!isVoiceInstalled()) { json(res, { error: 'Voice toolkit not installed' }, 503); return true }
    const body = await readBody(req)
    let data: { text?: string; voice_model?: string; chat_id?: string | number; state_dir?: string }
    try { data = JSON.parse(body.toString()) as typeof data } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const text = data.text?.trim() ?? ''
    const voiceModel = data.voice_model?.trim() ?? 'hu_HU-imre-medium'
    const chatId = String(data.chat_id ?? '').trim()
    const stateDir = data.state_dir?.trim() ?? ''

    if (!text) { json(res, { error: 'text required' }, 400); return true }
    if (!/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    if (!isSafeStateDir(stateDir)) { json(res, { error: 'Invalid state_dir' }, 400); return true }

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
