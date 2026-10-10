import { describe, it, expect } from 'vitest'
import { parseVoiceSttCalibration } from '../config.js'

// Card 75c3d163, upstream review of #1732 (request 1): the speech-to-text chain the transcript-uncertainty threshold
// was calibrated on, and the threshold itself, are install configuration, both or neither (src/config.ts). What the
// parser accepts, and what it turns into "no calibration" with a reason the voice route logs once.
describe('parseVoiceSttCalibration', () => {
  it('neither set: no calibration and no problem (the stock install)', () => {
    expect(parseVoiceSttCalibration(undefined, undefined)).toEqual({ calibration: null, problem: null })
    expect(parseVoiceSttCalibration('  ', '')).toEqual({ calibration: null, problem: null })
  })

  it('both set: the model, the optional revision and the threshold', () => {
    expect(parseVoiceSttCalibration('faster-whisper-medium-abc@abc', '0.9')).toEqual({
      calibration: { model: 'faster-whisper-medium-abc', revision: 'abc', threshold: 0.9 }, problem: null,
    })
    expect(parseVoiceSttCalibration(' small ', '1')).toEqual({ calibration: { model: 'small', revision: null, threshold: 1 }, problem: null })
  })

  it('only one of the two: no calibration, and the reason names the missing key', () => {
    const a = parseVoiceSttCalibration('small', undefined)
    expect(a.calibration).toBeNull()
    expect(a.problem).toContain('without VOICE_STT_UNCERTAIN_NO_SPEECH_PROB')
    const b = parseVoiceSttCalibration(undefined, '0.9')
    expect(b.calibration).toBeNull()
    expect(b.problem).toContain('without VOICE_STT_CALIBRATED_MODEL')
  })

  it('a threshold that is not a number in (0, 1]: no calibration', () => {
    for (const t of ['0', '1.5', '-0.2', 'abc', '0.9x', '1e-1']) {
      const r = parseVoiceSttCalibration('small', t)
      expect(r.calibration, t).toBeNull()
      expect(r.problem, t).toContain('(0, 1]')
    }
  })

  it('a model that is not <model>[@<revision>]: no calibration', () => {
    for (const m of ['@abc', 'small@', 'two words', 'small@a@b']) {
      const r = parseVoiceSttCalibration(m, '0.9')
      expect(r.calibration, m).toBeNull()
      expect(r.problem, m).toContain('<model>[@<revision>]')
    }
  })
})
