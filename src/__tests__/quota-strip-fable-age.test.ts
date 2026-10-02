// String-contract guard (house idiom, see federation-ui-contract.test.ts) for
// the Fable/Opus row's own age. quota.ts already computes FableSnapshot.ageSec
// from a collector independent of the statusLine's q.ageSec, but nothing
// rendered it: a muted row said "this might be old" with no way to tell
// minutes from days. Guards that the row's own ageSec travels into the
// windows tuple and reaches the DOM via the shared 'overview.quota.measured'
// key, so a regression that drops the threading silently (no functional test
// exercises the DOM here) still fails loud.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')

describe('quota strip: Fable/Opus row carries its own age', () => {
  it('threads fable.ageSec into the windows tuple', () => {
    expect(APP).toMatch(/windows\.push\(\['overview\.quota\.fable', fable\.window, fable\.status !== 'ok', fable\.ageSec\]\)/)
  })

  it('renders that per-row age via the shared measured-ago key', () => {
    expect(APP).toMatch(/typeof ageSecForRow === 'number'\) \{[\s\S]{0,120}overview\.quota\.measured/)
  })

  it('renders the age unconditionally, not gated on the row\'s muted state', () => {
    // The point of the age is to disambiguate a MUTED row ("might be old" ->
    // "how old"), so gating it on `muted` would defeat its own purpose. Pins
    // the guarding `if (` line itself, not just that the block exists.
    const guard = APP.match(/if \([^)]*typeof ageSecForRow === 'number'\) \{/)
    expect(guard).toBeTruthy()
    expect(guard![0]).not.toContain('muted')
  })

  it('the measured-ago key exists in both locales', () => {
    expect(EN).toContain("'overview.quota.measured':")
    expect(HU).toContain("'overview.quota.measured':")
  })
})
