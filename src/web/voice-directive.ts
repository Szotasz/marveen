import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR, WEB_PORT } from '../config.js'
import { AGENTS_BASE_DIR } from './agent-config.js'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'

const KNOWN_PROVIDERS = new Set<string>(['telegram', 'slack', 'discord', 'googlechat', 'teams'])

// Resolve the directory where an agent's channel plugin stores its bot .env.
// Search order:
//   1. <AGENTS_BASE_DIR>/<agentId>/.claude/channels/<provider>   (sub-agent own channel)
//   2. ~/.claude/channels/<provider>-<agentId>                   (alternative naming)
//   3. channelStateDir(provider)                                 (main agent -- env override,
//      then legacy shared path while unmigrated, then install-scoped; #915)
export function resolveAgentChannelStateDir(agentId: string, provider: string): string {
  const mainDir = KNOWN_PROVIDERS.has(provider)
    ? channelStateDir(provider as ChannelProviderType)
    : join(homedir(), '.claude', 'channels', provider)
  const candidates = [
    join(AGENTS_BASE_DIR, agentId, '.claude', 'channels', provider),
    join(homedir(), '.claude', 'channels', `${provider}-${agentId}`),
    mainDir,
  ]
  return candidates.find((d) => existsSync(join(d, '.env'))) ?? candidates[candidates.length - 1]
}

// Which inbound attachment kinds are actually audio.
//
// The channel tag carries attachment_kind, and the Telegram plugin uses it for
// EVERY attachment type -- "document", "photo" and so on, not just audio. The
// directive endpoint used to decide "was this a voice message?" from the mere
// PRESENCE of an attachment_file_id, so sending a PDF to an agent in `auto`
// voice mode made it answer a document with a synthesized voice message (and
// pushed the PDF through speech-to-text). Observed 2026-07-29 with an 826 kB
// PDF attachment.
const AUDIO_KINDS = new Set(['voice', 'audio', 'video_note'])

// True only when the inbound attachment is known to be audio. An absent or
// unrecognised kind counts as NOT audio: the conservative direction is to stay
// in text, because a wrong "speak" is a wrong-format answer to the owner, while
// a wrong "stay quiet" only loses the audio nicety.
export function inboundIsAudio(kind: string | null | undefined, fileId: string | null | undefined): boolean {
  if (!fileId) return false
  return AUDIO_KINDS.has(String(kind ?? '').trim().toLowerCase())
}

// Shell-quote a path as one single-quoted word.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export const TTS_TEXT_PLACEHOLDER = 'A_VÁLASZOD_SZÖVEGE'
export const TTS_HEREDOC_END_PREFIX = 'MARVEEN_TTS_END_'

// The heredoc's end marker, NEW for every directive. A fixed marker is known in advance:
// a reply line equal to it would end the body there, and the reply's further lines would
// run as shell commands in the agent's session (Dani's review of #2605). The reply can be
// steered by an inbound message, so the marker must not be guessable.
export function newTtsHeredocEnd(): string {
  return TTS_HEREDOC_END_PREFIX + randomBytes(8).toString('hex')
}

export interface TtsRequest {
  text: string
  voiceModel: string
  chatId: string
  stateDir: string
}

// The fields of POST /api/voice/tts, from either request shape:
//   - text/plain (the directive's, #2600): the body is the reply text as is, the other
//     fields come from the query string;
//   - JSON (the older directive and any other caller): { text, voice_model, chat_id, state_dir }.
// Returns null when a JSON body does not parse. Validation (empty text, chat id, state dir)
// stays with the route.
export function parseTtsRequest(
  contentType: string | undefined,
  body: Buffer,
  query: URLSearchParams,
  defaultVoiceModel: string,
): TtsRequest | null {
  if (String(contentType ?? '').trim().toLowerCase().startsWith('text/plain')) {
    return {
      text: body.toString('utf-8').trim(),
      voiceModel: query.get('voice_model')?.trim() || defaultVoiceModel,
      chatId: (query.get('chat_id') ?? '').trim(),
      stateDir: (query.get('state_dir') ?? '').trim(),
    }
  }
  let data: { text?: string; voice_model?: string; chat_id?: string | number; state_dir?: string }
  try { data = JSON.parse(body.toString()) as typeof data } catch { return null }
  return {
    text: data.text?.trim() ?? '',
    voiceModel: data.voice_model?.trim() ?? defaultVoiceModel,
    chatId: String(data.chat_id ?? '').trim(),
    stateDir: data.state_dir?.trim() ?? '',
  }
}

// Build a ready-to-run TTS directive block injected after the STT transcript.
// Returns null if the dashboard token file is missing, unreadable or empty.
//
// VOICETOKENLEAK1101: the directive is prompt text, so it lands in the agent's
// pane and in its transcript. It must carry only a REFERENCE to the token file,
// read by the shell when the command runs, never the token value itself.
export function buildTtsDirective(opts: {
  chatId: string
  stateDir: string
  voiceModel: string
}): string | null {
  try {
    const tokenPath = join(STORE_DIR, '.dashboard-token')
    if (!existsSync(tokenPath)) return null
    // Checked, not embedded: an empty or unreadable token file still means "no directive".
    if (!readFileSync(tokenPath, 'utf-8').trim()) return null
    const tokenRef = `$(cat ${shellSingleQuote(tokenPath)})`
    const { chatId, stateDir, voiceModel } = opts
    // #2600: the command used to build the JSON body with `jq -n --arg t "..."`. jq is not
    // installed by install-linux.sh and a stock Ubuntu has none, so the pipe sent an empty
    // body, the route answered 400 and the owner got no reply at all (the directive forbids a
    // text answer). The reply text also sat in a double-quoted shell word, so the shell expanded
    // it on the way. Now the text goes as the raw body through a QUOTED heredoc (no shell
    // expansion, no escaping for the agent to get wrong), the fixed fields go in the query
    // string, and the route builds the request itself (parseTtsRequest).
    const query = new URLSearchParams({ chat_id: chatId, state_dir: stateDir, voice_model: voiceModel })
    const url = `http://localhost:${WEB_PORT}/api/voice/tts?${query.toString()}`
    const end = newTtsHeredocEnd()
    return (
      `\n\n[Hang válasz direktíva]: A fenti hangüzenetre HANGBAN válaszolj. ` +
      `Amikor megvan a válaszod szövege, futtasd le ezt a parancsot: a ${TTS_TEXT_PLACEHOLDER} sort cseréld a válaszod szövegére, ` +
      `szó szerint, escape nélkül (több sor is lehet); a ${end} sor maradjon utolsónak, egyedül:\n` +
      `\`\`\`bash\n` +
      `curl -s -X POST ${shellSingleQuote(url)} -H "Content-Type: text/plain; charset=utf-8" -H "Authorization: Bearer ${tokenRef}" --data-binary @- <<'${end}'\n` +
      `${TTS_TEXT_PLACEHOLDER}\n` +
      `${end}\n` +
      `\`\`\`\n` +
      `Szöveges választ NE küldj -- CSAK a fenti curl-t futtasd le a hangküldéshez.`
    )
  } catch {
    return null
  }
}
