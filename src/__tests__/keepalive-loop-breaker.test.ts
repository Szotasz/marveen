import { describe, it, expect } from 'vitest'
import { decideKeepaliveLoop, KEEPALIVE_USELESS_RESPAWN_LIMIT } from '../web/channel-monitor.js'

// KEEPALIVELOOP923. 2026-09-23: the keepalive producer hung, the file stayed
// stale with a LIVE poller, and the keepalive path respawned a healthy main
// session 28 times in one morning. A respawn cannot fix a dead producer, so
// after KEEPALIVE_USELESS_RESPAWN_LIMIT respawns that did not move the file,
// the monitor must hold and alert once.
const base = {
  pollerAlive: true,
  keepaliveMtimeMs: 1000,
  mtimeAtLastRespawn: null as number | null,
  uselessRespawns: 0,
  alreadyAlerted: false,
  limit: KEEPALIVE_USELESS_RESPAWN_LIMIT,
}

describe('decideKeepaliveLoop', () => {
  it('respawns on the first stale tick (no earlier respawn to judge)', () => {
    expect(decideKeepaliveLoop(base)).toEqual({ decision: 'respawn', uselessRespawns: 0 })
  })

  it('replays the 2026-09-23 night: two useless respawns, then one alert, then silence', () => {
    let state = { ...base }
    const decisions: string[] = []
    let alerted = false
    for (let tick = 0; tick < 6; tick++) {
      const r = decideKeepaliveLoop({ ...state, alreadyAlerted: alerted })
      decisions.push(r.decision)
      if (r.decision === 'hold-and-alert') alerted = true
      state = {
        ...state,
        uselessRespawns: r.uselessRespawns,
        // the file never moves; a respawn records the mtime it saw
        mtimeAtLastRespawn: r.decision === 'respawn' ? 1000 : state.mtimeAtLastRespawn,
      }
    }
    expect(decisions).toEqual(['respawn', 'respawn', 'hold-and-alert', 'hold', 'hold', 'hold'])
  })

  it('a respawn that DID advance the file resets the count', () => {
    const r = decideKeepaliveLoop({ ...base, keepaliveMtimeMs: 2000, mtimeAtLastRespawn: 1000, uselessRespawns: 1 })
    expect(r).toEqual({ decision: 'respawn', uselessRespawns: 0 })
  })

  it('never holds back when the poller is dead (real deafness)', () => {
    const r = decideKeepaliveLoop({ ...base, pollerAlive: false, mtimeAtLastRespawn: 1000, uselessRespawns: 5, alreadyAlerted: true })
    expect(r.decision).toBe('respawn')
  })
})
