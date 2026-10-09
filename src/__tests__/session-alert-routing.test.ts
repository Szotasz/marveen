import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendSessionAlert } from '../web/channel-monitor.js'
import { MAIN_AGENT_ID } from '../config.js'

// SESSIONALERT8937: a sub-agent parked on a tool-permission prompt goes to the
// main agent as an in-process message when SESSION_ALERTS_TO_MAIN_AGENT is on;
// everything else keeps the alert chat.
describe('sendSessionAlert', () => {
  it('switch on, sub-agent session: one message to the main agent, nothing to the alert chat', () => {
    const create = vi.fn()
    const alert = vi.fn()
    const where = sendSessionAlert(false, '🔐 waiting', { toMainAgent: true, create, alert })
    expect(where).toBe('main-agent')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('system', MAIN_AGENT_ID, '🔐 waiting')
    expect(alert).not.toHaveBeenCalled()
  })

  it('switch off (the default behaviour): the alert chat, no message', () => {
    const create = vi.fn()
    const alert = vi.fn()
    expect(sendSessionAlert(false, 'x', { toMainAgent: false, create, alert })).toBe('alert-chat')
    expect(alert).toHaveBeenCalledWith('x')
    expect(create).not.toHaveBeenCalled()
  })

  it("switch on, the main agent's own session: the alert chat (it cannot read its inbox while parked)", () => {
    const create = vi.fn()
    const alert = vi.fn()
    expect(sendSessionAlert(true, 'x', { toMainAgent: true, create, alert })).toBe('alert-chat')
    expect(alert).toHaveBeenCalledWith('x')
    expect(create).not.toHaveBeenCalled()
  })

  it('switch on, the insert fails: falls back to the alert chat instead of losing the alert', () => {
    const create = vi.fn(() => { throw new Error('database is locked') })
    const alert = vi.fn()
    expect(sendSessionAlert(false, 'x', { toMainAgent: true, create, alert })).toBe('alert-chat')
    expect(alert).toHaveBeenCalledWith('x')
  })

  it('routine alert to the main agent keeps the 30-minute de-dup, then reports the repeats', () => {
    const create = vi.fn()
    const routine = vi.fn()
    const key = 'model-consent:test-dedup'
    const t0 = 1_000_000
    expect(sendSessionAlert(false, 'c', { routineKey: key, toMainAgent: true, create, routine, now: t0 })).toBe('main-agent')
    expect(sendSessionAlert(false, 'c', { routineKey: key, toMainAgent: true, create, routine, now: t0 + 60_000 })).toBe('suppressed')
    expect(create).toHaveBeenCalledTimes(1)
    expect(sendSessionAlert(false, 'c', { routineKey: key, toMainAgent: true, create, routine, now: t0 + 31 * 60_000 })).toBe('main-agent')
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][2]).toMatch(/^c\n\n\(Az elmult 30 percben 2 ilyen volt/)
    expect(routine).not.toHaveBeenCalled()
  })

  it('routine alert with the switch off (or the main session) goes through sendRoutineAlert unchanged', () => {
    const create = vi.fn()
    const routine = vi.fn()
    const alert = vi.fn()
    expect(sendSessionAlert(false, 'c', { routineKey: 'model-consent:test-off', toMainAgent: false, create, routine, alert })).toBe('alert-chat')
    expect(sendSessionAlert(true, 'c', { routineKey: 'model-consent:test-main', toMainAgent: true, create, routine, alert })).toBe('alert-chat')
    expect(routine.mock.calls).toEqual([['model-consent:test-off', 'c'], ['model-consent:test-main', 'c']])
    expect(create).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('the consent and folder-trust branches route through sendSessionAlert too', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(code).toMatch(/sendSessionAlert\(t\.isMarveen, `🛑 A\(z\) \$\{label\} session a mappa-megbízhatósági dialóguson parkol/)
    expect(code).toMatch(/sendSessionAlert\(t\.isMarveen, `🎛️ A\(z\) \$\{label\} session a modell-hozzájárulás dialóguson parkol[^\n]*\{ routineKey: `model-consent:\$\{label\}` \}\)/)
    expect(code).not.toMatch(/sendRoutineAlert\(`model-consent:/)
  })

  it('the tool-permission branch routes through sendSessionAlert with the main-session flag', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(code).toMatch(/sendSessionAlert\(t\.isMarveen, `🔐 A\(z\) \$\{label\} session egy engedélykérésen vár/)
    expect(code).not.toMatch(/sendAlert\(`🔐 A\(z\) \$\{label\} session egy engedélykérésen vár/)
  })
})
