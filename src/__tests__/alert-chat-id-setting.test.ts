import { describe, it, expect } from 'vitest'
import { resolveAlertChatIdSetting } from '../config.js'

// The shell alert scripts read MARVEEN_ALERT_CHAT_ID; the TS side must accept
// the same name (ALERT_CHAT_ID stays as an alias).
describe('resolveAlertChatIdSetting', () => {
  it('reads MARVEEN_ALERT_CHAT_ID', () => {
    expect(resolveAlertChatIdSetting({ MARVEEN_ALERT_CHAT_ID: ' 555 ' })).toBe('555')
  })
  it('falls back to ALERT_CHAT_ID', () => {
    expect(resolveAlertChatIdSetting({ ALERT_CHAT_ID: '444' })).toBe('444')
  })
  it('MARVEEN_ALERT_CHAT_ID wins over ALERT_CHAT_ID', () => {
    expect(resolveAlertChatIdSetting({ MARVEEN_ALERT_CHAT_ID: '555', ALERT_CHAT_ID: '444' })).toBe('555')
  })
  it('empty when neither is set', () => {
    expect(resolveAlertChatIdSetting({})).toBe('')
  })
})
