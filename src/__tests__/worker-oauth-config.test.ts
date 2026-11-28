// WORKEROAUTHFILE: the REAL config path (config.ts reads the setting from the env layer), not only the pure function.
// A whitespace-only value must reach the decision as a value and be refused, never collapse into "unset" (= the fleet token).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const envLayer = vi.hoisted(() => ({ values: {} as Record<string, string> }))

vi.mock('../env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../env.js')>()
  return { ...real, readEnvFile: (keys?: string[]) => {
    const base = real.readEnvFile(keys)
    return { ...base, ...envLayer.values }
  } }
})

import { decideWorkerOauthToken } from '../web/agent-oauth-token-file.js'

async function loadConfig() {
  vi.resetModules()
  return import('../config.js')
}
const decide = (configured: string) => decideWorkerOauthToken({
  configured, usesCustomProvider: () => false, fleetTokenPath: '/nonexistent/fleet.token', uid: typeof process.getuid === 'function' ? process.getuid() : null,
})

beforeEach(() => { envLayer.values = {} })

describe('WORKER_OAUTH_TOKEN_FILE(_FAST) through config.ts', () => {
  it('absent -> empty string -> unset (today\'s behaviour)', async () => {
    const c = await loadConfig()
    expect(c.WORKER_OAUTH_TOKEN_FILE).toBe('')
    expect(c.WORKER_OAUTH_TOKEN_FILE_FAST).toBe('')
    expect(decide(c.WORKER_OAUTH_TOKEN_FILE)).toEqual({ kind: 'unset' })
  })

  it('a whitespace-only value arrives as a value and is REFUSED as blank, for both workers', async () => {
    envLayer.values = { WORKER_OAUTH_TOKEN_FILE: '   ', WORKER_OAUTH_TOKEN_FILE_FAST: '\t ' }
    const c = await loadConfig()
    expect(c.WORKER_OAUTH_TOKEN_FILE).toBe('   ')
    expect(decide(c.WORKER_OAUTH_TOKEN_FILE)).toMatchObject({ kind: 'refused', reason: 'blank' })
    expect(decide(c.WORKER_OAUTH_TOKEN_FILE_FAST)).toMatchObject({ kind: 'refused', reason: 'blank' })
  })

  it('the two settings are independent', async () => {
    envLayer.values = { WORKER_OAUTH_TOKEN_FILE_FAST: 'relative/path' }
    const c = await loadConfig()
    expect(decide(c.WORKER_OAUTH_TOKEN_FILE)).toEqual({ kind: 'unset' })
    expect(decide(c.WORKER_OAUTH_TOKEN_FILE_FAST)).toMatchObject({ kind: 'refused', reason: 'not-absolute' })
  })
})
