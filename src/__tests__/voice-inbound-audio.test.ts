import { describe, it, expect } from 'vitest'
import { inboundIsAudio } from '../web/voice-directive.js'

// The single decision behind "should this agent answer with speech": was the
// inbound attachment audio? Getting it wrong is not cosmetic -- in `auto` voice
// mode a false positive makes the agent answer a document with a synthesized
// voice message, and pushes that file through speech-to-text.
describe('inboundIsAudio', () => {
  it('accepts the kinds Telegram uses for audio', () => {
    for (const kind of ['voice', 'audio', 'video_note']) {
      expect(inboundIsAudio(kind, 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(true)
    }
  })

  it('rejects a document attachment -- the 2026-07-29 regression', () => {
    // An 826 kB PDF arrived with a perfectly valid file id; the old code read
    // the id alone as proof of a voice message.
    expect(inboundIsAudio('document', 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(false)
  })

  it('rejects the other non-audio attachment kinds', () => {
    for (const kind of ['photo', 'video', 'sticker', 'animation']) {
      expect(inboundIsAudio(kind, 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(false)
    }
  })

  it('treats a missing or empty kind as NOT audio', () => {
    // Conservative direction: a wrong "speak" is a wrong-format answer to the
    // owner, a wrong "stay quiet" only loses the audio nicety.
    expect(inboundIsAudio(null, 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(false)
    expect(inboundIsAudio(undefined, 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(false)
    expect(inboundIsAudio('', 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(false)
  })

  it('is case and whitespace tolerant on the kind', () => {
    expect(inboundIsAudio(' Voice ', 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(true)
    expect(inboundIsAudio('VIDEO_NOTE', 'BQACAgQAAxkBAAIDSWpqdaVDcIjs')).toBe(true)
  })

  it('needs a file id: a kind alone is not an attachment', () => {
    expect(inboundIsAudio('voice', null)).toBe(false)
    expect(inboundIsAudio('voice', '')).toBe(false)
    expect(inboundIsAudio('voice', undefined)).toBe(false)
  })
})
