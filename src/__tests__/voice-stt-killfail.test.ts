// 082e174b R2 BLOCKER A1 regression (both review legs, reproduced measured):
// when the timeout-path `systemctl --user kill` child FAILS (exit 1) and the
// transient service stays alive holding the supervisor's descriptors, the STT
// caller must still settle within a bounded window, not stay pending forever.
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
  it('caller settles within a bounded window after the kill fails', async () => {
    vi.useFakeTimers()
    try {
      const voice = await import('../web/routes/voice.js')
      const p = voice.transcribeVoiceFile('FILEPROBE01', paths.stateDir)
      // A flag set by p's own reaction, NOT Promise.race against an already
      // resolved promise: that race reports "pending" even for a p that settled
      // long ago (the resolved arm's reaction is queued first), so it can never
      // pass and proves nothing.
      let outcome: 'STILL-PENDING' | 'SETTLED' | 'SETTLED-REJECTED' = 'STILL-PENDING'
      p.then(() => { outcome = 'SETTLED' }, () => { outcome = 'SETTLED-REJECTED' })
      await vi.advanceTimersByTimeAsync(1) // spawn + probe
      const stt = fake.recs.filter((r) => r.args.includes('transcribe') && r.cmd === 'systemd-run')
      expect(stt).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(160_000) // STT budget: SIGKILL + failed systemctl kill
      const kill = fake.recs.filter((r) => r.cmd === 'systemctl')
      expect(kill).toHaveLength(1)
      expect(outcome).toBe('STILL-PENDING') // the budget alone does not settle it: the descriptors are still held
      // Generous bounded-settle window: the kill's own 5s cap + a wide margin.
      await vi.advanceTimersByTimeAsync(6_000)
      await vi.advanceTimersByTimeAsync(30_000)
      // Desired behavior: bounded settlement even when the kill fails.
      expect(outcome).toBe('SETTLED')
    } finally {
      vi.useRealTimers()
    }
  })
})
