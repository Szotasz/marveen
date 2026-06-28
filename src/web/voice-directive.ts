import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR, WEB_PORT } from '../config.js'
import { AGENTS_BASE_DIR } from './agent-config.js'

// Resolve the directory where an agent's channel plugin stores its bot .env.
// Search order:
//   1. <AGENTS_BASE_DIR>/<agentId>/.claude/channels/<provider>   (sub-agent own channel)
//   2. ~/.claude/channels/<provider>-<agentId>                   (alternative naming)
//   3. ~/.claude/channels/<provider>                             (global fallback / main agent)
export function resolveAgentChannelStateDir(agentId: string, provider: string): string {
  const candidates = [
    join(AGENTS_BASE_DIR, agentId, '.claude', 'channels', provider),
    join(homedir(), '.claude', 'channels', `${provider}-${agentId}`),
    join(homedir(), '.claude', 'channels', provider),
  ]
  return candidates.find((d) => existsSync(join(d, '.env'))) ?? candidates[candidates.length - 1]
}

// Build a ready-to-run TTS directive block injected after the STT transcript.
// Returns null if the dashboard token cannot be read.
export function buildTtsDirective(opts: {
  chatId: string
  stateDir: string
  voiceModel: string
}): string | null {
  try {
    const tokenPath = join(STORE_DIR, '.dashboard-token')
    if (!existsSync(tokenPath)) return null
    const token = readFileSync(tokenPath, 'utf-8').trim()
    const { chatId, stateDir, voiceModel } = opts
    // Escape stateDir for embedding in a jq string argument
    const escapedStateDir = stateDir.replace(/'/g, "'\\''")
    return (
      `\n\n[Hang válasz direktíva]: A fenti hangüzenetre HANGBAN válaszolj. ` +
      `Amikor megvan a válaszod szövege, futtasd le ezt a parancsot (a szöveget JSON-escape-elve add meg a --arg-ban):\n` +
      `\`\`\`bash\n` +
      `jq -n --arg t "A_VÁLASZOD_SZÖVEGE" '{"text":$t,"chat_id":"${chatId}","state_dir":"${escapedStateDir}","voice_model":"${voiceModel}"}' | ` +
      `curl -s -X POST http://localhost:${WEB_PORT}/api/voice/tts -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" -d @-\n` +
      `\`\`\`\n` +
      `Szöveges választ NE küldj -- CSAK a fenti curl-t futtasd le a hangküldéshez.`
    )
  } catch {
    return null
  }
}
