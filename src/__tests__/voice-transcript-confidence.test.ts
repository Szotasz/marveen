import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// What this file guards, and why it is a BEHAVIOUR test rather than a source match:
// the classification below decides what a person is told about their own voice
// message. A regex over the source would have passed while the code path never
// ran -- that mistake was made on this repo on 2026-09-07 (card 1d984c7e), where
// a "42/42 green" rested on `expect(src).toMatch(...)` and four tests in the
// bundle failed on the very call the source-match claimed to cover.
//
// Every diag line below carries a REAL measurement taken on 2026-09-07 with a
// fresh model instance per file, one process per file (the live shape), not an
// invented number. The transcript TEXTS are not the recordings' own words: they
// are stand-ins, because what is pinned here is the classification of a diag
// line, and a person's message has no place in a test fixture.
//
// WITH THE MODEL NAMED, because the numbers do not survive without it: these were
// measured on faster-whisper **small**. The toolkit moved to **medium** at 15:28 the
// same day and the no_speech_prob scale shifted under the same six recordings (0.108
// -> 0.742 on one of them). These cases still test the right thing -- they pin the
// CLASSIFICATION given a diag line, not the model that produces one -- but do not read
// the numbers as current live values for any other purpose.

let nextRun: { stdout: string; stderr: string; code: number } = { stdout: '', stderr: '', code: 0 }

vi.mock('node:child_process', () => ({
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: { write(): void; end(): void }; kill(): void
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = { write() {}, end() {} }
    proc.kill = () => {}
    setImmediate(() => {
      if (nextRun.stdout) proc.stdout.emit('data', Buffer.from(nextRun.stdout))
      if (nextRun.stderr) proc.stderr.emit('data', Buffer.from(nextRun.stderr))
      proc.emit('close', nextRun.code)
    })
    return proc
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  // isVoiceInstalled() checks the venv python and _vtools.py exist.
  return { ...real, existsSync: () => true }
})

const { transcribeVoiceFileDetailed } = await import('../web/routes/voice.js')

// A synthetic id of the Telegram shape (SAFE_FILE_ID_RE), not a real message's.
const FILE_ID = 'AwACAgQAAxkBAAITestVoiceId0001'
const STATE_DIR = `${process.env.HOME}/.claude/channels/telegram`

const diag = (o: { seg: number; dur: number; nsp?: string; alp?: string; temp?: string }) =>
  `vtools-diag segments=${o.seg} duration=${o.dur.toFixed(2)} no_speech_prob=${o.nsp ?? ''} avg_logprob=${o.alp ?? ''} temperature=${o.temp ?? ''}\n`

beforeEach(() => { nextRun = { stdout: '', stderr: '', code: 0 } })

describe('transcribeVoiceFileDetailed: the three doubts are distinguishable', () => {
  it('a real owner recording that read cleanly is HIGH confidence', async () => {
    // Measured on a 4.40 s recording at -18.9 dB, the control file that always worked.
    nextRun = {
      stdout: 'Ez egy jól érthető, rendes mondat a teszthez.\n',
      stderr: diag({ seg: 1, dur: 4.39, nsp: '0.108', alp: '-0.598', temp: '0.00' }),
      code: 0,
    }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('high')
    expect(r.temperature).toBe(0)
  })

  it('the confident hallucination is UNCERTAIN -- it is born at temperature 0.0', async () => {
    // Measured: a 1.76 s noise clip calibrated to -39.9 dB produced "Sziasztok!"
    // at no_speech 0.907 / avg_logprob -0.946 / temperature 0.00. It passes the
    // drop rule because that rule is a CONJUNCTION, and it looks like a normal
    // transcript -- which is exactly why it has to be marked.
    nextRun = {
      stdout: 'Sziasztok!\n',
      stderr: diag({ seg: 1, dur: 1.77, nsp: '0.907', alp: '-0.946', temp: '0.00' }),
      code: 0,
    }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('uncertain')
    // The control that keeps the two labels apart: a deterministic decode must
    // NOT be reported as "no reliable reading".
    expect(r.confidence).not.toBe('unreliable')
  })

  it('a SAMPLED transcript is UNRELIABLE, and outranks the no-speech doubt', async () => {
    // temperature > 0 means the deterministic pass failed and the text came off
    // the fallback ladder. Measured on both LOST owner messages (1.00 s / 1.76 s):
    // no_speech 0.773 / avg_logprob -1.219 / temperature 1.00.
    nextRun = {
      stdout: 'Köszönöm a videóra!\n',
      stderr: diag({ seg: 1, dur: 1.00, nsp: '0.773', alp: '-1.219', temp: '1.00' }),
      code: 0,
    }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('unreliable')
  })

  it('an empty transcript is NO-TRANSCRIPT, never a silent success', async () => {
    // The case that was silent until 2026-09-07: exit 0, empty stdout, and the
    // diag line carries NO per-segment values because the segment was dropped.
    nextRun = { stdout: '', stderr: diag({ seg: 0, dur: 0.99 }), code: 0 }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('no-transcript')
    if (r.status !== 'no-transcript') return
    expect(r.durationSec).toBeCloseTo(0.99, 2)
  })

  it('a non-zero exit is FAILED, and is not confused with an empty transcript', async () => {
    nextRun = { stdout: '', stderr: 'Traceback...\n', code: 1 }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('failed')
  })

  it('degrades on an OLD installed _vtools.py that emits no diag line', async () => {
    // scripts/install-voice.sh deploys _vtools.py separately from the dashboard,
    // so a newer dashboard WILL meet an older toolkit. Missing diagnostics must
    // mean "unknown", not a wrong verdict: the transcript still goes through.
    nextRun = { stdout: 'Ez egy rendes mondat.\n', stderr: '', code: 0 }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('high')
    expect(r.temperature).toBeNull()
    expect(r.noSpeechProb).toBeNull()
  })

  it('the temperature field is read from the diag line, not assumed', async () => {
    // Mutation guard: if the parser stopped reading `temperature=`, this case
    // would fall back to 'high' and the strongest signal would vanish silently.
    nextRun = {
      stdout: 'valami szöveg\n',
      stderr: diag({ seg: 1, dur: 2.0, nsp: '0.010', alp: '-0.200', temp: '0.60' }),
      code: 0,
    }
    const r = await transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // Low no_speech AND good logprob -- the ONLY thing making this unreliable is
    // the temperature, so a broken parser turns this green-looking case red.
    expect(r.confidence).toBe('unreliable')
    expect(r.temperature).toBe(0.6)
  })
})
