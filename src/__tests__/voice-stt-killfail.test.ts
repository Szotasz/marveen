// 082e174b R2 BLOCKER A1 regression (both review legs, reproduced measured):
// a FAILED timeout-path `systemctl --user kill` (transient service stays alive
// holding the supervisor's descriptors) must not jam the single-flight queue
// forever. With the per-caller deadline the first caller itself settles null at
// 160 s; the queue head is then released by runProc's 8 s settle grace, so a
// second caller's whisper spawns ~8 s later and also settles at its own deadline.
// This fake is voice-stt-scope.test.ts's harness with ONE change: the
// systemctl branch finishes(1) and never closes the beheaded target.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fake = vi.hoisted(() => {
  interface Rec {
    cmd: string
    args: string[]
    closeTick: number | null
    killed: string | null
    close(code: number | null): void
  }
  const cfg = { probeCode: 0, holdTranscribe: true }
  const recs: Rec[] = []
  const beheaded = new Map<string, Rec>()
  function unitOf(args: string[]): string | null {
    const flag = args.find((x) => x.startsWith('--unit='))
    return flag ? flag.slice('--unit='.length) : null
  }
  function spawnImpl(cmd: string, args: string[]): {
    stdout: { on(ev: string, cb: (d: Buffer) => void): void }
    stderr: { on(ev: string, cb: (d: Buffer) => void): void }
    stdin: { write(d: string, e: string): void; end(): void }
    on(ev: string, cb: (code: number | null) => void): void
    kill(sig: string): void
  } {
    const rec: Rec = {
      cmd, args, closeTick: null, killed: null,
      close(code: number | null) { finish(code) },
    }
    recs.push(rec)
    const dataCbs: Array<(d: Buffer) => void> = []
    let closeCb: ((code: number | null) => void) | null = null
    function finish(code: number | null) {
      if (rec.closeTick != null) return
      rec.closeTick = 1
      setTimeout(() => { closeCb?.(code) }, 0)
    }
    const isProbe = cmd === 'systemd-run' && args.includes('/bin/true')
    const child = {
      stdout: { on: (_ev: string, cb: (d: Buffer) => void) => { dataCbs.push(cb) } },
      stderr: { on: (_ev: string, _cb: (d: Buffer) => void) => { /* no stderr in this fake */ } },
      stdin: { write: () => {}, end: () => {} },
      on: (ev: string, cb: (code: number | null) => void) => { if (ev === 'close') closeCb = cb },
      kill: (sig: string) => {
        rec.killed = sig
        if (sig !== 'SIGKILL') return
        const unit = cmd === 'systemd-run' && args.includes('transcribe') ? unitOf(args) : null
        if (unit) beheaded.set(unit, rec)
        else finish(null)
      },
    }
    if (isProbe) finish(cfg.probeCode)
    else if (cmd === 'systemctl') {
      // PROBE DIFFERENCE: the unit kill FAILS and the service stays alive
      // holding the descriptors -- the beheaded target is NOT closed.
      finish(1)
    }
    // transcribe children never finish on their own (holdTranscribe)
    return child
  }
  return { cfg, recs, beheaded, spawnImpl }
})

vi.mock('node:child_process', () => ({ spawn: fake.spawnImpl }))

const paths = vi.hoisted(() => ({ home: '', stateDir: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => paths.home,
}))

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: logs }))

vi.mock('../config.js', () => ({ PROJECT_ROOT: '/nonexistent-marveen-root' }))
vi.mock('../web/http-helpers.js', () => ({ readBody: vi.fn(), json: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({
  KNOWN_VOICE_MODELS: new Set(['hu_HU-imre-medium']),
  AGENTS_BASE_DIR: '/nonexistent-agents',
  readAgentVoiceConfig: () => ({ responseMode: 'text', voiceModel: 'm' }),
}))
vi.mock('../web/voice-modality.js', () => ({
  getLastInboundModality: () => 'text',
  setLastInboundModality: vi.fn(),
}))
vi.mock('../web/voice-directive.js', () => ({
  buildTtsDirective: () => 'curl-tts',
  resolveAgentChannelStateDir: () => paths.stateDir,
  inboundIsAudio: () => true,
  parseTtsRequest: () => null,
}))

const VENV = () => join(paths.home, '.local', 'share', 'marveen-voice', 'venv', 'bin', 'python')
const VTOOLS = () => join(paths.home, '.local', 'share', 'marveen-voice', '_vtools.py')

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), 'stt-probe-home-'))
  paths.home = home
  mkdirSync(join(home, '.local', 'share', 'marveen-voice', 'venv', 'bin'), { recursive: true })
  writeFileSync(VENV(), '')
  writeFileSync(VTOOLS(), '')
  const stateDir = join(home, '.claude', 'channels', 'telegram')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
  paths.stateDir = stateDir
})
afterAll(() => rmSync(paths.home, { recursive: true, force: true }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fake.recs.length = 0
  fake.beheaded.clear()
  fake.cfg.probeCode = 0
  fake.cfg.holdTranscribe = true
  process.env.MARVEEN_STT_MODE = 'systemd'
})

describe('PROBE A1: failed systemctl kill must not block the caller forever', () => {
  it('caller settles at its deadline and the queue is released by the settle grace after the kill fails', async () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.useFakeTimers()
    try {
      const voice = await import('../web/routes/voice.js')
      const p1 = voice.transcribeVoiceFile('FILEPROBE01', paths.stateDir)
      // Flags set by the promise's own reaction, NOT Promise.race against an
      // already resolved promise: that race reports "pending" even for a promise
      // that settled long ago, so it can never pass and proves nothing.
      let outcome: 'STILL-PENDING' | 'SETTLED' | 'SETTLED-REJECTED' = 'STILL-PENDING'
      let value: string | null | undefined
      p1.then((v) => { outcome = 'SETTLED'; value = v }, () => { outcome = 'SETTLED-REJECTED' })
      await vi.advanceTimersByTimeAsync(1) // spawn
      const stt = () => fake.recs.filter((r) => r.args.includes('transcribe') && r.cmd === 'systemd-run')
      expect(stt()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(160_000) // deadline: SIGKILL + failed systemctl kill
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fake.recs.filter((r) => r.cmd === 'systemctl')).toHaveLength(1)
      expect(outcome).toBe('SETTLED') // per-caller deadline; the descriptors are still held
      expect(value).toBeNull()

      const p2Deadline = Date.now() + 160_000
      const p2 = voice.transcribeVoiceFile('FILEPROBE02', paths.stateDir)
      await vi.advanceTimersByTimeAsync(1)
      expect(stt()).toHaveLength(1) // queue still held by the first run (its close never comes)

      await vi.advanceTimersByTimeAsync(8_000) // the settle grace frees the queue
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(stt()).toHaveLength(2)
      expect(stt()[1].args).toContain('FILEPROBE02')

      // The late starter's systemd-run gets only the REST of p2's budget: it is
      // SIGKILLed by p2's own deadline, not 160 s after it spawned (~8 s later).
      await vi.advanceTimersByTimeAsync(p2Deadline - Date.now() - 1_000)
      expect(stt()[1].killed).toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(stt()[1].killed).toBe('SIGKILL')
      expect(await p2).toBeNull()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', desc!)
    }
  })
})
