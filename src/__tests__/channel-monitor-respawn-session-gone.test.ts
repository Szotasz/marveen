// c5296a52 -- the restart loop: respawn-pane on a session the reap just took with it.
//
// Measured on this install (2026-09-18): the nightly restart came due at 03:00Z,
// respawnMainSessionFresh reaped the pane's claude, the session closed with it (channels.sh
// starts it WITHOUT remain-on-exit), `tmux respawn-pane -k` threw "can't find pane", the caller
// logged a WARN, and lastRestart stayed unset -- so the slot stayed DUE and every idle tick tried
// again: 176 'restart failed' lines between 03:00Z and 08:01Z.
//
// Like the sibling channel-monitor tests, a real tmux interaction cannot be driven from a unit
// test, so the asserts read the source and lock in the structural invariants: the respawn is
// GUARDED by a session-existence check, the missing-session branch relaunches through the SAME
// path the guard uses (channels.sh, via createMainChannelsSession), and a relaunch that could not
// start anything still throws -- because a restart booked as success while nothing came up is the
// other half of this bug.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, "..", "web", "channel-monitor.ts"), "utf-8")

function sliceFn(name: string): string {
  const start = src.indexOf("export function " + name)
  expect(start, name + " not found").toBeGreaterThan(0)
  const end = src.indexOf("\n}\n", start)
  expect(end, name + " closing brace not found").toBeGreaterThan(start)
  return src.slice(start, end)
}

describe("respawnMainSessionFresh: the session may be gone after the reap", () => {
  const body = sliceFn("respawnMainSessionFresh")

  it("guards the respawn with a session-existence check", () => {
    expect(body).toMatch(/if \(mainChannelsSessionExists\(\)\)/)
  })

  it("respawn-pane runs only inside that guard, not unconditionally", () => {
    const guardAt = body.indexOf("mainChannelsSessionExists()")
    const respawnAt = body.indexOf("'respawn-pane'")
    expect(respawnAt, "respawn-pane call not found").toBeGreaterThan(0)
    expect(respawnAt).toBeGreaterThan(guardAt)
  })

  it("relaunches through channels.sh (the guard's path), not a bespoke tmux command", () => {
    expect(body).toMatch(/createMainChannelsSession\(\)/)
    // A hand-rolled `tmux new-session` here is the drift this comment warns about: it would
    // miss the first-run dialog handling, the /rename and the plugin bring-up.
    expect(body).not.toMatch(/'new-session'/)
  })

  it("throws when the relaunch could not start anything (no silent success)", () => {
    expect(body).toMatch(/mainRelaunchSucceeded\(created\)/)
    expect(body).toMatch(/throw new Error\(/)
  })

  it("stamps the respawn on the relaunch path too, so the watchers stand aside while it boots", () => {
    const elseAt = body.indexOf("createMainChannelsSession()")
    expect(body.indexOf("writeRespawnStamp()", elseAt)).toBeGreaterThan(elseAt)
  })
})
