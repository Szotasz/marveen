// Which heavy-job gate jobs belong to an agent? Pure tests with an in-memory
// /proc and store, a real-process check of the /proc reader, and a contract
// check against the real scripts/heavy-job-gate.sh (names and record format).
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentHeavyJobs,
  descendsFrom,
  gateAlive,
  heavyJobPaths,
  liveGatedJobs,
  liveHeavyJobDeps,
  parseLockRecord,
  parseProcStat,
  sessionPanePids,
  type HeavyJobDeps,
  type ProcInfo,
} from '../web/heavy-job-owner.js'

const PATHS = heavyJobPaths('/inst', {})
const GATE = 'python3 /inst/scripts/heavy-job-gate.py --label x -- npx vitest run'

// Two agents: alpha (pane 100) and beta (pane 200).
//   100 sh (pane) -> 101 claude -> 102 bash -> 103 gate (RUNNING, holds the lock)
//                               -> 104 bash -> 105 gate (QUEUED)
//   200 sh (pane) -> 201 claude -> 202 bash -> 203 gate (QUEUED)
function world(overrides: Record<number, ProcInfo | null> = {}, files: Record<string, string> = {}): HeavyJobDeps {
  const procs: Record<number, ProcInfo | null> = {
    100: { ppid: 50, start: '1', state: 'S', cmdline: 'sh -c claude' },
    101: { ppid: 100, start: '2', state: 'S', cmdline: 'claude --continue' },
    102: { ppid: 101, start: '3', state: 'S', cmdline: '/bin/bash -c scripts/heavy-job-gate.sh' },
    103: { ppid: 102, start: '4', state: 'S', cmdline: GATE },
    104: { ppid: 101, start: '5', state: 'S', cmdline: '/bin/bash -c x' },
    105: { ppid: 104, start: '6', state: 'S', cmdline: GATE },
    200: { ppid: 50, start: '7', state: 'S', cmdline: 'sh -c claude' },
    201: { ppid: 200, start: '8', state: 'S', cmdline: 'claude' },
    202: { ppid: 201, start: '9', state: 'S', cmdline: '/bin/bash' },
    203: { ppid: 202, start: '10', state: 'S', cmdline: GATE },
    50: { ppid: 1, start: '0', state: 'S', cmdline: 'tmux' },
    ...overrides,
  }
  const q = PATHS.queueDir
  const fs: Record<string, string> = {
    [PATHS.lock]: 'token=abc pid=103 unit=heavy-job-1-103 since=now label=alpha-tests\n',
    [join(q, '00000000000000000001-0000000105.ticket')]: JSON.stringify({ pid: 105, start: '6', label: 'alpha-build' }),
    [join(q, '00000000000000000002-0000000203.ticket')]: JSON.stringify({ pid: 203, start: '10', label: 'beta-render' }),
    ...files,
  }
  return {
    readFile: (p) => (p in fs ? fs[p]! : null),
    listDir: (d) => Object.keys(fs).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1)),
    proc: (pid) => procs[pid] ?? null,
  }
}

describe('liveGatedJobs', () => {
  it('reads the running holder and the queued tickets', () => {
    expect(liveGatedJobs(world(), PATHS)).toEqual([
      { pid: 103, label: 'alpha-tests', state: 'running', start: '4' },
      { pid: 105, label: 'alpha-build', state: 'queued', start: '6' },
      { pid: 203, label: 'beta-render', state: 'queued', start: '10' },
    ])
  })

  it('a stale lock record (holder dead, zombie, or pid reused by a non-gate) is not a running job', () => {
    for (const holder of [null, { ppid: 102, start: '4', state: 'Z', cmdline: GATE }, { ppid: 102, start: '4', state: 'S', cmdline: 'vim notes' }]) {
      const jobs = liveGatedJobs(world({ 103: holder }), PATHS)
      expect(jobs.find((j) => j.state === 'running')).toBeUndefined()
    }
  })

  it('a ticket whose pid now has another start time (pid reuse) is stale', () => {
    const jobs = liveGatedJobs(world({ 105: { ppid: 104, start: '999', state: 'S', cmdline: GATE } }), PATHS)
    expect(jobs.map((j) => j.pid)).toEqual([103, 203])
  })

  it('malformed tickets and non-ticket files are ignored', () => {
    const q = PATHS.queueDir
    const jobs = liveGatedJobs(world({}, {
      [join(q, 'a.ticket')]: '{not json',
      [join(q, 'b.ticket')]: '[1,2]',
      [join(q, 'c.ticket')]: JSON.stringify({ pid: 'x' }),
      [join(q, '.tmp-9-abcd')]: JSON.stringify({ pid: 105 }),
    }), PATHS)
    expect(jobs.map((j) => j.pid)).toEqual([103, 105, 203])
  })

  it('no lock file and no queue directory -> no jobs', () => {
    const empty: HeavyJobDeps = { readFile: () => null, listDir: () => [], proc: () => null }
    expect(liveGatedJobs(empty, PATHS)).toEqual([])
  })

  it('labels are sanitized (whitespace, length)', () => {
    const q = PATHS.queueDir
    const jobs = liveGatedJobs(world({}, {
      [join(q, '00000000000000000002-0000000203.ticket')]: JSON.stringify({ pid: 203, start: '10', label: 'a b\tc' + 'x'.repeat(200) }),
    }), PATHS)
    const l = jobs.find((j) => j.pid === 203)!.label
    expect(l.startsWith('a_b_c')).toBe(true)
    expect(l.length).toBe(100)
  })
})

describe('agentHeavyJobs: ownership by process tree', () => {
  it('alpha owns its running and its queued job, not beta\'s', () => {
    expect(agentHeavyJobs([100], world(), PATHS).map((j) => j.label)).toEqual(['alpha-tests', 'alpha-build'])
  })

  it('beta owns only its queued job', () => {
    expect(agentHeavyJobs([200], world(), PATHS).map((j) => j.label)).toEqual(['beta-render'])
  })

  it('an agent without jobs, or with no pane pid, owns nothing', () => {
    expect(agentHeavyJobs([999], world(), PATHS)).toEqual([])
    expect(agentHeavyJobs([], world(), PATHS)).toEqual([])
  })

  it('a job reparented out of the tree (setsid + parent gone) is not claimed', () => {
    expect(agentHeavyJobs([100], world({ 103: { ppid: 1, start: '4', state: 'S', cmdline: GATE } }), PATHS).map((j) => j.pid)).toEqual([105])
  })

  it('descendsFrom terminates on a ppid cycle', () => {
    const deps = world({ 300: { ppid: 301, start: '', state: 'S', cmdline: '' }, 301: { ppid: 300, start: '', state: 'S', cmdline: '' } })
    expect(descendsFrom(300, new Set([100]), deps)).toBe(false)
  })

  it('gateAlive: same pid AND start time AND still a gate', () => {
    expect(gateAlive(103, '4', world())).toBe(true)
    expect(gateAlive(103, '999', world())).toBe(false)                                   // pid reused
    expect(gateAlive(103, '4', world({ 103: null }))).toBe(false)                        // gone
    expect(gateAlive(103, '4', world({ 103: { ppid: 1, start: '4', state: 'Z', cmdline: GATE } }))).toBe(false)
    expect(gateAlive(103, '4', world({ 103: { ppid: 1, start: '4', state: 'S', cmdline: 'vim' } }))).toBe(false)
  })

  it('parseLockRecord: first occurrence wins, junk skipped', () => {
    expect(parseLockRecord('token=a pid=1 label=x pid=2 =junk noeq\n')).toEqual({ token: 'a', pid: '1', label: 'x' })
  })
})

describe('read errors are never "no job"', () => {
  it('a lock or queue read error other than ENOENT propagates', () => {
    const deps = world()
    const failing: HeavyJobDeps = { ...deps, readFile: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    expect(() => agentHeavyJobs([100], failing, PATHS)).toThrow('EACCES')
    const failingDir: HeavyJobDeps = { ...deps, listDir: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } }
    expect(() => agentHeavyJobs([100], failingDir, PATHS)).toThrow('EIO')
  })

  it('the live readers: missing -> null / [], any other error throws', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'heavy-read-'))
    try {
      expect(liveHeavyJobDeps.readFile(join(tmp, 'missing'))).toBeNull()
      expect(liveHeavyJobDeps.listDir(join(tmp, 'missing'))).toEqual([])
      expect(() => liveHeavyJobDeps.readFile(tmp)).toThrow()          // EISDIR
      writeFileSync(join(tmp, 'f'), 'x')
      expect(() => liveHeavyJobDeps.listDir(join(tmp, 'f'))).toThrow() // ENOTDIR
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('sessionPanePids', () => {
  it('asks for every window (-s) through the given invocation and parses the pids', () => {
    let seen: string[] = []
    const pids = sessionPanePids('agent-x', (args) => { seen = args; return { file: '/bin/sh', args: ['-c', 'echo 11; echo 12; echo junk'] } })
    expect(pids).toEqual([11, 12])
    expect(seen).toEqual(['list-panes', '-s', '-t', '=agent-x:', '-F', '#{pane_pid}'])
  })

  it('a failing or empty tmux answer -> null', () => {
    expect(sessionPanePids('x', () => ({ file: '/bin/sh', args: ['-c', 'exit 1'] }))).toBeNull()
    expect(sessionPanePids('x', () => ({ file: '/bin/sh', args: ['-c', 'true'] }))).toBeNull()
    expect(sessionPanePids('x', () => { throw new Error('no tmux') })).toBeNull()
  })
})

describe('the live /proc reader (Linux)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'heavy-owner-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it.runIf(process.platform === 'linux')('finds a real queued gate process that descends from the given root', async () => {
    // A stand-in gate: its argv carries the heavy-job-gate mark, like the real one.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'heavy-job-gate.py'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 150))
      const paths = heavyJobPaths(tmp, {})
      mkdirSync(paths.queueDir, { recursive: true })
      const info = liveHeavyJobDeps.proc(child.pid!)
      expect(info?.ppid).toBe(process.pid)
      writeFileSync(join(paths.queueDir, `00000000000000000001-${String(child.pid).padStart(10, '0')}.ticket`),
        JSON.stringify({ pid: child.pid, start: info!.start, label: 'real-q' }))
      expect(agentHeavyJobs([process.pid], liveHeavyJobDeps, paths)).toEqual([{ pid: child.pid, label: 'real-q', state: 'queued', start: info!.start }])
      expect(agentHeavyJobs([999999], liveHeavyJobDeps, paths)).toEqual([])
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('heavyJobPaths: the gate\'s own names and overrides', () => {
  it('defaults to <root>/store/.heavy-job.lock, .heavy-job-queue and heavy-job-log.jsonl', () => {
    expect(heavyJobPaths('/inst', {})).toEqual({
      lock: '/inst/store/.heavy-job.lock',
      queueDir: '/inst/store/.heavy-job-queue',
      log: '/inst/store/heavy-job-log.jsonl',
    })
  })

  it('HEAVY_JOB_STORE moves all three, like the gate', () => {
    expect(heavyJobPaths('/inst', { HEAVY_JOB_STORE: '/var/heavy' })).toEqual({
      lock: '/var/heavy/.heavy-job.lock',
      queueDir: '/var/heavy/.heavy-job-queue',
      log: '/var/heavy/heavy-job-log.jsonl',
    })
  })

  it('HEAVY_JOB_LOCK takes the queue with it unless HEAVY_JOB_QUEUE_DIR is set; HEAVY_JOB_LOG moves the log', () => {
    expect(heavyJobPaths('/inst', { HEAVY_JOB_LOCK: '/t/x.lock' })).toMatchObject({ lock: '/t/x.lock', queueDir: '/t/.heavy-job-queue' })
    expect(heavyJobPaths('/inst', { HEAVY_JOB_LOCK: '/t/x.lock', HEAVY_JOB_QUEUE_DIR: '/q' }).queueDir).toBe('/q')
    expect(heavyJobPaths('/inst', { HEAVY_JOB_LOG: '/l.jsonl' }).log).toBe('/l.jsonl')
  })

  it('an empty variable counts as unset (the gate: os.environ.get(name) or default)', () => {
    expect(heavyJobPaths('/inst', { HEAVY_JOB_STORE: '', HEAVY_JOB_LOCK: '' }).lock).toBe('/inst/store/.heavy-job.lock')
  })
})

// The contract with the real gate: its lock record and tickets are found under
// the names heavyJobPaths gives, and its process carries the gate mark. Runs
// the gate uncapped (HEAVY_JOB_NO_SCOPE=1 + --allow-uncapped) against a fake
// meminfo, so it needs neither a user manager nor free memory.
describe('the real scripts/heavy-job-gate.sh (Linux, python3)', () => {
  const GATE_SH = join(__dirname, '..', '..', 'scripts', 'heavy-job-gate.sh')
  const hasPython = (() => {
    try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
  })()
  // Killed here too, not only in the test's finally: a test that times out
  // never reaches its finally, and the uncapped gates would outlive the run.
  const spawned: Array<ReturnType<typeof spawn>> = []
  afterAll(() => { for (const c of spawned) c.kill('SIGKILL') })

  it.runIf(process.platform === 'linux' && hasPython && existsSync(GATE_SH))(
    'a running and a queued gate call of this process are found as its jobs, and are gone once stopped',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'heavy-contract-'))
      const meminfo = join(root, 'meminfo')
      writeFileSync(meminfo, 'MemTotal: 99999999 kB\nMemAvailable: 99999999 kB\n')
      const env: NodeJS.ProcessEnv & { HEAVY_JOB_STORE: string } = {
        ...process.env,
        HEAVY_JOB_STORE: join(root, 'store'),
        HEAVY_JOB_MEMINFO: meminfo,
        HEAVY_JOB_NO_SCOPE: '1',
        HEAVY_JOB_POLL_SEC: '0.1',
      }
      for (const k of ['HEAVY_JOB_LOCK', 'HEAVY_JOB_QUEUE_DIR', 'HEAVY_JOB_LOG']) delete env[k]
      mkdirSync(env.HEAVY_JOB_STORE, { recursive: true })
      const paths = heavyJobPaths(join(root, 'unused'), { HEAVY_JOB_STORE: env.HEAVY_JOB_STORE })
      const gate = (label: string) => {
        const c = spawn('bash', [GATE_SH, '--allow-uncapped', '--min-mb', '1', '--max-mem', '1M',
          '--wait-sec', '20', '--label', label, '--', 'sleep', '20'], { env, stdio: 'ignore' })
        spawned.push(c)
        return c
      }
      // at most 5 s per wait, three waits: inside the 30 s test timeout
      const until = async (cond: () => boolean) => {
        for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 100))
      }
      const first = gate('contract-run')
      let second: ReturnType<typeof spawn> | null = null
      try {
        await until(() => liveGatedJobs(liveHeavyJobDeps, paths).some((j) => j.state === 'running'))
        second = gate('contract-queued')
        await until(() => liveGatedJobs(liveHeavyJobDeps, paths).length >= 2)
        const jobs = agentHeavyJobs([process.pid], liveHeavyJobDeps, paths)
        expect(jobs.map((j) => [j.label, j.state, j.pid])).toEqual([
          ['contract-run', 'running', first.pid],
          ['contract-queued', 'queued', second.pid],
        ])
        for (const j of jobs) expect(gateAlive(j.pid, j.start, liveHeavyJobDeps)).toBe(true)
        expect(agentHeavyJobs([999999], liveHeavyJobDeps, paths)).toEqual([])
        first.kill('SIGTERM'); second.kill('SIGTERM')
        await until(() => jobs.every((j) => !gateAlive(j.pid, j.start, liveHeavyJobDeps)))
        for (const j of jobs) expect(gateAlive(j.pid, j.start, liveHeavyJobDeps)).toBe(false)
        expect(existsSync(paths.log)).toBe(true)
      } finally {
        first.kill('SIGKILL'); second?.kill('SIGKILL')
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
})

describe('parseProcStat: an unparsable stat is unmeasurable, never "no such process"', () => {
  const fields = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1)).join(' ')
  it('parses ppid, state and start time after the LAST ")" (comm may contain spaces and parens)', () => {
    // pid (comm) state ppid ... field 22 = start time
    const line = `123 (weird ) name) S 77 ${fields(17)} 9999 rest`
    expect(parseProcStat(line)).toEqual({ ppid: 77, state: 'S', start: '9999' })
  })
  it('throws on a truncated or garbled line', () => {
    expect(() => parseProcStat('123 (x) S 77 1 2')).toThrow(/unparsable/)
    expect(() => parseProcStat('garbage without parens')).toThrow(/unparsable/)
    expect(() => parseProcStat(`123 (x) S notanumber ${fields(20)}`)).toThrow(/unparsable/)
  })
})
