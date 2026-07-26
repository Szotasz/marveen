import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 2026-07-26 incident. Three runner modules restarted the MAIN channels session
// by shelling out to a hardcoded `/bin/launchctl kickstart`. That binary is
// macOS-only, so on a systemd/Linux install every one of those restarts threw
// `spawnSync /bin/launchctl ENOENT` and was swallowed by the surrounding catch.
//
// The observable damage: the context-guard saturation net -- the ONLY mechanism
// that can rescue a pane already at "100% context used", because prompt
// dispatch refuses such a pane -- fired four times (09:47, 10:22, 10:57, 11:27)
// and failed all four. The main agent was unreachable for ~2h until a manual
// restart. The other two sites failed the same way, just less visibly: the
// daily fresh restart and the model-fallback-on-usage-limit swap could never
// take effect on Linux at all.
//
// #713 fixed the auto-restart runner by picking the mechanism from the launchctl
// BINARY (`mainRestartMechanism(existsSync('/bin/launchctl'))`). The other two
// call sites were untouched and are what this change fixes; they delegate to
// hardRestartMarveenChannels(), which already existed for the channel-monitor
// down-cascade. So two shapes now coexist, and this guard therefore asserts the
// INVARIANT both satisfy rather than one particular helper: a runner may name
// launchctl only if the same file also gates it on that binary existing, and it
// must have a non-launchd path to fall back to.
//
// These assertions are source-level on purpose. The failure mode was a missing
// platform branch on a path that only executes during a real incident, so there
// is no cheap runtime fixture that would have caught it, and the modules are
// I/O-heavy enough that a mocked harness would assert the mock. Same idiom as
// the #248 guard in stuck-tool-call.test.ts and the writeRespawnStamp guards in
// channel-monitor-session-recreate.test.ts.

const SRC = join(import.meta.dirname, '..')

// Every module that can restart the main channels session on a schedule or in
// response to a fault. Add new ones here.
const RUNNERS = [
  'web/context-guard-runner.ts',
  'web/auto-restart-runner.ts',
  'web/model-fallback-runner.ts',
] as const

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

// Strip line and block comments. The incident comments in these files mention
// /bin/launchctl by name to explain the history; without stripping, the guard
// would pass on documentation alone -- or fail on it. Only executable code
// counts.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// A launchctl-existence gate in the same file. Either form is acceptable:
// the direct existsSync probe, or mainRestartMechanism(), whose only argument
// IS that probe (see src/auto-restart.ts).
function hasLaunchctlGate(code: string): boolean {
  return /existsSync\(\s*'\/bin\/launchctl'\s*\)/.test(code) || /mainRestartMechanism\(/.test(code)
}

// A path that restarts main WITHOUT launchd.
function hasNonLaunchdPath(code: string): boolean {
  return /hardRestartMarveenChannels\(\)/.test(code) || /respawnMainSessionFresh\(\)/.test(code)
}

describe('main-session restart is platform-correct (2026-07-26 launchctl ENOENT)', () => {
  for (const rel of RUNNERS) {
    describe(rel, () => {
      it('never execs launchctl without checking the binary exists', () => {
        const code = stripComments(read(rel))
        if (/launchctl/.test(code)) {
          expect(hasLaunchctlGate(code)).toBe(true)
        }
      })

      it('has a non-launchd main-restart path', () => {
        expect(hasNonLaunchdPath(stripComments(read(rel)))).toBe(true)
      })

      it('surfaces a failed main restart when the helper reports one', () => {
        // hardRestartMarveenChannels returns {ok,error} rather than throwing.
        // Ignoring `ok` would recreate the original silent-failure bug with a
        // different mechanism: the caller would record "restarted" and, in the
        // auto-restart case, stamp lastRestart and skip the slot for a day.
        // Only asserted for callers of that helper -- respawnMainSessionFresh()
        // returns void and warns internally, so there is no result to check
        // (a real remaining gap, called out in the PR rather than papered over).
        const code = stripComments(read(rel))
        if (/hardRestartMarveenChannels\(\)/.test(code)) {
          expect(code).toMatch(/if\s*\(\s*!\s*res\.ok\s*\)\s*throw/)
        }
      })
    })
  }

  // The macOS leg must SURVIVE this change: the fix is an EXTENSION to Linux,
  // not a replacement, because marveen is also installed on macOS hosts. Both
  // directions are asserted so "we kept the mac path" is not just a claim in a
  // commit message.
  it('the helper keeps the launchd leg for macOS installs, gated on the plist', () => {
    const monitor = read('web/channel-monitor.ts')
    expect(monitor).toMatch(/export function hardRestartMarveenChannels/)
    // mac leg: non-linux AND the channels plist is actually registered.
    expect(monitor).toMatch(/process\.platform !== 'linux' && existsSync\(MAIN_CHANNELS_PLIST\)/)
    // ...and it still drives launchd, rather than having been stripped to a
    // Linux-only respawn.
    expect(monitor).toMatch(/execFileSync\('\/bin\/launchctl', \['unload', MAIN_CHANNELS_PLIST\]/)
    expect(monitor).toMatch(/execFileSync\('\/bin\/launchctl', \['load', MAIN_CHANNELS_PLIST\]/)
  })

  it('the helper falls through to the pane respawn when the plist is absent', () => {
    // A macOS host whose plist was never installed (or was unloaded by hand)
    // must not silently no-op: the helper warns and takes the respawn path,
    // which is also the whole Linux leg.
    const monitor = read('web/channel-monitor.ts')
    expect(monitor).toMatch(/channels plist absent -- falling back to respawn-pane/)
    expect(monitor).toMatch(/respawnMarveenSessionFresh\(\)/)
  })

  it('the launchd leg of the auto-restart runner is gated, and the fallback is the shared respawn helper', () => {
    // Positive assertion on the #713 shape, so a future edit that drops the
    // gate (back to an unconditional kickstart) fails here and not only in
    // production on a Linux host.
    const code = stripComments(read('web/auto-restart-runner.ts'))
    expect(code).toMatch(/mainRestartMechanism\(\s*existsSync\(\s*'\/bin\/launchctl'\s*\)\s*\)/)
    expect(code).toMatch(/respawnMainSessionFresh\(\)/)
  })
})

// Second half of the same incident. Arming the Linux restart path makes the
// context guard able to restart main every sweep -- which is exactly what was
// measured on 2026-07-26: the saturation net fresh-restarted the main agent
// five times in one morning, each restart dropping the conversation, so the
// agent kept losing its context roughly every half hour. A restart that is
// already in flight (or was just performed by ANY other respawner -- the
// channel-monitor down-cascade, the auto-restart runner, channel-watchdog.sh)
// must not be repeated while the fresh session is still booting: a booting pane
// can read as saturated/idle again before it has settled.
//
// The mechanism is the one already shared by every other respawner: the
// lastMainRespawnAt() stamp plus MARVEEN_POST_RESPAWN_GRACE_MS. Deliberately NO
// new tunable -- see stuck-tool-call-watcher.ts, which gates its recovery the
// same way against the same stamp.
describe('context guard defers a main restart inside the post-respawn grace', () => {
  const runner = () => stripComments(read('web/context-guard-runner.ts'))

  it('reuses the shared grace predicate and stamp, not a private threshold', () => {
    const code = runner()
    expect(code).toMatch(/shouldDeferForRecentRespawn\(/)
    expect(code).toMatch(/lastMainRespawnAt\(\)/)
    // No second grace constant: the number lives in channel-monitor.ts.
    expect(code).not.toMatch(/GRACE_MS\s*=\s*\d/)
  })

  it('gates the restart action, and only for the main session', () => {
    const code = runner()
    const gate = code.match(
      /if\s*\(\s*decision\.action === 'restart' && name === MAIN_AGENT_ID\s*\)\s*\{[\s\S]*?\n {2}\}/,
    )
    expect(gate, 'no main-only restart gate found').not.toBeNull()
    expect(gate?.[0]).toMatch(/shouldDeferForRecentRespawn\(/)
  })

  it('does NOT advance the guard state machine when it defers', () => {
    // The trap this asserts against: decideGuard() has already produced
    // nextState = await-ready by the time the gate runs. Committing that while
    // skipping the restart would leave the machine believing main was
    // restarted, and the next sweep would inject a "continue from your handoff"
    // resume prompt into the SAME saturated pane -- the guard would consume its
    // own recovery and never retry. So the deferral path must re-commit the
    // PREVIOUS state and return.
    const code = runner()
    const gateIdx = code.indexOf("decision.action === 'restart' && name === MAIN_AGENT_ID")
    const commitIdx = code.indexOf('guardStates.set(name, decision.nextState)')
    expect(gateIdx, 'restart gate not found').toBeGreaterThan(-1)
    expect(commitIdx, 'nextState commit not found').toBeGreaterThan(-1)
    expect(gateIdx, 'the grace gate must run BEFORE nextState is committed').toBeLessThan(commitIdx)
    expect(code).toMatch(/guardStates\.set\(name, state\)/)
  })
})
