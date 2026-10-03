// Router-side speech-to-text gate for inbound voice notes.
//
// Transcription costs a local faster-whisper run per voice note and changes the
// prompt the agent sees (an [Hang átirat] block replaces the raw attachment),
// so it must not switch on silently for text-mode agents after an update.
// Contract pinned here, end to end through runMessageRouterTick:
// - responseMode 'voice'/'auto': transcribed (historical path, unchanged);
// - responseMode 'text', no flag, install default off: NOT transcribed;
// - responseMode 'text' + voice.transcribeInbound=true: transcribed;
// - responseMode 'text' + install default on: transcribed, unless the agent
//   sets voice.transcribeInbound=false.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'router-stt-gate-'))
writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')

const cfgState = vi.hoisted(() => ({ installDefault: false }))
const voiceCfg = vi.hoisted(() => ({
  current: { responseMode: 'text', voiceModel: 'm' } as Record<string, unknown>,
}))

const mockTranscribe = vi.fn(async (..._a: unknown[]) => 'hello from a voice note' as string | null)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
const mockWrap = vi.fn((_cat: unknown, _safe: unknown, _from: unknown, content: string) => ({ prefix: '', wrapped: content }))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
  get VOICE_TRANSCRIBE_INBOUND() { return cfgState.installDefault },
}))

const pending: unknown[] = []
vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : pending.splice(0)),
  getMessageStatus: () => 'pending',
  markMessageDelivered: () => true,
  markMessageFailed: () => true,
  markMessageDone: () => true,
  markPendingFederatedFailed: () => true,
  setMessageResult: () => true,
  createAgentMessage: () => ({ id: 999 }),
  countNewerMessagesFromSameSender: () => 0,
  stampMessageTrace: () => false,
  upsertOtelSpan: () => undefined,
  closeOtelSpan: () => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => stateDir,
}))

vi.mock('../web/routes/voice.js', () => ({
  transcribeVoiceFile: (...a: unknown[]) => mockTranscribe(...a),
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => voiceCfg.current,
  readAgentWorksourceChannel: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: () => true,
  capturePane: () => '',
}))

vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'channel-inbound', safeFrom: 'telegram' }),
  wrapAgentMessageForDelivery: (...a: unknown[]) => mockWrap(...(a as [unknown, unknown, unknown, string])),
}))
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import { runMessageRouterTick, shouldTranscribeInboundVoice } from '../web/message-router.js'

let nextId = 100
function queueVoiceNote() {
  const id = nextId++
  pending.push({
    id,
    from_agent: 'telegram',
    to_agent: 'dex',
    content: `<channel source="telegram" chat_id="12345" message_id="7" attachment_kind="voice" attachment_file_id="FILE${id}">(voice message)</channel>`,
    created_at: Math.floor(Date.now() / 1000),
    origin_note: null,
    trace_id: null,
    span_id: null,
  })
}

async function deliverOneVoiceNote(): Promise<string> {
  queueVoiceNote()
  await runMessageRouterTick()
  expect(mockSendPrompt).toHaveBeenCalledTimes(1)
  return String(mockWrap.mock.calls[0]?.[3] ?? '')
}

describe('router voice STT gate (end to end through the tick)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pending.length = 0
    cfgState.installDefault = false
    voiceCfg.current = { responseMode: 'text', voiceModel: 'm' }
  })
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

  it('text-mode agent, no flag, install default off: no transcription, raw voice block delivered', async () => {
    const delivered = await deliverOneVoiceNote()
    expect(mockTranscribe).not.toHaveBeenCalled()
    expect(delivered).toContain('attachment_kind="voice"')
    expect(delivered).not.toContain('[Hang átirat]')
  })

  it('text-mode agent with voice.transcribeInbound=true: transcribed', async () => {
    voiceCfg.current = { responseMode: 'text', voiceModel: 'm', transcribeInbound: true }
    const delivered = await deliverOneVoiceNote()
    expect(mockTranscribe).toHaveBeenCalledTimes(1)
    expect(mockTranscribe.mock.calls[0]?.[0]).toMatch(/^FILE/)
    expect(delivered).toContain('[Hang átirat]: hello from a voice note')
    expect(delivered).not.toContain('attachment_file_id=')
  })

  it('text-mode agent, install default on: transcribed', async () => {
    cfgState.installDefault = true
    const delivered = await deliverOneVoiceNote()
    expect(mockTranscribe).toHaveBeenCalledTimes(1)
    expect(delivered).toContain('[Hang átirat]: hello from a voice note')
  })

  it('install default on, agent opts out with transcribeInbound=false: not transcribed', async () => {
    cfgState.installDefault = true
    voiceCfg.current = { responseMode: 'text', voiceModel: 'm', transcribeInbound: false }
    const delivered = await deliverOneVoiceNote()
    expect(mockTranscribe).not.toHaveBeenCalled()
    expect(delivered).toContain('attachment_kind="voice"')
  })

  for (const mode of ['voice', 'auto']) {
    it(`responseMode '${mode}': transcribed without any flag (historical path unchanged)`, async () => {
      voiceCfg.current = { responseMode: mode, voiceModel: 'm' }
      const delivered = await deliverOneVoiceNote()
      expect(mockTranscribe).toHaveBeenCalledTimes(1)
      expect(delivered).toContain('[Hang átirat]: hello from a voice note')
    })
  }

  it('STT failure falls back to the raw voice block', async () => {
    voiceCfg.current = { responseMode: 'voice', voiceModel: 'm' }
    mockTranscribe.mockResolvedValueOnce(null)
    const delivered = await deliverOneVoiceNote()
    expect(mockTranscribe).toHaveBeenCalledTimes(1)
    expect(delivered).toContain('attachment_kind="voice"')
  })
})

describe('shouldTranscribeInboundVoice (decision table)', () => {
  it.each([
    ['text', undefined, false, false],
    ['text', undefined, true, true],
    ['text', true, false, true],
    ['text', false, true, false],
    ['voice', undefined, false, true],
    ['voice', false, false, true],
    ['auto', undefined, false, true],
  ] as const)('mode=%s flag=%s installDefault=%s -> %s', (mode, flag, def, want) => {
    expect(shouldTranscribeInboundVoice({ responseMode: mode, transcribeInbound: flag }, def)).toBe(want)
  })
})
