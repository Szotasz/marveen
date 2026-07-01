// Hang (élő hang-mód) -- WS proxy a Gemini Live API felé.
//
// Architektúra (Option B, jóváhagyva -- lásd agents/rocket/docs/voice-mode-design.md):
// a böngésző mikrofonja -> ez a WS endpoint -> Vertex AI Live API (KIZÁRÓLAG
// input_audio_transcription, a modell saját hang-generálását eldobjuk). A transzkriptet
// Tars (ez a Claude Code session, NEM a Live API modellje) írja meg a választ. A válasz
// hangját egy KÜLÖN, dedikált Vertex TTS hívás mondja fel szó szerint.
//
// Auth: a natív böngésző WebSocket API nem tud egyéni headert küldeni, ezért a
// dashboard tokent ?token= query paramban fogadjuk el erre az egy path-ra -- pontosan
// ugyanaz a minta, mint a meglévő SSE live-pane streamnél (lásd web.ts isSseStream).
//
// Google-hitelesítés: service-account JWT -> OAuth2 access token, ugyanaz a minta mint
// a media-generation skill nanobana.mjs referenciájában (Node beépített `crypto`-val,
// nincs új Google SDK függőség).
//
// VERIFIED 2026-07-01 (élő teszthívásokkal, valós hitelesítő adatokkal, lásd rocket
// session-napló): projekt=maxine-dev, location=us-central1 (NEM "global" -- a Live API +
// a TTS model is csak us-central1-ben adott helyes választ ennél a projektnél). A
// realtimeInput.audio mező (NEM a deprecated mediaChunks) és a manuális
// activityStart/activityEnd (automatikus VAD helyett, ami a teszt során nem hozott
// megbízható eredményt egy nem-folyamatos mikrofon-stream mellett) adja a determinisztikus,
// működő turn-határt -- ez pont illeszkedik a kliens toggle-mic-gombhoz (mic be = activityStart,
// mic ki = activityEnd).
//
// Delivery to Tars: a finished transcript is handed off through the SAME trust
// mechanism as a Telegram message, per tars's explicit design call (channel-inbound,
// via a dedicated coordinator identity -- see channel-coordinator/voice-live-ingest.ts).
// Nothing here ever inserts with a client-supplied `from`; the coordinator id is a code
// constant, and the handoff is a direct DB call, never the public POST /api/messages
// path (which 403s on both coordinator ids, see web/routes/messages.ts).

import { createSign, randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Server, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket as UpstreamWebSocket } from 'ws'
import { STORE_DIR } from '../../config.js'
import { checkBearerToken } from '../dashboard-auth.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { createVoiceLiveHandoffMessage } from '../../channel-coordinator/voice-live-ingest.js'
import { neutralizeChannelTags } from '../../channel-coordinator.js'
import { buildLiveVoiceDirective } from '../voice-directive.js'
import type { RouteContext } from './types.js'

const SERVICE_ACCOUNT_PATH = join(STORE_DIR, '.secrets', 'maxine-vertex-runner.json')
// Ugyanaz a projekt/location mint a media-generation skill nanobana.mjs referenciája,
// de a Live API-hoz és a TTS-hez KÜLÖN, konkrétan tesztelt location kell (nem "global").
const GCP_PROJECT = 'maxine-dev'
const GCP_LOCATION = 'us-central1'
const LIVE_MODEL = 'gemini-live-2.5-flash-native-audio'
const TTS_MODEL = 'gemini-2.5-flash-preview-tts'
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const b64url = (s: string): string =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Cached access token -- service-account JWTs are cheap to mint but there is no reason
// to re-sign one per WS connection; refresh a few minutes before the 1h expiry.
let cachedToken: { value: string; expiresAtMs: number } | null = null

function loadServiceAccount(): { client_email: string; private_key: string } | null {
  if (!existsSync(SERVICE_ACCOUNT_PATH)) return null
  try {
    return JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'))
  } catch {
    return null
  }
}

async function mintAccessToken(): Promise<string | null> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAtMs - now > 5 * 60_000) return cachedToken.value
  const sa = loadServiceAccount()
  if (!sa) { logger.warn({ path: SERVICE_ACCOUNT_PATH }, 'voice-live: service account file missing'); return null }
  const nowSec = Math.floor(now / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: OAUTH_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }))
  const unsigned = `${header}.${claims}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const signature = signer.sign(sa.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  })
  if (!res.ok) {
    logger.warn({ status: res.status, body: (await res.text()).slice(0, 300) }, 'voice-live: token mint failed')
    return null
  }
  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = { value: data.access_token, expiresAtMs: now + data.expires_in * 1000 }
  return cachedToken.value
}

// One-shot TTS: synthesizes `text` and returns raw base64 PCM (audio/L16, 24kHz mono per
// the verified probe) or null on failure. Not part of the Live API session -- Tars's exact
// reply text is spoken verbatim, never regenerated by the Live model (see file header).
export async function synthesizeVoiceReply(text: string): Promise<{ audioBase64: string; mimeType: string } | null> {
  const token = await mintAccessToken()
  if (!token) return null
  const url = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${TTS_MODEL}:generateContent`
  const payload = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
  const data = await res.json() as {
    candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[]
  }
  if (!res.ok) { logger.warn({ status: res.status, data }, 'voice-live: TTS call failed'); return null }
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  if (!part?.inlineData) return null
  return { audioBase64: part.inlineData.data, mimeType: part.inlineData.mimeType }
}

// Registry of open live-voice browser sessions, keyed by a server-generated session id
// (independent of Google's own setupComplete.sessionId). Populated for the lifetime of
// the WS connection so /api/voice/live/reply (below) can push Tars's synthesized reply
// back down the right socket once the async agent turn finishes -- there is no other way
// to correlate "which live browser tab" a later, out-of-band HTTP call refers to.
const activeSessions = new Map<string, import('ws').WebSocket>()

// Per-browser-connection session: proxies mic audio to a fresh upstream Live API
// connection and relays input-transcription text back to the browser.
function runSession(clientWs: import('ws').WebSocket): void {
  const sessionId = randomUUID()
  activeSessions.set(sessionId, clientWs)
  let upstream: UpstreamWebSocket | null = null
  let upstreamReady = false
  const pendingAudio: string[] = [] // base64 PCM chunks queued while upstream connects

  const send = (obj: unknown) => { if (clientWs.readyState === clientWs.OPEN) clientWs.send(JSON.stringify(obj)) }
  send({ type: 'session', sessionId })

  mintAccessToken().then((token) => {
    if (!token) { send({ type: 'error', message: 'Google-hitelesítés sikertelen (service account hiányzik vagy érvénytelen)' }); clientWs.close(); return }
    const url = `wss://${GCP_LOCATION}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`
    upstream = new UpstreamWebSocket(url, { headers: { Authorization: `Bearer ${token}` } })

    upstream.on('open', () => {
      upstream!.send(JSON.stringify({
        setup: {
          model: `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${LIVE_MODEL}`,
          generationConfig: { responseModalities: ['AUDIO'] }, // required by the API; we discard the model's own audio, see header
          inputAudioTranscription: {},
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      }))
    })

    upstream.on('message', (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.setupComplete) {
        upstreamReady = true
        for (const chunk of pendingAudio) upstream!.send(chunk)
        pendingAudio.length = 0
        send({ type: 'ready' })
        return
      }
      // NOTE: only verified against a single short (~3s) utterance that arrived as ONE
      // inputTranscription message with finished=true already carrying the full text.
      // Whether a longer utterance streams multiple incremental messages before the
      // finished one (in which case this would need to accumulate them) is UNTESTED --
      // smoke-test with a longer sentence before relying on this for real conversations.
      const serverContent = msg.serverContent as Record<string, unknown> | undefined
      const inputTranscription = serverContent?.inputTranscription as { text?: string; finished?: boolean } | undefined
      if (inputTranscription?.text) {
        const finished = !!inputTranscription.finished
        send({ type: 'transcript', text: inputTranscription.text, finished })
        if (finished) {
          const channelBlock = `<channel source="voice-live" session_id="${sessionId}">\n${neutralizeChannelTags(inputTranscription.text)}\n</channel>`
          const directive = buildLiveVoiceDirective(sessionId) ?? ''
          createVoiceLiveHandoffMessage(channelBlock + directive)
        }
      }
      // Deliberately ignore serverContent.modelTurn (the Live model's own generated
      // audio reply) -- Option B discards it; Tars authors the real reply separately.
    })

    upstream.on('error', (err) => { logger.warn({ err: err.message }, 'voice-live: upstream WS error'); send({ type: 'error', message: 'Google Live API kapcsolati hiba' }) })
    upstream.on('close', (code) => { send({ type: 'upstream_closed', code }) })
  }).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'voice-live: session init failed')
    send({ type: 'error', message: 'Munkamenet indítása sikertelen' })
    clientWs.close()
  })

  // Client protocol (JSON text frames from the browser):
  //   { type: 'activity_start' }                        -- mic gomb bekapcsolva
  //   { type: 'audio', data: '<base64 pcm16 16k mono>' } -- audio chunk
  //   { type: 'activity_end' }                           -- mic gomb kikapcsolva (turn vége)
  clientWs.on('message', (raw: Buffer) => {
    let msg: { type?: string; data?: string }
    try { msg = JSON.parse(raw.toString()) } catch { return }
    const forward = (payload: unknown) => {
      const asString = JSON.stringify(payload)
      if (upstreamReady && upstream) upstream.send(asString)
      else pendingAudio.push(asString)
    }
    if (msg.type === 'activity_start') forward({ realtimeInput: { activityStart: {} } })
    else if (msg.type === 'audio' && msg.data) forward({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: msg.data } } })
    else if (msg.type === 'activity_end') forward({ realtimeInput: { activityEnd: {} } })
  })

  clientWs.on('close', () => { activeSessions.delete(sessionId); upstream?.close() })
  clientWs.on('error', () => { activeSessions.delete(sessionId); upstream?.close() })
}

// POST /api/voice/live/reply -- called by Tars's own UserPromptSubmit-driven directive
// (buildLiveVoiceDirective) once it has authored the actual reply text. Synthesizes the
// audio and pushes it down the matching still-open browser session, if any. Auth is the
// same blanket /api/* bearer-token gate in web.ts (nothing extra needed here); this route
// is registered in the normal tryHandle* dispatch chain, unlike the WS upgrade above.
export async function tryHandleVoiceLive(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/voice/live/reply' || method !== 'POST') return false

  const body = await readBody(req)
  let data: { session_id?: string; text?: string }
  try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
  const sessionId = data.session_id?.trim() ?? ''
  const text = data.text?.trim() ?? ''
  if (!sessionId || !text) { json(res, { error: 'session_id and text required' }, 400); return true }

  const clientWs = activeSessions.get(sessionId)
  if (!clientWs || clientWs.readyState !== clientWs.OPEN) {
    json(res, { error: 'session not found or closed' }, 404)
    return true
  }

  const audio = await synthesizeVoiceReply(text)
  if (!audio) { json(res, { error: 'TTS failed' }, 500); return true }

  clientWs.send(JSON.stringify({ type: 'speak', audioBase64: audio.audioBase64, mimeType: audio.mimeType, text }))
  json(res, { ok: true })
  return true
}

// Hooked once at server startup (src/web.ts) -- the http.Server 'upgrade' event has no
// place in the per-request tryHandle* dispatch chain (routes/types.ts), so this owns its
// own narrow slice of the upgrade event rather than forcing that shape onto it.
export function attachVoiceLiveUpgrade(server: Server, dashboardToken: string): void {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/api/voice/live/stream') return // let other upgrade consumers (none yet) see it
    const token = url.searchParams.get('token') ?? ''
    if (!checkBearerToken(`Bearer ${token}`, dashboardToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (clientWs) => { runSession(clientWs) })
  })
}
