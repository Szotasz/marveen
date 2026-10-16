// Issue #1805: the guard's "exported" fact comes from readMainSharedConfigState, and the decision tests
// fake that reader. This file runs the REAL reader against a temp store, so a reader that stopped reporting
// an existing fleet token as exported (bringing back the false restart notices) fails here.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'msc-state-'))
mkdirSync(join(ROOT, 'store'), { recursive: true })
vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  get PROJECT_ROOT() { return ROOT },
  get STORE_DIR() { return join(ROOT, 'store') },
}))

const { readMainSharedConfigState, mainSharedConfigTrigger } = await import('../web/agent-process.js')
const tokenFile = join(ROOT, 'store', '.claude-oauth-token')

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('readMainSharedConfigState: an existing fleet token is an exported one', () => {
  it('no token file: no token, nothing exported, the guard stays silent', () => {
    rmSync(tokenFile, { force: true })
    const s = readMainSharedConfigState(null)
    expect(s).toMatchObject({ fleetToken: false, fleetTokenExported: false })
    expect(mainSharedConfigTrigger(s)).toBeNull()
  })

  it('a non-empty token file: the token exists AND the launchers export it, so no notice', () => {
    writeFileSync(tokenFile, 'fleet-token-fixture\n')
    const s = readMainSharedConfigState(null)
    expect(s).toMatchObject({ fleetToken: true, fleetTokenExported: true })
    expect(mainSharedConfigTrigger(s)).toBeNull()
  })

  it('an empty token file counts as no token, exactly as channels.sh ([ -s ]) treats it', () => {
    writeFileSync(tokenFile, '\n')
    expect(readMainSharedConfigState(null)).toMatchObject({ fleetToken: false, fleetTokenExported: false })
  })
})
