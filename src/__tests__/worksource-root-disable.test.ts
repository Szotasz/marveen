import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dropRootWorksourceDisable } from '../web/agent-process.js'

const write = (obj: unknown) => {
  const p = join(mkdtempSync(join(tmpdir(), 'wsroot-')), 'settings.local.json')
  writeFileSync(p, JSON.stringify(obj))
  return p
}

describe('dropRootWorksourceDisable', () => {
  it('removes the key when worksource was the only disabled server', () => {
    const p = write({ permissions: { allow: ['Bash(x)'] }, disabledMcpjsonServers: ['worksource'] })
    expect(dropRootWorksourceDisable(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ permissions: { allow: ['Bash(x)'] } })
  })

  it('keeps other disabled servers', () => {
    const p = write({ disabledMcpjsonServers: ['other', 'worksource'] })
    expect(dropRootWorksourceDisable(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ disabledMcpjsonServers: ['other'] })
  })

  it('leaves the file untouched when worksource is not disabled', () => {
    const p = write({ disabledMcpjsonServers: ['other'] })
    const before = readFileSync(p, 'utf-8')
    expect(dropRootWorksourceDisable(p)).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })

  it('returns false for a missing file', () => {
    expect(dropRootWorksourceDisable(join(tmpdir(), 'no-such-dir-wsroot', 'settings.local.json'))).toBe(false)
  })
})
