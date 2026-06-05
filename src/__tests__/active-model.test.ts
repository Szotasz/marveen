import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { projectsDirFor } from '../web/active-model.js'

describe('projectsDirFor', () => {
  it('uses <home>/.claude/projects when no config dir is given', () => {
    const result = projectsDirFor('/home/u/work', undefined, '/home/u')
    expect(result).toBe(join('/home/u', '.claude', 'projects', '-home-u-work'))
  })

  it('uses the supplied config dir instead of the default home location', () => {
    const result = projectsDirFor('/home/u/work', '/home/u/.claude-coding', '/home/u')
    expect(result).toBe(join('/home/u/.claude-coding', 'projects', '-home-u-work'))
  })

  it('does not fall back to the home dir when a config dir is supplied', () => {
    const result = projectsDirFor('/home/u/work', '/var/lib/claude-coding', '/home/u')
    expect(result.startsWith('/var/lib/claude-coding')).toBe(true)
    expect(result).not.toContain('/home/u/.claude')
  })

  it('encodes slashes and dots in the working dir to dashes', () => {
    const result = projectsDirFor('/home/u/some.dir/app', '/cfg', '/home/u')
    expect(result).toBe(join('/cfg', 'projects', '-home-u-some-dir-app'))
  })

  it('produces distinct project dirs for the same working dir on different config roots', () => {
    const a = projectsDirFor('/w', '/home/u/.claude', '/home/u')
    const b = projectsDirFor('/w', '/home/u/.claude-coding', '/home/u')
    expect(a).not.toBe(b)
  })
})
