import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the in-process post-respawn channel-plugin unlock helper.
//
// The unlock keystrokes (/mcp + Up + Enter + Enter) are only safe to deliver
// when (a) the bun poller is provably ABSENT under the new claude pid and
// (b) the pane is at the idle bypass-permissions footer. The 2026-06-01 18:55
// channel-disconnect incident was caused precisely by an unlock-while-already-
// running cycle that toggled the plugin to `◯ disabled`. These tests pin the
// safety gates so a future refactor cannot quietly drop them.

const REPO_ROOT = join(__dirname, '../..')
const HELPER_PATH = join(REPO_ROOT, 'src/web/channel-plugin-unlock.ts')
const MONITOR_PATH = join(REPO_ROOT, 'src/web/channel-monitor.ts')

const helper = readFileSync(HELPER_PATH, 'utf-8')
const monitor = readFileSync(MONITOR_PATH, 'utf-8')

describe('channel-plugin-unlock helper contract', () => {
  it('exports schedulePluginUnlockAfterRespawn for the channel-monitor respawn paths', () => {
    expect(helper).toMatch(/export\s+function\s+schedulePluginUnlockAfterRespawn\b/)
  })

  it('gates the keystrokes on the absence of a bun child under the claude pid', () => {
    // The bun-child probe is the single most important safety check: if a
    // bun poller is alive, the plugin is running and Up+Enter+Enter would
    // navigate to "Disable", killing a healthy channel.
    expect(helper).toMatch(/pgrep/)
    expect(helper).toMatch(/hasBunChild/)
    // The unlock keystrokes path must be reachable ONLY when hasBunChild is
    // false - assert by checking the early-return branch precedes the
    // keystroke call inside runUnlockProbe.
    const probeStart = helper.indexOf('function runUnlockProbe')
    expect(probeStart, 'runUnlockProbe not found').toBeGreaterThan(0)
    const probeEnd = helper.indexOf('\n}\n', probeStart)
    const probeBody = helper.slice(probeStart, probeEnd > probeStart ? probeEnd : undefined)
    const bunIdx = probeBody.indexOf('hasBunChild(')
    const sendIdx = probeBody.indexOf('sendUnlockKeystrokes(')
    expect(bunIdx).toBeGreaterThan(0)
    expect(sendIdx).toBeGreaterThan(bunIdx)
    // Ensure the hasBunChild branch returns before sendUnlockKeystrokes.
    const between = probeBody.slice(bunIdx, sendIdx)
    expect(between).toMatch(/return\b/)
  })

  it('refuses to send keystrokes if the pane shows a modal or non-idle state', () => {
    // isSessionReadyForUnlock must reject "Resume from summary" and the
    // macOS permissions dialog - those signatures mean the keystrokes
    // would land in the wrong context.
    expect(helper).toMatch(/Resume from summary/)
    expect(helper).toMatch(/Open System Settings/)
    // Idle footer requirement: bypass-permissions string must be present.
    expect(helper).toMatch(/bypass permissions on/)
  })

  it('delivers exactly /mcp, Up, Enter, Enter as the unlock sequence', () => {
    // Pinning the exact 4-key sequence: anything else would either fail
    // to revive the plugin or risk an unintended menu action.
    const sendStart = helper.indexOf('function sendUnlockKeystrokes')
    expect(sendStart, 'sendUnlockKeystrokes not found').toBeGreaterThan(0)
    const sendEnd = helper.indexOf('\n}\n', sendStart)
    const sendBody = helper.slice(sendStart, sendEnd > sendStart ? sendEnd : undefined)
    expect(sendBody).toMatch(/'\/mcp',\s*'Enter'/)
    // Two stand-alone Enters after Up (open menu, activate first action).
    const upIdx = sendBody.indexOf("'Up'")
    expect(upIdx, "'Up' keystroke missing").toBeGreaterThan(0)
    const afterUp = sendBody.slice(upIdx)
    // Count standalone Enter keystrokes after Up: must be exactly two.
    const enterMatches = afterUp.match(/send-keys[^]*?'Enter'\]/g) ?? []
    expect(enterMatches.length).toBe(2)
  })

  it('schedules the probe with a cold-start delay >= 25 seconds', () => {
    // The plugin handshake needs time to complete on cold start; firing
    // the probe too early would always see no bun and trigger a needless
    // unlock cycle. Stay >= 25s to comfortably cover the 8s modal +
    // 5s /name + plugin spawn window observed in channels.sh.
    const m = helper.match(/const\s+UNLOCK_PROBE_DELAY_MS\s*=\s*([\d_]+)/)
    expect(m, 'UNLOCK_PROBE_DELAY_MS constant not found').not.toBeNull()
    const value = parseInt((m![1] as string).replace(/_/g, ''), 10)
    expect(value).toBeGreaterThanOrEqual(25_000)
  })
})

describe('channel-monitor wires the unlock probe into both in-process respawn paths', () => {
  // The 2026-06-01 18:55 root cause was that channels.sh's post-init unlock
  // probe (#231/#232) only runs on the launchd start path - the JS respawn
  // paths (resumeMarveenSession and respawnMarveenSessionFresh) call tmux
  // respawn-pane directly and skipped channels.sh entirely. Both JS paths
  // must now call schedulePluginUnlockAfterRespawn after scheduleIdentitySetup
  // or a Failed/disabled plugin will stay offline indefinitely.

  it('imports schedulePluginUnlockAfterRespawn from channel-plugin-unlock', () => {
    expect(monitor).toMatch(/from\s+'\.\/channel-plugin-unlock\.js'/)
    expect(monitor).toMatch(/schedulePluginUnlockAfterRespawn/)
  })

  function bodyOf(fnName: string): string {
    const start = monitor.indexOf(`function ${fnName}`)
    expect(start, `${fnName} not found`).toBeGreaterThan(0)
    const end = monitor.indexOf('\nfunction ', start + 1)
    return monitor.slice(start, end > start ? end : undefined)
  }

  it('resumeMarveenSession schedules the unlock probe after the respawn', () => {
    const body = bodyOf('resumeMarveenSession')
    expect(body).toMatch(/schedulePluginUnlockAfterRespawn\(MAIN_CHANNELS_SESSION/)
  })

  it('respawnMarveenSessionFresh schedules the unlock probe after the respawn', () => {
    const body = bodyOf('respawnMarveenSessionFresh')
    expect(body).toMatch(/schedulePluginUnlockAfterRespawn\(MAIN_CHANNELS_SESSION/)
  })
})
