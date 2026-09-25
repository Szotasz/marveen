import { describe, it, expect, vi } from 'vitest'

vi.mock('../web/agent-process.js', () => ({ isAgentRunning: vi.fn(), capturePane: vi.fn(), agentSessionName: vi.fn(), restartAgentProcess: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({ sendAlert: vi.fn(), hardRestartMarveenChannels: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: vi.fn(() => []) }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))

import { parseUnsupportedModelError, semverGte, decideVersionGuard, MODEL_VERSION_RESTART_COOLDOWN_MS } from '../web/model-version-guard.js'

// The real shape from an agent's pane, 2026-09-23 (wrapped at the pane width).
const AGENT_PANE = [
  '  fut ujra. </trusted-peer>',
  '',
  "⏺ API Error: 400 Claude Code 2.1.278 does not support this model;",
  "  version 2.1.280 or newer is required. Run 'claude update', or update",
  '  the Claude desktop app, then try again.',
  '',
  '✻ Baked for 1s · done 13:46',
  '❯ ',
].join('\n')

const base = { installedVersion: '2.1.280', processStartMs: 1000, binaryMtimeMs: 2000, lastActionAt: null, now: 10_000, cooldownMs: MODEL_VERSION_RESTART_COOLDOWN_MS }

describe('parseUnsupportedModelError', () => {
  it('reads the running and required versions from a wrapped pane', () => {
    expect(parseUnsupportedModelError(AGENT_PANE)).toEqual({ running: '2.1.278', required: '2.1.280' })
  })
  it('ignores a pane without the error', () => {
    expect(parseUnsupportedModelError('all good\n❯ ')).toBeNull()
    expect(parseUnsupportedModelError(null)).toBeNull()
  })
  it('ignores the error once it scrolled far above the live tail', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    expect(parseUnsupportedModelError(AGENT_PANE + '\n' + filler)).toBeNull()
  })
})

describe('semverGte', () => {
  it('compares numerically, not lexically', () => {
    expect(semverGte('2.1.280', '2.1.280')).toBe(true)
    expect(semverGte('2.1.280', '2.1.278')).toBe(true)
    expect(semverGte('2.1.99', '2.1.280')).toBe(false)
    expect(semverGte('2.2.0', '2.1.999')).toBe(true)
  })
})

describe('decideVersionGuard', () => {
  const error = { running: '2.1.278', required: '2.1.280' }
  it('replays 2026-09-23: new build on disk, session older than it -> restart', () => {
    expect(decideVersionGuard({ ...base, error })).toBe('restart')
  })
  it('never restarts a session that already started on the new build (stale --continue history)', () => {
    expect(decideVersionGuard({ ...base, error, processStartMs: 3000 })).toBe('none')
  })
  it('installed build too old -> alert, no restart', () => {
    expect(decideVersionGuard({ ...base, error, installedVersion: '2.1.279' })).toBe('alert-update')
  })
  it('does nothing inside the cooldown after an action', () => {
    expect(decideVersionGuard({ ...base, error, lastActionAt: 9_000 })).toBe('none')
  })
  it('does nothing destructive when a timestamp or the version is unknown', () => {
    expect(decideVersionGuard({ ...base, error, processStartMs: null })).toBe('none')
    expect(decideVersionGuard({ ...base, error, installedVersion: null })).toBe('none')
  })
  it('no error -> none', () => {
    expect(decideVersionGuard({ ...base, error: null })).toBe('none')
  })
})
