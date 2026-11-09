// MAINAUTH1107 (EGM code review 4): a vault that cannot be read is not "no key". In api mode the decision gives up
// (the caller keeps the last launch's files) instead of unstamping the owner's approval and reporting a missing key.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'mauth-vu-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const h = vi.hoisted(() => ({ mode: 'api' as string }))
vi.mock('../web/vault.js', () => ({ getSecret: () => { throw new Error('keychain not reachable') } }))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  readAgentAuthMode: () => h.mode,
  readAgentCustomProvider: () => null,
}))
const { gatherMainAuthInputs } = await import('../web/main-auth.js')

describe('gatherMainAuthInputs with an unreadable vault', () => {
  it('api: throws (no decision on a guess)', () => {
    h.mode = 'api'
    expect(() => gatherMainAuthInputs('shared', null, { projectRoot: ROOT, mainAgentId: 'm' })).toThrow(/vault is unreadable/)
  })
  it('shared: the vault key does not matter, so no throw and no key', () => {
    h.mode = 'shared'
    expect(gatherMainAuthInputs('shared', null, { projectRoot: ROOT, mainAgentId: 'm' })).toMatchObject({ authMode: 'shared', vaultKey: '' })
  })
})
