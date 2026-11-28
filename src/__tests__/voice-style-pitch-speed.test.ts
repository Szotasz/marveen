// Per-agent voice style: pitchSemitones / speed validation through the real
// agent-config fs layer, and the ffmpeg filter chain (pure builder).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENTS_BASE_DIR, readAgentVoiceConfig, writeAgentVoiceConfig } from '../web/agent-config.js'
import { buildVoiceStyleFilter, atempoChain, readVoiceSampleRate, FALLBACK_SAMPLE_RATE } from '../web/voice-style.js'
import { ttsStyleFilter } from '../web/routes/voice.js'

const NAME = `voice-style-test-${process.pid}`
const DIR = join(AGENTS_BASE_DIR, NAME)
const CFG = join(DIR, 'agent-config.json')
const put = (voice: unknown) => writeFileSync(CFG, JSON.stringify({ model: 'x', voice }))
const onDisk = () => JSON.parse(readFileSync(CFG, 'utf8')).voice
const TMP = mkdtempSync(join(tmpdir(), 'voice-style-'))

beforeAll(() => mkdirSync(DIR, { recursive: true }))
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
})

// Net tempo of a chain: asetrate ratio times every atempo factor.
function netTempo(af: string, sr: number): number {
  let t = 1
  for (const part of af.split(',')) {
    const [k, v] = part.split('=')
    if (k === 'asetrate') t *= Number(v) / sr
    if (k === 'atempo') t *= Number(v)
  }
  return t
}

describe('voice config: pitchSemitones / speed on read', () => {
  it('defaults to 0 / 1.0 when unset', () => {
    put({ responseMode: 'voice' })
    expect(readAgentVoiceConfig(NAME)).toMatchObject({ pitchSemitones: 0, speed: 1 })
  })

  it('reads valid values as given', () => {
    put({ responseMode: 'voice', pitchSemitones: 2, speed: 1.05 })
    expect(readAgentVoiceConfig(NAME)).toMatchObject({ pitchSemitones: 2, speed: 1.05 })
  })

  it('falls back to the default on out-of-range or non-numeric values', () => {
    for (const [p, s] of [[7, 1.3], [-6.5, 0.79], ['2', '1.05'], [null, null], [Number.NaN, true]] as unknown[][]) {
      put({ responseMode: 'voice', pitchSemitones: p, speed: s })
      expect(readAgentVoiceConfig(NAME)).toMatchObject({ pitchSemitones: 0, speed: 1 })
    }
  })

  it('accepts the range bounds', () => {
    put({ responseMode: 'voice', pitchSemitones: -6, speed: 0.8 })
    expect(readAgentVoiceConfig(NAME)).toMatchObject({ pitchSemitones: -6, speed: 0.8 })
    put({ responseMode: 'voice', pitchSemitones: 6, speed: 1.25 })
    expect(readAgentVoiceConfig(NAME)).toMatchObject({ pitchSemitones: 6, speed: 1.25 })
  })
})

describe('voice config: pitchSemitones / speed on write', () => {
  it('persists valid values and keeps them across an unrelated write', () => {
    put({ responseMode: 'text' })
    writeAgentVoiceConfig(NAME, { pitchSemitones: 2, speed: 1.05 })
    expect(onDisk()).toMatchObject({ pitchSemitones: 2, speed: 1.05 })
    writeAgentVoiceConfig(NAME, { responseMode: 'voice' })
    expect(onDisk()).toMatchObject({ responseMode: 'voice', pitchSemitones: 2, speed: 1.05 })
  })

  it('does not store neutral values, so resetting clears them', () => {
    put({ responseMode: 'text' })
    writeAgentVoiceConfig(NAME, { responseMode: 'voice' })
    expect('pitchSemitones' in onDisk()).toBe(false)
    expect('speed' in onDisk()).toBe(false)
    writeAgentVoiceConfig(NAME, { pitchSemitones: 3, speed: 1.1 })
    writeAgentVoiceConfig(NAME, { pitchSemitones: 0, speed: 1 })
    expect('pitchSemitones' in onDisk()).toBe(false)
    expect('speed' in onDisk()).toBe(false)
  })

  it('rejects invalid values and leaves the file unchanged', () => {
    put({ responseMode: 'text', pitchSemitones: 1 })
    const before = readFileSync(CFG, 'utf8')
    expect(() => writeAgentVoiceConfig(NAME, { pitchSemitones: 6.5 })).toThrow(/pitchSemitones/)
    expect(() => writeAgentVoiceConfig(NAME, { pitchSemitones: '2' as unknown as number })).toThrow(/pitchSemitones/)
    expect(() => writeAgentVoiceConfig(NAME, { speed: 1.5 })).toThrow(/speed/)
    expect(() => writeAgentVoiceConfig(NAME, { speed: Number.POSITIVE_INFINITY })).toThrow(/speed/)
    expect(readFileSync(CFG, 'utf8')).toBe(before)
  })
})

describe('buildVoiceStyleFilter', () => {
  it('returns null when both are neutral', () => {
    expect(buildVoiceStyleFilter(0, 1, 22050)).toBeNull()
  })

  it('tempo only: a single atempo, no resampling', () => {
    expect(buildVoiceStyleFilter(0, 1.05, 22050)).toBe('atempo=1.05')
  })

  it('pitch +2, speed 1.05 at 22050 Hz (example setting)', () => {
    const af = buildVoiceStyleFilter(2, 1.05, 22050) as string
    // 22050 * 2^(2/12) = 24750.2 -> 24750
    expect(af.startsWith('asetrate=24750,aresample=22050,atempo=')).toBe(true)
    expect(netTempo(af, 22050)).toBeCloseTo(1.05, 5)
  })

  it('pitch only: atempo undoes the asetrate speed-up (net tempo 1)', () => {
    const af = buildVoiceStyleFilter(-3, 1, 22050) as string
    expect(af).toMatch(/^asetrate=\d+,aresample=22050,atempo=[\d.]+$/)
    expect(netTempo(af, 22050)).toBeCloseTo(1, 5)
  })

  it('keeps every atempo stage within [0.5, 2] across the whole allowed range', () => {
    for (const p of [-6, -3, 0, 3, 6]) {
      for (const s of [0.8, 1, 1.25]) {
        const af = buildVoiceStyleFilter(p, s, 22050)
        if (!af) continue
        for (const m of af.matchAll(/atempo=([\d.]+)/g)) {
          const v = Number(m[1])
          expect(v).toBeGreaterThanOrEqual(0.5)
          expect(v).toBeLessThanOrEqual(2)
        }
        expect(netTempo(af, 22050)).toBeCloseTo(s, 5)
      }
    }
  })

  it('refuses out-of-range input', () => {
    expect(() => buildVoiceStyleFilter(7, 1, 22050)).toThrow(/pitchSemitones/)
    expect(() => buildVoiceStyleFilter(0, 2, 22050)).toThrow(/speed/)
    expect(() => buildVoiceStyleFilter(0, 1.1, 0)).toThrow(/sampleRate/)
  })
})

describe('atempoChain', () => {
  it('chains stages for factors outside [0.5, 2]', () => {
    expect(atempoChain(3)).toEqual(['atempo=2', 'atempo=1.5'])
    expect(atempoChain(0.3)).toEqual(['atempo=0.5', 'atempo=0.6'])
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2'])
    expect(atempoChain(1)).toEqual([])
  })
})

describe('readVoiceSampleRate', () => {
  it('reads audio.sample_rate from <model>.onnx.json', () => {
    const onnx = join(TMP, 'm.onnx')
    writeFileSync(`${onnx}.json`, JSON.stringify({ audio: { sample_rate: 16000, quality: 'low' } }))
    expect(readVoiceSampleRate(onnx)).toBe(16000)
  })

  it('falls back when the metadata is missing or malformed', () => {
    expect(readVoiceSampleRate(join(TMP, 'missing.onnx'))).toBe(FALLBACK_SAMPLE_RATE)
    const bad = join(TMP, 'bad.onnx')
    writeFileSync(`${bad}.json`, '{"audio":{"sample_rate":"x"}}')
    expect(readVoiceSampleRate(bad)).toBe(FALLBACK_SAMPLE_RATE)
  })
})

describe('ttsStyleFilter (the TTS route with ?agent=)', () => {
  it("uses the agent's config and the model's sample rate", () => {
    const onnx = join(TMP, 'imre.onnx')
    writeFileSync(`${onnx}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }))
    put({ responseMode: 'voice', voiceModel: 'hu_HU-imre-medium', pitchSemitones: 2, speed: 1.05 })
    expect(ttsStyleFilter(NAME, onnx)).toBe(buildVoiceStyleFilter(2, 1.05, 22050))
  })

  it('is null for a neutral config', () => {
    put({ responseMode: 'voice' })
    expect(ttsStyleFilter(NAME, join(TMP, 'imre.onnx'))).toBeNull()
  })
})
