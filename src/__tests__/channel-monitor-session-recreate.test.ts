// Regression tests for the self-healing main-session fix.
//
// Background: the channel-monitor down-cascade (handleMarveenDown) recovers a
// main session by replacing the claude process in the EXISTING tmux pane via
// `tmux respawn-pane`. respawn-pane needs a live pane -- it cannot recreate a
// session that has vanished entirely (crash, self-update mid-restart, OOM,
// reboot). On installs where nothing supervises the session (the channels
// systemd unit disabled, or any pure-tmux deploy) the session then stays gone,
// and the scheduler silently skips every main-agent task whose target tmux
// session is missing. This fix teaches check() to detect a fully-absent
// session and recreate it from scratch via scripts/channels.sh instead of
// running a respawn-pane cascade that can only fail.
//
// As with the sibling channel-monitor tests, we cannot drive a real tmux
// interaction from a unit test, so the asserts read the source and lock in the
// structural invariants the fix introduced.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, "..", "web", "channel-monitor.ts")
const src = readFileSync(MONITOR_PATH, "utf-8")

function sliceFn(name: string): string {
  const start = src.indexOf("function " + name)
  expect(start, name + " not found").toBeGreaterThan(0)
  const end = src.indexOf("\n}\n", start)
  expect(end, name + " closing brace not found").toBeGreaterThan(start)
  return src.slice(start, end)
}

describe("channel-monitor: self-healing vanished main session", () => {
  it("imports spawn from node:child_process", () => {
    expect(src).toMatch(/import\s*{[^}]*\bspawn\b[^}]*}\s*from\s*["']node:child_process["']/)
  })

  it("mainChannelsSessionExists probes via tmux has-session", () => {
    const fn = sliceFn("mainChannelsSessionExists")
    expect(fn).toContain("has-session")
    expect(fn).toContain("MAIN_CHANNELS_SESSION")
  })

  it("createMainChannelsSession launches channels.sh detached and unref'd", () => {
    const fn = sliceFn("createMainChannelsSession")
    expect(fn).toContain("CHANNELS_SCRIPT")
    expect(fn).toContain("spawn(")
    expect(fn).toContain("detached: true")
    expect(fn).toContain(".unref()")
  })

  it("createMainChannelsSession is throttled by a multi-minute grace", () => {
    const fn = sliceFn("createMainChannelsSession")
    expect(fn).toContain("MAIN_SESSION_CREATE_GRACE_MS")
    const m = src.match(/const\s+MAIN_SESSION_CREATE_GRACE_MS\s*=\s*([\d_]+)/)
    expect(m, "MAIN_SESSION_CREATE_GRACE_MS constant not found").not.toBeNull()
    const value = parseInt((m![1] as string).replace(/_/g, ""), 10)
    expect(value).toBeGreaterThanOrEqual(120_000)
  })

  it("createMainChannelsSession writes the shared respawn stamp for cold-start grace", () => {
    const fn = sliceFn("createMainChannelsSession")
    expect(fn).toContain("writeRespawnStamp()")
  })

  it("resumeMarveenSession writes the shared respawn stamp (2026-06-08 self-defer fix)", () => {
    // Without this stamp the stuck-tool-call-watcher cannot defer its own
    // self-respawn during the post-respawn grace, because lastMainRespawnAt()
    // only sees the keepalive and launchctl timestamps -- not a stage-3 /
    // watcher-triggered resume. The 2026-06-08 false-positive loop respawned
    // the session 13 times in 8h because every fresh respawn left a residual
    // TUI footer the watcher then re-classified as a wedge.
    const start = src.indexOf("export async function resumeMarveenSession")
    expect(start, "resumeMarveenSession not found").toBeGreaterThan(0)
    // Slice generously to the next top-level export so the assertion catches
    // a stamp call anywhere inside the function, not just before the next "\n}\n".
    const end = src.indexOf("\nexport ", start + 1)
    const fn = end > start ? src.slice(start, end) : src.slice(start)
    expect(fn).toContain("writeRespawnStamp()")
    // It must appear before the successful return so a failed respawn does
    // not falsely suppress later recovery paths.
    const stampIdx = fn.indexOf("writeRespawnStamp()")
    const returnTrueIdx = fn.indexOf("return true")
    expect(stampIdx, "writeRespawnStamp must precede the success return").toBeGreaterThan(0)
    expect(stampIdx).toBeLessThan(returnTrueIdx)
  })

  it("CHANNELS_SCRIPT resolves to scripts/channels.sh under PROJECT_ROOT", () => {
    expect(src).toMatch(/const\s+CHANNELS_SCRIPT\s*=\s*join\(PROJECT_ROOT,\s*["']scripts["'],\s*["']channels\.sh["']\)/)
  })

  it("check() recreates an absent session instead of running the respawn-pane cascade", () => {
    // The monitor loop must consult mainChannelsSessionExists() and route a
    // vanished session to createMainChannelsSession(), only falling through to
    // handleMarveenDown() when the session still exists (dead/wedged claude in
    // a live pane -- the case respawn-pane can actually fix).
    const fnStart = src.indexOf("export function startChannelPluginMonitor")
    expect(fnStart, "startChannelPluginMonitor not found").toBeGreaterThan(0)
    const loop = src.slice(fnStart)
    const existsIdx = loop.indexOf("!mainChannelsSessionExists()")
    const createIdx = loop.indexOf("createMainChannelsSession()")
    const downIdx = loop.indexOf("handleMarveenDown()")
    expect(existsIdx, "absent-session guard missing from monitor loop").toBeGreaterThan(0)
    expect(createIdx, "createMainChannelsSession call missing from monitor loop").toBeGreaterThan(0)
    expect(downIdx, "handleMarveenDown fall-through missing from monitor loop").toBeGreaterThan(0)
    // The absent-session check and its recreate must come before the
    // handleMarveenDown fall-through in the same branch.
    expect(existsIdx).toBeLessThan(createIdx)
    expect(createIdx).toBeLessThan(downIdx)
  })
})
