import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, chmodSync, renameSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { atomicWriteFileSync } from '../web/atomic-write.js'

const here = dirname(fileURLToPath(import.meta.url))
const vaultBindingsSrc = join(here, '..', 'web', 'vault-bindings.ts')

// VAULTMODE818: the vault-binding sync rewrites credential-bearing MCP config
// files (for the user target this IS ~/.claude.json). atomicWriteFileSync
// renames a fresh tmp file over the target, so WITHOUT an explicit mode the
// result inherits the umask (0644) and silently loosens a 0600 credential file
// to group/other-readable. Every write of target.mcpFilePath must pin 0600.
describe('VAULTMODE818: vault-bindings pins 0600 on credential-bearing writes', () => {
  it('every atomicWriteFileSync(target.mcpFilePath, ...) passes mode 0o600', () => {
    const src = readFileSync(vaultBindingsSrc, 'utf8')
    // Each such write is a single line; the credential-file write must pin 0600.
    const lines = src.split('\n').filter(l => l.includes('atomicWriteFileSync(target.mcpFilePath'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, `credential-file write must set 0600:\n${line}`).toMatch(/mode:\s*0o600/)
    }
  })

  it('atomicWriteFileSync with mode 0600 keeps a file 0600 even overwriting a 0644 one', () => {
    const path = join(tmpdir(), `vaultmode-${process.pid}-${randomBytes(4).toString('hex')}.json`)
    try {
      // Simulate an existing world-readable file the sync would overwrite.
      writeFileSync(path, '{}')
      chmodSync(path, 0o644)
      expect(statSync(path).mode & 0o777).toBe(0o644)
      atomicWriteFileSync(path, JSON.stringify({ x: 1 }), { mode: 0o600 })
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('atomicWriteFileSync WITHOUT mode inherits the umask (the bug being guarded)', () => {
    const path = join(tmpdir(), `vaultmode-nomode-${process.pid}-${randomBytes(4).toString('hex')}.json`)
    // The prior 0600 is lost on rewrite because rename swaps the inode: the new
    // file's perms come from the umask, not the old target. Tie the expectation
    // to THIS process's umask (0666 & ~umask) rather than hard-coding "not 0600"
    // -- under a restrictive umask (e.g. 077) the default is itself 0600 and a
    // bare "not 0600" would falsely fail.
    const um = process.umask()
    process.umask(um) // read-only: restore immediately
    const umaskDefault = 0o666 & ~um
    try {
      writeFileSync(path, '{}')
      chmodSync(path, 0o600)
      const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, '{"x":1}')
      renameSync(tmp, path)
      expect(statSync(path).mode & 0o777).toBe(umaskDefault)
    } finally {
      rmSync(path, { force: true })
    }
  })
})
