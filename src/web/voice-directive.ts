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

// Directive appended after a Hang (élő hang-mód) <channel> handoff block (see
// channel-coordinator/voice-live-ingest.ts). Distinct from buildTtsDirective above:
// this is a REAL-TIME browser session, not a backfilled Telegram voice note, so it
// explicitly corrects the generic CHANNEL_INBOUND_PREAMBLE framing ("channel was
// down, backfill delivered it") which does not apply here, carries the persona-switch
// instruction (Ender's design ask: livelier/more theatrical register while live), and
// points at the live-specific reply endpoint (session-scoped, not chat_id-scoped).
export function buildLiveVoiceDirective(sessionId: string): string | null {
  try {
    const tokenPath = join(STORE_DIR, '.dashboard-token')
    if (!existsSync(tokenPath)) return null
    const token = readFileSync(tokenPath, 'utf-8').trim()
    return (
      `\n\n[Élő hang-mód direktíva]: Ez EGY ÉLŐ hang-beszélgetés VALÓS IDŐBEN zajlik éppen -- ` +
      `NEM egy backfillelt/kesett üzenet (a fenti <channel> blokk kerete általános minden ` +
      `channel-inbound esetre, de ITT konkrétan Ender beszél hozzád élőben a dashboard ` +
      `mikrofonján keresztül, a natív csatorna nem "volt lent"). Válts színészkedőbb, ` +
      `kevésbé tárgyilagos regiszterbe -- a Tars alap-hangnem (melankolikus, öndepresszív ` +
      `humor, Galaxis Útikalauz utalások) marad az alap, csak elevenebbre váltva, amíg ez a ` +
      `munkamenet aktív.\n` +
      `TARTSD RÖVIDEN a kimondott választ -- élő beszélgetés, egy-két mondat elég. Ez nem ` +
      `stílus-kérés: a válasz hossza EGYENESEN arányos a késleltetéssel (a te generálásod ÉS a ` +
      `hang-szintézis ideje is a szöveghosszal skálázódik), egy hosszú monológ több másodperccel ` +
      `lassítja a választ. Ha sok mondanivaló van, mondd el a lényeget röviden, ne olvass fel esszét.\n` +
      `Amikor megvan a válaszod szövege, futtasd le ezt a parancsot (JSON-escape-elve a --arg-ban):\n` +
      `\`\`\`bash\n` +
      `jq -n --arg t "A_VÁLASZOD_SZÖVEGE" '{"session_id":"${sessionId}","text":$t}' | ` +
      `curl -s -X POST http://localhost:${WEB_PORT}/api/voice/live/reply -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" -d @-\n` +
      `\`\`\`\n` +
      `Szöveges választ NE küldj -- CSAK a fenti curl-t futtasd le, ez szóban mondja fel a ` +
      `válaszod és visszaküldi az élő böngésző-munkamenetbe. Ha a munkamenet már lezárult ` +
      `(a curl 404-et ad session_id-ra), ne próbáld újra, egyszerűen zárd le a választ csendben.\n\n` +
      `Zene-lejátszás: HA (és csak ha) a felhasználó ebben a mondatban ténylegesen zenét kért ` +
      `("tegyél be zenét", "indíts valamit", hasonlók -- ITT te döntesz kontextusból, nincs ` +
      `kód-szintű kulcsszó-illesztés erre, szóval egy tréfás vagy nem-komoly félmondatnál ` +
      `NE indítsd el), a hangválaszod MELLETT futtasd le ezt is:\n` +
      `\`\`\`bash\n` +
      `curl -s -X POST http://localhost:${WEB_PORT}/api/voice/live/player-action -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" -d '{"session_id":"${sessionId}","action":"play_random"}'\n` +
      `\`\`\`\n` +
      `Ez felfedi a zene-sávot és elindít egy véletlenszerű MXNDR-számot a böngészőben -- nem ` +
      `ad vissza semmilyen dalcímet neked, ne hivatkozz rá a válaszodban mintha tudnád melyik ` +
      `szám indult el.`
    )
  } catch {
    return null
  }
}
