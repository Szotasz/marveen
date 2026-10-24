import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
const h = vi.hoisted(() => ({ send: vi.fn(async () => {}), pane: vi.fn(() => '[marveen-codex:ready]') }))
vi.mock('../codex-backend.js', () => ({ usesCodex: () => true, sendCodexPrompt: h.send, codexPane: h.pane }))
import { sendPromptToSession } from '../web/agent-process.js'
beforeEach(() => { vi.clearAllMocks() })
describe('Codex integration preserves the develop emit guard', () => {
  it('sends when the guard returns null and records emission', async () => {
    const guard = vi.fn(() => null)
    const onEmitStart = vi.fn()
    expect(await sendPromptToSession(MAIN_CHANNELS_SESSION, 'fixture', null, { emitGuard: guard, onEmitStart })).toBe('sent')
    expect(guard).toHaveBeenCalledWith('[marveen-codex:ready]')
    expect(onEmitStart).toHaveBeenCalledOnce()
    expect(h.send).toHaveBeenCalledExactlyOnceWith('fixture')
  })
  it.each(['refusal', 'exception'])('does not emit on guard %s', async mode => {
    const guard = () => { if (mode === 'exception') throw Error('fixture refusal'); return 'blocked' }
    const onEmitStart = vi.fn()
    expect(await sendPromptToSession(MAIN_CHANNELS_SESSION, 'fixture', null, { emitGuard: guard, onEmitStart })).toBe('aborted-guard')
    expect(h.send).not.toHaveBeenCalled()
    expect(onEmitStart).not.toHaveBeenCalled()
  })
})
