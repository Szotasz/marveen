// Regression tests: two independent supervisors -- launchd
// com.marveen.channels (KeepAlive=true) and the dashboard's
// channel-monitor.ts createMainChannelsSession() -- can both start
// scripts/channels.sh for the same SESSION at the same time. channels.sh
// unconditionally `tmux kill-session`s any pre-existing session before
// creating a fresh one, so the later starter kills the session the earlier
// starter just created and is now supervising -> rapid-exit.
//
// scripts/lib/singleton-lock.sh adds a per-SESSION mkdir-based singleton
// lock (not flock(1) -- measured 2026-09-05: this macOS install has no
// flock binary on PATH; mkdir is POSIX-atomic and needs no external
// binary). Only one channels.sh instance may hold the lock for a given
// SESSION; a second starter backs off before touching the session at all.
//
// The first describe block drives the real library with real concurrent
// bash processes -- an actual mkdir race, not a mock. The second reads
// scripts/channels.sh and locks in that it is actually wired to the lock
// (source, call order relative to kill-session, EXIT-trapped release) --
// we cannot drive a real tmux + claude session from a unit test (same
// constraint as the sibling channel-monitor structural tests), so this half
// verifies wiring the way the rest of this suite already does for
// tmux-touching code.

import { describe, it, expect } from "vitest"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..", "..")
const LIB_PATH = join(REPO_ROOT, "scripts", "lib", "singleton-lock.sh")
const CHANNELS_SH_PATH = join(REPO_ROOT, "scripts", "channels.sh")

describe("scripts/lib/singleton-lock.sh (real concurrent bash processes)", () => {
  it("lets exactly one of two starters racing for the same session proceed; the other backs off untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-lock-test-"))
    const lockDir = join(dir, "session-lock")
    const events = join(dir, "events.log")
    try {
      const script = `
set -u
. "${LIB_PATH}"
LOCK_DIR="${lockDir}"
EVENTS="${events}"
run_starter() {
  local id="$1"
  if acquire_singleton_lock "$LOCK_DIR"; then
    echo "acquired $id $$" >> "$EVENTS"
    sleep 0.3
    release_singleton_lock "$LOCK_DIR"
    echo "released $id $$" >> "$EVENTS"
  else
    echo "skipped $id $$" >> "$EVENTS"
  fi
}
run_starter A &
run_starter B &
wait
`
      execFileSync("/bin/bash", ["-c", script], { timeout: 10_000 })
      const lines = readFileSync(events, "utf-8").trim().split("\n").filter(Boolean)
      const acquired = lines.filter((l) => l.startsWith("acquired "))
      const skipped = lines.filter((l) => l.startsWith("skipped "))
      const released = lines.filter((l) => l.startsWith("released "))

      expect(acquired, lines.join("\n")).toHaveLength(1)
      expect(skipped, lines.join("\n")).toHaveLength(1)
      expect(released, lines.join("\n")).toHaveLength(1)
      // the same instance that acquired the lock is the one that released it
      expect(released[0]?.split(" ")[2]).toBe(acquired[0]?.split(" ")[2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reclaims a lock left behind by a dead process, but never touches one whose owner is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "channels-lock-test-"))
    const lockDir = join(dir, "session-lock")
    try {
      // Simulate a crashed prior owner: the lock dir exists, its pid file
      // names a pid that is guaranteed not to be running.
      const staleScript = `
set -u
. "${LIB_PATH}"
mkdir "${lockDir}"
echo 999999 > "${lockDir}/pid"
if acquire_singleton_lock "${lockDir}"; then echo reclaimed; else echo held; fi
`
      const staleOut = execFileSync("/bin/bash", ["-c", staleScript], { timeout: 5000 }).toString().trim()
      expect(staleOut).toBe("reclaimed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    const dir2 = mkdtempSync(join(tmpdir(), "channels-lock-test-"))
    const lockDir2 = join(dir2, "session-lock")
    try {
      // A lock genuinely held by this same live test process must never be
      // reclaimed as "stale" just because the pid check races on write order.
      const liveScript = `
set -u
. "${LIB_PATH}"
mkdir "${lockDir2}"
echo $$ > "${lockDir2}/pid"
if acquire_singleton_lock "${lockDir2}"; then echo reclaimed; else echo held; fi
`
      const liveOut = execFileSync("/bin/bash", ["-c", liveScript], { timeout: 5000 }).toString().trim()
      expect(liveOut).toBe("held")
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})

describe("scripts/channels.sh is wired to the singleton lock", () => {
  const src = readFileSync(CHANNELS_SH_PATH, "utf-8")

  it("sources scripts/lib/singleton-lock.sh", () => {
    expect(src).toContain('"$INSTALL_DIR/scripts/lib/singleton-lock.sh"')
  })

  it("acquires the lock, keyed on $SESSION, before the unconditional old-session kill-session", () => {
    const acquireIdx = src.indexOf("acquire_singleton_lock ")
    expect(acquireIdx, "acquire_singleton_lock call not found").toBeGreaterThan(0)
    const killIdx = src.indexOf('kill-session -t "$SESSION"')
    expect(killIdx, "kill-session call not found").toBeGreaterThan(0)
    expect(acquireIdx).toBeLessThan(killIdx)

    const block = src.slice(Math.max(0, acquireIdx - 400), acquireIdx + 50)
    expect(block).toContain("$SESSION")
  })

  it("exits before reaching kill-session when the lock is already held by a live instance", () => {
    const acquireIdx = src.indexOf("acquire_singleton_lock ")
    const killIdx = src.indexOf('kill-session -t "$SESSION"')
    const block = src.slice(acquireIdx, killIdx)
    expect(block).toContain("exit 0")
  })

  it("releases the lock via an EXIT trap so a future legitimate restart is never permanently blocked", () => {
    expect(src).toContain("trap 'release_singleton_lock")
    expect(src).toMatch(/trap[^\n]*\bEXIT\b/)
  })
})
