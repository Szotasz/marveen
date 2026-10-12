import { describe, it, expect } from 'vitest'
import { restartFailureAction, mainRelaunchSucceeded, MAX_RESTART_ATTEMPTS } from '../auto-restart.js'

// c5296a52 -- the restart LOOP, not the restart.
//
// The measured failure (2026-09-18, this install): the nightly auto-restart came due at 03:00Z,
// respawnMainSessionFresh reaped the pane's claude, the session closed with it (channels.sh
// starts it without remain-on-exit), `tmux respawn-pane -k` threw "can't find pane", and the
// caller only logged a WARN. Because the throw left lastRestart unset, the slot stayed DUE, so
// every idle tick tried again: 176 'restart failed' lines between 03:00Z and 08:01Z, one attempt
// every 6-7 minutes, while channels.sh kept recreating the session underneath.
//
// Two decisions came out of that, and both live here as pure functions so they can be measured
// without a tmux server: how many times a failing restart may retry, and which relaunch results
// count as "the session is coming back".
describe('restartFailureAction', () => {
  it('retries the first failures -- a transient hiccup must not skip the nightly restart', () => {
    expect(restartFailureAction(1)).toBe('retry')
    expect(restartFailureAction(2)).toBe('retry')
  })

  it('releases the slot at the cap: the third failure stops the retry and notifies', () => {
    expect(restartFailureAction(MAX_RESTART_ATTEMPTS)).toBe('release-and-notify')
  })

  it('stays released past the cap (no wrap-around back into retrying)', () => {
    expect(restartFailureAction(MAX_RESTART_ATTEMPTS + 1)).toBe('release-and-notify')
    expect(restartFailureAction(176)).toBe('release-and-notify')
  })

  it('honours an explicit cap, so the policy is not hard-wired to 3', () => {
    expect(restartFailureAction(1, 1)).toBe('release-and-notify')
    expect(restartFailureAction(4, 9)).toBe('retry')
  })
})

describe('mainRelaunchSucceeded', () => {
  it("counts 'grace' as success: a launch already in flight IS the session coming back", () => {
    // The dangerous reading is the other one. 'grace' means createMainChannelsSession() was
    // called again inside its 6-minute throttle -- the session is booting. Treating that as a
    // failure would re-arm the retry loop precisely when something is already starting.
    expect(mainRelaunchSucceeded('grace')).toBe(true)
    expect(mainRelaunchSucceeded('started')).toBe(true)
  })

  it('counts a broken install as failure, so the caller can throw instead of booking success', () => {
    expect(mainRelaunchSucceeded('script-missing')).toBe(false)
    expect(mainRelaunchSucceeded('spawn-failed')).toBe(false)
  })
})
