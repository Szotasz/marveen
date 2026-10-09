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

  it('the tool-permission branch routes through sendSessionAlert with the main-session flag', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(code).toMatch(/sendSessionAlert\(t\.isMarveen, `🔐 A\(z\) \$\{label\} session egy engedélykérésen vár/)
    expect(code).not.toMatch(/sendAlert\(`🔐 A\(z\) \$\{label\} session egy engedélykérésen vár/)
  })
})
