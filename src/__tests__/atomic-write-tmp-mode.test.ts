import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { atomicWriteFileSync } from '../web/atomic-write.js'

const here = dirname(fileURLToPath(import.meta.url))
const atomicWriteSrc = join(here, '..', 'web', 'atomic-write.ts')

// VAULTMODE818 (tmp-window half): atomicWriteFileSync must create the tmp file
// AT the requested mode, not write it mode-less and chmod afterwards. The
// mode-less+chmod path leaves a short-lived tmp holding the full content at the
// umask default (0644) in the same directory as the protected target -- a
// world-readable window even though the final renamed file ends up 0600.
describe('atomic-write tmp-file creation mode', () => {
  // DO NOT delete this source-scan as "redundant" with the behaviour tests
  // below. Verified 2026-08-19 (Marveen's negative control): reverting the fix
  // to a mode-less tmp create keeps BOTH behaviour tests GREEN -- the trailing
  // chmod still repairs the END state, so statSync on the final file sees 0600.
  // Only this source-scan turns red. This fault class (a transient world-readable
  // tmp) is invisible to end-state assertions; the source-scan is the only guard
  // that catches a regression, so removing it silently re-opens the window.
  it('passes the mode to writeFileSync at tmp creation (not chmod-only)', () => {
    const src = readFileSync(atomicWriteSrc, 'utf8')
    // The tmp create call must carry the mode; a mode-less writeFileSync(tmp, data)
    // followed only by chmod is the bug being guarded.
    const tmpCreate = src.match(/writeFileSync\(\s*tmp\s*,[^\n]*\)/)?.[0] ?? ''
    expect(tmpCreate, `tmp create line:\n${tmpCreate}`).toMatch(/mode/)
  })

  it('final file is 0600 when mode 0600 is requested (overwriting a 0644 file)', () => {
    const path = join(tmpdir(), `atomicmode-${process.pid}-${randomBytes(4).toString('hex')}.json`)
    try {
      writeFileSync(path, '{}')
      chmodSync(path, 0o644)
      atomicWriteFileSync(path, JSON.stringify({ x: 1 }), { mode: 0o600 })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('a fresh write with mode 0600 is never group/other-readable', () => {
    const path = join(tmpdir(), `atomicmode-fresh-${process.pid}-${randomBytes(4).toString('hex')}.json`)
    try {
      atomicWriteFileSync(path, 'secret-bearing', { mode: 0o600 })
      expect(statSync(path).mode & 0o077).toBe(0) // no group/other bits
    } finally {
      rmSync(path, { force: true })
    }
  })
})
