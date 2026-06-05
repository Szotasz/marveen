import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MONITOR_PATH = join(__dirname, '../web/channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

describe('checkMainKeepaliveStaleness: bun-alive short-circuit (2026-06-01 21:18 incident)', () => {
  // Szabi reported: "óra :18 és :48 kor folyton" stale-keepalive alerts during
  // quiet conversation periods. Each alert triggered a respawn-pane that
  // killed the running --continue context for nothing -- the plugin was
  // perfectly alive, the file just hadn't been touched in 18+ min because
  // there was no organic inbound traffic. The fix: if the channel plugin's
  // bun poller is alive under the claude pid, return early; a stale file
  // with a live poller is a QUIET channel, not a deaf one.

  const fnStart = src.indexOf('function checkMainKeepaliveStaleness')
  expect(fnStart, 'checkMainKeepaliveStaleness not found').toBeGreaterThan(0)
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)

  it('probes hasChannelPluginAlive before measuring file staleness', () => {
    const aliveIdx = fnBody.indexOf('hasChannelPluginAlive(')
    const ageIdx = fnBody.indexOf('keepaliveAgeMs')
    expect(aliveIdx, 'hasChannelPluginAlive call missing').toBeGreaterThan(0)
    expect(ageIdx, 'age calculation missing').toBeGreaterThan(0)
    expect(aliveIdx).toBeLessThan(ageIdx)
  })

  it('returns early when the plugin is alive (no respawn for quiet channels)', () => {
    const aliveIdx = fnBody.indexOf('hasChannelPluginAlive(')
    // The early-return must come BEFORE shouldRespawnForStaleKeepalive() is consulted.
    const decisionIdx = fnBody.indexOf('shouldRespawnForStaleKeepalive(')
    expect(decisionIdx).toBeGreaterThan(aliveIdx)
    // And there must be a `return` between alive-probe and decision.
    const between = fnBody.slice(aliveIdx, decisionIdx)
    expect(between).toMatch(/return\b/)
  })

  it('fails OPEN (falls through to existing logic) if the liveness probe throws', () => {
    // A try/catch around the shortcut so a broken pgrep / missing tmux session
    // never blocks recovery of a genuinely dead session.
    const aliveIdx = fnBody.indexOf('hasChannelPluginAlive(')
    const tryIdx = fnBody.lastIndexOf('try {', aliveIdx)
    expect(tryIdx).toBeGreaterThan(0)
    // The try-block must end before shouldRespawnForStaleKeepalive
    const catchIdx = fnBody.indexOf('catch', tryIdx)
    expect(catchIdx).toBeGreaterThan(0)
    expect(catchIdx).toBeLessThan(fnBody.indexOf('shouldRespawnForStaleKeepalive('))
  })
})
