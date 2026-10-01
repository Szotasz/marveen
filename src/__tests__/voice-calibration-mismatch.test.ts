import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card 75c3d163: the uncertainty threshold in src/web/routes/voice.ts is calibrated on ONE speech-to-text chain,
// and the toolkit now names its model on the diag line. What this file pins, as BEHAVIOUR (the classification and
// the side effects actually happen, nothing is matched in the source):
//   - the design decision recorded on the card (2026-09-07 18:15Z): a foreign model does NOT change the
//     classification -- it travels separately as calibrationMismatch, a warn, ONE inter-agent message per model
//     pair, and a persistent state on GET /api/voice/status;
//   - the card's three acceptance controls: a foreign model (negative), the calibrated model (positive), and a
//     diag line with NO model field, i.e. an older installed toolkit (no signal, today's result);
//   - the dedup holds across a dashboard restart (the state file), and does not depend on the state file
//     being writable (the in-process fallback).

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR ?? '/tmp'}/voice-calibration-test-${process.pid}-${Date.now()}`,
  sent: [] as Array<{ from: string; to: string; content: string }>,
  failNextMessage: false,
  notified: [] as Array<{ chatId: string; text: string }>,
  run: { stdout: '', stderr: '', code: 0 },
}))

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
      if (h.run.stdout) proc.stdout.emit('data', Buffer.from(h.run.stdout))
      if (h.run.stderr) proc.stderr.emit('data', Buffer.from(h.run.stderr))
      proc.emit('close', h.run.code)
    })
    return proc
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  // isVoiceInstalled() and isSafeStateDir() check that files exist; the calibration state is read with readFileSync.
  return { ...real, existsSync: () => true }
})

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  STORE_DIR: h.dir,
  VOICE_CALIBRATION_ALERT_AGENT: 'dev-lead-x',
}))

vi.mock('../db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db.js')>()),
  createAgentMessage: (from: string, to: string, content: string) => {
    if (h.failNextMessage) {
      h.failNextMessage = false
      throw new Error('agent_messages unavailable')
    }
    h.sent.push({ from, to, content })
    return { id: 9000 + h.sent.length, from_agent: from, to_agent: to, content, status: 'pending' }
  },
}))

vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  notifyChat: async (chatId: string, text: string) => {
    h.notified.push({ chatId, text })
    return true
  },
}))

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  readAgentVoiceConfig: () => ({ responseMode: 'text', voiceModel: null }),
}))

vi.mock('../web/voice-directive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/voice-directive.js')>()),
  resolveAgentChannelStateDir: () => `${process.env.HOME}/.claude/channels/telegram`,
  inboundIsAudio: () => true,
}))

type VoiceModule = typeof import('../web/routes/voice.js')
let voice: VoiceModule

const FILE_ID = 'AwACAgQAAxkBAAITestVoiceId0002'
const STATE_DIR = `${process.env.HOME}/.claude/channels/telegram`
const REV = '08e178d48790749d25932bbc082711ddcfdfbc4f'
const OTHER_REV = '2222222222222222222222222222222222222222'
const STATE_FILE = () => join(h.dir, 'voice-calibration.json')

const diag = (o: { model?: string; revision?: string; seg?: number; nsp?: string; temp?: string }) =>
  'vtools-diag ' +
  (o.model !== undefined ? `model=${o.model} revision=${o.revision ?? ''} ` : '') +
  `segments=${o.seg ?? 1} duration=4.39 no_speech_prob=${o.nsp ?? '0.108'} avg_logprob=-0.598 temperature=${o.temp ?? '0.00'}\n`

const speak = (stderr: string, stdout = 'Ez egy jól érthető, rendes mondat a teszthez.\n') => {
  h.run = { stdout, stderr, code: 0 }
  return voice.transcribeVoiceFileDetailed(FILE_ID, STATE_DIR)
}

// node:fs is mocked for this file too (existsSync is always true), so absence is read from the ENOENT itself.
const state = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE(), 'utf-8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

beforeEach(async () => {
  rmSync(h.dir, { recursive: true, force: true })
  mkdirSync(h.dir, { recursive: true })
  h.sent.length = 0
  h.notified.length = 0
  h.failNextMessage = false
  vi.resetModules()
  voice = await import('../web/routes/voice.js')
})

afterAll(() => rmSync(h.dir, { recursive: true, force: true }))

describe('75c3d163: the three acceptance controls', () => {
  it('POSITIVE: the calibrated model keeps HIGH and raises nothing', async () => {
    const r = await speak(diag({ model: voice.CALIBRATED_STT_MODEL, revision: REV }))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('high')
    expect(r.calibrationMismatch).toBeNull()
    expect(h.sent).toHaveLength(0)
    expect(state()).toBeNull()
  })

  it('NEGATIVE: a foreign model keeps HIGH, and the mismatch travels separately (field + one message + state)', async () => {
    const r = await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    // the design decision: the classification is NOT touched by the mismatch
    expect(r.confidence).toBe('high')
    expect(r.calibrationMismatch).toEqual({ expected: voice.CALIBRATED_STT_MODEL, actual: `small@${OTHER_REV}` })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].from).toBe('voice-calibration')
    expect(h.sent[0].to).toBe('dev-lead-x')
    expect(h.sent[0].content).toContain(voice.CALIBRATED_STT_MODEL)
    expect(h.sent[0].content).toContain(`small@${OTHER_REV}`)
    const s = state()
    const e = s[`${voice.CALIBRATED_STT_MODEL} -> small@${OTHER_REV}`]
    expect(e.count).toBe(1)
    expect(e.notifiedAgent).toBe('dev-lead-x')
    expect(e.messageId).toBe(9001)
    expect(typeof e.notifiedAt).toBe('string')
  })

  it('THIRD: a diag line without a model field (older toolkit) is not a foreign model -- no signal, same result', async () => {
    const r = await speak(diag({}))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('high')
    expect(r.calibrationMismatch).toBeNull()
    expect(h.sent).toHaveLength(0)
    expect(state()).toBeNull()
  })
})

describe('75c3d163: what a mismatch must and must not change', () => {
  it('an UNCERTAIN transcript stays uncertain on a foreign model (no relabelling either way)', async () => {
    const r = await speak(diag({ model: 'small', revision: OTHER_REV, nsp: '0.907' }), 'Sziasztok!\n')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.confidence).toBe('uncertain')
    expect(r.calibrationMismatch).not.toBeNull()
  })

  it('the same model name with a different revision is a mismatch too', async () => {
    const r = await speak(diag({ model: voice.CALIBRATED_STT_MODEL, revision: OTHER_REV }))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.calibrationMismatch?.actual).toBe(`${voice.CALIBRATED_STT_MODEL}@${OTHER_REV}`)
  })

  it('a no-transcript result carries the mismatch as well', async () => {
    const r = await speak(diag({ model: 'small', revision: '', seg: 0, nsp: '', temp: '' }), '')
    expect(r.status).toBe('no-transcript')
    if (r.status !== 'no-transcript') return
    expect(r.calibrationMismatch).toEqual({ expected: voice.CALIBRATED_STT_MODEL, actual: 'small' })
  })

  it('an earlier vtools-diag line (a GPU fallback notice) does not hide the measurements', async () => {
    const r = await speak(
      'vtools-diag device_fallback=cpu reason=RuntimeError\n' + diag({ model: 'small', revision: OTHER_REV, nsp: '0.907' }),
      'Sziasztok!\n',
    )
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.noSpeechProb).toBe(0.907)
    expect(r.confidence).toBe('uncertain')
  })
})

describe('75c3d163: the one-time message', () => {
  it('goes once per model pair, and a second pair gets its own', async () => {
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(h.sent).toHaveLength(1)
    expect(state()[`${voice.CALIBRATED_STT_MODEL} -> small@${OTHER_REV}`].count).toBe(2)
    await speak(diag({ model: 'medium', revision: OTHER_REV }))
    expect(h.sent).toHaveLength(2)
  })

  it('does not come back after a dashboard restart (the state file is the dedup)', async () => {
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(h.sent).toHaveLength(1)
    vi.resetModules()
    voice = await import('../web/routes/voice.js')
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(h.sent).toHaveLength(1)
    expect(state()[`${voice.CALIBRATED_STT_MODEL} -> small@${OTHER_REV}`].count).toBe(2)
  })

  it('a failed send is retried on the next occurrence, and the transcription is not affected', async () => {
    h.failNextMessage = true
    const r = await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(r.status).toBe('ok')
    expect(h.sent).toHaveLength(0)
    expect(state()[`${voice.CALIBRATED_STT_MODEL} -> small@${OTHER_REV}`].notifiedAt).toBeNull()
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(h.sent).toHaveLength(1)
  })

  it('does not repeat when the state file cannot be written (in-process fallback)', async () => {
    // A directory where the state file should be: reading fails (EISDIR) and the atomic rename fails too.
    mkdirSync(STATE_FILE(), { recursive: true })
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    expect(h.sent).toHaveLength(1)
  })
})

describe('75c3d163: where the mismatch can be read later, and where it must not go', () => {
  it('GET /api/voice/status carries the calibrated model and the mismatches seen', async () => {
    await speak(diag({ model: 'small', revision: OTHER_REV }))
    const res = { status: 0, body: '', writeHead(s: number) { this.status = s }, end(b: string) { this.body = b } }
    const handled = await voice.tryHandleVoice({
      req: {} as never, res: res as never, path: '/api/voice/status', method: 'GET', url: new URL('http://x/api/voice/status'),
    })
    expect(handled).toBe(true)
    const body = JSON.parse(res.body)
    expect(body.calibration.model).toBe(voice.CALIBRATED_STT_MODEL)
    expect(body.calibration.mismatches).toHaveLength(1)
    expect(body.calibration.mismatches[0].actual).toBe(`small@${OTHER_REV}`)
  })

  it('the directive response carries it, but the SENDER is told only about the transcript, never about the model', async () => {
    h.run = { stdout: 'Sziasztok!\n', stderr: diag({ model: 'small', revision: OTHER_REV, nsp: '0.907' }), code: 0 }
    const res = { status: 0, body: '', writeHead(s: number) { this.status = s }, end(b: string) { this.body = b } }
    const url = new URL(`http://x/api/voice/directive?agent=tesztagens&chat=123456789&file=${FILE_ID}&kind=voice`)
    await voice.tryHandleVoice({ req: {} as never, res: res as never, path: '/api/voice/directive', method: 'GET', url })
    const body = JSON.parse(res.body)
    expect(body.transcriptConfidence).toBe('uncertain')
    expect(body.calibrationMismatch).toEqual({ expected: voice.CALIBRATED_STT_MODEL, actual: `small@${OTHER_REV}` })
    expect(body.noticeDelivered).toBe(true)
    expect(h.notified).toHaveLength(1)
    expect(h.notified[0].chatId).toBe('123456789')
    // the channel notice is the deeaa175 delivery: no transcript text, and nothing about calibration
    expect(h.notified[0].text).not.toContain('Sziasztok')
    expect(h.notified[0].text).not.toMatch(/small|kalibr|calibr/i)
  })
})
