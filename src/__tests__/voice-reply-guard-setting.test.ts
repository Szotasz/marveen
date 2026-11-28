// VOICEREPLYGATE1128: the voice-reply gate's switch. Off by default; it only tightens a turn, so switching it ON needs
// nothing, and switching it OFF loosens (the owner's session). The behaviour is tested in
// scripts/__tests__/telegram-reply-guard.test.py.
import { describe, it, expect } from 'vitest'
import { SETTINGS_REGISTRY } from '../config-registry.js'

describe('VOICE_REPLY_GUARD', () => {
  const d = SETTINGS_REGISTRY.find((x) => x.key === 'VOICE_REPLY_GUARD')!
  it('off by default, only on/off', () => {
    expect(d.default).toBe('off')
    expect(d.validate!('on')).toBeNull()
    expect(d.validate!('off')).toBeNull()
    expect(d.validate!('yes')).not.toBeNull()
  })
  it('switching it off loosens; switching it on or keeping it does not', () => {
    expect(d.loosens!('on', 'off')).toBe(true)
    expect(d.loosens!(' ON ', '')).toBe(true)
    expect(d.loosens!('off', 'on')).toBe(false)
    expect(d.loosens!('on', 'on')).toBe(false)
    expect(d.loosens!('off', 'off')).toBe(false)
  })
})
