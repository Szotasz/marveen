import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COLISTEN_CONFIRM_SWEEPS, COLISTEN_MAX_RESTARTS, COLISTEN_RESTART_WINDOW_MS,
  colistenProviders, decideColistenAction, emptyColistenState, providerOfPluginId, runColistenCheck,
  type ColistenState,
} from '../web/main-colisten-health.js'
import type { ChannelProviderType } from '../channel-provider.js'

// BOOTSTAGGER1007 (b). Measured 2026-10-07 after a power cut: the main
// session's co-listen Slack plugin never connected (DNS not up at boot), the
// primary Telegram was fine, and every monitor watched only the primary, so the
// owner's main channel was deaf for 30 minutes without an alert.

const MIN = 60_000
const GRACE = 6 * MIN

describe('decideColistenAction', () => {
  it('a probe that knew nothing changes nothing', () => {
    const r = decideColistenAction(emptyColistenState(), 'unknown', 0, false)
    expect(r.action).toBe('none')
    expect(r.next).toEqual(emptyColistenState())
  })

  it('down is confirmed over COLISTEN_CONFIRM_SWEEPS sweeps before anything acts', () => {
    expect(COLISTEN_CONFIRM_SWEEPS).toBe(2)
    const a = decideColistenAction(emptyColistenState(), 'down', 0, false)
    expect(a.action).toBe('wait')
    const b = decideColistenAction(a.next, 'down', MIN, false)
    expect(b.action).toBe('restart')
    expect(b.next.restartsAt).toEqual([MIN])
  })

  it('inside the post-respawn grace a plugin that is not up yet is not acted on', () => {
    let s = emptyColistenState()
    for (let i = 0; i < 5; i++) {
      const r = decideColistenAction(s, 'down', i * MIN, true)
      expect(r.action).toBe('wait')
      s = r.next
    }
    expect(s.restartsAt).toEqual([])
  })

  it('the cap: at most COLISTEN_MAX_RESTARTS restarts, then ONE give-up, then silence until it is up', () => {
    expect(COLISTEN_MAX_RESTARTS).toBe(2)
    let s = emptyColistenState()
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      const r = decideColistenAction(s, 'down', i * MIN, false)
      seen.push(r.action)
      s = r.next
    }
    expect(seen.filter((a) => a === 'restart')).toHaveLength(2)
    expect(seen.filter((a) => a === 'give-up')).toHaveLength(1)
    expect(seen.slice(seen.indexOf('give-up') + 1).every((a) => a === 'none')).toBe(true)
  })

  it('a flapping plugin cannot loop: the cap is a window, it survives recoveries', () => {
    let s: ColistenState = emptyColistenState()
    let restarts = 0
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 3; i++) {
        const r = decideColistenAction(s, 'down', cycle * 10 * MIN + i * MIN, false)
        if (r.action === 'restart') restarts++
        s = r.next
      }
      s = decideColistenAction(s, 'alive', cycle * 10 * MIN + 5 * MIN, false).next
    }
    expect(restarts).toBe(COLISTEN_MAX_RESTARTS)
  })

  it('...and after the window the budget is back', () => {
    const s: ColistenState = { downSince: 0, downSweeps: 1, restartsAt: [0, MIN], gaveUp: false }
    expect(decideColistenAction(s, 'down', 2 * MIN, false).action).toBe('give-up')
    const late = COLISTEN_RESTART_WINDOW_MS + 2 * MIN
    expect(decideColistenAction({ ...s, downSince: late - MIN }, 'down', late, false).action).toBe('restart')
  })

  it('up again: "recovered" only when the spell was acted on; a blip that never got a restart is quiet', () => {
    const blip = decideColistenAction(emptyColistenState(), 'down', 0, false).next
    expect(decideColistenAction(blip, 'alive', MIN, false).action).toBe('none')
    let s = emptyColistenState()
    s = decideColistenAction(s, 'down', 0, false).next
    s = decideColistenAction(s, 'down', MIN, false).next // restart
    const r = decideColistenAction(s, 'alive', 8 * MIN, false)
    expect(r.action).toBe('recovered')
    expect(r.next.downSince).toBeNull()
  })
})

describe('providerOfPluginId', () => {
  const providers: Array<{ type: ChannelProviderType; pluginId: string }> = [
    { type: 'telegram', pluginId: 'telegram@claude-plugins-official' },
    { type: 'slack', pluginId: 'slack-channel@marveen-marketplace' },
  ]
  it('maps a plugin id to its provider, and an unknown id to null', () => {
    expect(providerOfPluginId('slack-channel@marveen-marketplace', providers)).toBe('slack')
    expect(providerOfPluginId(' telegram@claude-plugins-official ', providers)).toBe('telegram')
    expect(providerOfPluginId('whatsapp@marveen-marketplace', providers)).toBeNull()
  })
})

describe('colistenProviders', () => {
  const providers: Array<{ type: ChannelProviderType; pluginId: string }> = [
    { type: 'telegram', pluginId: 'telegram@claude-plugins-official' },
    { type: 'slack', pluginId: 'slack-channel@marveen-marketplace' },
    { type: 'discord', pluginId: 'discord@claude-plugins-official' },
  ]
  it('our host: telegram primary + slack co-listen -> [slack]', () => {
    expect(colistenProviders('telegram', ['slack-channel@marveen-marketplace'], providers)).toEqual(['slack'])
  })
  it('the primary is never watched here, even if listed as an extra', () => {
    expect(colistenProviders('slack', ['slack-channel@marveen-marketplace', 'telegram@claude-plugins-official'], providers)).toEqual(['telegram'])
  })
  it('each provider once, unknown ids dropped, no extras -> []', () => {
    expect(colistenProviders('telegram', ['discord@claude-plugins-official', 'discord@claude-plugins-official', 'whatsapp@x'], providers)).toEqual(['discord'])
    expect(colistenProviders('telegram', [], providers)).toEqual([])
  })
})

describe('runColistenCheck: live primary + dead co-listen = restart and alert', () => {
  function harness(probe: Record<string, Array<'alive' | 'down' | 'unknown'>>, opts: { restartOk?: boolean; lastRespawnAt?: () => number } = {}) {
    const state = new Map<ChannelProviderType, ColistenState>()
    const alerts: string[] = []
    let restarts = 0
    let sweep = 0
    const run = async (extras: ChannelProviderType[] = ['slack']) => {
      const i = sweep++
      return runColistenCheck({
        primary: 'telegram', extras,
        probe: (p) => probe[p][Math.min(i, probe[p].length - 1)],
        now: i * MIN,
        lastRespawnAt: opts.lastRespawnAt ? opts.lastRespawnAt() : 0,
        respawnGraceMs: GRACE,
        state,
        alert: (t) => { alerts.push(t) },
        log: () => {},
        restart: async () => { restarts++; return opts.restartOk ?? true },
        botName: 'Marveen',
      })
    }
    return { run, alerts, get restarts() { return restarts }, state }
  }

  it('the 2026-10-07 boot: Slack never up -> confirmed, restart with an alert naming both channels', async () => {
    const h = harness({ slack: ['down'] })
    expect(await h.run()).toEqual(['wait'])
    expect(await h.run()).toEqual(['restart'])
    expect(h.restarts).toBe(1)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('slack-csatornája nem él')
    expect(h.alerts[0]).toContain('telegram')
    expect(h.alerts[0]).toContain('(1/2)')
  })

  it('a healthy co-listen plugin: no restart, no alert, ever', async () => {
    const h = harness({ slack: ['alive'] })
    for (let i = 0; i < 10; i++) expect(await h.run()).toEqual(['none'])
    expect(h.restarts).toBe(0)
    expect(h.alerts).toEqual([])
  })

  it('it stays down: two restarts, then one give-up alert, and no loop', async () => {
    const h = harness({ slack: ['down'] })
    for (let i = 0; i < 15; i++) await h.run()
    expect(h.restarts).toBe(2)
    expect(h.alerts.filter((a) => a.startsWith('⚠️'))).toHaveLength(2)
    expect(h.alerts.filter((a) => a.startsWith('❌'))).toHaveLength(1)
    expect(h.alerts[2]).toContain('itt (telegram) érsz el')
  })

  it('it comes back after a restart: one recovered alert', async () => {
    const h = harness({ slack: ['down', 'down', 'down', 'alive'] })
    for (let i = 0; i < 5; i++) await h.run()
    expect(h.restarts).toBe(1)
    expect(h.alerts).toHaveLength(2)
    expect(h.alerts[0].startsWith('⚠️')).toBe(true)
    expect(h.alerts[1].startsWith('✅')).toBe(true)
  })

  it('a session that was just respawned (any path) is left alone while it boots', async () => {
    const h = harness({ slack: ['down'] }, { lastRespawnAt: () => 1 })
    for (let i = 0; i < 6; i++) await h.run()
    expect(h.restarts).toBe(0)
    expect(h.alerts).toEqual([])
  })

  it('two dead co-listen plugins: ONE restart per sweep, the second keeps its budget', async () => {
    const h = harness({ slack: ['down'], discord: ['down'] })
    await h.run(['slack', 'discord'])
    const second = await h.run(['slack', 'discord'])
    expect(second).toEqual(['restart', 'wait'])
    expect(h.restarts).toBe(1)
    expect(h.state.get('discord')?.restartsAt).toEqual([])
  })

  it('a failed restart still counts against the cap (no tight retry loop)', async () => {
    const h = harness({ slack: ['down'] }, { restartOk: false })
    for (let i = 0; i < 15; i++) await h.run()
    expect(h.restarts).toBe(2)
  })
})

describe('the binding in channel-monitor (source)', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  it('runs only in the primary-ALIVE branch of the main target, right after the keepalive check', () => {
    expect(src).toMatch(/checkMainKeepaliveStaleness\(\)\n(?:\s*\/\/[^\n]*\n)*\s*await checkMainColistenChannels\(claudePid\)/)
  })
  it('probes each co-listen provider under the main claude, restarts with the conversation kept, alerts through sendAlert', () => {
    const fn = src.slice(src.indexOf('async function checkMainColistenChannels'), src.indexOf('function handleMarveenUp'))
    expect(fn).toContain('colistenProviders(primary, readExtraChannelPluginIds(), ALL_PROVIDER_TYPES.map((t) => getProvider(t)))')
    expect(fn).toContain('probe: (p) => probeChannelPluginLiveness(claudePid, p)')
    expect(fn).toContain('restart: () => resumeMarveenSession()')
    expect(fn).toContain('alert: sendAlert')
    expect(fn).toContain('respawnGraceMs: MARVEEN_POST_RESPAWN_GRACE_MS')
    expect(fn).toContain('lastRespawnAt: lastMainRespawnAt()')
  })
})
