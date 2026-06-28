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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { KNOWN_VOICE_MODELS, AGENTS_BASE_DIR, readAgentVoiceConfig } from '../agent-config.js'
import { getLastInboundModality, setLastInboundModality } from '../voice-modality.js'
import { buildTtsDirective, resolveAgentChannelStateDir } from '../voice-directive.js'
import { PROJECT_ROOT } from '../../config.js'
import type { RouteContext } from './types.js'

const VOICE_DIR = join(homedir(), '.local', 'share', 'marveen-voice')
const VTOOLS_PY = join(VOICE_DIR, '_vtools.py')
const VENV_PY = join(VOICE_DIR, 'venv', 'bin', 'python')

// Telegram file_ids are base64url + some punctuation; reject anything else.
const SAFE_FILE_ID_RE = /^[A-Za-z0-9_\-]{10,200}$/

// Known agent channel dirs -- only these are accepted as state_dir.
// The channel plugin stores its .env (bot token) here.
const CHANNELS_BASE = join(homedir(), '.claude', 'channels')

// Safe paths: ~/.claude/channels/<provider>/  OR  <AGENTS_BASE_DIR>/<name>/.claude/channels/<provider>/
// Both must contain a .env file. '..' traversal always rejected.
function isSafeStateDir(dir: string): boolean {
  const resolved = dir.replace(/\/$/, '')
  if (resolved.includes('..')) return false
  if (!existsSync(join(resolved, '.env'))) return false
  if (resolved.startsWith(CHANNELS_BASE + '/') || resolved === CHANNELS_BASE) return true
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
  opts: { stdinData?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false })
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

export async function tryHandleVoice(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/voice/directive?agent=X&chat=Y[&file=FILE_ID]
  // Returns { directive: string|null, transcript: string|null }.
  // directive semantics by responseMode:
  //   text  -> null (never speaks)
  //   voice -> always buildTtsDirective (speaks even for plain-text input)
  //   auto  -> buildTtsDirective only when a voice file_id is present (speaks only if user sent audio)
  // transcript: STT result when `file` is provided and valid (mode-independent -- even text-mode
  //   agents can benefit from knowing what a voice message said).
  // fail-safe: STT errors set transcript=null; directive is always attempted independently.
  if (path === '/api/voice/directive' && method === 'GET') {
    const agentId = ctx.url.searchParams.get('agent') ?? ''
    const chatId = ctx.url.searchParams.get('chat') ?? ''
    const fileParam = ctx.url.searchParams.get('file') ?? ''
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) { json(res, { error: 'Invalid agent' }, 400); return true }
    if (!chatId || !/^\d+$/.test(chatId)) { json(res, { error: 'Invalid chat_id' }, 400); return true }
    const voiceCfg = readAgentVoiceConfig(agentId)
    const stateDir = resolveAgentChannelStateDir(agentId, 'telegram')
    const fileIsVoice = !!fileParam && SAFE_FILE_ID_RE.test(fileParam)
    const ttsParams = { chatId, stateDir, voiceModel: voiceCfg.voiceModel ?? 'hu_HU-imre-medium' }
    const directive = voiceCfg.responseMode === 'text' ? null
      : voiceCfg.responseMode === 'voice' ? buildTtsDirective(ttsParams)
      : fileIsVoice ? buildTtsDirective(ttsParams)  // auto: only when inbound was audio
      : null

    let transcript: string | null = null
    if (fileParam && SAFE_FILE_ID_RE.test(fileParam) && isVoiceInstalled()) {
      const sttResult = await runProc(VENV_PY, [VTOOLS_PY, 'transcribe', fileParam, stateDir], { timeoutMs: 60_000 })
      if (sttResult.code === 0) {
        transcript = sttResult.stdout.trim() || null
      } else {
        logger.warn({ fileParam, stderr: sttResult.stderr }, '/api/voice/directive: STT failed (non-fatal)')
      }
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

    const result = await runProc(
      VENV_PY,
      [VTOOLS_PY, 'transcribe', fileId, stateDir],
      { timeoutMs: 60_000 },
    )
    if (result.code !== 0) {
      logger.warn({ fileId, stderr: result.stderr }, '/api/voice/stt: whisper failed')
      json(res, { error: 'STT failed', detail: result.stderr.slice(0, 200) }, 500)
      return true
    }
    json(res, { transcript: result.stdout.trim() })
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
      { timeoutMs: 90_000 },
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
      json(res, {
        needsSudo: true,
        sudoCommand: 'sudo apt-get install -y --no-install-recommends ffmpeg python3-venv python3',
      })
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
