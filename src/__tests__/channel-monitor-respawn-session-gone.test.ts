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

import { relaunchGoneMainSession, type MainSessionCreateResult } from "../web/channel-monitor.js"

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
    // 45b778e9: the relaunch branch lives in relaunchGoneMainSession, with createMainChannelsSession
    // and writeRespawnStamp passed in; its behaviour is tested below.
    expect(body).toMatch(/relaunchGoneMainSession\(createMainChannelsSession, writeRespawnStamp\)/)
    // A hand-rolled `tmux new-session` here is the drift this comment warns about: it would
    // miss the first-run dialog handling, the /rename and the plugin bring-up.
    expect(body).not.toMatch(/'new-session'/)
  })

  it("the relaunch branch returns right after the helper: no respawn-pane follow-ups on that path", () => {
    const callAt = body.indexOf("relaunchGoneMainSession(createMainChannelsSession, writeRespawnStamp)")
    expect(callAt, "relaunch call not found").toBeGreaterThan(0)
    expect(body.slice(callAt).split("\n")[1]).toMatch(/^\s*return\s*$/)
  })
})

// 45b778e9: the "no silent success" promise by BEHAVIOUR. The earlier source asserts
// (mainRelaunchSucceeded(created) and throw new Error( present) stayed green under the real
// mutation `if (false && !mainRelaunchSucceeded(created))`, in this test and in the full suite.
describe("relaunchGoneMainSession: a relaunch that started nothing throws, and nothing is stamped", () => {
  const futtat = (created: MainSessionCreateResult) => {
    let stamps = 0
    const run = () => relaunchGoneMainSession(() => created, () => { stamps += 1 })
    return { run, stamps: () => stamps }
  }

  for (const created of ["script-missing", "spawn-failed"] as const) {
    it(`throws on '${created}' and does not stamp a respawn`, () => {
      const f = futtat(created)
      expect(f.run).toThrow(`main channels session gone and relaunch failed: ${created}`)
      expect(f.stamps()).toBe(0)
    })
  }

  // 'grace' is success on purpose (a launch is in flight); its bound is stated at the helper.
  for (const created of ["started", "grace"] as const) {
    it(`returns '${created}' and stamps the respawn exactly once, so the watchers stand aside`, () => {
      const f = futtat(created)
      expect(f.run()).toBe(created)
      expect(f.stamps()).toBe(1)
    })
  }
})
