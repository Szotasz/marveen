// Identity module for the Hang (élő hang-mód) transcript handoff -- mirrors
// channel-coordinator/ingest.ts's COORDINATOR_AGENT_ID / createHandoffMessage pattern
// so a live-voice utterance reaches Tars at EXACTLY the same trust level as a Telegram
// message (channel-inbound: verbatim <channel> framing + reply-expected, body still
// marked untrusted), never more.
//
// Unlike the Telegram coordinator, voice-live.ts runs IN-PROCESS with the dashboard
// (it's a route module under src/web/, not a separate poller), so there is no separate
// SQLite handle to open here -- we reuse the dashboard's own already-open connection via
// createAgentMessage() from ../db.js. What matters for the security property is NOT
// which DB handle is used, it's that from_agent is this file's hardcoded constant,
// never client-supplied data, and that the only caller of createVoiceLiveHandoffMessage
// is voice-live.ts's WS handler after its own dashboard-token check -- never the public
// POST /api/messages path (see the 403 guard in web/routes/messages.ts).

import { createAgentMessage } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'

export const VOICE_LIVE_COORDINATOR_ID = 'voice-live-coordinator'

export function createVoiceLiveHandoffMessage(content: string): number {
  const msg = createAgentMessage(VOICE_LIVE_COORDINATOR_ID, MAIN_AGENT_ID, content)
  return msg.id
}
