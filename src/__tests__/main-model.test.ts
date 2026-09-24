import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setModel,
  modelBack,
  setEffort,
  sweepModelHold,
  readModelChoices,
  readHold,
  writeHold,
  parseHold,
  parseModelArgs,
  windowWarning,
  _resetMainModelForTest,
  countModelAcks,
  lastRejectionMessage,
  lastModelAck,
  modelSupportsEffort,
  readLastSent,
  onMainTurnEnded,
  effortSentFileFor,
  readEffortSent,
  scheduleHoldExpiry,
  BLOCK_ALERT_MS,
  type ModelDeps,
  type HoldState,
} from '../web/main-model.js'
import { measuredModelLines, effortLine, modelSummary, modelStateLine, registerBuiltinCommands, type ModelSummaryInput } from '../web/builtin-commands.js'
import { resolveCommand, clearCommandsForTest } from '../web/commands.js'
import { logger } from '../logger.js'
// Expected clock strings are built with the app's own formatter: CI runs in
// UTC, a hard-coded "14:52" only held in Budapest time.
import { formatDayClock } from '../web/system-status.js'

const BASE = 'claude-sonnet-5'
const T0 = Date.parse('2026-09-22T08:00:00Z')

let dir: string

function deps(over: Partial<ModelDeps> = {}, opts: { noAck?: boolean; reject?: string } = {}) {
  const sent: string[] = []
  const notes: string[] = []
  const env: Array<Record<string, string>> = []
  const expiries: Array<number | null> = []
  let now = T0
  let acks = 3 // older "Set model to" lines already on the pane
  let pane = 'API error: 529 {"type":"error","error":{"message":"old, overloaded"}}\n'
  const d: ModelDeps & { sent: string[]; notes: string[]; env: typeof env; expiries: typeof expiries; setNow(n: number): void } = {
    sent, notes, env, expiries,
    setNow(n: number) { now = n },
    now: () => now,
    choicesFile: join(dir, 'model-choices.json'),
    holdFile: join(dir, 'main-model-hold.json'),
    lastSentFile: join(dir, 'main-model-last-sent.json'),
    configured: () => BASE,
    measured: () => BASE,
    quiet: () => ({ quiet: true }),
    // The fake CLI prints its "Set model to" line for every /model it gets.
    send: async (c) => {
      sent.push(c)
      if (!c.startsWith('/model')) return
      if (opts.reject) pane += `❯ ${c}\n  ⎿  API error: 400\n     {"type":"error","error":{"type":"invalid_request_error","message":"${opts.reject}"}}\n`
      else if (!opts.noAck) acks++
    },
    pane: () => pane,
    writeEnv: (u) => { env.push(u) },
    notify: async (t) => { notes.push(t); return true },
    autoCompactWindow: () => null,
    configuredEffort: () => null,
    ackCount: () => acks,
    sleep: async () => {},
    scheduleExpiry: (u) => { expiries.push(u) },
    ...over,
  }
  return d
}

function writeChoices() {
  writeFileSync(join(dir, 'model-choices.json'), JSON.stringify({
    opus: { id: 'claude-opus-5[1m]', purpose: 'nehéz munka', default_hold_minutes: 120 },
    haiku: { id: 'claude-haiku-4-5-20251001', purpose: 'olcsó', default_hold_minutes: 60 },
  }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'main-model-'))
  _resetMainModelForTest()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('/model set (CMD920 tests 5, 6)', () => {
  it('an off-list model is refused and nothing is sent', async () => {
    writeChoices()
    const d = deps()
    const r = await setModel(['gpt-5'], d)
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/Nem értem: „gpt-5”.*Modell: opus, haiku/)
    expect(d.sent).toEqual([])
  })

  it("a choice file carrying ' or ; in an id is refused as a whole (shell-injection regression)", async () => {
    writeFileSync(join(dir, 'model-choices.json'), JSON.stringify({ evil: { id: "claude-opus-5'; rm -rf /" } }))
    const d = deps()
    const r = await setModel(['evil'], d)
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/választék olvashatatlan/)
    expect(d.sent).toEqual([])
    expect(() => readModelChoices(join(dir, 'model-choices.json'), BASE)).toThrow(/érvénytelen/)
  })

  it('temporary switch: hold file written with revert target and expiry, .env NOT written', async () => {
    writeChoices()
    const d = deps()
    const r = await setModel(['opus'], d)
    expect(r.ok).toBe(true)
    expect(d.sent).toEqual(['/model claude-opus-5[1m]'])
    expect(d.env).toEqual([])
    const h = readHold(d.holdFile).state!
    expect(h).toMatchObject({ model: 'claude-opus-5[1m]', revert_to: BASE, until: T0 + 120 * 60_000, verify_pending: true })
    expect(r.text).toMatch(/Ideiglenes: \d\d:\d\d-ig \(2 óra\), utána vissza: claude-sonnet-5\./)
  })

  it('custom hold: 30m and 4h; "set" is optional', async () => {
    writeChoices()
    const d = deps()
    await setModel(['set', 'opus', '30m'], d)
    expect(readHold(d.holdFile).state!.until).toBe(T0 + 30 * 60_000)
    await setModel(['opus', '4h'], d)
    expect(readHold(d.holdFile).state!.until).toBe(T0 + 4 * 3600_000)
    expect(parseHold('abc')).toBeNull()
    expect(parseHold('0m')).toBeNull()
  })

  it('keep: .env MAIN_AGENT_MODEL written, no hold state', async () => {
    writeChoices()
    const d = deps()
    writeHold(d.holdFile, { model: 'x', name: 'x', revert_to: BASE, until: T0 + 1, set_at: T0, effort: null, revert_effort: null, verify_pending: false, blocked_since: null, block_alert_at: null })
    const r = await setModel(['opus', 'keep'], d)
    expect(r.ok).toBe(true)
    expect(d.env).toEqual([{ MAIN_AGENT_MODEL: 'claude-opus-5[1m]' }])
    expect(existsSync(d.holdFile)).toBe(false)
  })

  it('keep replaces the existing .env line, it does not duplicate it (real updateEnvFile)', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'env-'))
    writeFileSync(join(envDir, '.env'), 'FOO=1\nMAIN_AGENT_MODEL=claude-sonnet-5\nBAR=2\n')
    const saved = process.env.CLAUDECLAW_ENV_DIR
    process.env.CLAUDECLAW_ENV_DIR = envDir
    try {
      vi.resetModules()
      const { updateEnvFile } = await import('../env.js')
      writeChoices()
      await setModel(['opus', 'keep'], deps({ writeEnv: updateEnvFile }))
      const lines = readFileSync(join(envDir, '.env'), 'utf-8').split('\n').filter(Boolean)
      expect(lines.filter(l => l.startsWith('MAIN_AGENT_MODEL='))).toEqual(['MAIN_AGENT_MODEL=claude-opus-5[1m]'])
      expect(lines).toContain('FOO=1')
      expect(lines).toContain('BAR=2')
    } finally {
      if (saved === undefined) delete process.env.CLAUDECLAW_ENV_DIR
      else process.env.CLAUDECLAW_ENV_DIR = saved
      rmSync(envDir, { recursive: true, force: true })
    }
  })

  it('busy session: nothing sent, no state, the reply points to /runs', async () => {
    writeChoices()
    const d = deps({ quiet: () => ({ quiet: false, reason: 'pane-busy' }) })
    const r = await setModel(['opus'], d)
    expect(r.ok).toBe(false)
    expect(r.text).toBe('Nem váltottam: a session épp dolgozik.')
    expect(r.busy).toBe(true)   // the caller queues it for the end of the turn
    expect(d.sent).toEqual([])
    expect(existsSync(d.holdFile)).toBe(false)
  })

  it('missing model-choices.json: the only choice is the configured model, and the reply says so', async () => {
    const d = deps()
    const r = await setModel(['opus'], d)
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/model-choices\.json hiányzik, csak a konfigurált modell/)
    expect(readModelChoices(d.choicesFile, BASE)).toEqual({ choices: [{ name: BASE, id: BASE, defaultHoldMinutes: 120 }], fromFile: false })
  })
})

// ELSOKOR922 Phase 7, owner decision 2026-09-22: one order-free line instead
// of a separate /model effort form (nothing had shipped, so no compat debt).
describe('/model: one line, model and/or effort and/or time', () => {
  const list = () => readModelChoices(join(dir, 'model-choices.json'), BASE)

  it('parses any order, and each part at most once', () => {
    writeChoices()
    expect(parseModelArgs(['opus', 'low', '4m'], list())).toMatchObject({ effort: 'low', hold: 4 })
    expect(parseModelArgs(['4m', 'low', 'opus'], list())).toMatchObject({ effort: 'low', hold: 4 })
    expect(parseModelArgs(['set', 'opus'], list())).toMatchObject({ effort: null, hold: undefined })
    expect(parseModelArgs(['low', '5m'], list())).toMatchObject({ choice: null, effort: 'low', hold: 5 })
    expect(parseModelArgs(['opus', 'keep'], list())).toMatchObject({ hold: 'keep' })
    expect(parseModelArgs(['opus', 'haiku'], list())).toMatch(/Kétszer adtál meg modellt/)
    expect(parseModelArgs(['low', 'high'], list())).toMatch(/Kétszer adtál meg effortot/)
    expect(parseModelArgs(['4m', '5m'], list())).toMatch(/Kétszer adtál meg időt/)
    expect(parseModelArgs(['gpt-5'], list())).toMatch(/Nem értem: „gpt-5”/)
    expect(parseModelArgs(['30m'], list())).toMatch(/adj meg modellt vagy effortot/)
    expect(parseModelArgs([], list())).toMatch(/^Használat: \/model/)
  })

  it('model + effort + time: both sent, both held, both put back at expiry', async () => {
    writeChoices()
    const d = deps({ configuredEffort: () => 'medium', measured: () => 'claude-opus-5' })
    const r = await setModel(['opus', 'low', '4m'], d)
    expect(r.ok).toBe(true)
    expect(d.sent).toEqual(['/model claude-opus-5[1m]', '/effort low'])
    expect(r.text).toMatch(/\nEffort: low\.\n/)
    expect(r.text).toMatch(/utána vissza: claude-sonnet-5, effort medium\./)
    expect(readHold(d.holdFile).state).toMatchObject({ model: 'claude-opus-5[1m]', effort: 'low', revert_effort: 'medium', until: T0 + 4 * 60_000 })
    expect(await sweepModelHold(T0 + 5 * 60_000, d)).toBe('reverted')
    expect(d.sent).toEqual(['/model claude-opus-5[1m]', '/effort low', `/model ${BASE}`, '/effort medium'])
    expect(d.notes[0]).toMatch(/A tartás lejárt: visszaváltva .* · effort vissza: medium/)
  })

  it('effort only: no model is sent, and the hold reverts just the effort', async () => {
    writeChoices()
    const d = deps({ configuredEffort: () => 'medium' })
    await setModel(['low', '5m'], d)
    expect(d.sent).toEqual(['/effort low'])
    expect(readHold(d.holdFile).state).toMatchObject({ model: null, revert_to: null, effort: 'low', revert_effort: 'medium' })
    expect(await sweepModelHold(T0 + 6 * 60_000, d)).toBe('reverted')
    expect(d.sent).toEqual(['/effort low', '/effort medium'])
  })

  // Owner feedback 2026-09-24: "the effort stays high after /model default".
  // Claude Code 2.1.110 has `/effort auto` (its own default, measured in the
  // binary), so a hold with no configured effort now goes back to auto.
  it('no configured effort: the hold goes back to the CLI default (auto)', async () => {
    writeChoices()
    const d = deps() // configuredEffort: () => null
    const r = await setModel(['low', '5m'], d)
    expect(r.text).toMatch(/utána vissza: effort alap \(auto\)/)
    expect(readHold(d.holdFile).state?.revert_effort).toBe('auto')
    expect(await sweepModelHold(T0 + 6 * 60_000, d)).toBe('reverted')
    expect(d.sent).toEqual(['/effort low', '/effort auto'])
    expect(d.notes[0]).toMatch(/effort vissza: alap \(auto\)/)
  })

  it('a hold written before the auto fallback (revert_effort null) also goes back to auto', async () => {
    writeChoices()
    const d = deps()
    writeHold(d.holdFile, { model: null, name: 'high', revert_to: null, effort: 'high', revert_effort: null,
      until: T0 - 1, set_at: T0 - 60_000, verify_pending: false, blocked_since: null, block_alert_at: null })
    const r = await modelBack(d)
    expect(d.sent).toEqual(['/effort auto'])
    expect(r.text).toBe('Effort vissza: alap (auto).')
  })

  it('/model default puts back the model and the held effort', async () => {
    writeChoices()
    const d = deps({ configuredEffort: () => 'medium', measured: () => 'claude-opus-5' })
    await setModel(['opus', 'low', '4m'], d)
    const r = await modelBack(d)
    expect(r.ok).toBe(true)
    expect(d.sent).toEqual(['/model claude-opus-5[1m]', '/effort low', `/model ${BASE}`, '/effort medium'])
    expect(existsSync(d.holdFile)).toBe(false)
  })
})

describe('/model window warning (CMD920 test 9)', () => {
  it('a smaller window than autoCompactWindow warns; a 1M model does not', async () => {
    expect(windowWarning('claude-haiku-4-5-20251001', 300_000)).toMatch(/Figyelem.*200k.*300k/)
    expect(windowWarning('claude-opus-5[1m]', 300_000)).toBeNull()
    expect(windowWarning('claude-haiku-4-5-20251001', null)).toBeNull()
    writeChoices()
    const r = await setModel(['haiku'], deps({ autoCompactWindow: () => 300_000 }))
    expect(r.text).toMatch(/Figyelem: a\(z\) claude-haiku-4-5-20251001 kontextus-ablaka/)
  })
})

describe('hold sweep (CMD920 tests 7, 8)', () => {
  const hold = (over: Partial<HoldState> = {}): HoldState => ({
    model: 'claude-opus-5[1m]', name: 'opus', revert_to: BASE, until: T0 + 60_000, set_at: T0,
    effort: null, revert_effort: null, verify_pending: false, blocked_since: null, block_alert_at: null, ...over,
  })

  it('before expiry nothing happens', async () => {
    const d = deps({ measured: () => 'claude-opus-5' })
    writeHold(d.holdFile, hold())
    expect(await sweepModelHold(T0 + 1000, d)).toBe('waiting')
    expect(d.sent).toEqual([])
  })

  it('after expiry on a quiet session: /model <base>, state removed, owner notified', async () => {
    const d = deps({ measured: () => 'claude-opus-5' })
    writeHold(d.holdFile, hold())
    expect(await sweepModelHold(T0 + 61_000, d)).toBe('reverted')
    expect(d.sent).toEqual([`/model ${BASE}`])
    expect(existsSync(d.holdFile)).toBe(false)
    expect(d.notes[0]).toMatch(/lejárt: visszaváltva claude-opus-5\[1m\] -> claude-sonnet-5/)
  })

  it('busy at expiry: keeps the state and waits; after 30 min it alerts ONCE', async () => {
    const d = deps({ measured: () => 'claude-opus-5', quiet: () => ({ quiet: false, reason: 'pane-busy' }) })
    writeHold(d.holdFile, hold())
    expect(await sweepModelHold(T0 + 61_000, d)).toBe('blocked')
    expect(readHold(d.holdFile).state!.blocked_since).toBe(T0 + 61_000)
    expect(await sweepModelHold(T0 + 61_000 + BLOCK_ALERT_MS, d)).toBe('block-alerted')
    expect(d.notes).toHaveLength(1)
    expect(d.notes[0]).toMatch(/perce foglalt \(épp dolgozik\)/)
    expect(await sweepModelHold(T0 + 61_000 + 2 * BLOCK_ALERT_MS, d)).toBe('blocked')
    expect(d.notes).toHaveLength(1)
    expect(d.sent).toEqual([])
  })

  it('respawn already on the base model: only clears, sends nothing', async () => {
    const d = deps({ measured: () => 'claude-sonnet-5' })
    writeHold(d.holdFile, hold())
    expect(await sweepModelHold(T0 + 61_000, d)).toBe('cleared-already-base')
    expect(d.sent).toEqual([])
    expect(existsSync(d.holdFile)).toBe(false)
  })

  // ELSOKOR922 Phase 7 A-smoke: no turn ran during a 3-minute hold, so the
  // newest line was the PRE-switch sonnet turn; the sweep read it as "respawn,
  // base already running", cleared the hold without sending, and opus stayed.
  it('no turn since the switch: a stale base-model line is NOT a respawn -- the revert is sent', async () => {
    const d = deps({ measured: (since) => (since === undefined ? BASE : null) })
    writeHold(d.holdFile, hold())
    expect(await sweepModelHold(T0 + 61_000, d)).toBe('reverted')
    expect(d.sent).toEqual([`/model ${BASE}`])
  })

  it('dashboard restart during the hold: a fresh process picks the expiry up from the file', async () => {
    const first = deps()
    writeChoices()
    await setModel(['opus', '30m'], first)
    // "restart": new deps object, nothing in memory, only the file survives
    const second = deps({ measured: () => 'claude-opus-5' })
    expect(await sweepModelHold(T0 + 31 * 60_000, second)).toBe('reverted')
    expect(second.sent).toEqual([`/model ${BASE}`])
  })

  it('corrupt hold file: a log line, no switch, nothing guessed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const d = deps({ measured: () => 'claude-opus-5' })
    writeFileSync(d.holdFile, '{broken')
    expect(await sweepModelHold(T0 + 10 * 3600_000, d)).toBe('corrupt')
    expect(await sweepModelHold(T0 + 11 * 3600_000, d)).toBe('corrupt')
    expect(d.sent).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(existsSync(d.holdFile)).toBe(true)
  })

  it('verification from measurement: the next assistant model confirms, or the mismatch is reported', async () => {
    const ok = deps({ measured: () => 'claude-opus-5' })
    writeHold(ok.holdFile, hold({ verify_pending: true }))
    expect(await sweepModelHold(T0 + 1000, ok)).toBe('verified')
    // the switch reply already carried the CLI's acknowledgement: a matching
    // measurement is not sent again, only a mismatch is
    expect(ok.notes).toEqual([])
    expect(readHold(ok.holdFile).state!.verify_pending).toBe(false)

    const bad = deps({ measured: () => 'claude-sonnet-4-6' })
    writeHold(bad.holdFile, hold({ verify_pending: true }))
    expect(await sweepModelHold(T0 + 1000, bad)).toBe('mismatch')
    expect(bad.notes[0]).toMatch(/Figyelem: a váltás után claude-sonnet-4-6 fut/)
  })

  it('no transcript line after the switch yet: verification stays pending', async () => {
    const d = deps({ measured: () => null })
    writeHold(d.holdFile, hold({ verify_pending: true }))
    expect(await sweepModelHold(T0 + 1000, d)).toBe('waiting')
    expect(readHold(d.holdFile).state!.verify_pending).toBe(true)
  })
})

// ELSOKOR922 Phase 7 A-smoke findings: a switch said only "elküldve"; a
// 3-minute hold reverted on the 5-minute sweep; after the revert /model still
// read the pre-revert turn and warned "eltér".
describe('/model acknowledgement, exact expiry, stale measurement', () => {
  it("the CLI's own 'Set model to' line turns the reply into 'Átváltva'", async () => {
    writeChoices()
    const r = await setModel(['opus', '3m'], deps())
    expect(r.text).toMatch(/^Átváltva: opus\.\nIdeiglenes: .*-ig \(3 perc\)/)
  })

  it('no acknowledgement seen: the reply stays the cautious "elküldve", never "Átváltva"', async () => {
    writeChoices()
    const r = await setModel(['opus', '3m'], deps({}, { noAck: true }))
    expect(r.text).toMatch(/^Elküldve: opus \(a Claude Code még nem igazolta vissza\)/)
    expect(r.text).not.toMatch(/Átváltva/)
    const blind = await setModel(['opus', '3m'], deps({ ackCount: () => null }))
    expect(blind.text).toMatch(/^Elküldve: opus/)
  })

  it('a hold arms the one-shot expiry timer at `until`; keep and back disarm it', async () => {
    writeChoices()
    const d = deps()
    await setModel(['opus', '3m'], d)
    expect(d.expiries).toEqual([T0 + 3 * 60_000])
    await setModel(['opus', 'keep'], d)
    await modelBack(deps({ measured: () => 'claude-opus-5' }))
    expect(d.expiries.at(-1)).toBeNull()
  })

  it('every sent /model is recorded with its time (the status names it as not yet measured)', async () => {
    writeChoices()
    const d = deps()
    await setModel(['opus', '3m'], d)
    expect(readLastSent(d.lastSentFile)).toEqual({ model: 'claude-opus-5[1m]', at: T0, acked: true })
    const blind = deps({}, { noAck: true })
    await setModel(['opus', '3m'], blind)
    expect(readLastSent(blind.lastSentFile)!.acked).toBe(false)
  })

  it('the expiry revert reports the acknowledgement too', async () => {
    writeChoices()
    const d = deps({ measured: () => 'claude-opus-5' })
    writeHold(d.holdFile, { model: 'claude-opus-5[1m]', name: 'opus', revert_to: BASE, until: T0 + 60_000, set_at: T0, effort: null, revert_effort: null, verify_pending: false, blocked_since: null, block_alert_at: null })
    expect(await sweepModelHold(T0 + 61_000, d)).toBe('reverted')
    expect(d.notes[0]).toMatch(/^A tartás lejárt: visszaváltva opus -> claude-sonnet-5\.$/)
    expect(d.expiries).toEqual([null])
  })

  it('a late acknowledgement (the CLI prints ~1 s after the send) is still caught within the bound', async () => {
    writeChoices()
    let acks = 0, reads = 0
    const d = deps({
      send: async () => {},
      ackCount: () => { reads++; if (reads === 5) acks++; return acks }, // appears on the 4th read after the send
    })
    const r = await setModel(['opus', '3m'], d)
    expect(r.text).toMatch(/^Átváltva/)
  })

  it('turn ended after an expiry the session was busy for: one retry armed; an unexpired hold arms nothing', () => {
    const file = join(dir, 'main-model-hold.json')
    writeHold(file, { model: 'claude-opus-5[1m]', name: 'opus', revert_to: BASE, until: T0 + 60_000, set_at: T0, effort: null, revert_effort: null, verify_pending: false, blocked_since: T0 + 61_000, block_alert_at: null })
    try {
      expect(onMainTurnEnded(T0 + 30_000, file)).toBe(false)
      expect(onMainTurnEnded(T0 + 90_000, file)).toBe(true)
      expect(onMainTurnEnded(T0 + 90_000, join(dir, 'none.json'))).toBe(false)
    } finally { scheduleHoldExpiry(null) }
  })

  it('countModelAcks matches only the prefix (two CLI builds print it differently)', () => {
    expect(countModelAcks('❯ /model x\n  ⎿  Set model to claude-opus-5[1m]\n  ⎿  Set model to `Opus 5 (1M context)`')).toBe(2)
    expect(countModelAcks(null)).toBeNull()
  })
})

describe('/model status: the measurement is shown with its age', () => {
  const at1447 = Date.parse('2026-09-22T12:47:00Z')
  const at1452 = Date.parse('2026-09-22T12:52:00Z')

  // Owner feedback: "Átváltva" next to a "Most fut" naming the pre-switch model
  // read as a contradiction -- a CLI-confirmed switch after the last turn IS
  // what runs now; only an unconfirmed send keeps the old reading.
  it('a CLI-confirmed switch after the last turn: "Most fut" names the new model, no "Azóta" line', () => {
    const r = measuredModelLines({ model: 'claude-sonnet-5', atMs: at1447 }, { model: 'claude-opus-5[1m]', at: at1452, acked: true }, 'claude-opus-5[1m]', BASE)
    expect(r.head).toHaveLength(1)
    expect(r.head[0]).toBe(`Most fut: claude-opus-5[1m] (váltva ${formatDayClock(at1452)}, a Claude Code visszaigazolta; rajta még nem futott kör)`)
    expect(r.warn).toBeNull()
  })

  it('an unconfirmed send after the last turn: the old reading stays, the send is named, no false "eltér"', () => {
    const r = measuredModelLines({ model: 'claude-opus-5', atMs: at1447 }, { model: BASE, at: at1452, acked: false }, null, BASE)
    expect(r.head[0]).toBe(`Most fut: claude-opus-5 (utolsó kör ${formatDayClock(at1447)})`)
    expect(r.head[1]).toBe(`Azóta: /model claude-sonnet-5 elküldve ${formatDayClock(at1452)}, visszaigazolás nélkül; a következő kör méri`)
    expect(r.warn).toBeNull()
  })

  it('a turn after the switch: the measurement wins again', () => {
    const r = measuredModelLines({ model: 'claude-opus-5', atMs: at1452 }, { model: 'claude-opus-5[1m]', at: at1447, acked: true }, 'claude-opus-5[1m]', BASE)
    expect(r.head[0]).toBe(`Most fut: claude-opus-5 (utolsó kör ${formatDayClock(at1452)})`)
  })

  it('during a hold the expected model is the hold model, not the configured one', () => {
    expect(measuredModelLines({ model: 'claude-opus-5', atMs: at1452 }, { model: 'claude-opus-5[1m]', at: at1447, acked: true }, 'claude-opus-5[1m]', BASE).warn).toBeNull()
    expect(measuredModelLines({ model: 'claude-haiku-4-5', atMs: at1452 }, null, 'claude-opus-5[1m]', BASE).warn).toMatch(/⚠️ A futó modell eltér a tartásétól/)
  })

  it('no hold, nothing pending, a different measured model: the warning stays', () => {
    expect(measuredModelLines({ model: 'claude-opus-5', atMs: at1452 }, { model: BASE, at: at1447, acked: true }, null, BASE).warn).toMatch(/⚠️ A futó modell eltér a beállítottól/)
  })
})

describe('/model back and /model effort', () => {
  it('back with a hold: sends the revert target and clears the hold', async () => {
    const d = deps({ measured: () => 'claude-opus-5' })
    writeHold(d.holdFile, { model: 'claude-opus-5', name: 'opus', revert_to: 'claude-sonnet-5', until: T0 + 3600_000, set_at: T0, effort: null, revert_effort: null, verify_pending: false, blocked_since: null, block_alert_at: null })
    const r = await modelBack(d)
    expect(r.ok).toBe(true)
    expect(d.sent).toEqual(['/model claude-sonnet-5'])
    expect(existsSync(d.holdFile)).toBe(false)
  })

  it('back on a busy session with a hold: expiry set to now, the sweep reverts later', async () => {
    const d = deps({ measured: () => 'claude-opus-5', quiet: () => ({ quiet: false, reason: 'pane-busy' }) })
    writeHold(d.holdFile, { model: 'claude-opus-5', name: 'opus', revert_to: BASE, until: T0 + 3600_000, set_at: T0, effort: null, revert_effort: null, verify_pending: false, blocked_since: null, block_alert_at: null })
    await modelBack(d)
    expect(d.sent).toEqual([])
    expect(readHold(d.holdFile).state!.until).toBe(T0)
  })

  it('back with nothing to undo says so', async () => {
    const r = await modelBack(deps())
    expect(r.text).toBe('Már az alapmodell fut: claude-sonnet-5.')
  })

  it('effort: valid level sent as /effort, invalid refused', async () => {
    const d = deps()
    expect((await setEffort('high', d)).ok).toBe(true)
    expect(d.sent).toEqual(['/effort high'])
    const bad = await setEffort('turbo', d)
    expect(bad.ok).toBe(false)
    expect(bad.text).toMatch(/low\|medium\|high\|max/)
    expect(d.sent).toHaveLength(1)
  })

  // ELSOKOR922 Phase 7 A-smoke: after /model effort high the status still said
  // "nincs beállítva (a CLI alapértéke)" -- the transcript never carries effort.
  it('effort: the sent level is recorded; the status shows it until the session restarts', async () => {
    const d = deps()
    await setEffort('high', d)
    const file = effortSentFileFor(d.lastSentFile)
    expect(readEffortSent(file, null)).toEqual({ level: 'high', at: T0 })
    expect(readEffortSent(file, T0 - 1000)).toEqual({ level: 'high', at: T0 })
    expect(readEffortSent(file, T0 + 1000)).toBeNull() // a restart after the send resets the CLI's effort
    expect(effortLine(null, { level: 'high', at: T0 })).toMatch(/^Effort: high \(elküldve .*\) · visszamérni nem tudjuk$/)
    expect(effortLine({ value: 'medium', source: '.claude/settings.json effortLevel' }, null)).toMatch(/medium \(\.claude\/settings\.json effortLevel\)/)
    expect(effortLine(null, null)).toMatch(/nincs beállítva \(a CLI alapértéke\)/)
  })
})

// Measured on the test bot (2026-09-23): "/model fable 10m" on Claude Code
// 2.1.110 -> "API error: 400 ... does not support this model", while the reply
// said "elküldve ... Ideiglenes: 10 perc" and a hold was written.
describe('a model the CLI refuses', () => {
  it('setModel: "Nem váltottam" with the CLI message; no hold, no effort sent', async () => {
    writeChoices()
    const d = deps({}, { reject: 'Claude Code 2.1.110 does not support this model; version 2.1.251 or newer is required' })
    const r = await setModel(['opus', 'high', '10m'], d)
    expect(r.ok).toBe(false)
    expect(r.text).toBe('Nem váltottam: a Claude Code elutasította a(z) claude-opus-5[1m] modellt (Claude Code 2.1.110 does not support this model; version 2.1.251 or newer is required).')
    expect(existsSync(d.holdFile)).toBe(false)
    expect(d.sent).toEqual(['/model claude-opus-5[1m]'])
  })

  it('an OLDER API error already on the pane is not a refusal of this send', async () => {
    writeChoices()
    const d = deps()
    const r = await setModel(['haiku', '5m'], d)
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^Átváltva: haiku/)
  })

  it('lastRejectionMessage reads a message wrapped across pane lines', () => {
    const pane = '  ⎿  API error: 400\n     {"type":"error","error":{"type":"invalid_request_error","message":"Claude\n     Code 2.1.110 does not support this model"}}'
    expect(lastRejectionMessage(pane)).toBe('Claude Code 2.1.110 does not support this model')
  })
})

describe('"/model effort high" (the plan\'s form) = "/model high"', () => {
  it('parses the literal "effort" away', () => {
    writeChoices()
    const list = readModelChoices(join(dir, 'model-choices.json'), BASE)
    expect(parseModelArgs(['effort', 'high'], list)).toEqual({ choice: null, effort: 'high', hold: undefined })
    expect(parseModelArgs(['effort', 'turbo'], list)).toMatch(/Nem értem: „turbo”/)
  })
})

describe('ack when an older ack scrolled off', () => {
  it('the count stays 1 but the last "Set model to" line changed: acked', async () => {
    writeChoices()
    let pane = '  ⎿  Set model to claude-opus-5[1m]\n'
    const d = deps({
      ackCount: () => (pane.match(/Set model to/g) ?? []).length,
      pane: () => pane,
      send: async (c) => { if (c.startsWith('/model')) pane = '  ⎿  Set model to claude-sonnet-5\n' },
    })
    const r = await setModel(['haiku', '5m'], d)
    expect(r.text).toMatch(/^Átváltva: haiku/)
  })

  it('nothing changed on the pane: stays the cautious "elküldve"', async () => {
    writeChoices()
    const pane = '  ⎿  Set model to claude-opus-5[1m]\n'
    const d = deps({ ackCount: () => 1, pane: () => pane, send: async () => {} })
    const r = await setModel(['haiku', '5m'], d)
    expect(r.text).toMatch(/Elküldve: haiku \(a Claude Code még nem igazolta vissza\)/)
  })

  it('lastModelAck folds whitespace and takes the last line', () => {
    expect(lastModelAck('Set model to  a\nx\n⎿ Set model to claude-sonnet-5  \n')).toBe('Set model to claude-sonnet-5')
    expect(lastModelAck('semmi')).toBeNull()
  })
})

describe('/model default with a hold while the session is busy', () => {
  it('is ok (the revert is armed, the hold expires now), so a queued model write gets dropped', async () => {
    writeChoices()
    const d = deps({ quiet: () => ({ quiet: false, reason: 'pane-busy' }) })
    writeHold(d.holdFile, {
      model: null, name: 'high', revert_to: null, effort: 'high', revert_effort: null,
      until: T0 + 3_600_000, set_at: T0, verify_pending: false, blocked_since: null, block_alert_at: null,
    })
    const r = await modelBack(d)
    expect(r).toEqual({ ok: true, text: 'A session épp dolgozik; a visszaváltás megtörténik, amint szabad.' })
    expect(readHold(d.holdFile).state?.until).toBe(T0)
    expect(d.sent).toEqual([])
  })
})

// The owner's /model view (owner feedback 2026-09-24, mocks approved): what
// runs, until when, what to type -- no config keys, no "nem mérhető (...)".
describe('/model owner view (modelSummary)', () => {
  const choices = [
    { name: 'opus', id: 'claude-opus-5[1m]', purpose: 'nehéz munka, tervezés' },
    { name: 'sonnet', id: 'claude-sonnet-5', purpose: 'napi munka' },
    { name: 'haiku', id: 'claude-haiku-4-5-20251001', purpose: 'gépies, olcsó körök (200K ablak)' },
  ]
  const base = (o: Partial<ModelSummaryInput> = {}): ModelSummaryInput => ({
    measured: { model: 'claude-sonnet-5', atMs: T0 - 60_000 }, lastSent: null, hold: null,
    configured: 'claude-sonnet-5', effortConfigured: null, effortSent: null, choices, now: T0, ...o,
  })

  it('base state: short names, no technical keys', () => {
    expect(modelSummary(base())).toBe([
      'Modell: sonnet (alap)',
      'Tartás: nincs',
      '',
      'Választható: opus (nehéz munka, tervezés) · sonnet (napi munka) · haiku (gépies, olcsó körök)',
      'Váltás: /model opus 30m · súgó: /model ?',
    ].join('\n'))
    expect(modelSummary(base())).not.toMatch(/\.env|MAIN_AGENT_MODEL|visszamérni|assistant-sor/)
  })

  it('a hold: until when, how long left, what comes back; effort marked temporary', () => {
    const hold = { model: 'claude-opus-5[1m]', name: 'opus', revert_to: 'claude-sonnet-5', effort: 'high', revert_effort: null,
      until: T0 + 25 * 60_000, set_at: T0 - 60_000, verify_pending: false, blocked_since: null, block_alert_at: null }
    const out = modelSummary(base({ hold, measured: { model: 'claude-opus-5', atMs: T0 - 1000 } }))
    expect(out).toMatch(/^Modell: opus, ideiglenes, \d\d:\d\d-ig \(még 25 perc\)\nUtána vissza: sonnet\nEffort: high, ideiglenes\n/)
    expect(out).not.toMatch(/Tartás: nincs/)
    expect(out).toMatch(/Váltás: \/model sonnet 30m · vissza most: \/model default · súgó: \/model \?/)
  })

  it('after a restart, no turn yet: says it will measure from the next turn', () => {
    expect(modelStateLine(base({ measured: null })).line).toBe('sonnet (alap), a következő körtől mérem')
  })

  it('a different model running than the one expected: a plain-language warning', () => {
    const r = modelStateLine(base({ measured: { model: 'claude-haiku-4-5-20251001', atMs: T0 - 1000 } }))
    expect(r.warn).toMatch(/^⚠️ Most haiku fut, pedig a beállítás sonnet\./)
  })

  it('effort only when there is one; a configured effort is "alap"', () => {
    expect(modelSummary(base())).not.toMatch(/Effort/)
    expect(modelSummary(base({ effortConfigured: 'medium' }))).toMatch(/Effort: medium \(alap\)/)
    expect(modelSummary(base({ effortSent: 'low' }))).toMatch(/Effort: low\n/)
  })

  it('/model details resolves to the READ entry, not a model switch', () => {
    clearCommandsForTest()
    registerBuiltinCommands()
    expect(resolveCommand('model', ['details'])?.kind).toBe('read')
    expect(resolveCommand('model', ['details'])?.usage).toBe('/model details')
    expect(resolveCommand('model', ['opus'])?.kind).toBe('write')
    expect(resolveCommand('model', [])?.kind).toBe('read')
  })
})

// Owner question 2026-09-24: "haiku has no effort level, does it?" -- Claude
// Code 2.1.110 (binary): every haiku id -> supportsEffort false.
describe('haiku has no effort', () => {
  it('/model haiku high 5m: switches, does NOT send the effort, and says so; no effort held', async () => {
    writeChoices()
    const d = deps()
    const r = await setModel(['haiku', 'high', '5m'], d)
    expect(r.ok).toBe(true)
    expect(d.sent).toEqual(['/model claude-haiku-4-5-20251001'])
    expect(r.text).toMatch(/^Átváltva: haiku\.\nA haiku nem támogat effortot, a\(z\) high szintet nem küldtem el\.\n/)
    expect(r.text).not.toMatch(/Effort: high/)
    expect(readHold(d.holdFile).state).toMatchObject({ effort: null, revert_effort: null })
  })

  it('an effort alone while haiku runs (a hold on haiku) is refused, nothing sent', async () => {
    writeChoices()
    const d = deps()
    await setModel(['haiku', '5m'], d)
    d.sent.length = 0
    const r = await setModel(['high', '5m'], d)
    expect(r).toEqual({ ok: false, text: 'Nem állítottam: a most futó haiku nem támogat effortot.' })
    expect(d.sent).toEqual([])
    expect((await setEffort('high', d)).text).toBe('Nem állítottam: a most futó haiku nem támogat effortot.')
  })

  it('opus and sonnet keep their effort', () => {
    expect(modelSupportsEffort('claude-opus-5[1m]')).toBe(true)
    expect(modelSupportsEffort('claude-sonnet-5')).toBe(true)
    expect(modelSupportsEffort('claude-haiku-4-5-20251001')).toBe(false)
  })
})

