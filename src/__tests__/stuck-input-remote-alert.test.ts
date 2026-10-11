import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// REMOTE agents were silent on every failure path (2026-10-11): a remote
// agent's give-up (3 bare Enters spent, input still parked) only logged, and a
// remote agent whose host was unreachable read as "not running" and was
// dropped without a word. These tests drive the REAL watcher loop with the I/O
// mocked: the remote give-up and a long blind spell must each reach the owner
// alert exactly once, a busy pane must defer it, a short ssh blip must not.

const io = vi.hoisted(() => ({
  agents: ['remo'] as string[],
  host: 'u@remote-host' as string | null,
  hosts: {} as Record<string, string | null>,   // per-agent host override
  localRecover: null as null | { parkedSig: string | null; firstSeenAt: number | null; lastRecoverAt: number | null; attempts: number },
  pending: [] as Array<{ agent: string; pending: number; oldestAgeSeconds: number }>,
  run: 'running' as 'running' | 'stopped' | 'unreachable',
  runs: {} as Record<string, 'running' | 'stopped' | 'unreachable'>,   // per-agent override
  parkedView: null as string | null,   // captureParkedInputView (ghostless)
  plainView: null as string | null,    // capturePane (plain)
  captureFails: false,
  failSessions: [] as string[],            // these sessions' capture fails (others read fine)
  throwSessions: [] as string[],           // these sessions' check THROWS
  captureHosts: [] as Array<string | null>,
  enters: [] as Array<{ session: string; host: string | null }>,
  alerts: [] as string[],
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'main' }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels' }))
vi.mock('../web/channel-mcp-reconnect.js', () => ({ resolveAgentSession: (n: string) => `agent-${n}` }))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => io.agents,
  readAgentRemoteHost: (n: string) => (n in io.hosts ? io.hosts[n] : io.host),
}))
vi.mock('../web/agent-process.js', () => ({
  agentRunState: (n: string) => io.runs[n] ?? io.run,
  captureParkedInputView: (session: string, host: string | null = null) => {
    if (session !== 'main-channels') io.captureHosts.push(host)
    if (io.throwSessions.includes(session)) throw new Error('capture boom')
    return session === 'main-channels' || io.captureFails || io.failSessions.includes(session) ? null : io.parkedView
  },
  capturePane: (session: string) =>
    session === 'main-channels' ? null : io.captureFails ? null : io.plainView,
  sendEnterToSession: (session: string, host: string | null) => { io.enters.push({ session, host }) },
}))
vi.mock('../db.js', () => ({ getPendingBacklogByAgent: () => io.pending }))
vi.mock('../web/channel-monitor.js', () => ({
  // MAIN goes through the local escalation; nothing parked there in these tests.
  recoverStuckInputForSession: async (session: string) =>
    session !== 'main-channels' && io.localRecover ? io.localRecover : ({ parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }),
  sendAlert: (text: string) => { io.alerts.push(text) },
}))

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const idleTail = ['● Done.', '', '✻ Worked for 23s']
const busyTail = ['● Working', '', '✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)']
const pane = (box: string, above: string[]) => [...above, SEP, box, SEP, FOOTER].join('\n')
const PARKED = pane('❯ TEAM MEMBER NOTICE -- a message that never got submitted', idleTail)

let watcher: typeof import('../web/stuck-input-watcher.js')
let timer: NodeJS.Timeout | null = null

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T08:30:00Z'))
  Object.assign(io, { agents: ['remo'], host: 'u@remote-host', hosts: {}, localRecover: null, pending: [], run: 'running', runs: {},
    parkedView: null, plainView: null, captureFails: false, failSessions: [], throwSessions: [], captureHosts: [], enters: [], alerts: [] })
  process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN = '5'

  vi.resetModules()
  watcher = await import('../web/stuck-input-watcher.js')
  timer = watcher.startStuckInputWatcher()
})

afterEach(() => {
  if (timer) clearInterval(timer)
  vi.useRealTimers()
})

const ticks = async (n: number) => {
  // the first sweep runs at +20s, then every 15s
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(15_000)
}

describe('remote give-up reaches the owner alert', () => {
  it('3 bare Enters on the remote host, then ONE alert naming the agent and host', async () => {
    io.parkedView = PARKED
    io.plainView = PARKED
    await ticks(14)
    expect(io.enters.length).toBe(3)
    expect(io.enters.every(e => e.host === 'u@remote-host')).toBe(true)
    expect(io.alerts.length).toBe(1)
    expect(io.alerts[0]).toContain('remo')
    expect(io.alerts[0]).toContain('u@remote-host')
    await ticks(10)
    expect(io.alerts.length).toBe(1) // once per spell
  })

  it('a BUSY pane defers the alert (RIASZTASZAJ819); the first idle tick fires it', async () => {
    io.parkedView = PARKED
    io.plainView = pane('❯ TEAM MEMBER NOTICE -- a message that never got submitted', busyTail)
    await ticks(14)
    expect(io.enters.length).toBe(3)
    expect(io.alerts.length).toBe(0)
    io.plainView = PARKED
    await ticks(1)
    expect(io.alerts.length).toBe(1)
  })

  it('the spell ending re-arms: a NEW parked spell alerts again', async () => {
    io.parkedView = PARKED
    io.plainView = PARKED
    await ticks(14)
    expect(io.alerts.length).toBe(1)
    io.parkedView = pane('❯ ', idleTail)
    io.plainView = io.parkedView
    await ticks(2)
    io.parkedView = pane('❯ TEAM MEMBER NOTICE -- a second message, also stuck', idleTail)
    io.plainView = io.parkedView
    await ticks(14)
    expect(io.alerts.length).toBe(2)
  })

  it('a LOCAL agent is never read over ssh (every capture with host null) -- the local path is untouched', async () => {
    io.host = null
    io.parkedView = pane('❯ ', idleTail)
    await ticks(5)
    expect(io.captureHosts.length).toBeGreaterThan(0)
    expect(io.captureHosts.every(h => h === null)).toBe(true)
  })

  it('the SAME text parked again after a proven-empty box is a new spell -> alerts again', async () => {
    io.parkedView = PARKED
    io.plainView = PARKED
    await ticks(14)
    expect(io.alerts.length).toBe(1)
    io.parkedView = pane('❯ ', idleTail)
    io.plainView = io.parkedView
    await ticks(2)
    io.parkedView = PARKED
    io.plainView = PARKED
    await ticks(14)
    expect(io.alerts.length).toBe(2)
  })

  it('a LOCAL agent never takes the remote path: its give-up uses the LOCAL alert, no remote text, no remote Enters', async () => {
    io.host = null
    io.parkedView = PARKED
    io.plainView = PARKED
    io.localRecover = { parkedSig: 'p', firstSeenAt: 1, lastRecoverAt: 1, attempts: 5 }
    await ticks(3)
    expect(io.alerts.length).toBe(1)                       // the local alert did fire (the test can fail)
    expect(io.alerts[0]).not.toContain('távoli')
    expect(io.enters.length).toBe(0)                       // bare remote Enters were never sent
  })

  it('an ssh blip (1 tick unreachable / capture null) does NOT re-alert the SAME parked text', async () => {
    io.parkedView = PARKED
    io.plainView = PARKED
    await ticks(14)
    expect(io.alerts.length).toBe(1)
    io.run = 'unreachable'
    await ticks(1)
    io.run = 'running'
    io.captureFails = true
    await ticks(1)
    io.captureFails = false
    await ticks(14)
    expect(io.alerts.length).toBe(1)
  })

  it('a parked PASTE placeholder that 3 Enters do not submit alerts too', async () => {
    const paste = pane('❯ [Pasted text #1 +42 lines]', idleTail)
    io.parkedView = paste
    io.plainView = paste
    await ticks(14)
    expect(io.enters.length).toBe(3)
    expect(io.alerts.length).toBe(1)
    expect(io.alerts[0]).toContain('remo')
  })
})

describe('a remote HOST the watcher cannot see alerts once -- only with messages waiting', () => {
  it('host unreachable 5+ min WITH a waiting message -> ONE alert; none before the window', async () => {
    io.run = 'unreachable'
    io.pending = [{ agent: 'remo', pending: 2, oldestAgeSeconds: 600 }]
    await ticks(19) // 20s + 18*15s = 290s of blindness: under the 5 min window
    expect(io.alerts.length).toBe(0)
    await ticks(2)
    expect(io.alerts.length).toBe(1)
    expect(io.alerts[0]).toContain('remo')
    expect(io.alerts[0]).toContain('u@remote-host')
    expect(io.alerts[0]).toContain('2 bejövő')
    await ticks(20)
    expect(io.alerts.length).toBe(1)
  })

  it('a sleeping laptop with NOTHING waiting never alerts; the first waiting message then does', async () => {
    io.run = 'unreachable'
    await ticks(30)
    expect(io.alerts.length).toBe(0)
    io.pending = [{ agent: 'remo', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(1)
    expect(io.alerts.length).toBe(1)
  })

  it('N agents on ONE blind host -> ONE alert naming them all', async () => {
    io.agents = ['remo', 'remo2']
    io.run = 'unreachable'
    io.pending = [{ agent: 'remo2', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(22)
    expect(io.alerts.length).toBe(1)
    expect(io.alerts[0]).toContain('remo, remo2')
  })

  it('one READABLE agent on a host does not hide ANOTHER agent whose capture keeps failing (per-agent clock)', async () => {
    io.agents = ['remo', 'remo2']
    io.parkedView = pane('❯ ', idleTail)
    io.plainView = io.parkedView
    io.failSessions = ['agent-remo2']
    io.pending = [{ agent: 'remo2', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(22)
    expect(io.alerts.length).toBe(1)
    expect(io.alerts[0]).toContain('remo2')
    expect(io.alerts[0]).not.toContain('remo, remo2')
  })

  it('one agent answering on the host proves it reachable: another agent marked unreachable in the same sweep does not run the host clock', async () => {
    io.agents = ['remo', 'remo2']
    io.runs = { remo: 'unreachable' }
    io.parkedView = pane('❯ ', idleTail)
    io.plainView = io.parkedView
    io.pending = [{ agent: 'remo', pending: 2, oldestAgeSeconds: 60 }]
    await ticks(30)
    expect(io.alerts.length).toBe(0)
  })

  it('a check that keeps THROWING still reaches the blind clock (alerts, does not drop out of it)', async () => {
    io.throwSessions = ['agent-remo']
    io.pending = [{ agent: 'remo', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(22)
    expect(io.alerts.length).toBe(1)
  })

  it('MARVEEN_REMOTE_BLIND_ALERT_MIN=0 turns the blind alert off', async () => {
    if (timer) clearInterval(timer)
    process.env.MARVEEN_REMOTE_BLIND_ALERT_MIN = '0'
    vi.resetModules()
    watcher = await import('../web/stuck-input-watcher.js')
    timer = watcher.startStuckInputWatcher()
    io.run = 'unreachable'
    io.pending = [{ agent: 'remo', pending: 3, oldestAgeSeconds: 600 }]
    await ticks(40)
    expect(io.alerts.length).toBe(0)
  })

  it('pane capture failing on a running remote agent counts as blind too', async () => {
    io.captureFails = true
    io.pending = [{ agent: 'remo', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(22)
    expect(io.alerts.length).toBe(1)
  })

  it('a short ssh blip (readable again inside the window) never alerts, and resets the clock', async () => {
    io.run = 'unreachable'
    io.pending = [{ agent: 'remo', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(15)
    io.run = 'running'
    io.parkedView = pane('❯ ', idleTail)
    io.plainView = io.parkedView
    await ticks(1)
    io.run = 'unreachable'
    await ticks(15)
    expect(io.alerts.length).toBe(0)
  })

  it('a STOPPED remote agent is not "blind" (no alert)', async () => {
    io.run = 'stopped'
    io.pending = [{ agent: 'remo', pending: 1, oldestAgeSeconds: 60 }]
    await ticks(30)
    expect(io.alerts.length).toBe(0)
  })
})

describe('decideUnreadableAlert (pure)', () => {
  it('alerts once at the window, re-arms only after a readable tick', async () => {
    const { decideUnreadableAlert, NO_UNREADABLE } = watcher
    let s = NO_UNREADABLE
    let r = decideUnreadableAlert(s, false, 0, 1000); expect(r.alert).toBe(false); s = r.next
    r = decideUnreadableAlert(s, false, 999, 1000); expect(r.alert).toBe(false); s = r.next
    r = decideUnreadableAlert(s, false, 1000, 1000); expect(r.alert).toBe(true); s = r.next
    r = decideUnreadableAlert(s, false, 5000, 1000); expect(r.alert).toBe(false); s = r.next
    r = decideUnreadableAlert(s, true, 5001, 1000); expect(r.alert).toBe(false); expect(r.next).toEqual(NO_UNREADABLE); s = r.next
    r = decideUnreadableAlert(s, false, 6000, 1000); expect(r.alert).toBe(false); s = r.next
    r = decideUnreadableAlert(s, false, 7000, 1000); expect(r.alert).toBe(true)
  })
})
