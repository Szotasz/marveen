import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'
import { buildRemoteTranscriptMtimeCommand, parseRemoteTranscriptMtime } from '../web/ssh-tmux.js'
import { decideTaskTimeout, probeTurnEvidence, TASK_FIRE_GRACE_MS } from '../web/schedule-runner.js'
import { readRemoteTranscriptMtime } from '../web/agent-process.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'

// REMOTESAWTURN1022: the post-fire watchdog's sawTurn probe is blind to a
// remote (ssh) agent.
//
// A remote agent's session writes its transcript on the remote host, but the
// in-flight entry carries a local workingDir/configDirs, that is, a
// ~/.claude/projects path that never receives a transcript. The transcript half
// of the probe therefore returned null on every sweep, and sawTurn could only
// come from a pane sample that happened to catch 'busy'. A fast remote round
// (a few seconds) ends between two sweeps, is judged 'lost' once the grace
// window has passed, and is re-injected, so it runs twice and the watchdog finally
// raises the "never started" give-up notice.
//
// The fix reads the transcript mtime on the remote host (one ssh call while no
// turn is seen yet), skew-corrected against the remote clock and conservative:
// the projected stamp is never later than the true write (local clock taken
// before the ssh call, one extra second for the whole-second truncation), so a
// write from before the injection can never pass for a turn.

const T0 = 1_792_695_851_686 // injectedAt of the fast-round examples in tests 8 and 17

type ProbeEntry = Pick<TaskInflightEntry, 'injectedAt' | 'sawTurn' | 'host' | 'workingDir' | 'configDirs'> & { remoteWorkdir?: string }

function remoteEntry(overrides: Partial<ProbeEntry> = {}): ProbeEntry {
  return {
    injectedAt: T0,
    sawTurn: false,
    host: 'agent@remote.example',
    workingDir: '/srv/app/agents/remote-agent',
    configDirs: [undefined],
    remoteWorkdir: '/home/agent',
    ...overrides,
  }
}

function localEntry(overrides: Partial<ProbeEntry> = {}): ProbeEntry {
  return {
    injectedAt: T0,
    sawTurn: false,
    host: null,
    workingDir: '/srv/app/agents/local-agent',
    configDirs: ['/srv/app/agents/local-agent/.claude-config'],
    ...overrides,
  }
}

describe('REMOTESAWTURN1022 parseRemoteTranscriptMtime: skew-corrected remote evidence', () => {
  it('1. maps the remote mtime onto the local clock via the remote "now" (remote clock 120 s behind)', () => {
    // Remote clock is 120 s behind ours. The turn ended 6 s after injection.
    const localBefore = T0 + 20_000
    const remoteNowS = Math.floor((localBefore - 120_000) / 1000)
    const remoteMtimeS = Math.floor((T0 + 6_000 - 120_000) / 1000)
    const est = parseRemoteTranscriptMtime(`${remoteNowS} ${remoteMtimeS}\n`, localBefore)
    expect(est).not.toBeNull()
    // conservative: never later than the true write, at most 2 s earlier
    expect(est as number).toBeLessThanOrEqual(T0 + 6_000)
    expect(est as number).toBeGreaterThanOrEqual(T0 + 4_000)
    expect(est as number).toBeGreaterThan(T0)
  })

  it('2. a remote clock ahead of ours does not fake evidence for an old write', () => {
    // Remote clock 300 s ahead; the newest transcript write was 60 s before injection.
    const localNow = T0 + 20_000
    const remoteNowS = Math.floor((localNow + 300_000) / 1000)
    const remoteMtimeS = Math.floor((T0 - 60_000 + 300_000) / 1000)
    const est = parseRemoteTranscriptMtime(`${remoteNowS} ${remoteMtimeS}`, localNow)
    expect(est).not.toBeNull()
    expect(est as number).toBeLessThan(T0)
  })

  it('3. no transcript / garbage / empty output is null, never a number', () => {
    const localNow = T0 + 20_000
    expect(parseRemoteTranscriptMtime(`${Math.floor(localNow / 1000)}`, localNow)).toBeNull()
    expect(parseRemoteTranscriptMtime('', localNow)).toBeNull()
    expect(parseRemoteTranscriptMtime('stat: cannot stat', localNow)).toBeNull()
    expect(parseRemoteTranscriptMtime('abc 123', localNow)).toBeNull()
    // an mtime in the remote future is a clock fault, not fresh evidence
    const nowS = Math.floor(localNow / 1000)
    expect(parseRemoteTranscriptMtime(`${nowS} ${nowS + 5}`, localNow)).toBeNull()
  })

  it('17. second boundary + ssh latency: a write 0.1 s before injection is never projected after it', () => {
    // Write at T0-0.1 s (whole second ...851), local clock read at T0+1.3 s
    // just before ssh, remote date at T0+1.31 s (whole second ...852): a naive
    // "localNow - diff*1000" gives T0+0.3 s, that is, a fake turn. The conservative
    // projection must stay <= the write.
    const localBefore = T0 + 1_300
    const remoteNowS = Math.floor((T0 + 1_310) / 1000)
    const remoteMtimeS = Math.floor((T0 - 100) / 1000)
    const est = parseRemoteTranscriptMtime(`${remoteNowS} ${remoteMtimeS}`, localBefore)
    expect(est).not.toBeNull()
    expect(est as number).toBeLessThanOrEqual(T0 - 100)
    // and a real turn (end 6.1 s after injection, probed at +20 s) still counts
    const est2 = parseRemoteTranscriptMtime(`${Math.floor((T0 + 20_000) / 1000)} ${Math.floor((T0 + 6_100) / 1000)}`, T0 + 20_000)
    expect(est2 as number).toBeGreaterThan(T0)
  })
})

describe('REMOTESAWTURN1022 buildRemoteTranscriptMtimeCommand: runs in a POSIX shell', () => {
  let home: string
  const WORKDIR = '/home/agent'

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'remote-saw-turn-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function run(cmd: string, pathPrefix = ''): string {
    // Executed exactly the way ssh hands it to the remote login shell: one
    // string, re-parsed by sh, with $HOME taken from the environment.
    const path = (pathPrefix ? pathPrefix + ':' : '') + (process.env.PATH ?? '/usr/bin:/bin')
    return execFileSync('sh', ['-c', cmd], { env: { PATH: path, HOME: home }, encoding: 'utf-8' })
  }

  function makeTranscriptDir(): string {
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(WORKDIR))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('4. prints "<now> <newest .jsonl mtime>" in epoch seconds for the encoded workdir dir', () => {
    const dir = makeTranscriptDir()
    const older = 1_792_000_000
    const newer = 1_792_695_857
    writeFileSync(join(dir, 'a.jsonl'), '{}\n')
    writeFileSync(join(dir, 'b.jsonl'), '{}\n')
    writeFileSync(join(dir, 'c.txt'), 'not a transcript\n')
    utimesSync(join(dir, 'a.jsonl'), older, older)
    utimesSync(join(dir, 'b.jsonl'), newer, newer)
    utimesSync(join(dir, 'c.txt'), newer + 500, newer + 500)
    const out = run(buildRemoteTranscriptMtimeCommand(WORKDIR)).trim()
    const parts = out.split(/\s+/)
    expect(parts).toHaveLength(2)
    expect(Math.abs(Number(parts[0]) - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(5)
    expect(Number(parts[1])).toBe(newer)
  })

  it('5. a missing transcript dir prints only "<now>" and exits 0 (parses to null)', () => {
    const out = run(buildRemoteTranscriptMtimeCommand(WORKDIR))
    expect(out.trim().split(/\s+/)).toHaveLength(1)
    expect(parseRemoteTranscriptMtime(out, Date.now())).toBeNull()
  })

  it('6. $HOME stays expandable and the encoded segment is single-quoted', () => {
    const cmd = buildRemoteTranscriptMtimeCommand(WORKDIR)
    expect(cmd).toContain('"$HOME/.claude/projects/"')
    expect(cmd).toContain(`'${encodeClaudeProjectDir(WORKDIR)}'`)
  })

  it('20. a BSD-only stat (rejects -c, answers -f %m) still yields the newest mtime', () => {
    // A macOS remote has no GNU stat. A fake stat first on PATH stands in for
    // it: any -c form fails, only `stat -f %m <file>` answers.
    const dir = makeTranscriptDir()
    writeFileSync(join(dir, 'a.jsonl'), '{}\n')
    const bin = join(home, 'fakebin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'stat'), '#!/bin/sh\nif [ "$1" = "-f" ] && [ "$2" = "%m" ]; then echo 1792695857; exit 0; fi\nexit 1\n')
    chmodSync(join(bin, 'stat'), 0o755)
    const parts = run(buildRemoteTranscriptMtimeCommand(WORKDIR), bin).trim().split(/\s+/)
    expect(parts).toHaveLength(2)
    expect(Number(parts[1])).toBe(1_792_695_857)
  })
})

describe('REMOTESAWTURN1022 probeTurnEvidence', () => {
  it('7. remote agent: evidence comes from the remote transcript and the local dir is not consulted', () => {
    const readLocal = vi.fn(() => null)
    const readRemote = vi.fn(() => T0 + 6_100)
    const r = probeTurnEvidence(remoteEntry(), 'idle', { readLocal, readRemote })
    expect(r.sawTurn).toBe(true)
    expect(r.mtimeSeen).toBe(T0 + 6_100)
    expect(readRemote).toHaveBeenCalledWith('agent@remote.example', '/home/agent')
    expect(readLocal).not.toHaveBeenCalled()
  })

  it('8. a fast remote round (6.1 s) judged at 41.6 s is done, not lost', () => {
    const e = { ...remoteEntry(), alerted: false, ownerAlerted: false, deliveryPending: false }
    const r = probeTurnEvidence(e, 'idle', { readLocal: () => null, readRemote: () => T0 + 6_100 })
    e.sawTurn = r.sawTurn
    const opts = { graceMs: TASK_FIRE_GRACE_MS, timeoutMs: 2_700_000, maxTrackMs: 6 * 3_600_000, ownerExtraMs: 75 * 60_000 }
    expect(decideTaskTimeout(e, 'idle', T0 + 41_594, opts)).toBe('done')
  })

  it('9. INVARIANT: a remote session that swallowed the prompt (no write after injection) is still lost', () => {
    const e = { ...remoteEntry(), alerted: false, ownerAlerted: false, deliveryPending: false }
    const r = probeTurnEvidence(e, 'idle', { readLocal: () => null, readRemote: () => T0 - 5_000 })
    expect(r.sawTurn).toBe(false)
    e.sawTurn = r.sawTurn
    const opts = { graceMs: TASK_FIRE_GRACE_MS, timeoutMs: 2_700_000, maxTrackMs: 6 * 3_600_000, ownerExtraMs: 75 * 60_000 }
    expect(decideTaskTimeout(e, 'idle', T0 + 41_594, opts)).toBe('lost')
  })

  it('10. INVARIANT: an unreachable remote (probe null) is no evidence and does not throw', () => {
    const r = probeTurnEvidence(remoteEntry(), 'idle', { readLocal: () => null, readRemote: () => null })
    expect(r).toEqual({ sawTurn: false, mtimeSeen: null })
  })

  it('11. INVARIANT: a remote entry without a remoteWorkdir falls back to "no evidence" and makes no ssh call', () => {
    const readRemote = vi.fn(() => T0 + 6_100)
    const r = probeTurnEvidence(remoteEntry({ remoteWorkdir: undefined }), 'idle', { readLocal: () => null, readRemote })
    expect(r.sawTurn).toBe(false)
    expect(readRemote).not.toHaveBeenCalled()
  })

  it('12. INVARIANT: a local agent keeps the local transcript probe and never calls ssh', () => {
    const readLocal = vi.fn(() => T0 + 2_000)
    const readRemote = vi.fn(() => null)
    const r = probeTurnEvidence(localEntry(), 'idle', { readLocal, readRemote })
    expect(r.sawTurn).toBe(true)
    expect(readLocal).toHaveBeenCalledWith('/srv/app/agents/local-agent', ['/srv/app/agents/local-agent/.claude-config'])
    expect(readRemote).not.toHaveBeenCalled()
  })

  it('13. INVARIANT: a busy pane is evidence without any transcript read; an already-seen turn probes nothing', () => {
    const readLocal = vi.fn(() => null)
    const readRemote = vi.fn(() => null)
    expect(probeTurnEvidence(remoteEntry(), 'busy', { readLocal, readRemote })).toEqual({ sawTurn: true, mtimeSeen: null })
    expect(probeTurnEvidence(remoteEntry({ sawTurn: true }), 'idle', { readLocal, readRemote })).toEqual({ sawTurn: true, mtimeSeen: null })
    expect(readLocal).not.toHaveBeenCalled()
    expect(readRemote).not.toHaveBeenCalled()
  })

  it('14. INVARIANT: a write exactly at injectedAt is not evidence (strictly after, as for local)', () => {
    expect(probeTurnEvidence(remoteEntry(), 'idle', { readLocal: () => null, readRemote: () => T0 }).sawTurn).toBe(false)
  })

  it('19. an unreachable host (pane capture null) costs no second ssh round trip per sweep', () => {
    const readRemote = vi.fn(() => T0 + 6_100)
    expect(probeTurnEvidence(remoteEntry(), null, { readLocal: () => null, readRemote })).toEqual({ sawTurn: false, mtimeSeen: null })
    expect(readRemote).not.toHaveBeenCalled()
  })
})

describe('REMOTESAWTURN1022 readRemoteTranscriptMtime: clock order, timeout, failure', () => {
  it('18. reads the local clock before the ssh call, bounds it at <= 3000 ms, and returns null on failure', () => {
    const order: string[] = []
    let seenTimeout = -1
    let seenFile = ''
    let seenArgs: string[] = []
    const r = readRemoteTranscriptMtime('agent@remote.example', '/home/agent', {
      now: () => { order.push('now'); return T0 + 20_000 },
      exec: (file, args, timeoutMs) => {
        order.push('exec'); seenFile = file; seenArgs = args; seenTimeout = timeoutMs
        return `${Math.floor((T0 + 20_000) / 1000)} ${Math.floor((T0 + 6_100) / 1000)}\n`
      },
    })
    expect(order).toEqual(['now', 'exec'])
    expect(seenTimeout).toBeGreaterThan(0)
    expect(seenTimeout).toBeLessThanOrEqual(3_000)
    expect(seenFile).toBe('ssh')
    expect(seenArgs).toContain('agent@remote.example')
    expect(seenArgs[seenArgs.length - 1]).toBe(buildRemoteTranscriptMtimeCommand('/home/agent'))
    expect(r as number).toBeGreaterThan(T0)
    const failed = readRemoteTranscriptMtime('agent@remote.example', '/home/agent', {
      now: () => T0,
      exec: () => { throw new Error('ssh: connect to host remote.example port 22: Operation timed out') },
    })
    expect(failed).toBeNull()
  })
})

describe('REMOTESAWTURN1022 wiring (fix-revert guards)', () => {
  const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it('15. the sweep takes sawTurn from probeTurnEvidence, not from an inline local-only read', () => {
    expect(src).toMatch(/probeTurnEvidence\(entry, state\)/)
    // the old inline local read inside the sweep must be gone (it was the blind spot)
    expect(src).not.toMatch(/lastMtimeSeen = readTranscriptMtimeAcrossConfigDirs\(entry\.workingDir, entry\.configDirs\)/)
  })

  it('16. the in-flight entry captures the remote workdir at injection time', () => {
    // the value written onto the entry when the task is injected, not just the interface field
    expect(src).toMatch(/remoteWorkdir: readAgentRemoteConfig\(agentName\)\.workdir/)
    // the 'lost' diagnostic names the probed remote dir, so a null mtime is
    // attributable (wrong dir vs unreachable host) from the log alone
    expect(src).toMatch(/remoteWorkdir: entry\.remoteWorkdir/)
  })
})
