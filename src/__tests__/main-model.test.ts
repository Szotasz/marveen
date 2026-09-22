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
  windowWarning,
  _resetMainModelForTest,
  BLOCK_ALERT_MS,
  type ModelDeps,
  type HoldState,
} from '../web/main-model.js'
import { logger } from '../logger.js'

const BASE = 'claude-sonnet-5'
const T0 = Date.parse('2026-09-22T08:00:00Z')

let dir: string

function deps(over: Partial<ModelDeps> = {}) {
  const sent: string[] = []
  const notes: string[] = []
  const env: Array<Record<string, string>> = []
  let now = T0
  const d: ModelDeps & { sent: string[]; notes: string[]; env: typeof env; setNow(n: number): void } = {
    sent, notes, env,
    setNow(n: number) { now = n },
    now: () => now,
    choicesFile: join(dir, 'model-choices.json'),
    holdFile: join(dir, 'main-model-hold.json'),
    configured: () => BASE,
    measured: () => BASE,
    quiet: () => ({ quiet: true }),
    send: async (c) => { sent.push(c) },
    writeEnv: (u) => { env.push(u) },
    notify: async (t) => { notes.push(t); return true },
    autoCompactWindow: () => null,
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
    expect(r.text).toMatch(/nincs a választékban.*opus, haiku/)
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
    expect(r.text).toMatch(/ideiglenes: 2 óra/)
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
    writeHold(d.holdFile, { model: 'x', name: 'x', revert_to: BASE, until: T0 + 1, set_at: T0, verify_pending: false, blocked_since: null, block_alert_at: null })
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
    expect(r.text).toMatch(/foglalt \(pane-busy\).*\/runs/)
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

describe('/model window warning (CMD920 test 9)', () => {
  it('a smaller window than autoCompactWindow warns; a 1M model does not', async () => {
    expect(windowWarning('claude-haiku-4-5-20251001', 300_000)).toMatch(/FIGYELEM.*200k.*300k/)
    expect(windowWarning('claude-opus-5[1m]', 300_000)).toBeNull()
    expect(windowWarning('claude-haiku-4-5-20251001', null)).toBeNull()
    writeChoices()
    const r = await setModel(['haiku'], deps({ autoCompactWindow: () => 300_000 }))
    expect(r.text).toMatch(/FIGYELEM: a\(z\) claude-haiku-4-5-20251001 ablaka/)
  })
})

describe('hold sweep (CMD920 tests 7, 8)', () => {
  const hold = (over: Partial<HoldState> = {}): HoldState => ({
    model: 'claude-opus-5[1m]', name: 'opus', revert_to: BASE, until: T0 + 60_000, set_at: T0,
    verify_pending: false, blocked_since: null, block_alert_at: null, ...over,
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
    expect(d.notes[0]).toMatch(/perce foglalt \(pane-busy\)/)
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
    expect(ok.notes[0]).toMatch(/Megerősítve: a futó modell claude-opus-5/)
    expect(readHold(ok.holdFile).state!.verify_pending).toBe(false)

    const bad = deps({ measured: () => 'claude-sonnet-4-6' })
    writeHold(bad.holdFile, hold({ verify_pending: true }))
    expect(await sweepModelHold(T0 + 1000, bad)).toBe('mismatch')
    expect(bad.notes[0]).toMatch(/FIGYELEM.*mért modell claude-sonnet-4-6/)
  })

  it('no transcript line after the switch yet: verification stays pending', async () => {
    const d = deps({ measured: () => null })
    writeHold(d.holdFile, hold({ verify_pending: true }))
    expect(await sweepModelHold(T0 + 1000, d)).toBe('waiting')
    expect(readHold(d.holdFile).state!.verify_pending).toBe(true)
  })
})

describe('/model back and /model effort', () => {
  it('back with a hold: sends the revert target and clears the hold', async () => {
    const d = deps({ measured: () => 'claude-opus-5' })
    writeHold(d.holdFile, { model: 'claude-opus-5', name: 'opus', revert_to: 'claude-sonnet-5', until: T0 + 3600_000, set_at: T0, verify_pending: false, blocked_since: null, block_alert_at: null })
    const r = await modelBack(d)
    expect(r.ok).toBe(true)
    expect(d.sent).toEqual(['/model claude-sonnet-5'])
    expect(existsSync(d.holdFile)).toBe(false)
  })

  it('back on a busy session with a hold: expiry set to now, the sweep reverts later', async () => {
    const d = deps({ measured: () => 'claude-opus-5', quiet: () => ({ quiet: false, reason: 'pane-busy' }) })
    writeHold(d.holdFile, { model: 'claude-opus-5', name: 'opus', revert_to: BASE, until: T0 + 3600_000, set_at: T0, verify_pending: false, blocked_since: null, block_alert_at: null })
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
    expect(bad.text).toMatch(/low\|medium\|high\|xhigh\|max/)
    expect(d.sent).toHaveLength(1)
  })
})
