// Per-agent voice style (pitch + tempo) applied to the Piper output in the
// ffmpeg ogg/opus conversion step of _vtools.py `speak`.
//
// The filter string is built here (pure, unit-tested) and handed to the
// toolkit through the MARVEEN_VOICE_STYLE_AF environment variable. The toolkit
// only accepts it when it matches the narrow character set produced below.

import { readFileSync } from 'node:fs'

export const VOICE_PITCH_MIN = -6
export const VOICE_PITCH_MAX = 6
export const VOICE_PITCH_DEFAULT = 0
export const VOICE_SPEED_MIN = 0.8
export const VOICE_SPEED_MAX = 1.25
export const VOICE_SPEED_DEFAULT = 1.0

// Piper "medium" voices (hu_HU-imre-medium, hu_HU-anna-medium) declare 22050 Hz
// in their .onnx.json; used only when that file cannot be read.
export const FALLBACK_SAMPLE_RATE = 22050

/** A finite number within [-6, +6] semitones; anything else is invalid. */
export function isValidPitchSemitones(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= VOICE_PITCH_MIN && v <= VOICE_PITCH_MAX
}

/** A finite tempo factor within [0.8, 1.25]; anything else is invalid. */
export function isValidSpeed(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= VOICE_SPEED_MIN && v <= VOICE_SPEED_MAX
}

/** Sample rate from the model's <model>.onnx.json (audio.sample_rate), else the fallback. */
export function readVoiceSampleRate(onnxPath: string): number {
  try {
    const meta = JSON.parse(readFileSync(`${onnxPath}.json`, 'utf-8')) as { audio?: { sample_rate?: unknown } }
    const sr = meta.audio?.sample_rate
    if (typeof sr === 'number' && Number.isInteger(sr) && sr >= 8000 && sr <= 192000) return sr
  } catch { /* missing or malformed metadata: fall back */ }
  return FALLBACK_SAMPLE_RATE
}

// Trim a float to a short, stable decimal (no exponent notation).
function fmt(n: number): string {
  return Number(n.toFixed(6)).toString()
}

/**
 * Split a tempo factor into atempo stages, each within ffmpeg's classic
 * [0.5, 2.0] range (older builds reject values outside it).
 */
export function atempoChain(factor: number): string[] {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error(`Invalid tempo factor: ${factor}`)
  const out: string[] = []
  let f = factor
  while (f > 2.0) { out.push('atempo=2'); f /= 2.0 }
  while (f < 0.5) { out.push('atempo=0.5'); f /= 0.5 }
  if (Math.abs(f - 1) > 1e-6) out.push(`atempo=${fmt(f)}`)
  return out
}

/**
 * ffmpeg -af chain for a pitch shift of `pitchSemitones` and a net tempo of
 * `speed`, or null when both are neutral (no styling at all).
 *
 * asetrate=SR*2^(n/12) raises the pitch AND speeds playback by the same ratio;
 * aresample=SR restores the container rate; atempo then corrects the tempo so
 * the net speed is exactly `speed` (atempo changes tempo without pitch).
 */
export function buildVoiceStyleFilter(pitchSemitones: number, speed: number, sampleRate: number): string | null {
  if (!isValidPitchSemitones(pitchSemitones)) throw new Error(`Invalid pitchSemitones: ${pitchSemitones}`)
  if (!isValidSpeed(speed)) throw new Error(`Invalid speed: ${speed}`)
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error(`Invalid sampleRate: ${sampleRate}`)
  const pitchOn = pitchSemitones !== 0
  const speedOn = Math.abs(speed - 1) > 1e-9
  if (!pitchOn && !speedOn) return null
  const filters: string[] = []
  let tempoFactor = speed
  if (pitchOn) {
    const shiftedRate = Math.round(sampleRate * Math.pow(2, pitchSemitones / 12))
    filters.push(`asetrate=${shiftedRate}`, `aresample=${sampleRate}`)
    // Use the rounded rate's actual ratio so the net tempo is exact.
    tempoFactor = speed * sampleRate / shiftedRate
  }
  filters.push(...atempoChain(tempoFactor))
  return filters.join(',')
}
