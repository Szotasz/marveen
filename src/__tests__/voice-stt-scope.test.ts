// STT subprocess scope: single-flight + cgroup isolation (card 082e174b,
// incident 2026-11-18: two parallel whisper runs inside the dashboard's own
// MemoryHigh=3G/MemoryMax=4G service cgroup drove it into reclaim and stalled
// the fleet's message traffic). Pins the contract of the whisper spawn seam
// in src/web/routes/voice.ts:
// - on Linux, when user systemd works (or is forced), the transcription runs
//   as a transient `systemd-run --user ... -p MemoryHigh -p MemoryMax
//   --unit=marveen-stt-*` unit around the SAME venv-python command, with the
//   same rc/stdout semantics as the old direct spawn;
// - one transcription at a time, process-wide; concurrent callers queue FIFO
//   and the second one logs its queue position;
// - a failed capability probe, MARVEEN_STT_MODE=direct, or a non-Linux host
//   fall back to the direct spawn (macOS path untouched);
// - on timeout the transient UNIT is SIGKILLed via systemctl --user kill,
//   fired from runProc's timeout path itself (measured on the target host:
//   with --pipe the service holds the supervisor's inherited descriptors, so
//   the awaited close never arrives until the unit dies -- a cleanup behind
//   the await would deadlock the caller and the queue head), and the caller
//   still gets the plain null failure.
// The spawn seam is faked the way router-voice-stt-gate.test.ts fakes its
// seams: vi.hoisted state behind vi.mock factories -- no new framework.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One fake child_process. Children classify themselves by cmd/args:
//   systemd-run ... /bin/true        -> the capability probe (rc = cfg.probeCode)
//   systemd-run ... transcribe ...   -> isolated STT (may be held open / killed)
//   systemctl ...                    -> the unit kill; its SPAWN is also what
//                                       closes a beheaded isolated STT child
//   <venv python> ... transcribe ... -> direct STT (may be held open / killed)
// Every event stamps a monotonic tick as well as Date.now(): overlap and
// ordering assertions must not depend on millisecond clock resolution.
const fake = vi.hoisted(() => {
  interface Rec {
    cmd: string
    args: string[]
    openTick: number
    closeTick: number | null
    openedAt: number
    closedAt: number | null
    killed: string | null
    unhandledError: boolean
    close(code: number | null): void
  }
  const cfg = {
    probeCode: 0,
    transcribeCode: 0,
    transcribeStdout: '  ez egy hangüzenet átirata  ',
    holdTranscribe: false,
    transcribeSpawnError: false,
  }
  const recs: Rec[] = []
  // Measured descriptor retention (target host, 2026-11-18): with --pipe the
  // transient service holds the supervisor's inherited stdout/stderr, so
  // SIGKILLing the systemd-run supervisor does NOT close the child -- it
  // closes only when a `systemctl --user kill --signal=SIGKILL <unit>` child
  // spawns and ends the service's processes. Unit name -> beheaded rec.
  const beheaded = new Map<string, Rec>()
  let tick = 0
  function unitOf(args: string[]): string | null {
    const flag = args.find((x) => x.startsWith('--unit='))
    return flag ? flag.slice('--unit='.length) : null
  }
  function spawnImpl(cmd: string, args: string[]): {
    stdout: { on(ev: string, cb: (d: Buffer) => void): void }
    stderr: { on(ev: string, cb: (d: Buffer) => void): void }
    stdin: { write(d: string, e: string): void; end(): void }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(ev: string, cb: (arg: any) => void): void
    kill(sig: string): void
  } {
    const rec: Rec = {
      cmd,
      args,
      openTick: ++tick,
      closeTick: null,
      openedAt: Date.now(),
      closedAt: null,
      killed: null,
      unhandledError: false,
      close(code: number | null) { finish(code) },
    }
    recs.push(rec)
    const dataCbs: Array<(d: Buffer) => void> = []
    let closeCb: ((code: number | null) => void) | null = null
    let errorCb: ((err: Error) => void) | null = null
    function finish(code: number | null) {
      if (rec.closeTick != null) return
      rec.closeTick = ++tick
      rec.closedAt = Date.now()
      // setTimeout(0), not sync emit: runProc attaches its data/close
      // listeners only after spawn() returns, in the same tick.
      setTimeout(() => {
        if (rec.args.includes('transcribe')) for (const cb of dataCbs) cb(Buffer.from(cfg.transcribeStdout))
        closeCb?.(code)
      }, 0)
    }
    const isProbe = cmd === 'systemd-run' && args.includes('/bin/true')
    const child = {
      stdout: { on: (_ev: string, cb: (d: Buffer) => void) => { dataCbs.push(cb) } },
      stderr: { on: (_ev: string, _cb: (d: Buffer) => void) => { /* no stderr in this fake */ } },
      stdin: { write: () => {}, end: () => {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: (ev: string, cb: (arg: any) => void) => {
        if (ev === 'close') closeCb = cb
        else if (ev === 'error') errorCb = cb
      },
      kill: (sig: string) => {
        rec.killed = sig
        // A plain SIGKILLed process dies even when the fake would otherwise
        // stall -- but the isolated-STT systemd-run supervisor is not plain:
        // --pipe left the transient service holding its stdout/stderr
        // descriptors, so the rec can only close once a systemctl kill child
        // for its unit spawns (see the systemctl branch below).
        if (sig !== 'SIGKILL') return
        const unit = cmd === 'systemd-run' && args.includes('transcribe') ? unitOf(args) : null
        if (unit) beheaded.set(unit, rec)
        else finish(null)
      },
    }
    if (isProbe) finish(cfg.probeCode)
    else if (cmd === 'systemctl') {
      // The unit kill ends the service's processes; only then do the beheaded
      // supervisor's inherited descriptors close and its 'close' fire.
      const target = beheaded.get(args[args.length - 1])
      if (target) {
        beheaded.delete(args[args.length - 1])
        target.close(null)
      }
      finish(0)
    }
    else if (cmd === 'systemd-run' && args.includes('transcribe') && cfg.transcribeSpawnError) {
      setTimeout(() => {
        if (errorCb) errorCb(new Error('spawn systemd-run ENOENT'))
        else rec.unhandledError = true
      }, 0)
    }
    else if (args.includes('transcribe') && !cfg.holdTranscribe) finish(cfg.transcribeCode)
    return child
  }
  return { cfg, recs, beheaded, spawnImpl, nextTick: () => ++tick }
})

vi.mock('node:child_process', () => ({ spawn: fake.spawnImpl }))

// homedir is redirected into a temp dir so isVoiceInstalled()/isSafeStateDir()
// pass against the real fs layer, the same trick the router gate test uses for
// its channel state dir.
const paths = vi.hoisted(() => ({ home: '', stateDir: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => paths.home,
}))

const http = vi.hoisted(() => ({ readBody: vi.fn(), json: vi.fn() }))

const logs = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}))
vi.mock('../logger.js', () => ({ logger: logs }))

// The rest of voice.ts's import surface: shape-only factories, matching the
// router test's blanket module mocks.
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/nonexistent-marveen-root' }))
vi.mock('../web/http-helpers.js', () => ({ readBody: http.readBody, json: http.json }))
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

// The isolation mode and the probe result are cached at module scope "for the
// process lifetime"; vi.resetModules() gives each case a fresh module (the
// vi.mock factories above survive it), so the cache is testable at all.
async function loadVoice(): Promise<typeof import('../web/routes/voice.js')> {
  return import('../web/routes/voice.js')
}

const VENV = () => join(paths.home, '.local', 'share', 'marveen-voice', 'venv', 'bin', 'python')
const VTOOLS = () => join(paths.home, '.local', 'share', 'marveen-voice', '_vtools.py')

const sttSpawns = () => fake.recs.filter((r) => r.args.includes('transcribe'))
const isolatedSpawns = () => sttSpawns().filter((r) => r.cmd === 'systemd-run')
const directSpawns = () => sttSpawns().filter((r) => r.cmd === VENV())
const probes = () => fake.recs.filter((r) => r.args.includes('/bin/true'))
const unitKills = () => fake.recs.filter((r) => r.cmd === 'systemctl')

const FILE_A = 'FILEAAAAAAAA01'
const FILE_B = 'FILEBBBBBBBB02'

const ENV_NAMES = ['MARVEEN_WHISPER_MODEL', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']
const savedEnv: Record<string, string | undefined> = {}

function pinLinux(): () => void {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  return () => { Object.defineProperty(process, 'platform', desc!) }
}

const DIRECTIVE_CTX = () => ({
  req: {} as any,
  res: {} as any,
  path: '/api/voice/directive',
  method: 'GET',
  url: new URL('http://x/api/voice/directive?agent=tester&chat=123&file=' + FILE_A + '&kind=voice'),
} as any)

beforeAll(() => {
  for (const n of ENV_NAMES) savedEnv[n] = process.env[n]
  const home = mkdtempSync(join(tmpdir(), 'stt-scope-home-'))
  paths.home = home
  // The on-disk toolkit layout isVoiceInstalled() checks for.
  mkdirSync(join(home, '.local', 'share', 'marveen-voice', 'venv', 'bin'), { recursive: true })
  writeFileSync(VENV(), '')
  writeFileSync(VTOOLS(), '')
  // A state dir isSafeStateDir() accepts: ~/.claude/channels/<provider>/.env
  const stateDir = join(home, '.claude', 'channels', 'telegram')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
  paths.stateDir = stateDir
})
afterAll(() => {
  rmSync(paths.home, { recursive: true, force: true })
  for (const n of ENV_NAMES) {
    if (savedEnv[n] !== undefined) process.env[n] = savedEnv[n]
    else delete process.env[n]
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fake.recs.length = 0
  fake.beheaded.clear()
  fake.cfg.probeCode = 0
  fake.cfg.transcribeCode = 0
  fake.cfg.transcribeStdout = '  ez egy hangüzenet átirata  '
  fake.cfg.holdTranscribe = false
  fake.cfg.transcribeSpawnError = false
  for (const n of ENV_NAMES) delete process.env[n]
  delete process.env.MARVEEN_STT_MODE
  delete process.env.MARVEEN_STT_MEMORY_HIGH
  delete process.env.MARVEEN_STT_MEMORY_MAX
})

describe('STT spawn scope: cgroup isolation + single-flight', () => {
  it('T1: probe-ok host runs STT as an isolated transient unit with the pinned argv and default budgets', async () => {
    // Regresses if: the systemd-run wrapper loses a flag (--pipe/--collect/
    // --wait each carry behavior: journald noise, dead-unit cleanup, rc
    // forwarding), the -p pair is reordered or renumbered (the budgets ARE the
    // incident fix), the unit name stops being unique per call (second
    // systemd-run would collide), or rc/stdout semantics drift.
    // Platform pinned so the suite does not depend on the runner's real one.
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const voice = await loadVoice()
      const out = await voice.transcribeVoiceFile(FILE_A, paths.stateDir)

      expect(probes()).toHaveLength(1) // auto mode: capability probed exactly once
      expect(logs.info.mock.calls.some((c) => String(c[0]).includes('probe ok; memory cap not verified'))).toBe(true)
      expect(logs.info.mock.calls.some((c) => String(c[0]).includes('isolation enabled'))).toBe(false)
      expect(isolatedSpawns()).toHaveLength(1)
      expect(directSpawns()).toHaveLength(0)

      const a = isolatedSpawns()[0].args
      expect(a.slice(0, 5)).toEqual(['--user', '--quiet', '--pipe', '--collect', '--wait'])
      const hi = a.indexOf('MemoryHigh=1610612736')
      const mx = a.indexOf('MemoryMax=3221225472')
      expect(hi).toBeGreaterThan(-1)
      expect(mx).toBeGreaterThan(-1)
      expect(a[hi - 1]).toBe('-p')
      expect(a[mx - 1]).toBe('-p')
      expect(hi).toBeLessThan(mx) // MemoryHigh before MemoryMax, as pinned
      const unitIdx = a.findIndex((x) => x.startsWith('--unit=marveen-stt-'))
      expect(unitIdx).toBeGreaterThan(-1)
      const rt = a.indexOf('RuntimeMaxSec=170')
      expect(rt).toBeGreaterThan(mx)
      expect(a[rt - 1]).toBe('-p')
      expect(rt).toBeLessThan(unitIdx)
      expect(a.some((x) => x.startsWith('--setenv'))).toBe(false) // all forwarded vars unset here
      expect(a[unitIdx]).toMatch(/^--unit=marveen-stt-\d+-\d+$/)
      // Trailing args exactly the old direct command.
      expect(a.slice(unitIdx + 1)).toEqual([VENV(), VTOOLS(), 'transcribe', FILE_A, paths.stateDir])

      expect(out).toBe('ez egy hangüzenet átirata') // success = trimmed stdout

      // Unit names stay unique across calls in one process.
      await voice.transcribeVoiceFile(FILE_B, paths.stateDir)
      const names = isolatedSpawns().map((r) => r.args.find((x) => x.startsWith('--unit=')))
      expect(names[0]).not.toBe(names[1])
    } finally {
      Object.defineProperty(process, 'platform', desc!)
    }
  })

  it('T2: two concurrent transcriptions never overlap; the second spawns only after the first resolves, in call order', async () => {
    // Regresses if: the promise-chain lock is dropped or reordered, and two
    // whispers can again run inside the dashboard cgroup at once -- the exact
    // 2026-11-18 incident -- or a queued caller is rejected/starved instead of
    // waiting its turn.
    process.env.MARVEEN_STT_MODE = 'direct' // serialization is mode-independent
    fake.cfg.holdTranscribe = true // children stay open until this test closes them
    const voice = await loadVoice()

    const marks: string[] = []
    const p1 = voice.transcribeVoiceFile(FILE_A, paths.stateDir).then((t) => {
      marks.push(`resolve:${t}`)
      return t
    })
    const p2 = voice.transcribeVoiceFile(FILE_B, paths.stateDir)

    await vi.waitFor(() => expect(sttSpawns()).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 25)) // give a misbehaving second spawn room to appear
    expect(sttSpawns()).toHaveLength(1) // no overlap: second has not spawned yet
    expect(sttSpawns()[0].args).toContain(FILE_A) // FIFO: first caller runs first

    sttSpawns()[0].close(0)
    await vi.waitFor(() => expect(sttSpawns()).toHaveLength(2))

    const [first, second] = sttSpawns()
    expect(second.args).toContain(FILE_B) // FIFO end-to-end
    expect(second.openTick).toBeGreaterThan(first.closeTick!) // strictly after close
    expect(second.openedAt).toBeGreaterThanOrEqual(first.closedAt!) // wall-clock too
    expect(marks).toHaveLength(1) // first call resolved BEFORE the second spawned
    expect(marks[0]).toBe('resolve:ez egy hangüzenet átirata')

    second.close(0)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('ez egy hangüzenet átirata')
    expect(r2).toBe('ez egy hangüzenet átirata')

    // The queued caller was announced exactly once, with its queue position.
    const queued = logs.warn.mock.calls.filter((c) => String(c[1]).includes('queued'))
    expect(queued).toHaveLength(1)
    expect(queued[0][0]).toMatchObject({ queuePosition: 1 })

    // MARVEEN_STT_MODE=direct pins the strategy outright: the capability
    // probe must never have run on this account.
    expect(probes()).toHaveLength(0)
  })

  it('T3: failed capability probe falls back permanently to the direct spawn', async () => {
    // Regresses if: a host without a working user systemd (container, broken
    // session) stops transcribing instead of degrading, or re-pays the probe
    // timeout on every voice note instead of caching the failure.
    fake.cfg.probeCode = 1
    const restore = pinLinux()
    try {
      const voice = await loadVoice()

      const out = await voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      expect(out).toBe('ez egy hangüzenet átirata')
      expect(directSpawns()).toHaveLength(1)
      expect(isolatedSpawns()).toHaveLength(0) // no systemd-run around STT itself
      expect(logs.warn.mock.calls.some((c) => String(c[1]).includes('probe failed'))).toBe(true)

      await voice.transcribeVoiceFile(FILE_B, paths.stateDir) // cache: probed once, ever
      expect(probes()).toHaveLength(1)
      expect(directSpawns()).toHaveLength(2)
    } finally {
      restore()
    }
  })

  it('T4: non-Linux host uses the direct spawn and never probes', async () => {
    // Regresses if: the macOS dev path changes behavior -- a probe there would
    // burn its 10s timeout failing on every fresh process, or isolation would
    // silently diverge the two platforms' STT.
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const voice = await loadVoice()
      const out = await voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      expect(out).toBe('ez egy hangüzenet átirata')
      expect(directSpawns()).toHaveLength(1)
      expect(probes()).toHaveLength(0) // the probe never ran
      expect(fake.recs.some((r) => r.cmd === 'systemd-run')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', desc!)
    }
  })

  it('T5: MARVEEN_STT_MEMORY_HIGH/MAX overrides replace the -p budgets', async () => {
    // Regresses if: the ops knobs stop reaching the unit properties (or a
    // lenient parse lets a non-integer pin a wrong cgroup limit on the host
    // someone was trying to tune).
    // Platform pinned so the suite does not depend on the runner's real one.
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      process.env.MARVEEN_STT_MODE = 'systemd'
      process.env.MARVEEN_STT_MEMORY_HIGH = '268435456'
      process.env.MARVEEN_STT_MEMORY_MAX = '536870912'
      const voice = await loadVoice()

      await voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      const a = isolatedSpawns()[0].args
      expect(a).toContain('MemoryHigh=268435456')
      expect(a).toContain('MemoryMax=536870912')
      expect(a).not.toContain('MemoryHigh=1610612736')
      expect(a).not.toContain('MemoryMax=3221225472')
      expect(a.indexOf('MemoryHigh=268435456')).toBeLessThan(a.indexOf('MemoryMax=536870912'))
    } finally {
      Object.defineProperty(process, 'platform', desc!)
    }
  })

  it('T5b: invalid overrides (non-integer, non-positive, oversized/unsafe digits, trailing newline) leave the DEFAULT budgets in place and warn per env var', async () => {
    // Regresses if: the parse accepts something that is not a strict safe
    // positive-integer byte count -- "0"/"-5"/"1.5G", a digits-only string so
    // long that Number() returns Infinity, the finite-but-unsafe integer
    // 9007199254740993 (past 2^53: isSafeInteger must reject what Number()
    // silently rounds), or a trailing newline ("4096\n": unlike some regex
    // flavors, JS `$` does not match before a final newline, so the digits-only
    // regex must reject it). All of these must pin NOTHING: the argv keeps the
    // default budgets and the log names the env var that was ignored.
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      process.env.MARVEEN_STT_MODE = 'systemd'
      const voice = await loadVoice()
      for (const bad of ['0', '-5', '1.5G', '9'.repeat(400), '9007199254740993', '4096\n']) {
        // Warn assertions are scoped to THIS iteration only: asserting over
        // the accumulated calls would let warnings emitted for an earlier bad
        // value satisfy an iteration that warned for nothing at all.
        const warnCountBefore = logs.warn.mock.calls.length
        process.env.MARVEEN_STT_MEMORY_HIGH = bad
        process.env.MARVEEN_STT_MEMORY_MAX = bad
        await voice.transcribeVoiceFile(FILE_A, paths.stateDir)
        const a = isolatedSpawns().at(-1)!.args
        expect(a).toContain('MemoryHigh=1610612736')
        expect(a).toContain('MemoryMax=3221225472')
        expect(a).not.toContain(`MemoryHigh=${bad}`)
        expect(a).not.toContain(`MemoryMax=${bad}`)
        const warned = logs.warn.mock.calls
          .slice(warnCountBefore)
          .filter((c) => String(c[1]).includes('memory override invalid'))
          .map((c) => (c[0] as { envName?: string }).envName)
        expect(warned).toContain('MARVEEN_STT_MEMORY_HIGH')
        expect(warned).toContain('MARVEEN_STT_MEMORY_MAX')
      }
    } finally {
      Object.defineProperty(process, 'platform', desc!)
    }
  })

  it('T6: systemd-run stalling past the budget gets its unit SIGKILLed via systemctl and the caller gets null', async () => {
    // Regresses if: the timeout only beheads the systemd-run supervisor and
    // leaves the whisper processes alive in their cgroup burning CPU/RAM after
    // everyone gave up, or the timeout path stops failing like a normal whisper
    // failure (warn + null). The fake models the measured descriptor
    // retention: the beheaded supervisor's descriptors stay open until the
    // unit dies, so this test HANGS (never settles) against any cleanup that
    // waits behind the blocked close instead of firing from the timeout path.
    process.env.MARVEEN_STT_MODE = 'systemd'
    fake.cfg.holdTranscribe = true // the unit never exits on its own
    const restore = pinLinux()
    vi.useFakeTimers()
    try {
      const voice = await loadVoice()
      const p = voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      await vi.advanceTimersByTimeAsync(1) // let the spawn happen
      expect(isolatedSpawns()).toHaveLength(1)
      expect(unitKills()).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(160_000) // the STT_TIMEOUT_MS budget elapses
      // The budget timer SIGKILLs the supervisor AND (from the timeout path)
      // spawns the systemctl unit kill; that spawn is what lets the fake's
      // beheaded supervisor finally close, through 0ms timers chained behind
      // the budget timer, so flush a round per link until the call settles.
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      const out = await p

      expect(out).toBeNull()
      const stt = isolatedSpawns()[0]
      expect(stt.killed).toBe('SIGKILL') // the runProc timer fired on systemd-run
      const unit = stt.args.find((x) => x.startsWith('--unit='))!
      expect(unitKills()).toHaveLength(1)
      expect(unitKills()[0].args).toEqual(['--user', 'kill', '--signal=SIGKILL', unit.slice('--unit='.length)])
      expect(logs.warn.mock.calls.some((c) => String(c[1]).includes('whisper failed'))).toBe(true)
    } finally {
      vi.useRealTimers()
      restore()
    }
  })

  it('T1b: forwarded env vars are passed to the unit by NAME only, never with their value', async () => {
    // Regresses if: the unit loses MARVEEN_WHISPER_MODEL / proxy variables
    // (the transient unit does not inherit the dashboard's environ), or a value
    // (a proxy URL with a password) leaks into argv, which is visible in /proc and ps.
    const restore = pinLinux()
    try {
      process.env.MARVEEN_STT_MODE = 'systemd'
      process.env.MARVEEN_WHISPER_MODEL = 'medium'
      process.env.HTTPS_PROXY = 'http://user:s3cr3t@proxy.invalid:3128'
      const voice = await loadVoice()
      await voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      const a = isolatedSpawns()[0].args
      const unitIdx = a.findIndex((x) => x.startsWith('--unit='))
      const m = a.indexOf('--setenv=MARVEEN_WHISPER_MODEL')
      const h = a.indexOf('--setenv=HTTPS_PROXY')
      expect(m).toBeGreaterThan(-1)
      expect(h).toBeGreaterThan(-1)
      expect(m).toBeLessThan(unitIdx)
      expect(h).toBeLessThan(unitIdx)
      expect(m).toBeLessThan(h)
      for (const x of a) {
        expect(x).not.toContain('s3cr3t')
        expect(x).not.toContain('medium')
      }
      expect(a).not.toContain('--setenv=NO_PROXY')
      expect(a).not.toContain('--setenv=no_proxy')
      expect(a).not.toContain('--setenv=https_proxy')
      expect(a.slice(unitIdx + 1)).toEqual([VENV(), VTOOLS(), 'transcribe', FILE_A, paths.stateDir])
    } finally {
      restore()
    }
  })

  it('T7: a queued caller settles within its own 160 s, and an expired queued caller never spawns', async () => {
    // Regresses if: the deadline is per whisper run instead of per caller (a
    // caller behind a stalled run settles at 320 s, past the client's 170 s),
    // or an expired queued caller still spawns its whisper when its turn comes.
    process.env.MARVEEN_STT_MODE = 'direct'
    fake.cfg.holdTranscribe = true
    const restore = pinLinux()
    vi.useFakeTimers()
    try {
      const voice = await loadVoice()
      let s1 = false
      let s2 = false
      let v1: string | null | undefined
      let v2: string | null | undefined
      const p1 = voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      const p2 = voice.transcribeVoiceFile(FILE_B, paths.stateDir)
      p1.then((v) => { s1 = true; v1 = v })
      p2.then((v) => { s2 = true; v2 = v })
      await vi.advanceTimersByTimeAsync(1)
      expect(sttSpawns()).toHaveLength(1)
      expect(sttSpawns()[0].args).toContain(FILE_A)
      await vi.advanceTimersByTimeAsync(159_999)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(s1).toBe(true)
      expect(s2).toBe(true)
      expect(v1).toBeNull()
      expect(v2).toBeNull()
      expect(sttSpawns()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(200_000)
      expect(sttSpawns()).toHaveLength(1)
      await Promise.all([p1, p2])
    } finally {
      vi.useRealTimers()
      restore()
    }
  })

  it('T7b: a caller that starts late gets only the rest of its budget', async () => {
    // Regresses if: the run budget restarts at 160 s when the caller finally
    // gets its turn (the whisper would outlive the caller's own deadline).
    process.env.MARVEEN_STT_MODE = 'direct'
    fake.cfg.holdTranscribe = true
    const restore = pinLinux()
    vi.useFakeTimers()
    try {
      const voice = await loadVoice()
      let s1 = false
      let s2 = false
      let v1: string | null | undefined
      let v2: string | null | undefined
      const p1 = voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      p1.then((v) => { s1 = true; v1 = v })
      await vi.advanceTimersByTimeAsync(100_000)
      const p2 = voice.transcribeVoiceFile(FILE_B, paths.stateDir)
      p2.then((v) => { s2 = true; v2 = v })
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(s1).toBe(true)
      expect(v1).toBeNull()
      expect(sttSpawns()).toHaveLength(2)
      expect(sttSpawns()[1].args).toContain(FILE_B)
      await vi.advanceTimersByTimeAsync(259_000 - 160_002)
      expect(s2).toBe(false)
      expect(sttSpawns()[1].killed).toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(s2).toBe(true)
      expect(v2).toBeNull()
      expect(sttSpawns()[1].killed).toBe('SIGKILL')
    } finally {
      vi.useRealTimers()
      restore()
    }
  })

  it('T8: the same file asked twice runs once and both callers get the transcript', async () => {
    // Regresses if: the same-file merge is dropped (two whispers for one voice
    // note, the second waiting behind the first) or the merged caller is
    // announced as queued.
    process.env.MARVEEN_STT_MODE = 'direct'
    fake.cfg.holdTranscribe = true
    const restore = pinLinux()
    try {
      const voice = await loadVoice()
      const p1 = voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      const p2 = voice.transcribeVoiceFile(FILE_A, paths.stateDir)
      await vi.waitFor(() => expect(sttSpawns()).toHaveLength(1))
      await new Promise((r) => setTimeout(r, 25))
      expect(sttSpawns()).toHaveLength(1)
      sttSpawns()[0].close(0)
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBe('ez egy hangüzenet átirata')
      expect(r2).toBe('ez egy hangüzenet átirata')
      expect(sttSpawns()).toHaveLength(1)
      expect(logs.warn.mock.calls.some((c) => String(c[1]).includes('queued'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('T9: /api/voice/directive goes through the single-flight queue', async () => {
    // Regresses if: the directive route spawns its own whisper beside the
    // queue (two whispers at once, the 2026-11-18 incident).
    process.env.MARVEEN_STT_MODE = 'direct'
    fake.cfg.holdTranscribe = true
    const restore = pinLinux()
    try {
      const voice = await loadVoice()
      const pB = voice.transcribeVoiceFile(FILE_B, paths.stateDir)
      await vi.waitFor(() => expect(sttSpawns()).toHaveLength(1))
      const h = voice.tryHandleVoice(DIRECTIVE_CTX())
      await new Promise((r) => setTimeout(r, 25))
      expect(sttSpawns()).toHaveLength(1)
      expect(http.json).not.toHaveBeenCalled()
      sttSpawns()[0].close(0)
      await vi.waitFor(() => expect(sttSpawns()).toHaveLength(2))
      expect(sttSpawns()[1].args).toContain(FILE_A)
      sttSpawns()[1].close(0)
      expect(await h).toBe(true)
      expect(http.json).toHaveBeenCalledTimes(1)
      expect(http.json.mock.calls[0][1]).toEqual({ directive: null, transcript: 'ez egy hangüzenet átirata' })
      await pB
    } finally {
      restore()
    }
  })

  it('T10: the directive answers within 160 s even behind a stalled run', async () => {
    // Regresses if: the directive's wait behind a stalled whisper is not
    // bounded by its own deadline (it would answer after the client's 170 s).
    process.env.MARVEEN_STT_MODE = 'direct'
    fake.cfg.holdTranscribe = true
    const restore = pinLinux()
    vi.useFakeTimers()
    try {
      const voice = await loadVoice()
      const pB = voice.transcribeVoiceFile(FILE_B, paths.stateDir)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(49_999)
      const h = voice.tryHandleVoice(DIRECTIVE_CTX())
      await vi.advanceTimersByTimeAsync(160_000)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(http.json).toHaveBeenCalledTimes(1)
      expect(http.json.mock.calls[0][1]).toEqual({ directive: null, transcript: null })
      expect(await h).toBe(true)
      await pB
    } finally {
      vi.useRealTimers()
      restore()
    }
  })

  it('T11: a spawn error on the isolated STT call fails that call and the queue moves on', async () => {
    // Regresses if: the isolated call loses spawnErrorAsFailure (an unhandled
    // 'error' event crashes the process or the caller hangs) or a failed call
    // jams the queue for the next one.
    const restore = pinLinux()
    try {
      process.env.MARVEEN_STT_MODE = 'systemd'
      fake.cfg.transcribeSpawnError = true
      const voice = await loadVoice()
      const out = await Promise.race([
        voice.transcribeVoiceFile(FILE_A, paths.stateDir),
        new Promise((r) => setTimeout(() => r('HUNG'), 500)),
      ])
      expect(out).toBeNull()
      expect(isolatedSpawns()[0].unhandledError).toBe(false)
      fake.cfg.transcribeSpawnError = false
      expect(await voice.transcribeVoiceFile(FILE_B, paths.stateDir)).toBe('ez egy hangüzenet átirata')
    } finally {
      restore()
    }
  })
})
